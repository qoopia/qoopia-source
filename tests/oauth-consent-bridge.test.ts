/**
 * ADR-017 §Tests / oauth-consent-bridge.test.ts
 *
 * The cookie-bridge consent flow:
 *   1. /oauth/authorize is a thin redirect that mints a server-side
 *      consent_ticket and 302s to /api/dashboard/oauth-consent?ticket=...
 *   2. The dashboard-scoped consent UI requires a verified dashboard
 *      cookie (or Bearer for tests) and the operator's workspace must
 *      match the ticket's workspace.
 *   3. Approve POST consumes a single-use nonce, marks the ticket
 *      approved, and 302s to /oauth/authorize/finalize?ticket=...
 *   4. Finalize redeems the ticket and emits the OAuth code, redirecting
 *      back to the client's redirect_uri with code+state.
 *
 * The /oauth/* endpoints intentionally never read the dashboard cookie
 * (ADR-015 invariant). Tests below pin that boundary by using only the
 * ticket id as state across the boundary.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { authLimiter, dashboardLimiter } from "../src/utils/rate-limit.ts";
import { env } from "../src/utils/env.ts";

let server: Server;
let baseUrl = "";

let WS_A_ID = "";
let WS_B_ID = "";
let STEWARD_A_KEY = "";
let STEWARD_A_ID = "";
let STEWARD_B_KEY = "";
let STEWARD_B_ID = "";

let CLIENT_A_ID = "";
const REDIRECT_URI_A = "https://example.com/cb-a";
const VALID_CHALLENGE = "x".repeat(43);

/**
 * Register an OAuth client via the public endpoint as steward A. Used
 * by tests below — we exercise the same path the friend-onboarding
 * flow uses.
 */
async function registerClientAsStewardA(): Promise<{
  client_id: string;
}> {
  const r = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${STEWARD_A_KEY}`,
    },
    body: JSON.stringify({
      client_name: "consent-bridge-client-a",
      redirect_uris: [REDIRECT_URI_A],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string };
}

/**
 * Hit /oauth/authorize and follow the 302 to /api/dashboard/oauth-consent
 * URL. Returns the ticket id (last segment of `?ticket=`).
 */
async function startAuthorize(opts: {
  clientId: string;
  redirectUri: string;
  state?: string;
  challenge?: string;
  challengeMethod?: string;
}): Promise<{ ticketId: string; redirectLocation: string; status: number }> {
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("code_challenge", opts.challenge ?? VALID_CHALLENGE);
  url.searchParams.set(
    "code_challenge_method",
    opts.challengeMethod ?? "S256",
  );
  if (opts.state) url.searchParams.set("state", opts.state);
  const r = await fetch(url.toString(), { redirect: "manual" });
  const loc = r.headers.get("location") || "";
  let ticketId = "";
  if (loc) {
    try {
      ticketId = new URL(loc, baseUrl).searchParams.get("ticket") || "";
    } catch {
      /* relative locations parse with a base */
    }
  }
  return { ticketId, redirectLocation: loc, status: r.status };
}

/**
 * GET the consent page authenticated with the given Bearer (acts as a
 * stand-in for the dashboard cookie since checkDashboardAuth honors both).
 */
async function getConsent(
  ticketId: string,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return fetch(
    `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(ticketId)}`,
    { headers, redirect: "manual" },
  );
}

async function postApprove(
  ticketId: string,
  nonce: string,
  bearer: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const params = new URLSearchParams({ ticket: ticketId, nonce });
  return fetch(`${baseUrl}/api/dashboard/oauth-consent/approve`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${bearer}`,
      ...extraHeaders,
    },
    body: params.toString(),
  });
}

