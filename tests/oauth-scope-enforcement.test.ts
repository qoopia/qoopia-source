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
import { createNote } from "../src/services/notes.ts";
import { startHttpServer } from "../src/http.ts";
import { db } from "../src/db/connection.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import { authLimiter, dashboardLimiter } from "../src/utils/rate-limit.ts";

let server: Server;
let baseUrl = "";

let WORKSPACE_ID = "";
let STEWARD_ID = "";
let STEWARD_KEY = "";
let STANDARD_KEY = "";
let CLIENT_ID = "";

const REDIRECT_URI = "https://example.com/cb-oauth-scope";

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

async function registerClient(): Promise<string> {
  const r = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${STEWARD_KEY}`,
    },
    body: JSON.stringify({
      client_name: "oauth-scope-client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(r.status).toBe(201);
  const json = (await r.json()) as { client_id: string };
  return json.client_id;
}

async function startAuthorize(scope = ""): Promise<{ ticketId: string; challenge: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "scope-e2e");
  if (scope) url.searchParams.set("scope", scope);
  const r = await fetch(url.toString(), { redirect: "manual" });
  expect(r.status).toBe(302);
  const loc = r.headers.get("location") || "";
  const ticketId = new URL(loc, baseUrl).searchParams.get("ticket") || "";
  expect(ticketId).toMatch(/^qct_/);
  return { ticketId, challenge, verifier };
}

async function getConsent(ticketId: string, bearer: string): Promise<Response> {
  return fetch(
    `${baseUrl}/api/dashboard/oauth-consent?ticket=${encodeURIComponent(ticketId)}`,
    {
      headers: { authorization: `Bearer ${bearer}` },
      redirect: "manual",
    },
  );
}

function extractNonce(html: string): string {
  const m = html.match(/name="nonce" value="([^"]+)"/);
  expect(m).not.toBeNull();
  return m![1]!;
}

async function approve(ticketId: string, nonce: string, bearer: string): Promise<Response> {
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

async function finalize(ticketId: string): Promise<string> {
  const r = await fetch(
    `${baseUrl}/oauth/authorize/finalize?ticket=${encodeURIComponent(ticketId)}`,
    { redirect: "manual" },
  );
  expect(r.status).toBe(302);
  const code = new URL(r.headers.get("location")!).searchParams.get("code") || "";
  expect(code).toMatch(/^qc_/);
  return code;
}

async function exchange(
  code: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token: string; scope?: string }> {
  const r = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    }).toString(),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as {
    access_token: string;
    refresh_token: string;
    scope?: string;
  };
}

async function issueToken(scope = ""): Promise<{
  accessToken: string;
  refreshToken: string;
  scope?: string;
}> {
  const { ticketId, verifier } = await startAuthorize(scope);
  const ui = await getConsent(ticketId, STEWARD_KEY);
  expect(ui.status).toBe(200);
  const nonce = extractNonce(await ui.text());
  const approval = await approve(ticketId, nonce, STEWARD_KEY);
  expect(approval.status).toBe(302);
  const code = await finalize(ticketId);
  const exchanged = await exchange(code, verifier);
  return {
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token,
    scope: exchanged.scope,
  };
}

async function mcpList(accessToken: string, profile?: "full"): Promise<string[]> {
  const r = await fetch(`${baseUrl}/mcp${profile ? "?profile=full" : ""}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(r.status).toBe(200);
  const json = await parseMcpResponse(r) as {
    result?: { tools?: Array<{ name?: string }> };
  };
  return (json.result?.tools || [])
    .map((tool) => tool.name || "")
    .filter(Boolean);
}

