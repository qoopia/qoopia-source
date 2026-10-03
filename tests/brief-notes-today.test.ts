/**
 * F-275: brief's per-agent notes_today counts only the last day and reads it
 * through the created_at index range, not the whole workspace per agent.
 */
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { brief } from "../src/services/brief.ts";

let WS = "", AGENT = "";

beforeAll(() => {
  runMigrations();
  WS = createWorkspace({ name: "Brief today", slug: "brief-today" }).id;
  const agent = createAgent({ name: "brief-today-agent", workspaceSlug: "brief-today" });
  AGENT = agent.id;
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const insert = db.prepare("INSERT INTO notes (id, workspace_id, agent_id, type, text, created_at) VALUES (?, ?, ?, 'note', ?, ?)");
  insert.run("bt_old", WS, AGENT, "two days ago", at(2 * 86_400_000));
  insert.run("bt_new", WS, AGENT, "an hour ago", at(3_600_000));
  insert.run("bt_new_seconds", WS, AGENT, "second precision", at(7_200_000).replace(/\.\d{3}Z$/, "Z"));
});

test("notes_today counts the last day only and uses the created_at index range", () => {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  let result: ReturnType<typeof brief>;
  try {
    result = brief({ workspace_id: WS, caller_agent_id: AGENT, is_admin: true });
  } finally {
    db.prepare = prepare;
  }
  expect((result.agent_activity as Record<string, { notes_today: number }>)["brief-today-agent"]?.notes_today).toBe(2);

  const sql = seen.find((s) => s.includes("notes_today"))!;
  const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(AGENT, 2, WS) as Array<{ detail: string }>).map((r) => r.detail).join(" ; ");
  expect(plan).toContain("created_at>?");
});
