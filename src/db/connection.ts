import fs from "node:fs";
import path from "node:path";
import { env } from "../utils/env.ts";
import { ensureSafeDir, ensureSafeFile } from "../utils/fs-perms.ts";
import { openReadonlyDatabase, openWritableDatabase } from "./sqlite.ts";

// Ancestor-directory test runs may not load bunfig's isolated preload.
// Refuse before filesystem access instead of opening the normal ~/.qoopia database.
if(process.env.NODE_ENV==='test'&&!process.env.QOOPIA_ROOT&&!process.env.QOOPIA_DATA_DIR)
  throw new Error('Tests require an explicit isolated QOOPIA_ROOT or QOOPIA_DATA_DIR; run from the product directory with its test preload');

// QSEC-003: data, logs, backups all hold sensitive material — DB rows, audit
// logs with workspace/agent ids, backup .db files. All three must be 0700;
// startup refuses a directory that stays group/other accessible.
ensureSafeDir(env.DATA_DIR);
ensureSafeDir(env.LOG_DIR);
ensureSafeDir(env.BACKUP_DIR);

export const DB_PATH = path.join(env.DATA_DIR, "qoopia.db");

export const DB_READ_ONLY = env.SERVER_ROLE === "legacy-readonly";

// WS-2: role policy is not the security boundary. A legacy instance opens the
// database through SQLite's read-only VFS mode and also enables query_only as
// a second, connection-local invariant. This makes an accidentally reachable
// writer fail at SQLite even if an HTTP method or MCP risk label is wrong.
export const db = DB_READ_ONLY
  ? openReadonlyDatabase(DB_PATH)
  : openWritableDatabase(DB_PATH, { create: true, wal: true });

// SQLite creates the DB under the inherited umask (0644) and copies the main
// file's mode onto -wal/-shm, so tightening all three here covers new and
// existing installs alike.
if (!DB_READ_ONLY) {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(file)) ensureSafeFile(file);
  }
}

// Removed unsafe manual BEGIN/COMMIT runInTransaction.
// Use db.transaction(fn)() directly — it is Bun-native and handles nesting correctly.

export function closeDb() {
  if (!DB_READ_ONLY) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch { /* Checkpoint is an optimisation; the WAL stays durable and is replayed on open. */ }
  }
  db.close();
}
