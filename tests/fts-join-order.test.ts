/**
 * F-340: full-text queries read the FTS index first. Without a pinned order
 * SQLite 3.51.2 (Linux Bun) walked every note of the workspace through
 * idx_notes_known_ms and probed FTS per row: ~80 ms per recall at 5,000 notes.
 */
import { beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";

let WS = "", AGENT = "";

beforeAll(() => {
  runMigrations();
  WS = createWorkspace({ name: "FTS order", slug: "fts-order" }).id;
  AGENT = createAgent({ name: "fts-order-agent", workspaceSlug: "fts-order" }).id;
  createNote({ workspace_id: WS, agent_id: AGENT, text: "lighthouse quartz north" });
});

test("recall reads the notes FTS index before the notes table", async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("notes_fts MATCH")) return statement;
    const all = statement.all.bind(statement);
    (statement as any).all = (...params: unknown[]) => { seen.push({ sql, params }); return all(...(params as never[])); };
    return statement;
  }) as typeof db.prepare;
  try {
    await recall({ workspace_id: WS, caller_agent_id: AGENT, is_admin: false, query: "quartz", scope: "notes", mode: "fts5" });
  } finally {
    db.prepare = prepare;
  }
  expect(seen.length).toBeGreaterThan(0);
  for (const { sql, params } of seen) {
    const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>;
    expect(plan[0]!.detail).toStartWith("SCAN f VIRTUAL TABLE");
  }
});

test("every FTS join pins the FTS table as the outer loop", () => {
  const unpinned: string[] = [];
  for (const file of ["src/services/recall.ts", "src/services/entities.ts", "src/services/sessions.ts", "src/dashboard-api.ts"]) {
    const source = fs.readFileSync(path.join(import.meta.dir, "..", file), "utf8");
    for (const m of source.matchAll(/FROM \w+_fts f\s+(\w+ )?JOIN/g)) if (m[1] !== "CROSS ") unpinned.push(`${file}: ${m[0]}`);
  }
  expect(unpinned).toEqual([]);
});
