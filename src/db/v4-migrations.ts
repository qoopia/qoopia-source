import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { recordMigrationStatus } from "../utils/observability.ts";
import { assertMigration033Gate, MIGRATION_033_FILENAME } from "./migration-033-gate.ts";
import { applyMigration033Sql } from "./migration-033-exec.ts";

export const V4_TARGET_SCHEMA = 32;


export interface MigrationFile {
  version: number;
  filename: string;
  path: string;
}

export interface MigrationRunResult {
  initial_schema: number;
  final_schema: number;
  target_schema: number;
  applied: string[];
  no_op: boolean;
}

export interface ApplyMigrationOptions {
  migrationsDir: string;
  targetVersion?: number;
}

function schemaVersionsExists(db: Database): boolean {
  return db
    .query(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_versions'`,
    )
    .get() != null;
}

export function readSchemaVersion(db: Database): number {
  if (!schemaVersionsExists(db)) return 0;
  const row = db
    .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_versions")
    .get() as { version: number };
  return row.version;
}

export function listMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const migrations = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3}[-_].+\.sql$/.test(entry.name))
    .map((entry) => ({
      version: Number.parseInt(entry.name.slice(0, 3), 10),
      filename: entry.name,
      path: path.join(migrationsDir, entry.name),
    }))
    .sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename));

  const seen = new Map<number, string>();
  for (const migration of migrations) {
    const previous = seen.get(migration.version);
    if (previous) {
      throw new Error(
        `Duplicate migration version ${migration.version}: ${previous}, ${migration.filename}`,
      );
    }
    seen.set(migration.version, migration.filename);
  }
  return migrations;
}

/**
 * Apply the reviewed migration set to an explicitly supplied scratch/clone
 * handle. The caller owns backup and path policy; this helper never opens a
 * production path and never hides a data backfill inside DDL.
 */
export function applyMigrationsToDatabase(
  db: Database,
  options: ApplyMigrationOptions,
): MigrationRunResult {
  const targetVersion = options.targetVersion ?? V4_TARGET_SCHEMA;
  const initialSchema = readSchemaVersion(db);
  if (initialSchema > targetVersion) {
    throw new Error(
      `Unsupported forward schema ${initialSchema}; reviewed target is ${targetVersion}`,
    );
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  const migrations = listMigrationFiles(options.migrationsDir).filter(
    (migration) => migration.version <= targetVersion,
  );
  if (!migrations.some((migration) => migration.version === targetVersion)) {
    throw new Error(`Migration ${targetVersion} is not present in ${options.migrationsDir}`);
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    const exists = db
      .query("SELECT 1 FROM schema_versions WHERE version = ?")
      .get(migration.version);
    if (exists) continue;

    const sql = fs.readFileSync(migration.path, "utf8");
    // V4.1: тот же runner-level gate И тот же failure-atomic исполнитель
    // Phase C, что и в runMigrations (см. migration-033-exec.ts).
    const is033 = migration.filename === MIGRATION_033_FILENAME;
    if (is033) assertMigration033Gate(db);
    db.transaction(() => {
      if (is033) applyMigration033Sql(db, sql);
      else db.exec(sql);
      db.query(
        `INSERT OR IGNORE INTO schema_versions (version, description)
         VALUES (?, ?)`,
      ).run(migration.version, migration.filename);
    })();

    const recorded = db
      .query("SELECT 1 FROM schema_versions WHERE version = ?")
      .get(migration.version);
    if (!recorded) {
      throw new Error(`Migration ${migration.filename} did not record schema version`);
    }
    applied.push(migration.filename);
  }

  const finalSchema = readSchemaVersion(db);
  if (finalSchema !== targetVersion) {
    throw new Error(
      `Migration run ended at schema ${finalSchema}; expected ${targetVersion}`,
    );
  }
  recordMigrationStatus(applied.length === 0 ? "noop" : "applied");
  return {
    initial_schema: initialSchema,
    final_schema: finalSchema,
    target_schema: targetVersion,
    applied,
    no_op: applied.length === 0,
  };
}

export function assertV4Schema(db: Database, expected = V4_TARGET_SCHEMA): void {
  const actual = readSchemaVersion(db);
  if (actual !== expected) {
    throw new Error(`Schema ${actual} is not the required schema ${expected}`);
  }
  for (const table of [
    "note_relations",
    "note_provenance",
    "memory_lifecycle",
    "extraction_runs",
    "extraction_candidates",
    "recall_traces",
    "recall_trace_items",
    "recall_feedback",
    "memory_event_outbox",
  ]) {
    const exists = db
      .query(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(table);
    if (!exists) throw new Error(`Schema ${expected} is missing table ${table}`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function stableValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { blob_sha256: createHash("sha256").update(value).digest("hex") };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Hash a database by schema and row values without emitting any row content.
 * This is deliberately logical rather than a file hash so interrupted/resumed
 * backfills compare equal despite harmless SQLite page-layout differences.
 */
export function computeLogicalDatabaseHash(db: Database): string {
  const hash = createHash("sha256");
  const tables = db
    .query(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string | null }>;

  for (const table of tables) {
    hash.update(`table\0${table.name}\0${table.sql ?? ""}\n`);
    const columns = db
      .query(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    const encoded: string[] = [];
    for (const row of db.query(`SELECT * FROM ${quoteIdentifier(table.name)}`).iterate() as IterableIterator<Record<string, unknown>>) {
      encoded.push(JSON.stringify(names.map((name) => stableValue(row[name]))));
    }
    encoded.sort();
    for (const row of encoded) hash.update(`${row}\n`);
  }
  return hash.digest("hex");
}
