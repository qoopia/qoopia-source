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
  // CSP-3 navigation restriction (defense-in-depth against window.location
  // exfiltration from any injected inline script).
  expect(c).toContain("navigate-to 'self'");
  // Inline scripts are allowed (the dashboard ships a single inline block);
  // but external script hosts must NOT be permitted.
  expect(c).not.toContain("script-src *");
  expect(c).not.toContain("script-src 'self' http");
  expect(c).not.toContain("script-src 'self' https:");
}

describe("QSA-G / Codex QSA-007: dashboard CSP + HSTS-on-https", () => {
  test("GET /dashboard returns hardened CSP", async () => {
    const r = await fetch(`${baseUrl}/dashboard`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/html");
    expectHardenedCsp(r.headers.get("content-security-policy"));
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
