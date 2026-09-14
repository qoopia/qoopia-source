#!/usr/bin/env bun
/**
 * Phase 1 item 6 — recall_log smoke test (in-container).
 *
 * Runs the full recall() → recall_log insert path against an EPHEMERAL
 * SQLite DB in /tmp inside the container. The production DB at
 * /data/qoopia.db is NEVER opened by this script — QOOPIA_DATA_DIR is
 * overridden BEFORE any module is imported (the env knob is read by
 * src/utils/env.ts at import time).
 *
 * Invocation: `sg docker -c 'docker exec qoopia-corsair env \
 *   QOOPIA_DATA_DIR=/tmp/qoopia-item6-smoke \
 *   QOOPIA_LOG_DIR=/tmp/qoopia-item6-smoke/logs \
 *   QOOPIA_BACKUP_DIR=/tmp/qoopia-item6-smoke/backups \
 *   bun /app/scripts/recall_log_smoke.ts'`
 */
import fs from "node:fs";
import path from "node:path";

// Force a per-run tmp dir so reruns start from a clean state.
const ROOT = process.env.QOOPIA_DATA_DIR || "/tmp/qoopia-item6-smoke";
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(ROOT, "..", "logs-item6-smoke"), {
  recursive: true,
  mode: 0o700,
});
process.env.QOOPIA_DATA_DIR = ROOT;
process.env.QOOPIA_LOG_DIR =
  process.env.QOOPIA_LOG_DIR || path.join(ROOT, "..", "logs-item6-smoke");
process.env.QOOPIA_BACKUP_DIR =
  process.env.QOOPIA_BACKUP_DIR || path.join(ROOT, "..", "backups-item6-smoke");
fs.mkdirSync(process.env.QOOPIA_LOG_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(process.env.QOOPIA_BACKUP_DIR, { recursive: true, mode: 0o700 });
process.env.QOOPIA_PORT = process.env.QOOPIA_PORT || "0";
process.env.QOOPIA_LOG_LEVEL = process.env.QOOPIA_LOG_LEVEL || "warn";
process.env.QOOPIA_ADMIN_SECRET =
  process.env.QOOPIA_ADMIN_SECRET || "item6-smoke-admin-secret";
process.env.QOOPIA_SESSION_SECRET =
  process.env.QOOPIA_SESSION_SECRET || "item6-smoke-session-secret";

// AFTER env is set up — import the migrate runner + recall service. Both
// modules read env at import time.
const { runMigrations } = await import("../src/db/migrate.ts");
const { db } = await import("../src/db/connection.ts");
const { recall } = await import("../src/services/recall.ts");

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`[OK] ${msg}`);
}

console.log(`smoke: data dir = ${process.env.QOOPIA_DATA_DIR}`);

// 1. Apply migrations (includes 015).
runMigrations();
const versions = (
  db.prepare("SELECT version FROM schema_versions ORDER BY version").all() as Array<{
    version: number;
  }>
).map((r) => r.version);
if (!versions.includes(15)) fail(`schema_versions does not include 15; got ${versions.join(",")}`);
ok(`migrations applied; schema_versions = [${versions.join(",")}]`);

// 2. Seed a workspace and a few notes so recall() has something to return.
const WS = "01SMOKEITEM6WORKSPACE000000";
const AGENT = "01SMOKEITEM6CALLERAGENT00000";
const NOW = new Date().toISOString().replace(/\.\d+Z$/, "Z");

db.prepare(
  `INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)`,
).run(WS, "Item-6 Smoke", "item-6-smoke");

// notes.agent_id has a FK to agents(id); seed an agent row first so the
// note inserts below don't trip SQLITE_CONSTRAINT_FOREIGNKEY.
db.prepare(
  `INSERT OR IGNORE INTO agents (id, workspace_id, name, api_key_hash) VALUES (?, ?, ?, ?)`,
).run(AGENT, WS, "item6-smoke-caller", "noop-hash-not-a-real-key");

const SEED_NOTES: Array<{ id: string; text: string }> = [
  { id: "01SMOKEITEM6NOTEPHASE1AUDIT", text: "phase 1 audit progress note" },
  { id: "01SMOKEITEM6NOTERECALLOGLOG", text: "recall_log captures per-call telemetry" },
  { id: "01SMOKEITEM6NOTEAUDITRUBRIC", text: "secret safe audit rubric §5 patterns" },
];
const insertNote = db.prepare(
  `INSERT OR IGNORE INTO notes
     (id, workspace_id, agent_id, project_id, type, text, metadata,
      visibility, created_at, updated_at)
   VALUES (?, ?, ?, NULL, 'knowledge', ?, '{}', 'workspace', ?, ?)`,
);
for (const n of SEED_NOTES) insertNote.run(n.id, WS, AGENT, n.text, NOW, NOW);
ok(`seeded ${SEED_NOTES.length} notes in workspace ${WS}`);

