/**
 * Codex QSA-H regression — eligibility gates on the bridge consent surface.
 *
 * The fixes under test:
 *   - /oauth/register rejects OAuth access tokens (api-key only); a steward
 *     OAuth bearer cannot mint new clients.
 *   - /api/dashboard/oauth-consent (GET, approve, deny) rejects OAuth bearers
 *     and ordinary agents. Approval/denial is the steward or the owner via
 *     static key or signed cookie (ADR-020).
 *   - finalizeConsentTicket (run by approve) verifies the *approving agent's
 *     current workspace* still matches the ticket's workspace (not the
 *     registering client owner's).
 *   - cross-workspace deny attempts are audited (parity with GET/approve).
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
import { env } from "../src/utils/env.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import { authLimiter, dashboardLimiter } from "../src/utils/rate-limit.ts";
import {
  approveConsentTicket,
  createConsentTicket,
  finalizeConsentTicket,
  redeemConsentTicket,
} from "../src/auth/oauth.ts";

let server: Server;
let baseUrl = "";

let WS_A_ID = "";
let WS_B_ID = "";

let STEWARD_A_KEY = "";
let STEWARD_A_ID = "";
let STEWARD_B_KEY = "";
let STEWARD_B_ID = "";
let STANDARD_A_KEY = "";

let CLIENT_A_ID = "";
const REDIRECT_URI = "https://example.com/cb-eligibility";
const VALID_CHALLENGE = "x".repeat(43);

/**
 * Mint an opaque access token directly into oauth_tokens, bypassing the full
 * authorize→exchange flow. authenticate() will resolve it as source="oauth"
 * because findActiveToken() returns the row with token_type="access".
 */
function mintRawAccessToken(opts: {
  agent_id: string;
  workspace_id: string;
  client_id: string;
}): string {
  const token = `qa_test_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const tokenHash = sha256Hex(token);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const expires = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  db.prepare(
    `INSERT INTO oauth_tokens
       (token_hash, client_id, agent_id, workspace_id, token_type,
        expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 'access', ?, 0, ?)`,
  ).run(
    tokenHash,
    opts.client_id,
    opts.agent_id,
    opts.workspace_id,
    expires,
    now,
  );
  return token;
}

async function postRegister(
  body: Record<string, unknown>,
  bearer: string,
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

async function startAuthorize(
  clientId: string,
): Promise<{ ticketId: string; status: number }> {
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", VALID_CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
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
  return { ticketId, status: r.status };
}

async function getConsent(
  ticketId: string,
  bearer: string,
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(ticketId)}`,
    {
      headers: { authorization: `Bearer ${bearer}` },
      redirect: "manual",
    },
  );
}

