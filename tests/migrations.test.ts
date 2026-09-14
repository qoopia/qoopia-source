/**
 * Migration idempotency: running runMigrations() a second time on an already-
 * migrated database must be a no-op.  Catches the common bug where a migration
 * file lacks IF NOT EXISTS / INSERT OR IGNORE and the second pass crashes the
 * server on cold restart.
 *
 * Also confirms the schema_versions row count matches the number of migration
 * .sql files on disk after the first pass.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "..", "migrations");

function migrationFileVersions(): Set<number> {
  return new Set(
    fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => {
        const m = f.match(/^(\d+)/);
        return m ? parseInt(m[1]!, 10) : NaN;
      })
      .filter((n) => Number.isFinite(n)),
  );
}

describe("runMigrations", () => {
  test("first call applies every migration file on disk", () => {
    runMigrations();
    const applied = (
      db
        .prepare(`SELECT version FROM schema_versions ORDER BY version`)
        .all() as Array<{ version: number }>
    ).map((r) => r.version);

    const expected = [...migrationFileVersions()].sort((a, b) => a - b);
    expect(applied).toEqual(expected);
  });

  test("second call is a no-op (idempotent)", () => {
    const before = (
      db.prepare(`SELECT COUNT(*) as c FROM schema_versions`).get() as { c: number }
    ).c;

    expect(() => runMigrations()).not.toThrow();

    const after = (
      db.prepare(`SELECT COUNT(*) as c FROM schema_versions`).get() as { c: number }
    ).c;
    expect(after).toBe(before);
  });

  test("third call with extra workspaces present does not duplicate rows", () => {
    // Seed user data between calls — simulating a real production restart.
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)`,
    ).run("01MIGRATION_TEST_WS_01_______", "Migration Test", "migration-test");

    const before = (
      db.prepare(`SELECT COUNT(*) as c FROM schema_versions`).get() as { c: number }
    ).c;

    expect(() => runMigrations()).not.toThrow();

    const after = (
      db.prepare(`SELECT COUNT(*) as c FROM schema_versions`).get() as { c: number }
    ).c;
    expect(after).toBe(before);

    // Original workspace row still there.
    const ws = db
      .prepare(`SELECT slug FROM workspaces WHERE id = ?`)
      .get("01MIGRATION_TEST_WS_01_______") as { slug: string } | undefined;
    expect(ws?.slug).toBe("migration-test");
  });
});