// 3. Exercise the FTS path so we get a deterministic backend_path = 'fts'.
//    Hybrid would also work but pulls Ollama into the smoke surface.
const before = (
  db.prepare("SELECT COUNT(*) AS c FROM recall_log").get() as { c: number }
).c;

const res = await recall({
  workspace_id: WS,
  caller_agent_id: AGENT,
  is_admin: false,
  query: "phase 1 audit",
  limit: 5,
  mode: "fts5",
});
ok(`recall() returned ${res.results.length} rows; mode=${res.mode}`);

// 4. Assert a row landed in recall_log with the expected shape.
const after = (
  db.prepare("SELECT COUNT(*) AS c FROM recall_log").get() as { c: number }
).c;
if (after !== before + 1) fail(`expected 1 new recall_log row; saw ${after - before}`);
ok(`recall_log row count grew by 1 (${before} -> ${after})`);

const row = db
  .prepare(
    `SELECT id, created_at, caller_agent, workspace_id, query_text, top_k,
            result_ids, result_scores, latency_ms, backend_path, scope,
            deep_used, error_class
     FROM recall_log ORDER BY id DESC LIMIT 1`,
  )
  .get() as {
  id: number;
  created_at: string;
  caller_agent: string;
  workspace_id: string;
  query_text: string;
  top_k: number;
  result_ids: string;
  result_scores: string;
  latency_ms: number;
  backend_path: string;
  scope: string;
  deep_used: number;
  error_class: string | null;
};
console.log("inserted row:", JSON.stringify(row, null, 2));

if (!row.created_at) fail("created_at is null/empty");
if (row.caller_agent !== AGENT) fail(`caller_agent mismatch (got ${row.caller_agent})`);
if (row.workspace_id !== WS) fail(`workspace_id mismatch (got ${row.workspace_id})`);
if (row.query_text !== "phase 1 audit") fail(`query_text mismatch (got ${row.query_text})`);
if (row.top_k !== 5) fail(`top_k mismatch (got ${row.top_k})`);

const ids = JSON.parse(row.result_ids) as string[];
if (!Array.isArray(ids)) fail("result_ids does not parse as array");
if (ids.length > 5) fail(`result_ids length ${ids.length} > limit 5`);
ok(`result_ids parses as JSON array, length=${ids.length} (<=5)`);

const scores = JSON.parse(row.result_scores) as number[];
if (!Array.isArray(scores)) fail("result_scores does not parse as array");
if (scores.length !== ids.length)
  fail(`result_scores length ${scores.length} != ids length ${ids.length}`);

if (!(row.latency_ms > 0)) fail(`latency_ms not > 0 (got ${row.latency_ms})`);
ok(`latency_ms=${row.latency_ms} > 0`);

const VALID_BACKEND = new Set(["fts", "vector", "hybrid", "deep", "deep_llm"]);
if (!VALID_BACKEND.has(row.backend_path))
  fail(`backend_path invalid (got ${row.backend_path})`);
if (row.backend_path !== "fts") fail(`expected backend_path=fts; got ${row.backend_path}`);
ok(`backend_path=${row.backend_path}`);

if (row.scope !== "notes") fail(`scope mismatch (got ${row.scope})`);
if (row.deep_used !== 0) fail(`deep_used should be 0 for fts path; got ${row.deep_used}`);
if (row.error_class !== null) fail(`error_class should be NULL on success; got ${row.error_class}`);

ok("all smoke assertions passed");

// 5. Exercise redaction once more end-to-end so we see what a secret-bearing
//    query looks like in the table — proof that redactQuery() is on the
//    insert path and not bypassable.
await recall({
  workspace_id: WS,
  caller_agent_id: AGENT,
  is_admin: false,
  query: "apikey=sk-live-leakcanary phase",
  limit: 3,
  mode: "fts5",
});
const redacted = db
  .prepare(
    "SELECT query_text FROM recall_log ORDER BY id DESC LIMIT 1",
  )
  .get() as { query_text: string };
console.log("secret-bearing query stored as:", redacted.query_text);
if (redacted.query_text.includes("sk-live-leakcanary"))
  fail("secret payload leaked into recall_log unredacted");
if (!redacted.query_text.includes("<REDACTED:api_key>"))
  fail("redaction marker missing for secret-bearing query");
ok("secret-bearing query was redacted before insert (no leakage)");

console.log("\nSMOKE OK");
