/**
 * QSA-G / Codex QSA-007: every HTML response surfaced to a browser must
 * carry a hardened Content-Security-Policy. We exercise the two HTML
 * surfaces in the server:
 *
 *   1. GET /dashboard — the dashboard page.
 *   2. GET /api/dashboard/oauth-consent — the OAuth consent page (under
 *      ADR-017 the OAuth consent UI lives on the dashboard surface; the
 *      legacy GET /oauth/authorize is now a thin 302 redirect with no
 *      HTML body so it does not need CSP).
 *
 * The plain-http test loopback CANNOT exercise HSTS — Strict-Transport-
 * Security must only be emitted on HTTPS, and the test server is plain
 * http on 127.0.0.1. We assert that HSTS is *absent* on plain http
 * (downgrade-trap regression) and that CSP is present and contains the
 * load-bearing directives.
 *
 * The unit-level isHttps logic is covered by dashboard-cookie-hardening,
 * so we don't re-prove it here.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { nowIso } from "../src/utils/errors.ts";

let server: Server;
let baseUrl = "";
let CLIENT_ID = "";
let AGENT_KEY = "";
let TICKET_ID = "";
const REDIRECT_URI = "https://example.com/cb";

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({
    name: "QSA-G Security Headers",
    slug: "qsa-g-security-headers",
  });
  const agent = createAgent({
    name: "qsa-g-target",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  AGENT_KEY = agent.api_key;

  // ADR-017: oauth_clients carries workspace_id directly. We INSERT here
  // (instead of going through registerClient) to keep this test focused
  // on CSP — the registration path is exercised by oauth-register.test.
  CLIENT_ID = `qc_${crypto.randomBytes(16).toString("base64url")}`;
  db.prepare(
    `INSERT INTO oauth_clients
       (id, name, agent_id, workspace_id, client_secret_hash, redirect_uris, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CLIENT_ID,
    "qsa-g-test",
    agent.id,
    ws.id,
    "",
    JSON.stringify([REDIRECT_URI]),
    nowIso(),
  );

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Mint a consent_ticket so the consent UI has something to render. We
  // hit /oauth/authorize as the friend would; the redirect carries the
  // ticket id.
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", "x".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "csp");
  const r = await fetch(url.toString(), { redirect: "manual" });
  const loc = r.headers.get("location") || "";
  TICKET_ID = new URL(loc, baseUrl).searchParams.get("ticket") || "";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Assert the load-bearing CSP directives. We don't lock the full string
 * verbatim because that turns the test into a tautology — instead we
 * assert each clause that meaningfully reduces the XSS / clickjacking /
 * exfil blast radius.
 */
function expectHardenedCsp(csp: string | null) {
  expect(csp).not.toBeNull();
  const c = csp!;
  expect(c).toContain("default-src 'self'");
  expect(c).toContain("frame-ancestors 'none'");
  expect(c).toContain("object-src 'none'");
  expect(c).toContain("base-uri 'none'");
  expect(c).toContain("form-action 'self'");
  // Dropped from CSP Level 3 and unrecognised by every current browser, so it would only add a
  // console error on every page and hide the violations worth seeing.
  expect(c).not.toContain("navigate-to");
  // Same-origin script files only: no inline script, no inline handler, no external host.
  expect(c.split("; ")).toContain("script-src 'self'");
}

/** A page under that policy must not rely on what the policy forbids. */
function expectNoInlineScript(html: string) {
  expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) ?? []).toEqual([]);
  expect(html.match(/<[^>]+\son[a-z]+\s*=/gi) ?? []).toEqual([]);
}