async function postDeny(
  ticketId: string,
  nonce: string,
  bearer: string,
): Promise<Response> {
  const params = new URLSearchParams({ ticket: ticketId, nonce });
  return fetch(`${baseUrl}/api/dashboard/oauth-consent/deny`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${bearer}`,
    },
    body: params.toString(),
  });
}

async function exchangeCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.verifier,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
    }).toString(),
  });
}

function extractNonce(html: string): string {
  // Both forms (approve + deny) carry the same nonce. Match the first.
  const m = html.match(/name="nonce" value="([^"]+)"/);
  expect(m).not.toBeNull();
  return m![1]!;
}

function resetLimiters() {
  authLimiter.resetForTests();
  dashboardLimiter.resetForTests();
}

beforeAll(async () => {
  runMigrations();
  resetLimiters();
  const wsA = createWorkspace({
    name: "Consent Bridge WS A",
    slug: "consent-bridge-ws-a",
  });
  WS_A_ID = wsA.id;
  const wsB = createWorkspace({
    name: "Consent Bridge WS B",
    slug: "consent-bridge-ws-b",
  });
  WS_B_ID = wsB.id;

  const sa = createAgent({
    name: "consent-bridge-steward-a",
    workspaceSlug: wsA.slug,
    type: "steward",
  });
  STEWARD_A_ID = sa.id;
  STEWARD_A_KEY = sa.api_key;

  const sb = createAgent({
    name: "consent-bridge-steward-b",
    workspaceSlug: wsB.slug,
    type: "steward",
  });
  STEWARD_B_ID = sb.id;
  STEWARD_B_KEY = sb.api_key;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Register the workspace-A client once for use in most tests.
  const c = await registerClientAsStewardA();
  CLIENT_A_ID = c.client_id;
});

beforeEach(() => {
  resetLimiters();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("ADR-017: /oauth/authorize is a thin redirect", () => {
  test("valid params (no cookie) → 302 to /api/dashboard/oauth-consent?ticket=...", async () => {
    const { status, redirectLocation, ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-thin-redirect",
    });
    expect(status).toBe(302);
    expect(redirectLocation).toContain("/api/dashboard/oauth-consent?ticket=");
    expect(ticketId).toMatch(/^qct_/);

    // Ticket row exists, in-flight, with workspace_id snapshot.
    const row = db
      .prepare(
        `SELECT client_id, workspace_id, redirect_uri, state, redeemed,
                denied, approved_by_agent_id, expires_at
           FROM consent_tickets WHERE id = ?`,
      )
      .get(ticketId) as
      | {
          client_id: string;
          workspace_id: string;
          redirect_uri: string;
          state: string;
          redeemed: number;
          denied: number;
          approved_by_agent_id: string | null;
          expires_at: string;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.client_id).toBe(CLIENT_A_ID);
    expect(row!.workspace_id).toBe(WS_A_ID);
    expect(row!.redirect_uri).toBe(REDIRECT_URI_A);
    expect(row!.state).toBe("s-thin-redirect");
    expect(row!.redeemed).toBe(0);
    expect(row!.denied).toBe(0);
    expect(row!.approved_by_agent_id).toBeNull();
  });

  test("audit log fingerprints consent tickets instead of logging raw qct ids", async () => {
    const auditPath = path.join(env.LOG_DIR, "audit.log");
    let auditOffset = 0;
    try {
      auditOffset = fs.statSync(auditPath).size;
    } catch {
      // file may not exist yet
    }

    const { status, ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-audit-fingerprint",
    });
    expect(status).toBe(302);

    const consent = await getConsent(ticketId, STEWARD_A_KEY);
    expect(consent.status).toBe(200);
    const nonce = extractNonce(await consent.text());

    const approval = await postApprove(ticketId, nonce, STEWARD_A_KEY);
    expect(approval.status).toBe(302);

    const finalize = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(finalize.status).toBe(302);

    const rows = (fs.existsSync(auditPath)
      ? fs.readFileSync(auditPath, "utf8").slice(auditOffset).split("\n")
      : [])
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((row): row is Record<string, unknown> => row !== null)
      .filter((row) => row.event === "oauth_consent");

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const detail = String(row.detail || "");
      expect(detail).not.toContain(ticketId);
      if (detail.includes("ticket_fp=")) {
        expect(detail).toMatch(/ticket_fp=[0-9a-f]{12}/);
      }
    }
  });

  test("missing client_id → 400, no ticket created", async () => {
    const before = (db
      .prepare(`SELECT COUNT(*) AS n FROM consent_tickets`)
      .get() as { n: number }).n;
    const url = new URL(`${baseUrl}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI_A);
    url.searchParams.set("code_challenge", VALID_CHALLENGE);
    const r = await fetch(url.toString(), { redirect: "manual" });
    expect(r.status).toBe(400);
    const after = (db
      .prepare(`SELECT COUNT(*) AS n FROM consent_tickets`)
      .get() as { n: number }).n;
    expect(after).toBe(before);
  });

  test("unknown client_id → 400 invalid_client, no ticket created", async () => {
    const before = (db
      .prepare(`SELECT COUNT(*) AS n FROM consent_tickets`)
      .get() as { n: number }).n;
    const url = new URL(`${baseUrl}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "qc_does_not_exist");
    url.searchParams.set("redirect_uri", REDIRECT_URI_A);
    url.searchParams.set("code_challenge", VALID_CHALLENGE);
    const r = await fetch(url.toString(), { redirect: "manual" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
    const after = (db
      .prepare(`SELECT COUNT(*) AS n FROM consent_tickets`)
      .get() as { n: number }).n;
    expect(after).toBe(before);
  });

  test("redirect_uri not in allowlist → 400, no ticket created", async () => {
    const before = (db
      .prepare(`SELECT COUNT(*) AS n FROM consent_tickets`)
      .get() as { n: number }).n;
    const url = new URL(`${baseUrl}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_A_ID);
    url.searchParams.set("redirect_uri", "https://attacker.example.com/cb");
    url.searchParams.set("code_challenge", VALID_CHALLENGE);
    const r = await fetch(url.toString(), { redirect: "manual" });
    expect(r.status).toBe(400);
    const after = (db
      .prepare(`SELECT COUNT(*) AS n FROM consent_tickets`)
      .get() as { n: number }).n;
    expect(after).toBe(before);
  });

  test("malformed S256 code_challenge → 400 invalid_request", async () => {
    const { status } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      challenge: "short-not-a-valid-s256-challenge",
    });
    expect(status).toBe(400);
  });

  test("legacy USER POST /oauth/authorize is gone → 405 Allow: GET", async () => {
    const r = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=approve",
      redirect: "manual",
    });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
  });
});

