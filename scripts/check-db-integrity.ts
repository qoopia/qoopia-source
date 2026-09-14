#!/usr/bin/env bun
/** Read-only SQLite integrity preflight. This command never repairs data. */
import path from "node:path";
import { env } from "../src/utils/env.ts";
import {
  inspectDatabaseIntegrity,
  openReadonlyDatabase,
} from "../src/db/sqlite.ts";

const argv = process.argv.slice(2);
const dbArg = argv.indexOf("--db");
const dbPath = dbArg >= 0
  ? argv[dbArg + 1]
  : path.join(env.DATA_DIR, "qoopia.db");
if (!dbPath) {
  console.error("usage: bun run scripts/check-db-integrity.ts [--db <path>] [--no-quick-check]");
  process.exit(2);
}

const db = openReadonlyDatabase(dbPath);
try {
  const result = inspectDatabaseIntegrity(db, {
    quickCheck: !argv.includes("--no-quick-check"),
  });
  console.log(JSON.stringify({ database: dbPath, ...result }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  db.close();
}
