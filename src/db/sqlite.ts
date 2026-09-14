import fs from "node:fs";
import { Database } from "bun:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface WritableDatabaseOptions {
  create?: boolean;
  wal?: boolean;
  busyTimeoutMs?: number;
}

export interface ReadonlyDatabaseOptions {
  queryOnly?: boolean;
  busyTimeoutMs?: number;
}

export interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

export interface IntegrityPreflightResult {
  ok: boolean;
  quick_check: string[];
  foreign_key_violations: ForeignKeyViolation[];
}

function boundedBusyTimeout(value: number | undefined): number {
  const timeout = value ?? SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw new Error(`invalid SQLite busy timeout: ${timeout}`);
  }
  return timeout;
}

function assertForeignKeysEnabled(db: Database): void {
  const state = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
  if (state.foreign_keys !== 1) {
    throw new Error("SQLite writable connection refused: foreign_keys is not enabled");
  }
}

/**
 * Configure a writable SQLite handle before any application statement runs.
 * SQLite foreign-key enforcement is connection-local, so every writable
 * opener must pass through this function rather than relying on the main DB.
 */
export function configureWritableDatabase(
  db: Database,
  options: WritableDatabaseOptions = {},
): void {
  if (options.wal) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(`PRAGMA busy_timeout = ${boundedBusyTimeout(options.busyTimeoutMs)}`);
  db.exec("PRAGMA foreign_keys = ON");
  assertForeignKeysEnabled(db);
}

/** Apply the common bounded-busy/read-only invariants to snapshot handles. */
export function configureReadonlyDatabase(
  db: Database,
  options: ReadonlyDatabaseOptions = {},
): void {
  db.exec(`PRAGMA busy_timeout = ${boundedBusyTimeout(options.busyTimeoutMs)}`);
  db.exec("PRAGMA foreign_keys = ON");
  if (options.queryOnly !== false) {
    db.exec("PRAGMA query_only = ON");
    const state = db.query("PRAGMA query_only").get() as { query_only: number };
    if (state.query_only !== 1) {
      throw new Error("SQLite read-only connection refused: query_only is not enabled");
    }
  }
}

export function openWritableDatabase(
  filename: string,
  options: WritableDatabaseOptions = {},
): Database {
  const create = options.create === true;
  if (!create && !fs.existsSync(filename)) {
    throw new Error(`SQLite writable database does not exist: ${filename}`);
  }
  const db = create
    ? new Database(filename, { create: true })
    : new Database(filename, { readwrite: true });
  try {
    configureWritableDatabase(db, options);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openReadonlyDatabase(
  filename: string,
  options: ReadonlyDatabaseOptions = {},
): Database {
  const db = new Database(filename, { readonly: true });
  try {
    configureReadonlyDatabase(db, options);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Read-only integrity inspection used by CI fixtures and the operator
 * preflight command. It never attempts a repair or mutates the database.
 */
export function inspectDatabaseIntegrity(
  db: Database,
  options: { quickCheck?: boolean } = {},
): IntegrityPreflightResult {
  const quickCheck = options.quickCheck === false
    ? []
    : (db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>).map(
        (row) => row.quick_check,
      );
  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all() as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  const quickOk = quickCheck.length === 0 ||
    (quickCheck.length === 1 && quickCheck[0] === "ok");
  return {
    ok: quickOk && foreignKeyViolations.length === 0,
    quick_check: quickCheck,
    foreign_key_violations: foreignKeyViolations,
  };
}

/** Refuse an operational write workflow when its starting database is dirty. */
export function assertDatabaseIntegrity(
  db: Database,
  label = "database",
): IntegrityPreflightResult {
  const result = inspectDatabaseIntegrity(db);
  if (!result.ok) {
    throw new Error(
      `${label} integrity preflight failed: ` +
        `${result.quick_check.filter((row) => row !== "ok").length} quick-check errors, ` +
        `${result.foreign_key_violations.length} foreign-key violations`,
    );
  }
  return result;
}
