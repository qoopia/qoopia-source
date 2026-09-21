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
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
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
