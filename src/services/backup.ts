import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { openReadonlyDatabase } from "../db/sqlite.ts";
import { computeLogicalDatabaseHash } from "../db/v4-migrations.ts";
import { privateDirectory, safePath } from "../delivery/files.ts";
const ensureSafeDir = privateDirectory;
const ensureSafeFile = (file: string) => fs.chmodSync(safePath(file), 0o600);

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filename, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export interface BackupReport {
  source: string;
  output: string;
  created_at: string;
  sha256: string;
  size_bytes: number;
  mode: "0600";
  schema_version: number;
  integrity_check: "ok";
  foreign_key_violations: number;
  logical_hash: string;
  duration_ms: number;
}

/** Consistent SQLite snapshot. Never falls back to copying a live DB/WAL. */
export function createVerifiedBackup(input: {
  source: string;
  output: string;
  now?: Date;
}): BackupReport {
  const started = performance.now();
  const source = safePath(path.resolve(input.source));
  const output = safePath(path.resolve(input.output));
  if (source === output) throw new Error("backup source and output must differ");
  if (!fs.existsSync(source)) throw new Error(`backup source does not exist: ${source}`);
  if (fs.existsSync(output)) throw new Error(`backup output already exists: ${output}`);
  ensureSafeDir(path.dirname(output));
  const db = openReadonlyDatabase(source, { queryOnly: false });
  try {
    const sourceIntegrity = (db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const sourceForeignKeys = db.query("PRAGMA foreign_key_check").all();
    if (sourceIntegrity.length !== 1 || sourceIntegrity[0] !== "ok" || sourceForeignKeys.length !== 0) {
      throw new Error("backup source failed integrity preflight");
    }
    db.exec(`VACUUM INTO ${sqlString(output)}`);
  } finally {
    db.close();
  }
  ensureSafeFile(output);
  const snapshot = openReadonlyDatabase(output);
  try {
    const integrity = (snapshot.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const foreignKeys = snapshot.query("PRAGMA foreign_key_check").all();
    if (integrity.length !== 1 || integrity[0] !== "ok" || foreignKeys.length !== 0) {
      throw new Error("backup output failed integrity verification");
    }
    const schema = snapshot.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_versions").get() as { version: number };
    return {
      source,
      output,
      created_at: (input.now ?? new Date()).toISOString(),
      sha256: sha256File(output),
      size_bytes: fs.statSync(output).size,
      mode: "0600",
      schema_version: schema.version,
      integrity_check: "ok",
      foreign_key_violations: 0,
      logical_hash: computeLogicalDatabaseHash(snapshot),
      duration_ms: Number((performance.now() - started).toFixed(2)),
    };
  } finally {
    snapshot.close();
  }
}

export interface RestoreRehearsalReport {
  source_sha256: string;
  restored_sha256: string;
  source_logical_hash: string;
  restored_logical_hash: string;
  schema_version: number;
  integrity_check: "ok";
  foreign_key_violations: number;
  counts_match: boolean;
  rto_ms: number;
  rto_budget_ms: number;
  rto_pass: boolean;
}

export function rehearseRestore(input: {
  source: string;
  workdir: string;
  rto_budget_ms?: number;
}): RestoreRehearsalReport {
  const started = performance.now();
  const workdir = path.resolve(input.workdir);
  ensureSafeDir(workdir);
  const restored = path.join(workdir, "restored.db");
  const snapshot = createVerifiedBackup({ source: input.source, output: restored });
  const sourceDb = openReadonlyDatabase(input.source);
  const restoredDb = openReadonlyDatabase(restored);
  try {
    const sourceHash = computeLogicalDatabaseHash(sourceDb);
    const restoredHash = computeLogicalDatabaseHash(restoredDb);
    const sourceCounts = sourceDb.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const count = (db: typeof sourceDb, name: string) =>
      (db.query(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() as { count: number }).count;
    const countsMatch = sourceCounts.every(({ name }) => count(sourceDb, name) === count(restoredDb, name));
    const rto = Number((performance.now() - started).toFixed(2));
    const budget = input.rto_budget_ms ?? 30 * 60 * 1_000;
    return {
      source_sha256: sha256File(input.source),
      restored_sha256: snapshot.sha256,
      source_logical_hash: sourceHash,
      restored_logical_hash: restoredHash,
      schema_version: snapshot.schema_version,
      integrity_check: "ok",
      foreign_key_violations: 0,
      counts_match: countsMatch && sourceHash === restoredHash,
      rto_ms: rto,
      rto_budget_ms: budget,
      rto_pass: rto <= budget && countsMatch && sourceHash === restoredHash,
    };
  } finally {
    sourceDb.close();
    restoredDb.close();
  }
}
