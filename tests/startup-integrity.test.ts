import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

test("startup refuses a database with foreign-key corruption before listening", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-startup-integrity-"));
  const data = path.join(root, "data");
  const env = {
    ...process.env,
    NODE_ENV: "test",
    QOOPIA_ROOT: root,
    QOOPIA_DATA_DIR: data,
    QOOPIA_LOG_DIR: path.join(root, "logs"),
    QOOPIA_BACKUP_DIR: path.join(root, "backups"),
    QOOPIA_SERVER_ROLE: "canonical",
    QOOPIA_HOST: "127.0.0.1",
    QOOPIA_PORT: "0",
    QOOPIA_ADMIN_SECRET: "a".repeat(64),
    QOOPIA_SESSION_SECRET: "b".repeat(64),
  };
  try {
    const setup = spawnSync("bun", ["-e", "import {runMigrations} from './src/db/migrate.ts'; import {closeDb} from './src/db/connection.ts'; runMigrations(); closeDb();"], { cwd: path.join(import.meta.dir, ".."), env, encoding: "utf8", timeout: 120_000 });
    expect(setup.status).toBe(0);
    const db = new Database(path.join(data, "qoopia.db"));
    db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE startup_parent(id TEXT PRIMARY KEY); CREATE TABLE startup_child(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES startup_parent(id)); INSERT INTO startup_child VALUES('orphan','missing');");
    expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    db.close();

    const child = spawn("bun", ["src/index.ts"], { cwd: path.join(import.meta.dir, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const code = await Promise.race([
      new Promise<number | null>(resolve => child.once("close", resolve)),
      Bun.sleep(5_000).then(() => null),
    ]);
    if (code === null) child.kill("SIGKILL");
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(output).toContain("Startup database integrity preflight failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});