/**
 * Migration 048: hot read paths probe an index instead of scanning the table.
 * The SQL is captured from the real service calls where they run against the
 * shared connection, then explained on the migrated test database.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { agentMemoryStatus } from "../src/services/memory-policy.ts";
import { agentInbox } from "../src/services/agent-comm.ts";
import { fileList, fileListByFolder, fileListFolders } from "../src/services/files.ts";

let WS = "", A = "", B = "";

const explain = (sql: string) => {
  const holes = (sql.match(/\?/g) ?? []).length;
  // Not db.query: a cached EXPLAIN of a write stays "in progress" and breaks the next COMMIT.
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return (statement.all(...(Array(holes).fill(null) as never[])) as Array<{ detail: string }>).map((r) => r.detail).join(" ; ");
  } finally {
    statement.finalize();
  }
};

/** Plans of every statement `run` prepares whose SQL matches `pick`. */
function plansOf(run: () => unknown, pick: RegExp): string[] {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db), query = db.query.bind(db);
  db.prepare = ((sql: string) => (seen.push(sql), prepare(sql))) as typeof db.prepare;
  db.query = ((sql: string) => (seen.push(sql), query(sql))) as typeof db.query;
  try { run(); } finally { db.prepare = prepare; db.query = query; }
  const plans = seen.filter((sql) => pick.test(sql)).map(explain);
  expect(plans.length).toBeGreaterThan(0);
  return plans;
}

beforeAll(() => {
  runMigrations();
  WS = createWorkspace({ name: "Read paths", slug: "read-paths" }).id;
  A = createAgent({ name: "read-paths-a", workspaceSlug: "read-paths" }).id;
  B = createAgent({ name: "read-paths-b", workspaceSlug: "read-paths" }).id;
  db.prepare(
    `INSERT INTO agent_comm_sessions (id, workspace_id, topic, status, created_by_agent_id, metadata, created_at, updated_at)
     VALUES ('rp_s', ?, 'probe', 'open', ?, '{}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
  ).run(WS, A);
  db.prepare(
    `INSERT INTO agent_comm_messages (id, workspace_id, session_id, sender_agent_id, recipient_agent_id, kind, body, metadata, created_at)
     VALUES ('rp_m', ?, 'rp_s', ?, ?, 'request', 'hello', '{}', '2026-10-01T00:00:00Z')`,
  ).run(WS, A, B);
});

describe("migration 048 read-path indexes", () => {
  test("F-271: per-agent session message count and last capture use idx_session_messages_agent", () => {
    // Same SQL as listAgents' countMessages in src/dashboard-api.ts.
    expect(explain("SELECT COUNT(*) as c FROM session_messages WHERE agent_id = ?")).toContain("idx_session_messages_agent");
    const [capture] = plansOf(() => agentMemoryStatus(WS, A), /MAX\(created_at\) AS at FROM session_messages/);
    expect(capture).toContain("idx_session_messages_agent");
  });

  test("F-273: agent_inbox and its delivery stamp are index lookups", () => {
    const [inbox] = plansOf(() => agentInbox({ workspace_id: WS, agent_id: B }), /FROM agent_comm_messages m\s+JOIN agents sa/);
    expect(inbox).toContain("idx_agent_comm_messages_inbox");
    expect(inbox).not.toContain("TEMP B-TREE");
    const [stamp] = plansOf(() => agentInbox({ workspace_id: WS, agent_id: B }), /UPDATE agent_wake_events/);
    expect(stamp).toContain("idx_agent_wake_events_message");
  });

  test("F-274: file lists stop after LIMIT instead of sorting every BLOB row", () => {
    for (const [run, pick] of [
      [() => fileList({ workspace_id: WS }), /FROM files f JOIN agents o/],
      [() => fileListByFolder({ workspace_id: WS }), /FROM files WHERE .* ORDER BY created_at DESC/],
      [() => fileListByFolder({ workspace_id: WS, folder: "inbox" }), /FROM files WHERE .* ORDER BY created_at DESC/],
      [() => fileListFolders({ workspace_id: WS }), /GROUP BY folder/],
    ] as const) {
      for (const plan of plansOf(run, pick)) {
        expect(plan).toMatch(/idx_files_ws_(folder_)?created/);
        expect(plan).not.toContain("TEMP B-TREE");
      }
    }
    const listed: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => (listed.push(sql), prepare(sql))) as typeof db.prepare;
    try { fileList({ workspace_id: WS }); } finally { db.prepare = prepare; }
    expect(listed.find((s) => s.includes("FROM files f"))).toContain("text_excerpt IS NOT NULL");
  });

  test("F-277: the FK child lookup of a note delete uses an index", () => {
    expect(explain("SELECT 1 FROM notes WHERE project_id = ?")).not.toContain("SCAN notes");
  });
});
