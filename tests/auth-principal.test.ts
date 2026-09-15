/**
 * Unit cover for the shared principal helpers.
 *
 * assertWriteScope used to exist as five copies. Four demanded mcp:write
 * outright; the fifth also accepted mcp:admin. The MCP dispatcher gates every
 * tool through grantedScopeAllowsRisk first, and that helper treats mcp:admin
 * as covering write-low — so the four strict copies could refuse a call the
 * dispatcher had already allowed. These tests pin the resolved behaviour.
 */
import { describe, expect, test } from "bun:test";
import type { AuthContext } from "../src/auth/middleware.ts";
import { ADMIN_TYPES, isAdmin, assertWriteScope } from "../src/auth/principal.ts";

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    agent_id: "agent-1",
    workspace_id: "ws-1",
    agent_name: "tester",
    type: "standard",
    source: "api-key",
    ...over,
  } as AuthContext;
}

describe("isAdmin", () => {
  test("recognises exactly owner, steward and claude-privileged", () => {
    expect([...ADMIN_TYPES].sort()).toEqual(["claude-privileged", "owner", "steward"]);
    for (const type of ["owner", "steward", "claude-privileged"] as const) {
      expect(isAdmin(auth({ type }))).toBe(true);
    }
    expect(isAdmin(auth({ type: "standard" }))).toBe(false);
    expect(isAdmin(auth({ type: "ingest-daemon" }))).toBe(false);
  });
});

describe("assertWriteScope", () => {
  test("lets an api-key caller through: scope is not its authority model", () => {
    expect(() => assertWriteScope(auth({ source: "api-key" }))).not.toThrow();
  });

  test("accepts an OAuth caller holding mcp:write", () => {
    expect(() =>
      assertWriteScope(auth({ source: "oauth", granted_scope: ["mcp:write"] })),
    ).not.toThrow();
  });

  // The divergence this refactor resolved: mcp:admin outranks mcp:write, and
  // the dispatcher already admits it, so the service layer must not refuse it.
  test("accepts an OAuth caller holding only mcp:admin", () => {
    expect(() =>
      assertWriteScope(auth({ source: "oauth", granted_scope: ["mcp:admin"] })),
    ).not.toThrow();
  });

  test("refuses an OAuth caller holding only mcp:read", () => {
    expect(() =>
      assertWriteScope(auth({ source: "oauth", granted_scope: ["mcp:read"] })),
    ).toThrow(/mcp:write scope is required/);
  });

  test("refuses an OAuth token that was granted nothing", () => {
    expect(() =>
      assertWriteScope(auth({ source: "oauth", granted_scope: [] })),
    ).toThrow(/mcp:write scope is required/);
  });

  test("lets a legacy unscoped OAuth token through, as the risk gate does", () => {
    expect(() =>
      assertWriteScope(auth({ source: "oauth", granted_scope: undefined })),
    ).not.toThrow();
  });
});
