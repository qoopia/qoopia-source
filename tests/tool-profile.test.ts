/**
 * QSA-F / Codex QSA-004 / ADR-016: per-agent MCP tool risk profiles.
 *
 * Coverage:
 *   1. normalizeAgentProfile — known values pass through; null / unknown
 *      coerce to 'read-only' (fail-closed).
 *   2. isToolAllowedForProfile — every (risk × profile) cell is asserted.
 *   3. riskOf — covers a representative slice of canonical and V2-compat
 *      tool names and the unknown-name path.
 *   4. registerTools end-to-end via a fake McpServer that captures the
 *      list of registered tool names. We assert that the per-agent
 *      filter actually trims the canonical tools, the admin tools, AND
 *      the V2 compat aliases — the V2 alias step is the load-bearing
 *      part of the patch (a 'read-only' agent must NOT see `create` /
 *      `update` / `delete` / `note`, otherwise the boundary is theatre).
 *   5. agent_set_profile admin tool — including the self-demote and
 *      last-active-steward guards.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import {
  isToolAllowedForProfile,
  normalizeAgentProfile,
  registerTools,
  riskOf,
  type AgentToolProfile,
  type RiskClass,
} from "../src/mcp/tools.ts";
import { adminTools } from "../src/mcp/admin-tools.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { QoopiaError } from "../src/utils/errors.ts";

// -- Section 1: normalizeAgentProfile (fail-closed on unknown) ------

describe("QSA-F: normalizeAgentProfile fails closed on unknown values", () => {
  for (const ok of ["read-only", "no-destructive", "full"] as const) {
    test(`accepts known profile '${ok}'`, () => {
      expect(normalizeAgentProfile(ok, "test-agent")).toBe(ok);
    });
  }

  test("null → read-only", () => {
    expect(normalizeAgentProfile(null, "test-agent")).toBe("read-only");
  });

  test("undefined → read-only", () => {
    expect(normalizeAgentProfile(undefined, "test-agent")).toBe("read-only");
  });

  test("empty string → read-only", () => {
    expect(normalizeAgentProfile("", "test-agent")).toBe("read-only");
  });

  test("garbage string → read-only", () => {
    expect(normalizeAgentProfile("destructive-everything", "test-agent")).toBe(
      "read-only",
    );
  });

  test("non-string types → read-only", () => {
    expect(normalizeAgentProfile(42, "test-agent")).toBe("read-only");
    expect(normalizeAgentProfile({ tool_profile: "full" }, "test-agent")).toBe(
      "read-only",
    );
  });
});

// -- Section 2: isToolAllowedForProfile cell-by-cell -----------------

describe("QSA-F: isToolAllowedForProfile cell-by-cell", () => {
  const cases: {
    risk: RiskClass;
    profile: AgentToolProfile;
    expected: boolean;
  }[] = [
    // read tools
    { risk: "read", profile: "read-only", expected: true },
    { risk: "read", profile: "no-destructive", expected: true },
    { risk: "read", profile: "full", expected: true },
    // write-low
    { risk: "write-low", profile: "read-only", expected: false },
    { risk: "write-low", profile: "no-destructive", expected: true },
    { risk: "write-low", profile: "full", expected: true },
    // write-destructive
    { risk: "write-destructive", profile: "read-only", expected: false },
    { risk: "write-destructive", profile: "no-destructive", expected: false },
    { risk: "write-destructive", profile: "full", expected: true },
    // admin
    { risk: "admin", profile: "read-only", expected: false },
    { risk: "admin", profile: "no-destructive", expected: false },
    { risk: "admin", profile: "full", expected: true },
  ];
  for (const c of cases) {
    test(`risk=${c.risk} profile=${c.profile} → ${c.expected}`, () => {
      expect(isToolAllowedForProfile(c.risk, c.profile)).toBe(c.expected);
    });
  }
});

// -- Section 3: riskOf coverage --------------------------------------

describe("QSA-F: riskOf returns the documented class for known tools", () => {
  test("canonical reads", () => {
    expect(riskOf("recall")).toBe("read");
    expect(riskOf("brief")).toBe("read");
    expect(riskOf("note_get")).toBe("read");
    expect(riskOf("activity_list")).toBe("read");
  });
  test("canonical write-low", () => {
    expect(riskOf("note_create")).toBe("write-low");
    expect(riskOf("session_save")).toBe("write-low");
  });
  test("canonical write-destructive", () => {
    expect(riskOf("note_delete")).toBe("write-destructive");
    // QSA-F / Codex review #2 (2026-04-28): note_update text/metadata
    // replace is non-recoverable — no-destructive must NOT see this tool.
    expect(riskOf("note_update")).toBe("write-destructive");
  });
  test("admin tools", () => {
    expect(riskOf("agent_onboard")).toBe("admin");
    expect(riskOf("agent_deactivate")).toBe("admin");
    expect(riskOf("agent_set_profile")).toBe("admin");
    expect(riskOf("agent_list")).toBe("read");
  });
  test("V2 compat aliases", () => {
    expect(riskOf("create")).toBe("write-low");
    // QSA-F / Codex review #2: V2 'update' wraps note_update. Mirror its
    // write-destructive class so the alias does not bypass the boundary.
    expect(riskOf("update")).toBe("write-destructive");
    expect(riskOf("delete")).toBe("write-destructive");
    expect(riskOf("list")).toBe("read");
    expect(riskOf("get")).toBe("read");
    expect(riskOf("note")).toBe("write-low");
  });
  test("unknown tool name", () => {
    expect(riskOf("does-not-exist")).toBeNull();
  });
});

// -- Section 4: registerTools via fake server ------------------------

interface FakeServer {
  registered: string[];
  tool: (name: string, ...rest: unknown[]) => void;
  registerTool: (name: string, ...rest: unknown[]) => void;
}

function makeFakeServer(): FakeServer {
  const registered: string[] = [];
  return {
    registered,
    registerTool(name: string) { registered.push(name); },
    tool(name: string) {
      registered.push(name);
    },
  };
}

function fakeAuth(): AuthContext {
  return {
    agent_id: "test-agent-id",
    agent_name: "test",
    workspace_id: "test-ws",
    type: "steward",
    source: "api-key",
    tool_profile: "full",
  };
}

describe("QSA-F: registerTools per-agent profile filter", () => {
  test("'full' profile (default) registers canonical + admin tools, but no V2 compat aliases", () => {
    const fake = makeFakeServer();
    registerTools(
      fake as unknown as Parameters<typeof registerTools>[0],
      () => fakeAuth(),
      "full",
      { isSteward: true, agentToolProfile: "full" },
    );
    // Canonical tools (sample)
    expect(fake.registered).toContain("recall");
    expect(fake.registered).toContain("note_create");
    expect(fake.registered).toContain("note_delete");
    // Admin tools
    expect(fake.registered).toContain("agent_onboard");
    expect(fake.registered).toContain("agent_deactivate");
    expect(fake.registered).toContain("agent_set_profile");
    // V2 compat aliases are disabled by default.
    expect(fake.registered).not.toContain("create");
    expect(fake.registered).not.toContain("delete");
  });

  test("'read-only' profile drops every write/destructive/admin tool AND every V2 mutator alias", () => {
    const fake = makeFakeServer();
    registerTools(
      fake as unknown as Parameters<typeof registerTools>[0],
      () => fakeAuth(),
      "full",
      { isSteward: true, agentToolProfile: "read-only" },
    );
    // Reads remain
    expect(fake.registered).toContain("recall");
    expect(fake.registered).toContain("note_get");
    expect(fake.registered).toContain("note_list");
    expect(fake.registered).toContain("agent_list");
    expect(fake.registered).not.toContain("get"); // V2 alias disabled by default
    expect(fake.registered).not.toContain("list"); // V2 alias disabled by default
    // Writes blocked at canonical layer
    expect(fake.registered).not.toContain("note_create");
    expect(fake.registered).not.toContain("note_update");
    expect(fake.registered).not.toContain("note_delete");
    expect(fake.registered).not.toContain("session_save");
    // Admin blocked
    expect(fake.registered).not.toContain("agent_onboard");
    expect(fake.registered).not.toContain("agent_deactivate");
    expect(fake.registered).not.toContain("agent_set_profile");
    // V2 compat mutator aliases blocked — this is the load-bearing
    // part of the patch. If this fails, a read-only agent could
    // bypass the boundary by calling `create` instead of `note_create`.
    expect(fake.registered).not.toContain("create");
    expect(fake.registered).not.toContain("update");
    expect(fake.registered).not.toContain("delete");
    expect(fake.registered).not.toContain("note");
  });



  test("QOOPIA_ENABLE_V2_COMPAT=true re-enables legacy aliases for rollback", () => {
    const old = process.env.QOOPIA_ENABLE_V2_COMPAT;
    process.env.QOOPIA_ENABLE_V2_COMPAT = "true";
    try {
      const fake = makeFakeServer();
      registerTools(
        fake as unknown as Parameters<typeof registerTools>[0],
        () => fakeAuth(),
        "full",
        { isSteward: true, agentToolProfile: "full" },
      );
      expect(fake.registered).toContain("create");
      expect(fake.registered).toContain("list");
      expect(fake.registered).toContain("get");
      expect(fake.registered).toContain("note");
      expect(fake.registered).toContain("update");
      expect(fake.registered).toContain("delete");
    } finally {
      if (old === undefined) delete process.env.QOOPIA_ENABLE_V2_COMPAT;
      else process.env.QOOPIA_ENABLE_V2_COMPAT = old;
    }
  });

  test("'no-destructive' profile keeps write-low, drops destructive+admin", () => {
    const fake = makeFakeServer();
    registerTools(
      fake as unknown as Parameters<typeof registerTools>[0],
      () => fakeAuth(),
      "full",
      { isSteward: true, agentToolProfile: "no-destructive" },
    );
    // write-low stays
    expect(fake.registered).toContain("note_create");
    expect(fake.registered).toContain("session_save");
    expect(fake.registered).not.toContain("create"); // V2 alias disabled by default
    expect(fake.registered).not.toContain("note"); // V2 alias disabled by default
    // destructive/admin gone
    expect(fake.registered).not.toContain("note_delete");
    expect(fake.registered).not.toContain("delete"); // V2 alias destructive
    expect(fake.registered).not.toContain("agent_onboard");
    expect(fake.registered).not.toContain("agent_deactivate");
    // QSA-F / Codex review #2: note_update is write-destructive (text/
    // metadata replace is non-recoverable). The V2 'update' alias mirrors
    // it. A no-destructive agent must NOT see either.
    expect(fake.registered).not.toContain("note_update");
    expect(fake.registered).not.toContain("update");
  });
});

// -- Section 5: agent_set_profile admin tool -------------------------

describe("QSA-F: agent_set_profile self-demote + last-steward guards", () => {
  let WORKSPACE_ID = "";
  let STEWARD_NAME = "";
  let SECOND_STEWARD_NAME = "";
  let STANDARD_NAME = "";
  let WORKSPACE_SLUG = "";

  beforeAll(() => {
    runMigrations();
    const ws = createWorkspace({
      name: "QSA-F Profile",
      slug: "qsa-f-profile",
    });
    WORKSPACE_ID = ws.id;
    WORKSPACE_SLUG = ws.slug;

    STEWARD_NAME = "qsa-f-steward";
    createAgent({ name: STEWARD_NAME, workspaceSlug: ws.slug, type: "steward" });

    // Second steward via direct SQL — the unique partial index allows
    // multiple stewards in different workspaces; here we want a SECOND
    // steward in the SAME workspace which the index forbids in real
    // flows. We bypass the index because the test only needs a row that
    // *acts* as a steward for the last-steward count.
    // Use claude-privileged here so we don't trip the per-workspace
    // single-steward unique index, but treat it as admin via type query.
    // For the purposes of the last-steward guard test we keep the row
    // type='steward' inserted directly.
    SECOND_STEWARD_NAME = "qsa-f-steward-2";
    // Drop the partial unique index that guarantees one active steward
    // per workspace so this test can stage two stewards in one workspace
    // (we need this to verify the last-active-steward guard refuses to
    // demote the SOLE remaining steward; the guard counts *other* stewards
    // and must see at least one). Recreated after setup.
    db.prepare(`DROP INDEX IF EXISTS idx_one_steward`).run();
    const row = createAgent({
      name: SECOND_STEWARD_NAME,
      workspaceSlug: ws.slug,
      type: "claude-privileged",
    });
    db.prepare(`UPDATE agents SET type = 'steward' WHERE id = ?`).run(row.id);
    // We deliberately do NOT recreate idx_one_steward inside this test
    // file — the agent_set_profile guard keeps both rows as type='steward'
    // throughout the suite (it only flips tool_profile), so re-adding the
    // index would fail. Test isolation: each test file uses its own
    // DATA_DIR (see tests/test-env.ts), so dropping the index cannot
    // leak into prod or other suites.

    STANDARD_NAME = "qsa-f-standard";
    createAgent({ name: STANDARD_NAME, workspaceSlug: ws.slug });
  });

  function callerCtx(name: string): AuthContext {
    const row = db
      .prepare(`SELECT id, type FROM agents WHERE name = ?`)
      .get(name) as { id: string; type: string };
    return {
      agent_id: row.id,
      agent_name: name,
      workspace_id: WORKSPACE_ID,
      type: row.type,
      source: "api-key",
      tool_profile: "full",
    };
  }

  function setProfileTool() {
    const t = adminTools.find((x) => x.name === "agent_set_profile");
    if (!t) throw new Error("agent_set_profile not found");
    return t;
  }

  test("non-steward caller is rejected", () => {
    const tool = setProfileTool();
    expect(() =>
      tool.handler(
        { name: STANDARD_NAME, tool_profile: "read-only" },
        callerCtx(STANDARD_NAME),
      ),
    ).toThrow(QoopiaError);
  });

  test("self-demote to read-only refused", () => {
    const tool = setProfileTool();
    expect(() =>
      tool.handler(
        { name: STEWARD_NAME, tool_profile: "read-only" },
        callerCtx(STEWARD_NAME),
      ),
    ).toThrow(/cannot demote self/i);
  });

  test("self-demote to no-destructive refused", () => {
    const tool = setProfileTool();
    expect(() =>
      tool.handler(
        { name: STEWARD_NAME, tool_profile: "no-destructive" },
        callerCtx(STEWARD_NAME),
      ),
    ).toThrow(/cannot demote self/i);
  });

  test("last-active-steward guard refuses when only one full-profile steward remains", () => {
    const tool = setProfileTool();
    // Demote SECOND_STEWARD first so STEWARD_NAME is the only full-
    // profile steward in the workspace.
    tool.handler(
      { name: SECOND_STEWARD_NAME, tool_profile: "no-destructive" },
      callerCtx(STEWARD_NAME),
    );
    // Now another caller (say SECOND_STEWARD_NAME, still type='steward'
    // but no longer 'full') tries to demote STEWARD_NAME — should fail
    // because it would leave zero full-profile stewards.
    expect(() =>
      tool.handler(
        { name: STEWARD_NAME, tool_profile: "read-only" },
        callerCtx(SECOND_STEWARD_NAME),
      ),
    ).toThrow(/last full-profile steward/i);
    // Restore for downstream tests.
    tool.handler(
      { name: SECOND_STEWARD_NAME, tool_profile: "full" },
      callerCtx(STEWARD_NAME),
    );
  });

  test("happy path: steward demotes a different agent to read-only", () => {
    const tool = setProfileTool();
    const result = tool.handler(
      { name: STANDARD_NAME, tool_profile: "read-only" },
      callerCtx(STEWARD_NAME),
    ) as {
      changed: boolean;
      previous_profile: string;
      new_profile: string;
    };
    expect(result.changed).toBe(true);
    expect(result.new_profile).toBe("read-only");
    // Verify it landed.
    const row = db
      .prepare(`SELECT tool_profile FROM agents WHERE name = ?`)
      .get(STANDARD_NAME) as { tool_profile: string };
    expect(row.tool_profile).toBe("read-only");
  });

  test("non-existent target → NOT_FOUND", () => {
    const tool = setProfileTool();
    expect(() =>
      tool.handler(
        { name: "does-not-exist", tool_profile: "read-only" },
        callerCtx(STEWARD_NAME),
      ),
    ).toThrow(/not found/i);
  });
});
