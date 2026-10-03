/**
 * F-268: migration 017 backfilled updated_at_ms with truncated julianday
 * arithmetic, so about half of the legacy notes ended 1 ms early (and a
 * never-updated one below its created_at_ms). 048 corrects them to the exact
 * epoch-ms of updated_at.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { splitSqlStatements } from "../src/db/migration-033-exec.ts";
import { p1Database } from "./helpers/p1-fixtures.ts";

test("a pre-017 note reaches head with updated_at_ms equal to its updated_at", () => {
  const db = p1Database(16);
  db.run("INSERT INTO workspaces(id,name,slug) VALUES ('w1','W','w')");
  db.run("INSERT INTO agents(id,workspace_id,name,api_key_hash) VALUES ('a1','w1','a','h')");
  const at = (i: number) => `2026-02-02T10:${String(i).padStart(2, "0")}:00Z`;
  for (let i = 0; i < 60; i++) {
    db.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,created_at,updated_at) VALUES (?,'w1','a1','note','x',?,?)").run(`n${i}`, at(i), at(i));
  }
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql") && Number(n.slice(0, 3)) > 16).sort()) {
    db.transaction(() => {
      for (const statement of splitSqlStatements(readFileSync(new URL(name, dir), "utf8"))) db.run(statement);
      db.query("INSERT OR IGNORE INTO schema_versions(version,description) VALUES (?,?)").run(Number(name.slice(0, 3)), name);
    })();
  }
  const rows = db.query("SELECT id, updated_at, updated_at_ms, created_at_ms FROM notes ORDER BY id").all() as Array<{ id: string; updated_at: string; updated_at_ms: number; created_at_ms: number }>;
  expect(rows.find((r) => r.id === "n1")?.updated_at_ms).toBe(1770026460000);
  for (const row of rows) {
    expect(row.updated_at_ms).toBe(Date.parse(row.updated_at));
    expect(row.updated_at_ms).toBe(row.created_at_ms);
  }
  db.close();
});
