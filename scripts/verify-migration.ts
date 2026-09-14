#!/usr/bin/env bun
/**
 * scripts/verify-migration.ts
 *
 * Reads V2 prod DB + V3 DB and asserts row counts match for each migrated
 * table group. Also runs FTS5 smoke test + cross-reference validation.
 *
 * Usage:
 *   bun run scripts/verify-migration.ts [--source <path>]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db as v3, closeDb } from "../src/db/connection.ts";
import {
  inspectDatabaseIntegrity,
  openReadonlyDatabase,
} from "../src/db/sqlite.ts";

const argv = process.argv.slice(2);
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return argv[i + 1];
}

const SOURCE =
  arg("source") || path.join(os.homedir(), ".openclaw/qoopia/data/qoopia.db");
if (!fs.existsSync(SOURCE)) {
  console.error(`V2 database not found: ${SOURCE}`);
  process.exit(1);
}

const v2 = openReadonlyDatabase(SOURCE);
let fail = 0;

function assertCount(
  label: string,
  v2sql: string,
  v3sql: string,
) {
  const v2c = (v2.prepare(v2sql).get() as { c: number }).c;
  const v3c = (v3.prepare(v3sql).get() as { c: number }).c;
  if (v2c !== v3c) {
    console.error(`✗ ${label}: V2=${v2c}, V3=${v3c}`);
    fail++;
  } else {
    console.log(`✓ ${label}: ${v2c} rows`);
  }
}

assertCount(
  "workspaces",
  `SELECT COUNT(*) as c FROM workspaces`,
  `SELECT COUNT(*) as c FROM workspaces`,
);
assertCount(
  "users",
  `SELECT COUNT(*) as c FROM users`,
  `SELECT COUNT(*) as c FROM users`,
);
assertCount(
  "agents",
  `SELECT COUNT(*) as c FROM agents`,
  `SELECT COUNT(*) as c FROM agents`,
);
assertCount(
  "notes (original)",
  `SELECT COUNT(*) as c FROM notes`,
  `SELECT COUNT(*) as c FROM notes WHERE metadata LIKE '%"v2_agent_name"%'`,
);
assertCount(
  "tasks",
  `SELECT COUNT(*) as c FROM tasks`,
  `SELECT COUNT(*) as c FROM notes WHERE type='task'`,
);
assertCount(
  "deals",
  `SELECT COUNT(*) as c FROM deals`,
  `SELECT COUNT(*) as c FROM notes WHERE type='deal'`,
);
assertCount(
  "contacts",
  `SELECT COUNT(*) as c FROM contacts`,
  `SELECT COUNT(*) as c FROM notes WHERE type='contact'`,
);
assertCount(
  "finances",
  `SELECT COUNT(*) as c FROM finances`,
  `SELECT COUNT(*) as c FROM notes WHERE type='finance'`,
);
assertCount(
  "projects",
  `SELECT COUNT(*) as c FROM projects`,
  `SELECT COUNT(*) as c FROM notes WHERE type='project'`,
);
assertCount(
  "activity",
  `SELECT COUNT(*) as c FROM activity`,
  `SELECT COUNT(*) as c FROM activity`,
);
assertCount(
  "oauth_clients",
  `SELECT COUNT(*) as c FROM oauth_clients`,
  `SELECT COUNT(*) as c FROM oauth_clients`,
);

// Sample spot check: pick a task at random and verify the status round-trips.
const sample = v2
  .prepare(`SELECT id, title, status FROM tasks LIMIT 1`)
  .get() as { id: string; title: string; status: string } | undefined;
if (sample) {
  const mig = v3
    .prepare(`SELECT type, text, metadata FROM notes WHERE id = ?`)
    .get(sample.id) as { type: string; text: string; metadata: string } | undefined;
  if (!mig) {
    console.error(`✗ sample task ${sample.id} missing from V3`);
    fail++;
  } else if (mig.type !== "task") {
    console.error(`✗ sample task wrong type: ${mig.type}`);
    fail++;
  } else {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(mig.metadata);
    } catch {}
    if (meta.status !== sample.status) {
      console.error(
        `✗ sample task status mismatch: V2=${sample.status}, V3=${meta.status}`,
      );
      fail++;
    } else {
      console.log(`✓ sample task round-trips: "${sample.title.slice(0, 40)}"`);
    }
  }
}

// FTS5 smoke test
try {
  const ftsRow = v3
    .prepare(
      `SELECT n.id FROM notes_fts f JOIN notes n ON n.rowid = f.rowid WHERE notes_fts MATCH 'migration*' LIMIT 1`,
    )
    .get();
  if (ftsRow) console.log(`✓ FTS5 functional`);
  else console.log(`⚠ FTS5 query returned no match (no data matches "migration*")`);
} catch (e) {
  console.error(`✗ FTS5 query failed: ${e}`);
  fail++;
}

// Cross-references: notes.project_id should point to a note of type='project'
const orphan = v3
  .prepare(
    `SELECT COUNT(*) as c FROM notes
     WHERE project_id IS NOT NULL
       AND project_id NOT IN (SELECT id FROM notes WHERE type = 'project')`,
  )
  .get() as { c: number };
if (orphan.c > 0) {
  console.warn(`⚠ ${orphan.c} notes reference missing projects (non-fatal)`);
}

const integrity = inspectDatabaseIntegrity(v3);
if (!integrity.ok) {
  console.error(
    `✗ V3 integrity: ${integrity.foreign_key_violations.length} foreign-key violation(s)`,
  );
  fail++;
} else {
  console.log("✓ V3 quick-check and foreign-key preflight clean");
}

v2.close();
closeDb();

if (fail > 0) {
  console.error(`\nVerification FAILED: ${fail} check(s) failed`);
  process.exit(1);
}
console.log(`\n✓ All checks passed`);
