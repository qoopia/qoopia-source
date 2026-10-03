/**
 * F-265: a runtime error (UNIQUE / CHECK / FK / RAISE) inside any migration
 * must roll that migration back and stop the run. bun:sqlite `db.exec` on a
 * script silently drops such errors, so every version runs statement by
 * statement in both runners.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyMigrationsToDatabase } from "../src/db/v4-migrations.ts";

const MIGRATIONS = resolve(import.meta.dir, "..", "migrations");

function seedDuplicateAgents(db: Database) {
  db.run("INSERT INTO workspaces(id,name,slug) VALUES ('w1','W','w')");
  db.run("INSERT INTO agents(id,workspace_id,name,api_key_hash) VALUES ('a1','w1','dup','h1'),('a2','w1','dup','h2')");
}

test("runMigrations: a UNIQUE failure in 003 fails the run and leaves schema at 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qoopia-migr-atomic-"));
  try {
    const assets = join(dir, "assets"), data = join(dir, "data");
    mkdirSync(join(assets, "migrations"), { recursive: true });
    mkdirSync(data);
    for (const f of readdirSync(MIGRATIONS).filter((f) => /^00[12][-_].*\.sql$/.test(f))) {
      copyFileSync(join(MIGRATIONS, f), join(assets, "migrations", f));
    }
    const env = { PATH: process.env.PATH!, NODE_ENV: "test", TMPDIR: tmpdir(), QOOPIA_DATA_DIR: data,
      QOOPIA_LOG_DIR: join(dir, "logs"), QOOPIA_BACKUP_DIR: join(dir, "backups"), QOOPIA_LOG_LEVEL: "info",
      QOOPIA_SERVER_ROLE: "canonical", QOOPIA_INSTANCE_ID: "migr-atomic" };
    const migrate = async (extra: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, "scripts/migrate.ts"], { stdout: "pipe", stderr: "pipe", env: { ...env, ...extra } });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, text: out + err };
    };
    expect((await migrate({ QOOPIA_BUNDLE_ASSETS: assets })).code).toBe(0);
    const db = new Database(join(data, "qoopia.db"));
    seedDuplicateAgents(db);
    db.close();

    const full = await migrate();
    expect(full.code).toBe(1);
    expect(full.text).toMatch(/Migration 003_agent_name_unique\.sql failed: .*UNIQUE/);
    const after = new Database(join(data, "qoopia.db"), { readonly: true });
    expect((after.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number }).v).toBe(2);
    expect(after.query("SELECT 1 FROM sqlite_master WHERE name='idx_agents_workspace_name_active'").get()).toBeNull();
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("applyMigrationsToDatabase: a UNIQUE failure in 003 throws and records nothing", () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  applyMigrationsToDatabase(db, { migrationsDir: MIGRATIONS, targetVersion: 2 });
  seedDuplicateAgents(db);
  expect(() => applyMigrationsToDatabase(db, { migrationsDir: MIGRATIONS, targetVersion: 3 })).toThrow(/UNIQUE/);
  expect((db.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number }).v).toBe(2);
  db.close();
});
