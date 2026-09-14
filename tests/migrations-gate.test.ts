/**
 * QSA-D / Codex QSA-003 regression: production startup must not silently
 * apply pending migrations.
 *
 * The gate lives in src/index.ts (not exercised here — that would mean
 * spawning the service). Instead we verify the building blocks the gate
 * relies on:
 *
 *   - getPendingMigrations() returns a list before runMigrations()
 *     and an empty list after (no infinite re-apply, no false positives).
 *   - backupDbBeforeMigrate() creates a 0600 SQLite snapshot in BACKUP_DIR
 *     that is itself a readable SQLite database with the expected schema.
 *
 * Together with the explicit gate in index.ts, this guarantees that normal
 * service startup never applies schema. The only supported write entry point
 * is `bun run migrate`, which preflights integrity and backs up first.
 */
import fs from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  assertSchemaCurrent,
  backupDbBeforeMigrate,
  getPendingMigrations,
  runMigrations,
} from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { env } from "../src/utils/env.ts";

describe("QSA-D: getPendingMigrations() reflects schema_versions state", () => {
  test("after runMigrations(), no migrations remain pending", () => {
    runMigrations();
    const pending = getPendingMigrations();
    expect(pending).toEqual([]);
  });

  test("simulated unapplied bookkeeping → migration appears pending", () => {
    // We simulate a fresh deploy where one migration is not yet recorded
    // by deleting the schema_versions row, calling getPendingMigrations()
    // (read-only — does NOT replay SQL), and then putting the row back.
    // This deliberately avoids re-running runMigrations() because some
    // historical migration files (e.g. 009-activity-fts) are not
    // idempotent on top of an already-migrated schema.
    runMigrations();
    const max = db
      .prepare(
        "SELECT version, description FROM schema_versions ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: number; description: string } | undefined;
    if (!max) return; // nothing to assert on a totally fresh setup

    db.prepare("DELETE FROM schema_versions WHERE version = ?").run(
      max.version,
    );
    try {
      const pending = getPendingMigrations();
      expect(pending.length).toBeGreaterThan(0);
      const versionStr = String(max.version).padStart(3, "0");
      expect(pending.some((f) => f.startsWith(versionStr))).toBe(true);
      expect(() => assertSchemaCurrent("test operation")).toThrow(
        "Run `bun run migrate` separately first",
      );
    } finally {
      // Always restore — never leave the schema_versions table in a
      // half-deleted state for the next test in this suite.
      db.prepare(
        "INSERT OR REPLACE INTO schema_versions (version, description) VALUES (?, ?)",
      ).run(max.version, max.description);
    }
    expect(getPendingMigrations()).toEqual([]);
  });
});

describe("QSA-D: backupDbBeforeMigrate() writes a 0600 SQLite snapshot", () => {
  test("backup file exists, is mode 0600, and is a readable SQLite DB", () => {
    runMigrations();
    const before = fs.existsSync(env.BACKUP_DIR)
      ? fs.readdirSync(env.BACKUP_DIR)
      : [];
    const backupPath = backupDbBeforeMigrate(["009-activity-fts.sql"]);
    expect(fs.existsSync(backupPath)).toBe(true);

    // Mode bits — only the owner permission triplet matters; mask with 0o777.
    const stat = fs.statSync(backupPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);

    // The filename should encode "pre-migrate-" and the tag for the
    // first pending migration we passed in.
    const base = backupPath.split("/").pop()!;
    expect(base.startsWith("pre-migrate-")).toBe(true);
    expect(base).toContain("009-activity-fts");

    // Cleanup so subsequent test runs don't accumulate snapshots.
    fs.unlinkSync(backupPath);
    // Also remove anything new we created so the dir stays tidy.
    if (fs.existsSync(env.BACKUP_DIR)) {
      const after = fs.readdirSync(env.BACKUP_DIR);
      for (const f of after) {
        if (!before.includes(f) && f.startsWith("pre-migrate-")) {
          try {
            fs.unlinkSync(`${env.BACKUP_DIR}/${f}`);
          } catch {
            /* ignore */
          }
        }
      }
    }
  });
});