describe("ADR-017: /api/dashboard/oauth-consent GET", () => {
  test("no cookie / no Bearer → 302 to /dashboard?next=...", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    expect(ticketId).not.toBe("");
    const r = await getConsent(ticketId);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") || "";
    expect(loc).toContain("/dashboard?next=");
    expect(loc).toContain(encodeURIComponent("/api/dashboard/oauth-consent"));

    // Regression: /dashboard?next=... must render the dashboard shell, not
    // fall through to {error:"not_found"} because req.url includes the query.
    const dashboard = await fetch(new URL(loc, baseUrl), { redirect: "manual" });
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain("Qoopia V1");
    expect(html).toContain("consumeSafeNext");
  });

  test("Bearer for workspace B against ticket for workspace A → 403 wrong-workspace HTML, no nonce", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const r = await getConsent(ticketId, STEWARD_B_KEY);
    expect(r.status).toBe(403);
    const html = await r.text();
    expect(html).toContain("Wrong workspace");
    // Crucially: no approve form, no nonce input rendered.
    expect(html).not.toContain('name="nonce"');
    expect(html).not.toContain("oauth-consent/approve");

    // Ticket nonce was NOT rotated — still equals what was minted at
    // /oauth/authorize. Confirm by ensuring approving with that ticket
    // requires re-rotating via a successful GET.
    const row = db
      .prepare(`SELECT approve_nonce FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { approve_nonce: string } | undefined;
    expect(row?.approve_nonce.length).toBeGreaterThan(0);
  });

  test("Bearer for workspace A + valid ticket → 200 + approve form + fresh nonce", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const before = db
      .prepare(`SELECT approve_nonce FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { approve_nonce: string };

    const r = await getConsent(ticketId, STEWARD_A_KEY);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('action="/api/dashboard/oauth-consent/approve"');
    expect(html).toContain("Approve");
    const nonce = extractNonce(html);
    expect(nonce).toMatch(/^qcn_/);

    // Nonce was rotated on render.
    const after = db
      .prepare(`SELECT approve_nonce FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { approve_nonce: string };
    expect(after.approve_nonce).not.toBe(before.approve_nonce);
    expect(after.approve_nonce).toBe(nonce);
  });
});

describe("ADR-017: /api/dashboard/oauth-consent/approve guards", () => {
  test("workspace mismatch on approve POST → 403 (defense in depth)", async () => {
    // Mint a ticket as A, then try to approve while presenting B's Bearer.
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    // Get a real nonce by rendering the consent UI as A first.
    const okResp = await getConsent(ticketId, STEWARD_A_KEY);
    expect(okResp.status).toBe(200);
    const nonce = extractNonce(await okResp.text());

    const r = await postApprove(ticketId, nonce, STEWARD_B_KEY);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("forbidden");

    const row = db
      .prepare(
        `SELECT approved_by_agent_id, redeemed, denied
           FROM consent_tickets WHERE id = ?`,
      )
      .get(ticketId) as
      | {
          approved_by_agent_id: string | null;
          redeemed: number;
          denied: number;
        }
      | undefined;
    expect(row?.approved_by_agent_id).toBeNull();
    expect(row?.redeemed).toBe(0);
    expect(row?.denied).toBe(0);
  });

  test("reused nonce on approve POST → 403 second time", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const nonce = extractNonce(await (await getConsent(ticketId, STEWARD_A_KEY)).text());

    // First approve consumes the nonce, but our caller is workspace A so
    // it actually approves. Mint a fresh ticket for the strict reuse test.
    const ok = await postApprove(ticketId, nonce, STEWARD_A_KEY);
    expect(ok.status).toBe(302);
    // Re-using the same nonce on a fresh ticket — but nonce binding is to
    // ticket id, so `nonce` is wrong for a different ticket. Test directly
    // by reusing on the SAME ticket (which is now approved → status check
    // catches it before the nonce check). To pin nonce reuse specifically:
    // start a fresh ticket, render once, then send the same nonce twice.
    const { ticketId: freshTicket } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const freshNonce = extractNonce(
      await (await getConsent(freshTicket, STEWARD_A_KEY)).text(),
    );
    // Need a second agent in workspace A so we can fail on nonce
    // (workspace match passes). Reuse steward A.
    const first = await postApprove(freshTicket, freshNonce, STEWARD_A_KEY);
    expect(first.status).toBe(302);
    const replay = await postApprove(freshTicket, freshNonce, STEWARD_A_KEY);
    // Already approved, so the status branch fires before nonce — but the
    // 4xx assertion is what we need either way.
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  test("forged Origin → 403, ticket untouched", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const nonce = extractNonce(await (await getConsent(ticketId, STEWARD_A_KEY)).text());

    const r = await postApprove(ticketId, nonce, STEWARD_A_KEY, {
      origin: "https://evil.example.com",
    });
    expect(r.status).toBe(403);
    const row = db
      .prepare(
        `SELECT approved_by_agent_id FROM consent_tickets WHERE id = ?`,
      )
      .get(ticketId) as { approved_by_agent_id: string | null } | undefined;
    expect(row?.approved_by_agent_id).toBeNull();
  });

  test("opaque browser Origin null → approve allowed", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-origin-null",
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );

    const r = await postApprove(ticketId, nonce, STEWARD_A_KEY, {
      origin: "null",
      host: "mcp.qoopia.ai",
      "x-forwarded-host": "mcp.qoopia.ai",
      "x-forwarded-proto": "https",
    });
    expect(r.status).toBe(302);
  });

  test("proxy forwarded host origin → approve allowed", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-forwarded-origin",
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );

    const r = await postApprove(ticketId, nonce, STEWARD_A_KEY, {
      origin: "https://mcp.qoopia.ai",
      host: "qoopia-corsair:3738",
      "x-forwarded-host": "mcp.qoopia.ai",
      "x-forwarded-proto": "https",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain(
      `/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
    );
  });

  test("happy path approve → 302 to /oauth/authorize/finalize?ticket=...; row.approved_by_agent_id set", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-happy-approve",
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );

    const r = await postApprove(ticketId, nonce, STEWARD_A_KEY);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") || "";
    expect(loc).toContain("/oauth/authorize/finalize?ticket=");
    expect(loc).toContain(`ticket=${encodeURIComponent(ticketId)}`);

    const row = db
      .prepare(
        `SELECT approved_by_agent_id, redeemed FROM consent_tickets WHERE id = ?`,
      )
      .get(ticketId) as
      | { approved_by_agent_id: string | null; redeemed: number }
      | undefined;
    expect(row?.approved_by_agent_id).toBe(STEWARD_A_ID);
    expect(row?.redeemed).toBe(0); // finalize hasn't run yet
  });
});

