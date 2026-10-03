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
import os from "node:os";
import { createHash } from "node:crypto";
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

// Migrations up to 044 predate this rule and keep their names and headers: renaming an
// applied file or inventing thirty-one retroactive rollbacks would add risk, not safety.
const RECORDED_FROM = 45;
describe("migration record", () => {
  const recent = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && parseInt(f, 10) >= RECORDED_FROM);

  test("new migrations are named NNN-name.sql", () => {
    for (const file of recent) expect(file).toMatch(/^\d{3}-[a-z0-9]+(-[a-z0-9]+)*\.sql$/);
  });

  test("new migrations state reader/writer compatibility, recovery and the fate of later data", () => {
    expect(recent.length).toBeGreaterThan(0);
    for (const file of recent) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      for (const field of ["compatibility:", "recovery:", "data-after-upgrade:"])
        expect(sql.includes(`-- ${field}`), `${file} lacks "-- ${field}"`).toBe(true);
    }
  });
});

// F-266: applied state is keyed by the numeric prefix only, so two files with one
// prefix or an edit to a shipped file would go unnoticed by every database.
describe("shipped migration identity", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  test("migration prefixes are unique", () => {
    expect(migrationFileVersions().size).toBe(files.length);
  });

  test("shipped migrations match SHA256SUMS; changing one is a reviewed edit of that file", () => {
    const sums = new Map(
      fs.readFileSync(path.join(MIGRATIONS_DIR, "SHA256SUMS"), "utf8").trim().split("\n")
        .map((line) => line.split(/\s+\*?/) as [string, string])
        .map(([hash, name]) => [name, hash]),
    );
    expect([...sums.keys()].sort()).toEqual([...files].sort());
    for (const file of files) {
      const actual = createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS_DIR, file))).digest("hex");
      expect(actual, `${file} differs from SHA256SUMS`).toBe(sums.get(file)!);
    }
  });

  test("the runner refuses two files with one version", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-migr-dup-"));
    try {
      const assets = path.join(dir, "assets", "migrations");
      fs.mkdirSync(assets, { recursive: true });
      fs.copyFileSync(path.join(MIGRATIONS_DIR, "001-initial-schema.sql"), path.join(assets, "001-initial-schema.sql"));
      fs.writeFileSync(path.join(assets, "002-alpha.sql"), "CREATE TABLE probe_alpha(x);\n");
      fs.writeFileSync(path.join(assets, "002-beta.sql"), "CREATE TABLE probe_beta(x);\n");
      const child = Bun.spawn([process.execPath, "scripts/migrate.ts"], {
        stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH!, NODE_ENV: "test", TMPDIR: os.tmpdir(), QOOPIA_DATA_DIR: path.join(dir, "data"),
          QOOPIA_LOG_DIR: path.join(dir, "logs"), QOOPIA_BACKUP_DIR: path.join(dir, "backups"), QOOPIA_LOG_LEVEL: "info",
          QOOPIA_SERVER_ROLE: "canonical", QOOPIA_INSTANCE_ID: "migr-dup", QOOPIA_BUNDLE_ASSETS: path.join(dir, "assets") },
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(out + err).toContain("Duplicate migration version 2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
