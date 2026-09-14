import path from "node:path";
import { env } from "../utils/env.ts";
import { auditDirMode, ensureSafeDir } from "../utils/fs-perms.ts";
import { openReadonlyDatabase, openWritableDatabase } from "./sqlite.ts";

// Ancestor-directory test runs may not load bunfig's isolated preload.
// Refuse before filesystem access instead of opening the normal ~/.qoopia database.
if(process.env.NODE_ENV==='test'&&!process.env.QOOPIA_ROOT&&!process.env.QOOPIA_DATA_DIR)
  throw new Error('Tests require an explicit isolated QOOPIA_ROOT or QOOPIA_DATA_DIR; run from the product directory with its test preload');

// QSEC-003: data, logs, backups all hold sensitive material — DB rows, audit
// logs with workspace/agent ids, backup .db files. All three must be 0700.
ensureSafeDir(env.DATA_DIR);
ensureSafeDir(env.LOG_DIR);
ensureSafeDir(env.BACKUP_DIR);
// Audit pre-existing installs in case dirs were created before this hardening
// (e.g., upgrades from earlier versions where LOG_DIR/BACKUP_DIR inherited umask).
auditDirMode(env.DATA_DIR);
auditDirMode(env.LOG_DIR);
auditDirMode(env.BACKUP_DIR);

export const DB_PATH = path.join(env.DATA_DIR, "qoopia.db");

export const DB_READ_ONLY = env.SERVER_ROLE === "legacy-readonly";

// WS-2: role policy is not the security boundary. A legacy instance opens the
// database through SQLite's read-only VFS mode and also enables query_only as
// a second, connection-local invariant. This makes an accidentally reachable
// writer fail at SQLite even if an HTTP method or MCP risk label is wrong.
export const db = DB_READ_ONLY
  ? openReadonlyDatabase(DB_PATH)
  : openWritableDatabase(DB_PATH, { create: true, wal: true });

// Removed unsafe manual BEGIN/COMMIT runInTransaction.
// Use db.transaction(fn)() directly — it is Bun-native and handles nesting correctly.

export function closeDb() {
  if (!DB_READ_ONLY) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
  }
  db.close();
}