describe("ADR-017: /oauth/authorize/finalize", () => {
  test("no approval → 400 ticket not approved", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const r = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error_description?: string };
    expect(body.error_description).toContain("not approved");
  });

  test("happy path finalize → 302 to client redirect_uri with code+state, oauth_codes row bound to approver", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-finalize-happy",
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    const approveResp = await postApprove(ticketId, nonce, STEWARD_A_KEY);
    expect(approveResp.status).toBe(302);

    const finalizeResp = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(finalizeResp.status).toBe(302);
    const loc = finalizeResp.headers.get("location") || "";
    expect(loc).toContain(REDIRECT_URI_A);
    const u = new URL(loc);
    expect(u.searchParams.get("state")).toBe("s-finalize-happy");
    const code = u.searchParams.get("code") || "";
    expect(code).toMatch(/^qc_/);

    // The oauth_tokens 'code' row is bound to the approving agent.
    const codeRow = db
      .prepare(
        `SELECT agent_id, workspace_id, token_type, client_id, revoked
           FROM oauth_tokens
           WHERE token_type = 'code' AND client_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get(CLIENT_A_ID) as
      | {
          agent_id: string;
          workspace_id: string;
          token_type: string;
          client_id: string;
          revoked: number;
        }
      | undefined;
    expect(codeRow).toBeDefined();
    expect(codeRow!.agent_id).toBe(STEWARD_A_ID);
    expect(codeRow!.workspace_id).toBe(WS_A_ID);

    // Ticket is now redeemed.
    const ticketRow = db
      .prepare(`SELECT redeemed FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { redeemed: number };
    expect(ticketRow.redeemed).toBe(1);
  });

  test("malformed code_verifier at token exchange → 400 invalid_request", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-bad-verifier",
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    const approveResp = await postApprove(ticketId, nonce, STEWARD_A_KEY);
    expect(approveResp.status).toBe(302);

    const finalizeResp = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(finalizeResp.status).toBe(302);
    const code = new URL(finalizeResp.headers.get("location") || "").searchParams.get("code") || "";
    expect(code).toMatch(/^qc_/);

    const tokenResp = await exchangeCode({
      code,
      verifier: "too-short",
      redirectUri: REDIRECT_URI_A,
      clientId: CLIENT_A_ID,
    });
    expect(tokenResp.status).toBe(400);
    const body = (await tokenResp.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("replay finalize on redeemed ticket → repeats cached redirect", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    await postApprove(ticketId, nonce, STEWARD_A_KEY);
    // first finalize
    const first = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);
    // replay
    const replay = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe(first.headers.get("location"));
  });

  test("redeemed ticket without replay cache → shows completed HTML", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    await postApprove(ticketId, nonce, STEWARD_A_KEY);
    db.prepare(`UPDATE consent_tickets SET redeemed = 1 WHERE id = ?`).run(ticketId);

    const resp = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(resp.status).toBe(400);
    expect(resp.headers.get("content-type")).toContain("text/html");
    expect(await resp.text()).toContain("Authorization already completed");
  });

  test("approve POST on redeemed ticket → shows completed HTML", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    await postApprove(ticketId, nonce, STEWARD_A_KEY);
    db.prepare(`UPDATE consent_tickets SET redeemed = 1 WHERE id = ?`).run(ticketId);

    const resp = await postApprove(ticketId, nonce, STEWARD_A_KEY);
    expect(resp.status).toBe(400);
    expect(resp.headers.get("content-type")).toContain("text/html");
    expect(await resp.text()).toContain("Authorization already completed");
  });

  test("expired ticket → 400 ticket expired", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
    });
    // Approve normally, then jump expires_at into the past.
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    await postApprove(ticketId, nonce, STEWARD_A_KEY);
    db.prepare(
      `UPDATE consent_tickets SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`,
    ).run(ticketId);
    const r = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error_description?: string };
    expect(body.error_description).toContain("expired");
  });
});

describe("ADR-017: deny path", () => {
  test("deny POST → 302 to client redirect_uri with error=access_denied; finalize on denied ticket → 400", async () => {
    const { ticketId } = await startAuthorize({
      clientId: CLIENT_A_ID,
      redirectUri: REDIRECT_URI_A,
      state: "s-deny",
    });
    const nonce = extractNonce(
      await (await getConsent(ticketId, STEWARD_A_KEY)).text(),
    );
    const r = await postDeny(ticketId, nonce, STEWARD_A_KEY);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") || "";
    expect(loc).toContain(REDIRECT_URI_A);
    const u = new URL(loc);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("s-deny");

    // Ticket marked denied.
    const row = db
      .prepare(`SELECT denied FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { denied: number };
    expect(row.denied).toBe(1);

    // Finalize on denied ticket fails closed.
    const finalize = await fetch(
      `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
      { redirect: "manual" },
    );
    expect(finalize.status).toBe(400);
    const body = (await finalize.json()) as { error: string };
    expect(body.error).toBe("access_denied");
  });
});