describe("QSA-G / Codex QSA-007: dashboard CSP + HSTS-on-https", () => {
  test("GET /dashboard returns hardened CSP", async () => {
    const r = await fetch(`${baseUrl}/dashboard`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/html");
    expectHardenedCsp(r.headers.get("content-security-policy"));
    const html = await r.text();
    expectNoInlineScript(html);
    // The page's own code is a same-origin file, versioned with the page and served as JavaScript.
    const src = /<script src="(\/brand\/dashboard\.js\?v=[0-9a-f]{12})"><\/script>/.exec(html)?.[1];
    expect(src).toBeString();
    const script = await fetch(baseUrl + src!);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const code = await script.text();
    expect(code).toContain("window.location.origin");
    // Markup built by the script is subject to the same policy: no inline handlers, no javascript: URLs.
    expect(code.match(/[\s"'\\]on[a-z]+\s*=\s*\\?["']|javascript:/gi) ?? []).toEqual([]);
    // The links that used those handlers now name their target in an attribute, so the page must
    // carry exactly one delegated listener that acts on them; without it they are dead.
    const targets = [...code.matchAll(/data-go=\\?"([a-z]+)/g)].map(m => m[1]!);
    expect(new Set(targets).size).toBeGreaterThan(0);
    const delegated = /addEventListener\('click'[\s\S]{0,400}?\[data-go\],\[data-route\][\s\S]{0,300}?go\(link\.dataset\.go\)/.exec(code);
    expect(delegated, "dashboard.js must delegate [data-go]/[data-route] clicks").not.toBeNull();
    // go() refuses a page that is not in NAV, so a stale target would be a silently dead link.
    const nav = new Set([...code.matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map(m => m[1]!));
    for (const page of new Set(targets)) expect([...nav]).toContain(page);
    expect(html).toContain('<link href="/brand/dashboard.css?v=' + r.headers.get("x-qoopia-dashboard-version") + '"');
  });

  test("GET /dashboard sets x-content-type-options + referrer-policy", async () => {
    const r = await fetch(`${baseUrl}/dashboard`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    // F-182: same-origin keeps the Origin on the page's own native form POST; other origins get no Referer.
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
  });

  test("GET /dashboard does NOT emit HSTS on plain http", async () => {
    // RFC 6797: emitting HSTS over plain http is meaningless and risks
    // sticking on a TLS-terminating tunnel. The server must omit the
    // header when isHttps(req) is false (which is the case for the test
    // loopback, since TRUST_PROXY is off in the test env).
    const r = await fetch(`${baseUrl}/dashboard`);
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("QSA-G / Codex QSA-007: OAuth consent page CSP", () => {
  test("GET /api/dashboard/oauth-consent returns hardened CSP", async () => {
    expect(TICKET_ID).not.toBe("");
    const r = await fetch(
      `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(TICKET_ID)}`,
      {
        headers: { authorization: `Bearer ${AGENT_KEY}` },
        redirect: "manual",
      },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/html");
    expectHardenedCsp(r.headers.get("content-security-policy"));
    // The consent page is where an approval is given: it must work with scripts forbidden.
    expectNoInlineScript(await r.text());
  });

  test("GET /api/dashboard/oauth-consent does NOT emit HSTS on plain http", async () => {
    expect(TICKET_ID).not.toBe("");
    const r = await fetch(
      `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(TICKET_ID)}`,
      {
        headers: { authorization: `Bearer ${AGENT_KEY}` },
        redirect: "manual",
      },
    );
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("F-186: every HTML response refuses framing and unused powerful features", () => {
  test("GET /offline carries the hardened CSP like every other HTML page", async () => {
    const r = await fetch(`${baseUrl}/offline`);
    expect(r.headers.get("content-type") || "").toContain("text/html");
    expectHardenedCsp(r.headers.get("content-security-policy"));
    expect(r.headers.get("service-worker-allowed")).toBe("/");
  });

  test("dashboard, consent and /offline send X-Frame-Options DENY and a Permissions-Policy", async () => {
    const consent = `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(TICKET_ID)}`;
    for (const [url, init] of [[`${baseUrl}/dashboard`, {}], [`${baseUrl}/offline`, {}],
      [consent, { headers: { authorization: `Bearer ${AGENT_KEY}` }, redirect: "manual" }]] as const) {
      const r = await fetch(url, init as RequestInit);
      expect(r.headers.get("x-frame-options"), url).toBe("DENY");
      expect(r.headers.get("permissions-policy"), url).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    }
  });
});

describe("F-188: session-bound and credential-bearing JSON is never cached", () => {
  const expectNoStore = (r: Response, label: string) => {
    expect(r.headers.get("cache-control"), label).toBe("no-store");
    expect(r.headers.get("x-content-type-options"), label).toBe("nosniff");
  };
  test("/api/v1, the dashboard authority proxy and /api/dashboard/profile send no-store + nosniff", async () => {
    const bearer = { authorization: `Bearer ${AGENT_KEY}` };
    expectNoStore(await fetch(`${baseUrl}/api/v1/capabilities`, { headers: bearer }), "v1 capabilities");
    for (const code of ["not-a-pairing-code", "x".repeat(43)]) {
      expectNoStore(await fetch(`${baseUrl}/api/v1/agent-pairings/redeem`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
      }), "pairing redeem");
    }
    expectNoStore(await fetch(`${baseUrl}/api/dashboard/authority/capabilities`, { headers: bearer }), "authority proxy");
    expectNoStore(await fetch(`${baseUrl}/api/dashboard/profile`), "profile");
  });
});

describe("F-318: OAuth consent pages speak the owner's language and have a main landmark", () => {
  const consent = (headers: Record<string, string>, query = "") =>
    fetch(`${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(TICKET_ID)}${query}`, {
      headers: { authorization: `Bearer ${AGENT_KEY}`, ...headers },
      redirect: "manual",
    });

  test("Accept-Language: ru renders the Russian consent decision under the same CSP", async () => {
    const r = await consent({ "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" });
    expect(r.status).toBe(200);
    expectHardenedCsp(r.headers.get("content-security-policy"));
    const html = await r.text();
    expectNoInlineScript(html);
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain("Разрешить доступ");
    // The EN/RU switch links are 44px touch targets like the account buttons.
    expect(html).toMatch(/\.languages a\{[^}]*min-height:44px/);
    expect(html).toMatch(/<button type="submit" class="approve">Разрешить<\/button>/);
    expect(html).toMatch(/<main class="card">[\s\S]*<form method="POST" action="\/api\/dashboard\/oauth-consent\/approve">[\s\S]*<\/main>/);
  });

  test("an explicit ?lang wins over the browser language; English stays the default", async () => {
    const en = await (await consent({ "accept-language": "ru-RU" }, "&lang=en")).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain(">Approve</button>");
    const plain = await (await consent({})).text();
    expect(plain).toContain('<html lang="en">');
    expect(plain).toContain('<main class="card">');
  });

  test("the already-completed page is localized", async () => {
    const page = (lang: string) => fetch(`${baseUrl}/oauth/authorize/finalize`, { headers: { "accept-language": lang } }).then(r => r.text());
    const ru = await page("ru-RU");
    expect(ru).toContain('<html lang="ru">');
    expect(ru).toContain("<main>");
    expect(await page("en-US")).toContain("Authorization already completed");
  });
});
