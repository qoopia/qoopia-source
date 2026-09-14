/**
 * QSA-C / Codex QSA-002 regression: V2 compat 'create activity' must be
 * admin-only.
 *
 * Audit finding: any full-profile MCP agent could call the V2 compat 'create'
 * tool with entity='activity' and forge audit-log rows (arbitrary action,
 * entity_type, entity_id, summary, details). That destroys the integrity of
 * the activity log as an audit trail.
 *
 * Fix: standard agents now get FORBIDDEN; only steward / claude-privileged
 * may emit activity through this path.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { AuthContext } from "../src/auth/middleware.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { v2Create } from "../src/mcp/compat.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let WORKSPACE_ID = "";
let STD_AGENT_ID = "";
let STEWARD_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Compat Forgery", slug: "compat-forgery" });
  WORKSPACE_ID = ws.id;
  STD_AGENT_ID = createAgent({
    name: "compat-std",
    workspaceSlug: ws.slug,
  }).id;
  STEWARD_ID = createAgent({
    name: "compat-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  }).id;
});

function mkAuth(agent_id: string, type: AuthContext["type"]): AuthContext {
  return {
    agent_id,
    agent_name: type === "steward" ? "compat-steward" : "compat-std",
    workspace_id: WORKSPACE_ID,
    type,
    source: "api-key",
    // QSA-F (2026-04-28): activity forging now requires profile='full' in
    // addition to admin type. Production stewards default to 'full' via
    // the agents table column (migration 010), so this matches reality.
    tool_profile: "full",
  };
}

describe("QSA-C: V2 compat 'create activity' admin gate", () => {
  test("standard agent — FORBIDDEN", () => {
    expect(() =>
      v2Create(
        {
          entity: "activity",
          action: "forged_action",
          entity_type: "note",
          summary: "should not land",
        },
        mkAuth(STD_AGENT_ID, "standard"),
      ),
    ).toThrow(QoopiaError);

    // Confirm no row was written under the standard agent.
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM activity WHERE workspace_id = ? AND agent_id = ? AND summary = ?",
      )
      .get(WORKSPACE_ID, STD_AGENT_ID, "should not land") as { c: number };
    expect(row.c).toBe(0);
  });

  test("steward — allowed (audit operations preserved)", () => {
    const result = v2Create(
      {
        entity: "activity",
        action: "manual_audit",
        entity_type: "note",
        summary: "steward audit row",
      },
      mkAuth(STEWARD_ID, "steward"),
    ) as { created: boolean; id: string };
    expect(result.created).toBe(true);
    expect(typeof result.id).toBe("string");

    const row = db
      .prepare(
        "SELECT summary FROM activity WHERE workspace_id = ? AND agent_id = ? AND id = ?",
      )
      .get(WORKSPACE_ID, STEWARD_ID, result.id) as
      | { summary: string }
      | undefined;
    expect(row?.summary).toBe("steward audit row");
  });

  test("claude-privileged — allowed", () => {
    const cp = createAgent({
      name: "compat-claude-priv",
      workspaceSlug: "compat-forgery",
      type: "claude-privileged",
    });
    const result = v2Create(
      {
        entity: "activity",
        action: "manual_audit",
        entity_type: "note",
        summary: "claude-priv audit row",
      },
      mkAuth(cp.id, "claude-privileged"),
    ) as { created: boolean; id: string };
    expect(result.created).toBe(true);
  });

  test("QSA-F: admin-capable agent on no-destructive profile cannot forge activity", () => {
    const auth: AuthContext = {
      agent_id: STEWARD_ID,
      agent_name: "compat-steward",
      workspace_id: WORKSPACE_ID,
      type: "steward",
      source: "api-key",
      tool_profile: "no-destructive",
    };
    expect(() =>
      v2Create(
        {
          entity: "activity",
          action: "stealth",
          entity_type: "note",
          summary: "should not land",
        },
        auth,
      ),
    ).toThrow(/only 'full' profile may write to the audit log/);
  });

  test("QSA-F: read-only profile cannot forge activity even if admin type", () => {
    const auth: AuthContext = {
      agent_id: STEWARD_ID,
      agent_name: "compat-steward",
      workspace_id: WORKSPACE_ID,
      type: "steward",
      source: "api-key",
      tool_profile: "read-only",
    };
    expect(() =>
      v2Create({ entity: "activity", action: "x", summary: "y" }, auth),
    ).toThrow(QoopiaError);
  });

  test("error code is FORBIDDEN with explanatory message", () => {
    try {
      v2Create(
        { entity: "activity", action: "x", summary: "y" },
        mkAuth(STD_AGENT_ID, "standard"),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QoopiaError);
      const e = err as QoopiaError;
      expect(e.code).toBe("FORBIDDEN");
      expect(e.message).toMatch(/admin-only/);
    }
  });
});
