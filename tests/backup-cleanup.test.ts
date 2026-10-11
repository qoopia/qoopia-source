/** F-520-backup-partial: a backup that fails after VACUUM INTO leaves no file that looks like a backup. */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createVerifiedBackup } from "../src/services/backup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("a snapshot that fails verification is removed, and a retry can use the same path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-backup-cleanup-"));
  roots.push(root);
  const source = path.join(root, "source.db"), output = path.join(root, "backups", "snapshot.db");
  const db = new Database(source);
  db.exec("CREATE TABLE schema_versions(version INTEGER); INSERT INTO schema_versions VALUES (48); CREATE TABLE notes(id TEXT, text TEXT); INSERT INTO notes VALUES ('n1','synthetic')");
  db.close();
  const chmod = fs.chmodSync;
  fs.chmodSync = ((file: fs.PathLike, mode: fs.Mode) => { if (String(file).endsWith(path.join("backups", "snapshot.db"))) throw new Error("synthetic chmod failure"); return chmod(file, mode); }) as typeof fs.chmodSync;
  try { expect(() => createVerifiedBackup({ source, output })).toThrow("synthetic chmod failure"); }
  finally { fs.chmodSync = chmod; }
  expect(fs.existsSync(output)).toBe(false);
  expect(createVerifiedBackup({ source, output }).integrity_check).toBe("ok");
});