async function mcpCall(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  profile?: "full",
): Promise<unknown> {
  const r = await fetch(`${baseUrl}/mcp${profile ? "?profile=full" : ""}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(r.status).toBe(200);
  return parseMcpResponse(r);
}

async function parseMcpResponse(r: Response): Promise<unknown> {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {}

  const frames = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
  for (let i = frames.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(frames[i]!);
    } catch {
      // keep scanning older frames
    }
  }
  throw new Error(`Unable to parse MCP response: ${text}`);
}

function mintLegacyAccessToken(): string {
  const access = `qa_${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const exp = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  db.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, client_id, agent_id, workspace_id, token_type, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 'access', ?, 0, ?)`,
  ).run(
    sha256Hex(access),
    CLIENT_ID,
    STEWARD_ID,
    WORKSPACE_ID,
    exp,
    now,
  );
  return access;
}

beforeAll(async () => {
  runMigrations();
  const ws = createWorkspace({
    name: "OAuth Scope WS",
    slug: "oauth-scope-ws",
  });
  WORKSPACE_ID = ws.id;
  const steward = createAgent({
    name: "oauth-scope-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  });
  STEWARD_ID = steward.id;
  STEWARD_KEY = steward.api_key;
  const standard = createAgent({
    name: "oauth-scope-standard",
    workspaceSlug: ws.slug,
    type: "standard",
  });
  STANDARD_KEY = standard.api_key;

  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  CLIENT_ID = await registerClient();
});

beforeEach(() => {
  authLimiter.resetForTests();
  dashboardLimiter.resetForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("OAuth scope validation + persistence", () => {
  test("unknown scope is rejected at /oauth/authorize", async () => {
    const { verifier, challenge } = pkce();
    const url = new URL(`${baseUrl}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "mcp:read totally:unknown");
    url.searchParams.set("state", verifier);
    const r = await fetch(url.toString(), { redirect: "manual" });
    expect(r.status).toBe(400);
    const body = await r.json() as { error?: string };
    expect(body.error).toBe("invalid_scope");
  });

  test("normalized scope is shown on consent and copied into code/access/refresh rows", async () => {
    const { ticketId, verifier } = await startAuthorize("mcp:write mcp:read mcp:read");
    const ui = await getConsent(ticketId, STEWARD_KEY);
    expect(ui.status).toBe(200);
    const html = await ui.text();
    expect(html).toContain("mcp:read");
    expect(html).toContain("mcp:write");
    const nonce = extractNonce(html);

    const approval = await approve(ticketId, nonce, STEWARD_KEY);
    expect(approval.status).toBe(302);
    const code = await finalize(ticketId);
    const exchanged = await exchange(code, verifier);
    expect(exchanged.scope).toBe("mcp:read mcp:write");

    const codeRow = db
      .prepare(`SELECT granted_scope FROM oauth_tokens WHERE token_hash = ?`)
      .get(sha256Hex(code)) as { granted_scope: string } | undefined;
    const accessRow = db
      .prepare(`SELECT granted_scope FROM oauth_tokens WHERE token_hash = ?`)
      .get(sha256Hex(exchanged.access_token)) as { granted_scope: string } | undefined;
    const refreshRow = db
      .prepare(`SELECT granted_scope FROM oauth_tokens WHERE token_hash = ?`)
      .get(sha256Hex(exchanged.refresh_token)) as { granted_scope: string } | undefined;
    expect(codeRow?.granted_scope).toBe("mcp:read mcp:write");
    expect(accessRow?.granted_scope).toBe("mcp:read mcp:write");
    expect(refreshRow?.granted_scope).toBe("mcp:read mcp:write");
  });
});

