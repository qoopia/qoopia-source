import { assetPath } from "../utils/assets.ts";
import fs from "node:fs";
import path from "node:path";
import { db } from "./connection.ts";
import { logger } from "../utils/logger.ts";
import { env } from "../utils/env.ts";
import { assertMigration033Gate, MIGRATION_033_FILENAME } from "./migration-033-gate.ts";
import { applyMigration033Sql, splitSqlStatements } from "./migration-033-exec.ts";
import { backfill036 } from "./migration-036-backfill.ts";
import { backfill041 } from "./migration-041-backfill.ts";
import { readSchemaVersion } from "../utils/health-metadata.ts";
import { listMigrationFiles } from "./v4-migrations.ts";
import { tableExists } from "./introspect.ts";

const MIGRATIONS_DIR = assetPath("migrations");

/**
 * QSA-D / Codex QSA-003: list pending migrations without applying them.
 * The startup gate uses this only to decide whether to refuse boot. Schema
 * application is restricted to the standalone migration command.
 *
 * Returns the migration filenames (e.g. "009-activity-fts.sql") that
 * exist on disk but have not yet been recorded in schema_versions.
 * Reads only schema metadata and schema_versions. A fresh DB reports every
 * migration pending; schema creation belongs exclusively to runMigrations().
 * Keeping this function physically read-only lets legacy-readonly startup use
 * it without weakening the DB-level invariant.
 */
export function getPendingMigrations(): string[] {
  const schemaVersionsExists = tableExists(db, "schema_versions");

  const pending: string[] = [];
  // F-266: listMigrationFiles refuses two files with one version; applied state is keyed by it.
  for (const { version, filename } of listMigrationFiles(MIGRATIONS_DIR)) {
    const applied = schemaVersionsExists
      ? db.prepare("SELECT 1 FROM schema_versions WHERE version = ?").get(version)
      : null;
    if (!applied) pending.push(filename);
  }
  return pending;
}

/** The newest migration this build ships (numeric prefix, as getPendingMigrations reads it). */
export function latestShippedMigration(): number {
  return Math.max(0, ...listMigrationFiles(MIGRATIONS_DIR).map((m) => m.version));
}

/** Older software must not open a schema it does not support, e.g. after a code-only rollback. */
export function assertSchemaNotAhead(operation = "operation"): void {
  const current = readSchemaVersion(db), shipped = latestShippedMigration();
  if (current !== null && current > shipped) {
    throw new Error(
      `${operation} refused: database schema ${current} is newer than this build supports (${shipped}). ` +
        "Deploy the release that wrote it, or restore the backup taken before its migration.",
    );
  }
}

/** Refuse a non-migration operation when its code and schema differ. */
export function assertSchemaCurrent(operation = "operation"): void {
  assertSchemaNotAhead(operation);
  const pending = getPendingMigrations();
  if (pending.length > 0) {
    throw new Error(
      `${operation} refused: ${pending.length} pending migration(s): ` +
        `${pending.join(", ")}. Run \`bun run migrate\` separately first.`,
    );
  }
}

/**
 * QSA-D: take a hard-link / file-copy backup of the live SQLite DB into
 * BACKUP_DIR before applying migrations. The backup file name encodes
 * the UTC timestamp and the list of pending migrations so an operator
 * can restore it back-to-back if a migration goes wrong.
 *
 * Uses VACUUM INTO so the backup is a clean, consistent copy even if
 * other connections are mid-write. Returns the absolute backup path.
 *
 * Safe to call on an empty DB (still produces a snapshot file). Throws
 * if the backup cannot be written (e.g. disk full, perms) so the caller
 * can refuse to proceed with the migration.
 */
export function backupDbBeforeMigrate(pending: string[]): string {
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = pending
    .map((f) => f.replace(/\.sql$/, ""))
    .slice(0, 3)
    .join("_");
  const filename = `pre-migrate-${stamp}-${tag || "none"}.db`;
  const target = path.join(env.BACKUP_DIR, filename);

  // VACUUM INTO writes a fresh, consistent SQLite file at `target`.
  // SQLite quoting: single-quote and escape any embedded single quotes.
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  // Tighten perms; backups can contain sensitive note text and tokens.
  try {
    fs.chmodSync(target, 0o600);
  } catch (err) {
    // Don't leave a 0644 backup lying around — delete it and re-throw
    // so the caller refuses migrate.
    try {
      fs.unlinkSync(target);
    } catch {
      /* ignore */
    }
    throw new Error(
      `Failed to chmod backup ${target} to 0600: ${err}. Aborting migrate.`,
    );
  }
  logger.info(`Pre-migrate backup written to ${target}`);
  return target;
}

export function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  for (const { version, filename: file, path: filePath } of listMigrationFiles(MIGRATIONS_DIR)) {
    const applied = db
      .prepare("SELECT 1 FROM schema_versions WHERE version = ?")
      .get(version);
    if (applied) continue;

    const sql = fs.readFileSync(filePath, "utf8");
    try {
      // V4.1: gate протокола 033 обязан отработать ДО первой мутации. Каждый
      // скрипт (F-265: все версии, не только 033 и 036+) исполняется оператор
      // за оператором: `db.exec` молча проглатывает ошибки времени исполнения
      // (UNIQUE / CHECK / RAISE(ABORT) / FK) и оставлял бы полу-мигрированную
      // БД с записанной версией схемы.
      const is033 = file === MIGRATION_033_FILENAME;
      if (is033) assertMigration033Gate(db);
      let authorityReport: ReturnType<typeof backfill036> | undefined;
      db.transaction(() => {
        if (is033) applyMigration033Sql(db, sql);
        else for (const statement of splitSqlStatements(sql)) db.run(statement);
        if (version === 36) authorityReport = backfill036(db);
        if (version === 41) backfill041(db,env.PUBLIC_URL);
        // INSERT OR IGNORE: некоторые исторические migration-файлы (001) содержат
        // собственный INSERT INTO schema_versions. Wrapper не должен падать на
        // UNIQUE constraint, если запись уже существует — свежая установка иначе
        // зацикливается и БД неюзабельна.
        db.prepare(
          `INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)`,
        ).run(version, file);
      })();
      if (authorityReport) {
        for (const principal of authorityReport.principals) logger.info("Migration036 legacy permission mapping", principal);
        logger.info("Migration036 backfill committed", { principals: authorityReport.principals.length, skills: authorityReport.skills, owner_mapping: "none" });
      }
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err}`);
    }
  }
}