async function postApprove(
  ticketId: string,
  nonce: string,
  bearer: string,
): Promise<Response> {
  const params = new URLSearchParams({ ticket: ticketId, nonce });
  return fetch(`${baseUrl}/api/dashboard/oauth-consent/approve`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${bearer}`,
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

function extractNonce(html: string): string {
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

  const wsA = createWorkspace({
    name: "QSA-H WS A",
    slug: "qsa-h-ws-a",
  });
  WS_A_ID = wsA.id;
  const wsB = createWorkspace({
    name: "QSA-H WS B",
    slug: "qsa-h-ws-b",
  });
  WS_B_ID = wsB.id;

  const stewardA = createAgent({
    name: "qsah-steward-a",
    workspaceSlug: wsA.slug,
    type: "steward",
  });
  STEWARD_A_ID = stewardA.id;
  STEWARD_A_KEY = stewardA.api_key;

  const stewardB = createAgent({
    name: "qsah-steward-b",
    workspaceSlug: wsB.slug,
    type: "steward",
  });
  STEWARD_B_ID = stewardB.id;
  STEWARD_B_KEY = stewardB.api_key;

  const standardA = createAgent({
    name: "qsah-standard-a",
    workspaceSlug: wsA.slug,
    type: "standard",
  });
  STANDARD_A_KEY = standardA.api_key;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Register a client that we'll use throughout (after server is up).
  const reg = await postRegister(
    {
      client_name: "qsah-client-a",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    },
    STEWARD_A_KEY,
  );
  expect(reg.status).toBe(201);
  CLIENT_A_ID = ((await reg.json()) as { client_id: string }).client_id;
});

beforeEach(() => {
  resetLimiters();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("QSA-H: /oauth/register rejects OAuth access tokens", () => {
  test("steward's OAuth access token cannot register a new client (403)", async () => {
    // Mint an OAuth access token bound to STEWARD_A. authenticate() will
    // resolve it with source="oauth".
    const oauthBearer = mintRawAccessToken({
      agent_id: STEWARD_A_ID,
      workspace_id: WS_A_ID,
      client_id: CLIENT_A_ID,
    });

    const r = await postRegister(
      {
        client_name: "qsah-attempted-via-oauth",
        redirect_uris: ["https://example.com/cb-evil"],
      },
      oauthBearer,
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; error_description: string };
    expect(body.error).toBe("forbidden");
    // No row written.
    const row = db
      .prepare(`SELECT 1 FROM oauth_clients WHERE name = ?`)
      .get("qsah-attempted-via-oauth");
    expect(row).toBeFalsy();
  });

  test("steward's static api_key still works (control)", async () => {
    const r = await postRegister(
      {
        client_name: "qsah-control-via-apikey",
        redirect_uris: ["https://example.com/cb-control"],
      },
      STEWARD_A_KEY,
    );
    expect(r.status).toBe(201);
  });
});

describe("QSA-H: consent surface rejects OAuth access tokens", () => {
  test("GET /api/dashboard/oauth-consent with OAuth bearer → 403, no consent UI", async () => {
    const { ticketId, status } = await startAuthorize(CLIENT_A_ID);
    expect(status).toBe(302);
    expect(ticketId.length).toBeGreaterThan(0);

    const oauthBearer = mintRawAccessToken({
      agent_id: STEWARD_A_ID,
      workspace_id: WS_A_ID,
      client_id: CLIENT_A_ID,
    });
    const r = await getConsent(ticketId, oauthBearer);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; error_description: string };
    expect(body.error).toBe("forbidden");
    expect(body.error_description.toLowerCase()).toContain("oauth");
  });

  test("approve POST with OAuth bearer → 403, ticket stays not-approved", async () => {
    // First render the consent UI as steward A to get a fresh nonce.
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    const ui = await getConsent(ticketId, STEWARD_A_KEY);
    expect(ui.status).toBe(200);
    const nonce = extractNonce(await ui.text());

    const oauthBearer = mintRawAccessToken({
      agent_id: STEWARD_A_ID,
      workspace_id: WS_A_ID,
      client_id: CLIENT_A_ID,
    });
    const r = await postApprove(ticketId, nonce, oauthBearer);
    expect(r.status).toBe(403);

    // Ticket must remain unapproved.
    const row = db
      .prepare(
        `SELECT approved_by_agent_id, redeemed FROM consent_tickets WHERE id = ?`,
      )
      .get(ticketId) as
      | { approved_by_agent_id: string | null; redeemed: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.approved_by_agent_id).toBeNull();
    expect(row!.redeemed).toBe(0);
  });

  test("deny POST with OAuth bearer → 403, ticket stays not-denied", async () => {
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    const ui = await getConsent(ticketId, STEWARD_A_KEY);
    const nonce = extractNonce(await ui.text());

    const oauthBearer = mintRawAccessToken({
      agent_id: STEWARD_A_ID,
      workspace_id: WS_A_ID,
      client_id: CLIENT_A_ID,
    });
    const r = await postDeny(ticketId, nonce, oauthBearer);
    expect(r.status).toBe(403);

    const row = db
      .prepare(`SELECT denied FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { denied: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.denied).toBe(0);
  });
});