describe("OAuth scope enforcement at MCP", () => {
  test("migrated principals keep the legacy /mcp surface with API keys and OAuth, without widening token scope", async () => {
    const previous=(db.query("SELECT legacy_skill_access AS n FROM agents WHERE id=?").get(STEWARD_ID) as {n:number}).n;
    try {
      db.query("UPDATE agents SET legacy_skill_access=0 WHERE id=?").run(STEWARD_ID);
      expect(await mcpList(STEWARD_KEY)).not.toContain("agent_status");
      db.query("UPDATE agents SET legacy_skill_access=1 WHERE id=?").run(STEWARD_ID);
      const names=await mcpList(STEWARD_KEY);
      expect(names).toContain("agent_status");expect(names).toContain("agent_send");
      expect(await mcpCall(STEWARD_KEY,"agent_status",{})).toHaveProperty("result");
      const {accessToken}=await issueToken("mcp:read");
      const scoped=await mcpList(accessToken);
      expect(scoped).toContain("agent_status");expect(scoped).not.toContain("agent_send");
      expect(await mcpCall(accessToken,"agent_status",{})).toHaveProperty("result");
      db.query("UPDATE agents SET legacy_skill_access=0 WHERE id=?").run(STEWARD_ID);
      expect(await mcpList(STEWARD_KEY)).not.toContain("agent_status");
    } finally {db.query("UPDATE agents SET legacy_skill_access=? WHERE id=?").run(previous,STEWARD_ID);}
  });

  test("mcp:read token cannot create notes", async () => {
    const { accessToken, scope } = await issueToken("mcp:read");
    expect(scope).toBe("mcp:read");

    const tools = await mcpList(accessToken, "full");
    expect(tools).toContain("recall");
    expect(tools).not.toContain("note_create");
    expect(tools).not.toContain("note_delete");
    expect(tools).not.toContain("agent_set_profile");

    const marker = `scope-read-block-${Date.now()}`;
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM notes WHERE text = ?`)
      .get(marker) as { n: number };

    const reply = await mcpCall(accessToken, "note_create", { text: marker }, "full");
    expect(JSON.stringify(reply).toLowerCase()).toMatch(/forbidden|not found|unknown/);

    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM notes WHERE text = ?`)
      .get(marker) as { n: number };
    expect(after.n).toBe(before.n);
  });

  test("mcp:write token cannot run destructive/admin tools", async () => {
    const { accessToken, scope } = await issueToken("mcp:write");
    expect(scope).toBe("mcp:write");

    const tools = await mcpList(accessToken, "full");
    expect(tools).toContain("note_create");
    expect(tools).toContain("session_save");
    expect(tools).not.toContain("note_delete");
    expect(tools).not.toContain("agent_set_profile");

    const note = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: STEWARD_ID,
      text: `scope-write-delete-${Date.now()}`,
    });
    const reply = await mcpCall(accessToken, "note_delete", { id: note.id }, "full");
    expect(JSON.stringify(reply).toLowerCase()).toMatch(/forbidden|not found|unknown/);

    const row = db
      .prepare(`SELECT deleted_at FROM notes WHERE id = ?`)
      .get(note.id) as { deleted_at: string | null } | undefined;
    expect(row?.deleted_at).toBeNull();
  });

  test("legacy token without granted_scope falls back to the agent tool_profile", async () => {
    const legacyToken = mintLegacyAccessToken();
    // Existing principals retain their old surface without changing the URL.
    // The full profile still cannot bypass OAuth grants/current DB policy.
    const bootstrap = await mcpList(legacyToken);
    expect(bootstrap).toContain("note_delete");
    expect(bootstrap).toContain("agent_set_profile");
    const tools = await mcpList(legacyToken, "full");
    expect(tools).toContain("note_delete");
    expect(tools).toContain("agent_set_profile");
    const note = createNote({ workspace_id: WORKSPACE_ID, agent_id: STEWARD_ID, text: "legacy scope delete fixture" });
    const reply = await mcpCall(legacyToken, "note_delete", { id: note.id }, "full") as { result?: { isError?: boolean } };
    expect(reply.result).toBeDefined();
    expect(reply.result?.isError).not.toBe(true);
    expect((db.prepare("SELECT deleted_at FROM notes WHERE id=?").get(note.id) as { deleted_at: string | null }).deleted_at).not.toBeNull();
    const kept = createNote({ workspace_id: WORKSPACE_ID, agent_id: STEWARD_ID, text: "legacy scope protected fixture" });
    try {
      db.prepare("UPDATE agents SET tool_profile='read-only' WHERE id=?").run(STEWARD_ID);
      const demoted = await mcpList(legacyToken, "full");
      expect(demoted).toContain("note_get");
      expect(demoted).not.toContain("note_delete");
      expect(demoted).not.toContain("agent_set_profile");
      const denied = await mcpCall(legacyToken, "note_delete", { id: kept.id }, "full");
      expect(JSON.stringify(denied).toLowerCase()).toMatch(/forbidden|not found|unknown/);
      expect((db.prepare("SELECT deleted_at FROM notes WHERE id=?").get(kept.id) as { deleted_at: string | null }).deleted_at).toBeNull();
    } finally {
      db.prepare("UPDATE agents SET tool_profile='full' WHERE id=?").run(STEWARD_ID);
    }
  });
});

describe("OAuth consent gate", () => {
  test("mcp:admin request cannot be approved by a standard agent", async () => {
    const { ticketId } = await startAuthorize("mcp:admin");
    const r = await getConsent(ticketId, STANDARD_KEY);
    expect(r.status).toBe(403);
    const body = await r.json() as { error?: string; error_description?: string };
    expect(body.error).toBe("forbidden");
    expect(body.error_description || "").toContain("steward or claude-privileged");
  });
});
