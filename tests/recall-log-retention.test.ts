// F-105: recall_log.query_text never keeps a token-shaped secret, and rows older
// than 90 days are purged by the daily maintenance job (migration 015 promised a
// sweep that never existed).
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { recall } from "../src/services/recall.ts";
import { runMaintenance } from "../src/services/retention.ts";

let ws = "", agent = "";

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Recall log retention", slug: "recall-log-retention" });
  ws = w.id;
  agent = createAgent({ name: "recall-log-agent", workspaceSlug: w.slug }).id;
});

test("a bare token in a recall query is redacted before it reaches recall_log", async () => {
  const fake = "ghp_" + "0123456789abcdef0123456789abcdef"; // synthetic
  await recall({ workspace_id: ws, caller_agent_id: agent, is_admin: false, query: `find ${fake}`, mode: "fts5" });
  const row = db.query("SELECT query_text FROM recall_log WHERE workspace_id=? ORDER BY id DESC LIMIT 1").get(ws) as { query_text: string };
  expect(row.query_text).toStartWith("find ");
  expect(row.query_text).not.toContain(fake);
});

test("maintenance deletes recall_log rows older than 90 days and keeps recent ones", () => {
  const insert = db.prepare(`INSERT INTO recall_log (created_at, caller_agent, workspace_id, query_text, top_k, result_ids,
    result_scores, latency_ms, backend_path) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now',?), ?, ?, ?, 10, '[]', '[]', 1, 'fts')`);
  const old = insert.run("-100 days", agent, ws, "old query").lastInsertRowid;
  const recent = insert.run("-1 days", agent, ws, "recent query").lastInsertRowid;
  const { report } = runMaintenance();
  expect(report.recall_log_deleted).toBeGreaterThanOrEqual(1);
  expect(db.query("SELECT 1 FROM recall_log WHERE id=?").get(old)).toBeNull();
  expect(db.query("SELECT 1 FROM recall_log WHERE id=?").get(recent)).not.toBeNull();
});
