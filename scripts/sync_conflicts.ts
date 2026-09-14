#!/usr/bin/env bun
/**
 * Shadow sync conflict-queue CLI — invoked by the operator wrapper under
 * $QOOPIA_ROOT/scripts.
 * Phase 2 Item B step 4 (plan note 01KSC0E9F1WFWJMSP58KS34H2A), Q-P2-2 Q3.
 *
 * Subcommands:
 *   list                    — paginated listing of pending conflicts, sorted by
 *                             created_at DESC (20 per page).
 *   show <id>               — show one conflict envelope. NEVER dumps body bytes
 *                             (rubric §7) — diff_summary, hashes, ts only.
 *   resolve <id> --side {local|remote|manual} [--note <text>]
 *                           — flip the queue row to resolved_*; records the
 *                             reviewer agent (env QOOPIA_AGENT_ID or "operator").
 *                             This records the review disposition only. The
 *                             operator must reconcile the source/target row,
 *                             generate a fresh plan, and obtain a fresh signed
 *                             apply manifest; stale plans remain unusable.
 *
 * Default invocation: `bun /app/scripts/sync_conflicts.ts <subcommand> [...]`
 * inside the qoopia-corsair container.
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import {
  openReadonlyDatabase,
  openWritableDatabase,
} from "../src/db/sqlite.ts";
import { env } from "../src/utils/env.ts";

const DEFAULT_DB = process.env.QOOPIA_DB_PATH ?? path.join(env.DATA_DIR, "qoopia.db");
const PAGE = 20;
const RESOLVED_STATES = new Set([
  "resolved_local",
  "resolved_remote",
  "resolved_manual",
  "dismissed",
]);
const SECRET_KEY_RE = /(secret|token|key|password|cookie|authorization|bearer)/i;

function openDb(writable = false): Database {
  // List/show are physically read-only. Resolve is the only writable path and
  // receives the same FK + bounded-busy connection safeguards as sync apply.
  return writable
    ? openWritableDatabase(DEFAULT_DB)
    : openReadonlyDatabase(DEFAULT_DB);
}

function usage(): never {
  console.error(
    [
      "usage: sync_conflicts.ts <subcommand> [args]",
      "",
      "  list [--page <n>]",
      "      Paginated listing (20 per page).",
      "  show <conflict-id>",
      "      Envelope only — diff summary, hashes, timestamps (no body bytes).",
      "  resolve <conflict-id> --side {local|remote|manual} [--note <text>]",
      "      Marks the conflict resolved. Reviewer recorded from QOOPIA_AGENT_ID env.",
      "",
      "Database: " + DEFAULT_DB,
    ].join("\n"),
  );
  process.exit(2);
}

function cmdList(argv: string[]) {
  let page = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--page") page = parseInt(argv[++i] || "1", 10);
  }
  if (!Number.isFinite(page) || page < 1) page = 1;
  const db = openDb();
  try {
    const total = (
      db.query("SELECT count(*) AS n FROM sync_conflict_queue WHERE status='pending'").get() as { n: number }
    ).n;
    const offset = (page - 1) * PAGE;
    const rows = db
      .query(
        `SELECT id, created_at, table_name, row_id, direction, status, field_diff_summary
           FROM sync_conflict_queue
          WHERE status = 'pending'
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(PAGE, offset) as Array<{
      id: number;
      created_at: string;
      table_name: string;
      row_id: string;
      direction: string;
      status: string;
      field_diff_summary: string;
    }>;
    console.log(`pending: ${total}, page ${page}, showing ${rows.length}`);
    for (const r of rows) {
      console.log(
        `  #${r.id}  ${r.created_at}  ${r.table_name}/${r.row_id.slice(0, 8)}  ${r.direction}  ${redactKeys(r.field_diff_summary)}`,
      );
    }
  } finally {
    db.close();
  }
}

function cmdShow(argv: string[]) {
  if (argv.length === 0) {
    console.error("error: show needs a conflict id");
    usage();
  }
  const id = parseInt(argv[0], 10);
  if (!Number.isFinite(id)) {
    console.error("error: conflict id must be numeric");
    process.exit(2);
  }
  const db = openDb();
  try {
    const row = db
      .query(
        `SELECT id, created_at, table_name, row_id, direction,
                local_updated_at_ms, remote_updated_at_ms,
                local_hash, remote_hash, field_diff_summary, status,
                resolved_at, resolved_by, resolution_note
           FROM sync_conflict_queue
          WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          created_at: string;
          table_name: string;
          row_id: string;
          direction: string;
          local_updated_at_ms: number;
          remote_updated_at_ms: number;
          local_hash: string;
          remote_hash: string;
          field_diff_summary: string;
          status: string;
          resolved_at: string | null;
          resolved_by: string | null;
          resolution_note: string | null;
        }
      | undefined;
    if (!row) {
      console.error(`no conflict with id=${id}`);
      process.exit(1);
    }
    const lines = [
      `conflict #${row.id}`,
      `  created_at:           ${row.created_at}`,
      `  table:                ${row.table_name}`,
      `  row_id:               ${row.row_id.slice(0, 8)} (truncated to id8)`,
      `  direction:            ${row.direction}`,
      `  local_updated_at_ms:  ${row.local_updated_at_ms}`,
      `  remote_updated_at_ms: ${row.remote_updated_at_ms}`,
      `  local_hash:           ${row.local_hash.slice(0, 16)}…`,
      `  remote_hash:          ${row.remote_hash.slice(0, 16)}…`,
      `  diff_summary:         ${redactKeys(row.field_diff_summary)}`,
      `  status:               ${row.status}`,
    ];
    if (row.resolved_at) lines.push(`  resolved_at:          ${row.resolved_at}`);
    if (row.resolved_by) lines.push(`  resolved_by:          ${row.resolved_by}`);
    if (row.resolution_note) lines.push(`  resolution_note:      ${redactKeys(row.resolution_note)}`);
    console.log(lines.join("\n"));
  } finally {
    db.close();
  }
}

function cmdResolve(argv: string[]) {
  if (argv.length === 0) {
    console.error("error: resolve needs a conflict id");
    usage();
  }
  const id = parseInt(argv[0], 10);
  if (!Number.isFinite(id)) {
    console.error("error: conflict id must be numeric");
    process.exit(2);
  }
  let side: string | undefined;
  let note: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--side") side = argv[++i];
    else if (argv[i] === "--note") note = argv[++i];
  }
  if (!side || !["local", "remote", "manual"].includes(side)) {
    console.error("error: --side must be one of local|remote|manual");
    process.exit(2);
  }
  const status =
    side === "local" ? "resolved_local" : side === "remote" ? "resolved_remote" : "resolved_manual";
  const reviewer = process.env.QOOPIA_AGENT_ID ?? "operator";
  const nowIso = new Date().toISOString();
  const db = openDb(true);
  try {
    const cur = db
      .query("SELECT status FROM sync_conflict_queue WHERE id = ?")
      .get(id) as { status: string } | undefined;
    if (!cur) {
      console.error(`no conflict with id=${id}`);
      process.exit(1);
    }
    if (RESOLVED_STATES.has(cur.status)) {
      console.error(`conflict #${id} already in terminal state '${cur.status}'`);
      process.exit(1);
    }
    db.query(
      `UPDATE sync_conflict_queue
          SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?
        WHERE id = ?`,
    ).run(status, nowIso, reviewer, redactKeys(note ?? ""), id);
    console.log(
      `resolved #${id} status=${status} by=${reviewer} at=${nowIso}`,
    );
  } finally {
    db.close();
  }
}

/** Strip any key=value substring whose KEY name matches the secret regex.
 *  Defense-in-depth on top of the writer-side rubric §7 enforcement. */
function redactKeys(s: string): string {
  if (!s) return s;
  return s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)=[^\s,]+/g, (m, k) => {
    return SECRET_KEY_RE.test(k) ? `${k}=<redacted>` : m;
  });
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "list":
      cmdList(rest);
      break;
    case "show":
      cmdShow(rest);
      break;
    case "resolve":
      cmdResolve(rest);
      break;
    case undefined:
    case "-h":
    case "--help":
      usage();
      break;
    default:
      console.error(`unknown subcommand: ${sub}`);
      usage();
  }
}

if (import.meta.main) main();
