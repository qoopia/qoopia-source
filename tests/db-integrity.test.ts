import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDatabaseIntegrity,
  inspectDatabaseIntegrity,
  openReadonlyDatabase,
  openWritableDatabase,
} from "../src/db/sqlite.ts";

const roots: string[] = [];

function fixturePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-integrity-"));
  roots.push(root);
  return path.join(root, "fixture.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SQLite connection and integrity preflight", () => {
  test("a create-enabled writable helper enforces connection invariants", () => {
    const db = openWritableDatabase(fixturePath(), { create: true });
    try {
      const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      const busy = db.query("PRAGMA busy_timeout").get() as { timeout: number };
      expect(foreignKeys.foreign_keys).toBe(1);
      expect(busy.timeout).toBe(5_000);
    } finally {
      db.close();
    }
  });

  test("the default no-create contract refuses a missing writable path", () => {
    const filename = fixturePath();
    expect(fs.existsSync(filename)).toBe(false);
    expect(() => openWritableDatabase(filename)).toThrow(
      `SQLite writable database does not exist: ${filename}`,
    );
    expect(fs.existsSync(filename)).toBe(false);
  });

  test("preflight reports clean and orphaned databases without mutating them", () => {
    const filename = fixturePath();
    const seed = new Database(filename, { create: true });
    seed.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
      INSERT INTO child (id, parent_id) VALUES ('orphan', 'missing');
    `);
    seed.close();

    const readonly = openReadonlyDatabase(filename);
    try {
      const result = inspectDatabaseIntegrity(readonly);
      expect(result.ok).toBe(false);
      expect(result.quick_check).toEqual(["ok"]);
      expect(result.foreign_key_violations).toEqual([
        { table: "child", rowid: 1, parent: "parent", fkid: 0 },
      ]);
      expect(() => assertDatabaseIntegrity(readonly, "fixture")).toThrow(
        "fixture integrity preflight failed",
      );
    } finally {
      readonly.close();
    }
  });
});
