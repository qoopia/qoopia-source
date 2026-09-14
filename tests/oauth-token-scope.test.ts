/**
 * ADR-017 §Tests / oauth-token-scope.test.ts
 *
 * End-to-end:
 *   - registerClient under steward A → consent ticket → approve by A's
 *     cookie/Bearer → finalize → exchangeCodeForTokens → access token has
 *     agent_id of A and workspace_id of A
 *
 * Cross-workspace negative:
 *   - cookie/Bearer for B against ticket for A: approve fails 403, the
 *     ticket is never finalized, and no oauth_tokens row is minted.
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
import crypto from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import { authLimiter, dashboardLimiter } from "../src/utils/rate-limit.ts";

let server: Server;
let baseUrl = "";

let WS_A_ID = "";
let WS_B_ID = "";
let STEWARD_A_KEY = "";
let STEWARD_A_ID = "";
let STEWARD_B_KEY = "";

const REDIRECT_URI = "https://example.com/cb-token-scope";

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

async function registerClient(bearer: string, name: string): Promise<{
  client_id: string;
  client_secret?: string;
}> {
  const r = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string; client_secret?: string };
}

async function startAuthorize(
  clientId: string,
  challenge: string,
): Promise<string> {
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "e2e");
  const r = await fetch(url.toString(), { redirect: "manual" });
  expect(r.status).toBe(302);
  const loc = r.headers.get("location") || "";
  const ticketId = new URL(loc, baseUrl).searchParams.get("ticket") || "";
  expect(ticketId).toMatch(/^qct_/);
  return ticketId;
}

async function getNonce(ticketId: string, bearer: string): Promise<string> {
  const r = await fetch(
    `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(ticketId)}`,
    {
      headers: { authorization: `Bearer ${bearer}` },
      redirect: "manual",
    },
  );
  expect(r.status).toBe(200);
  const html = await r.text();
  const m = html.match(/name="nonce" value="([^"]+)"/);
  expect(m).not.toBeNull();
  return m![1]!;
}

async function approve(
  ticketId: string,
  nonce: string,
  bearer: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/dashboard/oauth-consent/approve`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${bearer}`,
    },
    body: new URLSearchParams({ ticket: ticketId, nonce }).toString(),
  });
}

async function finalize(ticketId: string): Promise<Response> {
  return fetch(
    `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
    { redirect: "manual" },
  );
}

async function exchange(
  clientId: string,
  code: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const r = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    }).toString(),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as {
    access_token: string;
    refresh_token: string;
  };
}

beforeAll(async () => {
  runMigrations();
  const wsA = createWorkspace({
    name: "Token Scope WS A",
    slug: "token-scope-ws-a",
  });
  WS_A_ID = wsA.id;
  const wsB = createWorkspace({
    name: "Token Scope WS B",
    slug: "token-scope-ws-b",
  });
  WS_B_ID = wsB.id;
  const sa = createAgent({
    name: "token-scope-steward-a",
    workspaceSlug: wsA.slug,
    type: "steward",
  });
  STEWARD_A_ID = sa.id;
  STEWARD_A_KEY = sa.api_key;
  const sb = createAgent({
    name: "token-scope-steward-b",
    workspaceSlug: wsB.slug,
    type: "steward",
  });
  STEWARD_B_KEY = sb.api_key;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  authLimiter.resetForTests();
  dashboardLimiter.resetForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("ADR-017 e2e: register → ticket → approve → finalize → exchange", () => {
  test("token row carries A's agent_id + workspace_id", async () => {
    const { client_id } = await registerClient(STEWARD_A_KEY, "e2e-happy");
    const { verifier, challenge } = pkce();
    const ticketId = await startAuthorize(client_id, challenge);
    const nonce = await getNonce(ticketId, STEWARD_A_KEY);
    const approveResp = await approve(ticketId, nonce, STEWARD_A_KEY);
    expect(approveResp.status).toBe(302);

    const finResp = await finalize(ticketId);
    expect(finResp.status).toBe(302);
    const code = new URL(finResp.headers.get("location")!).searchParams.get(
      "code",
    )!;
    expect(code).toMatch(/^qc_/);

    const { access_token, refresh_token } = await exchange(
      client_id,
      code,
      verifier,
    );

    const accessRow = db
      .prepare(
        `SELECT agent_id, workspace_id, token_type, revoked
           FROM oauth_tokens WHERE token_hash = ?`,
      )
      .get(sha256Hex(access_token)) as
      | {
          agent_id: string;
          workspace_id: string;
          token_type: string;
          revoked: number;
        }
      | undefined;
    expect(accessRow).toBeDefined();
    expect(accessRow!.token_type).toBe("access");
    expect(accessRow!.agent_id).toBe(STEWARD_A_ID);
    expect(accessRow!.workspace_id).toBe(WS_A_ID);
    expect(accessRow!.revoked).toBe(0);

    const refreshRow = db
      .prepare(
        `SELECT agent_id, workspace_id, token_type FROM oauth_tokens WHERE token_hash = ?`,
      )
      .get(sha256Hex(refresh_token)) as
      | { agent_id: string; workspace_id: string; token_type: string }
      | undefined;
    expect(refreshRow?.agent_id).toBe(STEWARD_A_ID);
    expect(refreshRow?.workspace_id).toBe(WS_A_ID);
    expect(refreshRow?.token_type).toBe("refresh");

    // Negative: no token leaked into workspace B.
    const wsBLeak = db
      .prepare(
        `SELECT COUNT(*) AS n FROM oauth_tokens WHERE workspace_id = ? AND client_id = ?`,
      )
      .get(WS_B_ID, client_id) as { n: number };
    expect(wsBLeak.n).toBe(0);
  });
});

describe("ADR-017 e2e: cross-workspace cookie cannot mint a token", () => {
  test("approve POST with B's Bearer against A's ticket → 403; no token row exists", async () => {
    const { client_id } = await registerClient(
      STEWARD_A_KEY,
      "e2e-cross-workspace",
    );
    const { challenge } = pkce();
    const ticketId = await startAuthorize(client_id, challenge);

    // Render the consent UI as A only to obtain a fresh nonce. (B's
    // Bearer would render the wrong-workspace HTML and not produce a
    // nonce — that is itself part of the bridge contract, exercised in
    // oauth-consent-bridge.test.ts.)
    const nonce = await getNonce(ticketId, STEWARD_A_KEY);

    const r = await approve(ticketId, nonce, STEWARD_B_KEY);
    expect(r.status).toBe(403);

    // Ticket never approved.
    const ticketRow = db
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
    expect(ticketRow?.approved_by_agent_id).toBeNull();
    expect(ticketRow?.redeemed).toBe(0);
    expect(ticketRow?.denied).toBe(0);

    // No code, no access, no refresh row for this client at all.
    const minted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ?`,
      )
      .get(client_id) as { n: number };
    expect(minted.n).toBe(0);
  });
});