describe("QSA-H: consent surface rejects standard agents", () => {
  test("GET as standard agent → 403", async () => {
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    const r = await getConsent(ticketId, STANDARD_A_KEY);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; error_description: string };
    expect(body.error_description).toMatch(/steward|claude-privileged|admin/i);
  });

  test("approve as standard agent → 403, ticket stays unapproved", async () => {
    // Get a fresh nonce as the steward (the standard agent can't render).
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    const ui = await getConsent(ticketId, STEWARD_A_KEY);
    const nonce = extractNonce(await ui.text());

    const r = await postApprove(ticketId, nonce, STANDARD_A_KEY);
    expect(r.status).toBe(403);

    const row = db
      .prepare(
        `SELECT approved_by_agent_id FROM consent_tickets WHERE id = ?`,
      )
      .get(ticketId) as { approved_by_agent_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.approved_by_agent_id).toBeNull();
  });

  test("deny as standard agent → 403, ticket stays not-denied", async () => {
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    const ui = await getConsent(ticketId, STEWARD_A_KEY);
    const nonce = extractNonce(await ui.text());

    const r = await postDeny(ticketId, nonce, STANDARD_A_KEY);
    expect(r.status).toBe(403);

    const row = db
      .prepare(`SELECT denied FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { denied: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.denied).toBe(0);
  });
});

// F-076: approve redeems in the same request through finalizeConsentTicket,
// which still refuses an approved agent that is no longer active in the
// ticket's workspace. These tests exercise that shared helper directly.
describe("QSA-H: finalize re-checks the approving agent's eligibility", () => {
  const codeCount = () => (db
    .prepare(`SELECT COUNT(*) AS c FROM oauth_tokens WHERE client_id = ? AND token_type = 'code'`)
    .get(CLIENT_A_ID) as { c: number }).c;

  test("approved agent belongs to another workspace → no code, ticket not redeemed", async () => {
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    // Steward B's workspace differs from the ticket's: the same predicate a
    // real approver drift trips.
    expect(approveConsentTicket(ticketId, STEWARD_B_ID)).toBe(true);
    const before = codeCount();

    expect(finalizeConsentTicket(ticketId, STEWARD_B_ID)).toBeNull();

    const row = db
      .prepare(`SELECT redeemed FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { redeemed: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.redeemed).toBe(0);
    expect(codeCount()).toBe(before);
  });

  test("approved agent was deactivated → no code, ticket not redeemed", async () => {
    // A dedicated approved agent in WS A so deactivating it does not disturb other tests.
    // The ticket's approved agent is the one the grant binds (an ordinary agent since ADR-020).
    const tempSteward = createAgent({
      name: "qsah-temp-steward-a",
      workspaceSlug: "qsa-h-ws-a",
    });

    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    expect(approveConsentTicket(ticketId, tempSteward.id)).toBe(true);
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(tempSteward.id);
    const before = codeCount();

    expect(finalizeConsentTicket(ticketId, tempSteward.id)).toBeNull();

    const row = db
      .prepare(`SELECT redeemed FROM consent_tickets WHERE id = ?`)
      .get(ticketId) as { redeemed: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.redeemed).toBe(0);
    expect(codeCount()).toBe(before);
  });
});

describe("QSA-H / MED #5: cross-workspace deny is audited", () => {
  test("steward B denies a workspace-A ticket → 403 + workspace_mismatch audit line", async () => {
    const { ticketId } = await startAuthorize(CLIENT_A_ID);
    // Get a nonce as steward A first (steward B can't render UI for an A ticket).
    const ui = await getConsent(ticketId, STEWARD_A_KEY);
    const nonce = extractNonce(await ui.text());

    // Snapshot audit-log size so we can scan only the lines this test added.
    const auditPath = path.join(env.LOG_DIR, "audit.log");
    let auditOffset = 0;
    try {
      auditOffset = fs.statSync(auditPath).size;
    } catch {
      /* file may not exist yet — start from 0 */
    }

    // Attempt deny as steward B.
    const r = await postDeny(ticketId, nonce, STEWARD_B_KEY);
    expect(r.status).toBe(403);

    // Audit line written: event=workspace_mismatch, detail contains
    // "oauth-consent deny", agent_id=STEWARD_B_ID.
    const newLines = fs.existsSync(auditPath)
      ? fs.readFileSync(auditPath, "utf8").slice(auditOffset).split("\n")
      : [];
    const matched = newLines
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (r): r is Record<string, unknown> =>
          r !== null &&
          r.event === "workspace_mismatch" &&
          r.agent_id === STEWARD_B_ID &&
          typeof r.detail === "string" &&
          (r.detail as string).startsWith("oauth-consent deny"),
      );
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[0]!.result).toBe("deny");
  });
});

