import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const mode = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

// [F-133] umask is process-wide and the preload already holds a DB open, so the
// server/migrate/CLI paths run in children started under a permissive umask.
test("DB, WAL, SHM and CLI backups are 0600 under umask 022; a shared backup parent is refused", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-secret-modes-")));
  const env = { PATH: process.env.PATH!, NODE_ENV: "test", TMPDIR: os.tmpdir(), QOOPIA_ROOT: root, QOOPIA_LOG_LEVEL: "error" };
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  };
  const openModes = () => run("-e", `const {DB_PATH}=await import(${JSON.stringify(path.join(repo, "src/db/connection.ts"))});
    console.log(["","-wal","-shm"].map((s)=>(require("node:fs").statSync(DB_PATH+s).mode&0o777).toString(8)).join(","));`);
  const previous = process.umask(0o022);
  try {
    expect(run("scripts/migrate.ts").code).toBe(0);
    const dbFile = path.join(root, "data", "qoopia.db");
    expect(mode(dbFile)).toBe("600");
    expect(openModes().stdout.trim()).toBe("600,600,600");

    // An install created before the fix keeps 0644 until the next open.
    fs.chmodSync(dbFile, 0o644);
    expect(openModes().stdout.trim()).toBe("600,600,600");

    const backup = path.join(root, "out", "manual.db");
    const made = run("src/cli.ts", "backup", "--to", backup);
    expect(made.code).toBe(0);
    expect(mode(backup)).toBe("600");
    expect(mode(path.dirname(backup))).toBe("700");

    const shared = path.join(root, "shared");
    fs.mkdirSync(shared, { mode: 0o755 });
    const refused = run("src/cli.ts", "backup", "--to", path.join(shared, "manual.db"));
    expect(refused.code).toBe(1);
    expect(fs.existsSync(path.join(shared, "manual.db"))).toBe(false);
  } finally {
    process.umask(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
