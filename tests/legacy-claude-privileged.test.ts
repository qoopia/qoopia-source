// ADR-020: 'claude-privileged' is no category. An existing row is an ordinary agent everywhere;
// management rights belong to the steward and the owner; new agents cannot be created with that type.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, setAgentType } from "../src/admin/agents.ts";
import { ADMIN_TYPES, isAdmin } from "../src/auth/principal.ts";
import { assertCanRegisterOAuth, registerClient } from "../src/auth/oauth.ts";
import { v2Create } from "../src/mcp/compat.ts";
import { startHttpServer } from "../src/http.ts";
import { authLimiter, dashboardLimiter } from "../src/utils/rate-limit.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { legacyPrivilegedAgent } from "./helpers/legacy-agent.ts";

const REDIRECT_URI = "https://example.com/cb-legacy-privileged";
let server: Server, base = "", slug = "", ws = "";
let legacy = { id: "", api_key: "" }, steward = { id: "", api_key: "" };

beforeAll(async () => {
  runMigrations();
  const w = createWorkspace({ name: "Legacy privileged", slug: "adr020-legacy-priv" });
  ws = w.id;
  slug = w.slug;
  legacy = legacyPrivilegedAgent("legacy-priv", slug);
  steward = createAgent({ name: "legacy-priv-steward", workspaceSlug: slug, type: "steward" });
  server = startHttpServer();
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  authLimiter.resetForTests();
  dashboardLimiter.resetForTests();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const legacyAuth = (): AuthContext => ({
  agent_id: legacy.id, agent_name: "legacy-priv", workspace_id: ws, type: "claude-privileged", source: "api-key", tool_profile: "full",
});

describe("no new claude-privileged agents", () => {
  test("create and set-type refuse it, naming the toggle and the steward", () => {
    expect(() => createAgent({ name: "new-priv", workspaceSlug: slug, type: "claude-privileged" as never })).toThrow(/shared context.*steward/i);
    expect(() => setAgentType("legacy-priv-steward", slug, "claude-privileged" as never)).toThrow(/shared context.*steward/i);
    expect(db.query("SELECT 1 FROM agents WHERE name = 'new-priv'").get()).toBeNull();
    expect((db.query("SELECT type FROM agents WHERE id = ?").get(steward.id) as { type: string }).type).toBe("steward");
  });
});

describe("an existing claude-privileged row is an ordinary agent", () => {
  test("no management rights: only the owner and the steward are admins", () => {
    expect([...ADMIN_TYPES].sort()).toEqual(["owner", "steward"]);
    expect(isAdmin(legacyAuth())).toBe(false);
    expect(() => assertCanRegisterOAuth(legacyAuth())).toThrow(/steward|owner/);
    expect(() => v2Create({ entity: "activity", action: "forged", entity_type: "note", summary: "legacy forged" }, legacyAuth())).toThrow(/admin-only/);
  });

  test("POST /oauth/register with its key → 403", async () => {
    const r = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${legacy.api_key}` },
      body: JSON.stringify({ client_name: "legacy", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    });
    expect(r.status).toBe(403);
  });

  test("dashboard login is not admin and the overview hides backup/ops health", async () => {
    const login = await fetch(`${base}/api/dashboard/login`, { method: "POST", headers: { authorization: `Bearer ${legacy.api_key}` } });
    expect(login.status).toBe(200);
    expect(((await login.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
    const overview = await fetch(`${base}/api/dashboard/overview`, { headers: { authorization: `Bearer ${legacy.api_key}` } });
    const health = ((await overview.json()) as { health: { verified_backup: { status: string }; operations: { status: string } } }).health;
    expect(health.verified_backup.status).toBe("owner_only");
    expect(health.operations.status).toBe("owner_only");
  });

  test("it cannot consent; the steward's approval binds the grant to the client's own agent, never the steward", async () => {
    // A grant bound to the claude-privileged agent, as the pre-V1 claude.ai DCR registers it.
    const { client_id } = registerClient({ client_name: "legacy-dcr", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }, legacyAuth());
    const authorize = new URL(`${base}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: REDIRECT_URI, code_challenge: "x".repeat(43), code_challenge_method: "S256" }))
      authorize.searchParams.set(k, v);
    const location = (await fetch(authorize, { redirect: "manual" })).headers.get("location") || "";
    const ticket = new URL(location, base).searchParams.get("ticket")!;
    expect(ticket).toBeTruthy();
    const consent = (key: string) => fetch(`${base}/api/dashboard/oauth-consent?ticket=${ticket}`, { headers: { authorization: `Bearer ${key}` }, redirect: "manual" });

    const denied = await consent(legacy.api_key);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error_description: string }).error_description).toMatch(/steward or the workspace owner/);

    const page = await consent(steward.api_key);
    expect(page.status).toBe(200);
    const nonce = (await page.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
    const approve = await fetch(`${base}/api/dashboard/oauth-consent/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${steward.api_key}` },
      body: new URLSearchParams({ ticket, nonce }).toString(),
    });
    expect(approve.status).toBe(302);
    expect(approve.headers.get("location")).toStartWith(REDIRECT_URI);
    const row = db.query("SELECT approved_by_agent_id FROM consent_tickets WHERE id = ?").get(ticket) as { approved_by_agent_id: string };
    expect(row.approved_by_agent_id).toBe(legacy.id);
  });
});