describe("QSA-H round 2 / CRITICAL #1: dashboard /clients rejects OAuth bearers", () => {
  test("POST /api/dashboard/oauth/clients with OAuth bearer → 403, no client written", async () => {
    // The dashboard shim accepts cookie sessions and api-key Bearer (parity
    // with /oauth/register). An OAuth access token presented as Bearer must
    // be rejected — otherwise the source-rejection in
    // assertCanRegisterOAuth() at /oauth/register is trivially bypassed via
    // this shim.
    const oauthBearer = mintRawAccessToken({
      agent_id: STEWARD_A_ID,
      workspace_id: WS_A_ID,
      client_id: CLIENT_A_ID,
    });

    const r = await fetch(`${baseUrl}/api/dashboard/oauth/clients`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${oauthBearer}`,
      },
      body: JSON.stringify({
        client_name: "qsah-r2-attempted-via-oauth",
        redirect_uris: ["https://example.com/cb-evil-r2"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; error_description: string };
    expect(body.error).toBe("forbidden");
    expect(body.error_description.toLowerCase()).toContain("oauth");

    // No row written.
    const row = db
      .prepare(`SELECT 1 FROM oauth_clients WHERE name = ?`)
      .get("qsah-r2-attempted-via-oauth");
    expect(row).toBeFalsy();
  });

  test("POST /api/dashboard/oauth/clients with api-key Bearer still works (control)", async () => {
    const r = await fetch(`${baseUrl}/api/dashboard/oauth/clients`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${STEWARD_A_KEY}`,
      },
      body: JSON.stringify({
        client_name: "qsah-r2-control-via-apikey",
        redirect_uris: ["https://example.com/cb-r2-control"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(r.status).toBe(201);
  });
});

describe("QSA-H round 2 / HIGH #1: redeemConsentTicket is atomically gated on approver state", () => {
  test("approver flipped to active=0 after approve → redeemConsentTicket returns false, ticket stays unredeemed", async () => {
    // Spin up a dedicated approved agent so we can deactivate without disturbing
    // siblings (idx_one_steward forbids two active stewards per workspace).
    const tempApprover = createAgent({
      name: "qsah-r2-atomic-approver",
      workspaceSlug: "qsa-h-ws-a",
    });

    // Mint an approved ticket directly. We bypass the HTTP approve path so
    // the test isolates the redeem predicate, not the consent surface.
    const ticket = createConsentTicket({
      clientId: CLIENT_A_ID,
      workspaceId: WS_A_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: VALID_CHALLENGE,
      codeChallengeMethod: "S256",
      scope: "",
      state: "atomic-test",
    });
    db.prepare(
      `UPDATE consent_tickets SET approved_by_agent_id = ? WHERE id = ?`,
    ).run(tempApprover.id, ticket.id);

    // Sanity: pre-condition — without drift, redeem would succeed. We do
    // not actually redeem here; we simulate the TOCTOU by flipping the
    // approver to inactive *before* calling redeem.
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(
      tempApprover.id,
    );

    const ok = redeemConsentTicket(ticket.id);
    expect(ok).toBe(false);

    const row = db
      .prepare(`SELECT redeemed FROM consent_tickets WHERE id = ?`)
      .get(ticket.id) as { redeemed: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.redeemed).toBe(0);

    // Restore approver active=1 — confirm the only thing blocking redeem
    // was the approver predicate, not some other ticket state.
    db.prepare(`UPDATE agents SET active = 1 WHERE id = ?`).run(
      tempApprover.id,
    );
    const ok2 = redeemConsentTicket(ticket.id);
    expect(ok2).toBe(true);
  });

  test("approver moved to a different workspace → redeemConsentTicket returns false", async () => {
    // Use a fresh ordinary approved agent in WS A (we cannot move a
    // steward out of WS A without breaking idx_one_steward in WS B).
    const tempApprover = createAgent({
      name: "qsah-r2-atomic-approver-ws",
      workspaceSlug: "qsa-h-ws-a",
    });

    const ticket = createConsentTicket({
      clientId: CLIENT_A_ID,
      workspaceId: WS_A_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: VALID_CHALLENGE,
      codeChallengeMethod: "S256",
      scope: "",
      state: "atomic-ws-test",
    });
    db.prepare(
      `UPDATE consent_tickets SET approved_by_agent_id = ? WHERE id = ?`,
    ).run(tempApprover.id, ticket.id);

    // Direct UPDATE to relocate the approver. An ordinary agent is not
    // covered by idx_one_steward, so this is safe schema-wise.
    db.prepare(`UPDATE agents SET workspace_id = ? WHERE id = ?`).run(
      WS_B_ID,
      tempApprover.id,
    );

    const ok = redeemConsentTicket(ticket.id);
    expect(ok).toBe(false);

    const row = db
      .prepare(`SELECT redeemed FROM consent_tickets WHERE id = ?`)
      .get(ticket.id) as { redeemed: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.redeemed).toBe(0);
  });
});
