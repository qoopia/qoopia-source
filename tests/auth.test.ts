/**
 * Authentication tests — exercise the API-key path of authenticate().
 * Validates that valid Bearer tokens resolve to the correct agent context
 * and that bogus / missing / inactive tokens are rejected.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { authenticate } from "../src/auth/middleware.ts";
import { db } from "../src/db/connection.ts";
import { generateApiKey } from "../src/auth/api-keys.ts";
import { getClient } from "../src/auth/oauth.ts";
import { logger } from "../src/utils/logger.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";
let API_KEY = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Auth Test", slug: "auth-test" });
  WORKSPACE_ID = ws.id;
  const ag = createAgent({ name: "auth-tester", workspaceSlug: ws.slug });
  AGENT_ID = ag.id;
  API_KEY = ag.api_key;
});

function withBearer(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request("http://local/", { headers });
}

describe("authenticate (API key)", () => {
  test("resolves a valid Bearer token to the correct agent context", () => {
    const ctx = authenticate(withBearer(API_KEY));
    expect(ctx).not.toBeNull();
    expect(ctx?.agent_id).toBe(AGENT_ID);
    expect(ctx?.workspace_id).toBe(WORKSPACE_ID);
    expect(ctx?.agent_name).toBe("auth-tester");
    expect(ctx?.source).toBe("api-key");
  });

  test("rejects requests without an Authorization header", () => {
    expect(authenticate(withBearer(null))).toBeNull();
  });

  test("rejects malformed Authorization header", () => {
    const req = new Request("http://local/", {
      headers: { authorization: "NotBearer something" },
    });
    expect(authenticate(req)).toBeNull();
  });

  test("rejects an unknown but well-formed key", () => {
    const fake = generateApiKey();
    expect(authenticate(withBearer(fake))).toBeNull();
  });

  test("rejects a key that belongs to a deactivated agent", () => {
    db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(AGENT_ID);
    expect(authenticate(withBearer(API_KEY))).toBeNull();
    // Restore for any other tests in this file (none yet, but defensive).
    db.prepare(`UPDATE agents SET active = 1 WHERE id = ?`).run(AGENT_ID);
  });

  test("trims whitespace around Bearer token", () => {
    const req = new Request("http://local/", {
      headers: { authorization: `Bearer   ${API_KEY}   ` },
    });
    const ctx = authenticate(req);
    expect(ctx?.agent_id).toBe(AGENT_ID);
  });
});

test("a client whose stored redirect_uris cannot be parsed is refused and logged [F-057]", () => {
  db.prepare(`INSERT INTO oauth_clients (id, name, agent_id, workspace_id, client_secret_hash, redirect_uris, created_at)
    VALUES ('qc_corrupt', 'Corrupt', ?, ?, '', 'not json', datetime('now'))`).run(AGENT_ID, WORKSPACE_ID);
  const warn = spyOn(logger, "warn");
  try {
    expect(getClient("qc_corrupt")?.redirect_uris).toEqual([]);
    expect(warn.mock.calls.map(([message, context]) => [message, context])).toEqual([
      ["OAuth client has unparseable redirect_uris; every redirect will be refused", { client_id: "qc_corrupt" }],
    ]);
  } finally { warn.mockRestore(); }
});
