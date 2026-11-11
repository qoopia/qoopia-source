/** F-520-backup-partial: a backup that fails after VACUUM INTO leaves no file that looks like a backup. */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createVerifiedBackup } from "../src/services/backup.ts";
import { prunePreMigrateCopies } from "../src/services/retention.ts";

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

test("copies taken before a migration are rotated: the three newest stay, nothing else is touched [M10]", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-backup-cleanup-"));
  roots.push(root);
  // One full copy per release with a migration, kept for ever: eight of them held 10 GB.
  const copies = ["2026-01-05T10-00-00-000Z-048-a", "2026-03-01T10-00-00-000Z-050-b", "2026-05-01T10-00-00-000Z-052-c_053-d",
    "2026-07-01T10-00-00-000Z-054-e", "2026-09-01T10-00-00-000Z-055-f", "2026-11-01T10-00-00-000Z-056-g"].map((name) => `pre-migrate-${name}.db`);
  for (const name of copies) fs.writeFileSync(path.join(root, name), "synthetic");
  const others = ["qoopia-2026-01-01T03-00-00-000Z.db", "pre-migrate-notes.txt", "pre-migrate-2025-01-01T00-00-00-000Z-linked.db"];
  fs.writeFileSync(path.join(root, others[0]!), "daily");fs.writeFileSync(path.join(root, others[1]!), "owner file");
  fs.symlinkSync(path.join(root, others[0]!), path.join(root, others[2]!));
  expect(prunePreMigrateCopies(root)).toBe(3);
  expect(fs.readdirSync(root).sort()).toEqual([...copies.slice(3), ...others].sort());
  expect(prunePreMigrateCopies(root)).toBe(0);
});
