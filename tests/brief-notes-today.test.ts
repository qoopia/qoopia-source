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

test("superseded and archived notes are history, not current state (F-520-brief-history)", () => {
  const ws = createWorkspace({ name: "Brief history", slug: "brief-history" }).id;
  const agent = createAgent({ name: "brief-history-agent", workspaceSlug: "brief-history" }).id;
  const insert = db.prepare("INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata, invalidated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("bh_task_old", ws, agent, "task", "old plan", "{}", Date.now());
  insert.run("bh_task_new", ws, agent, "task", "new plan", "{}", null);
  insert.run("bh_note_archived", ws, agent, "note", "archived note", JSON.stringify({ status: "archived" }), null);
  insert.run("bh_note_live", ws, agent, "note", "live note", "{}", null);
  const b = brief({ workspace_id: ws, caller_agent_id: agent, is_admin: true });
  expect(b.open_tasks.items.map((n) => n.id)).toEqual(["bh_task_new"]);
  expect(b.open_tasks.total).toBe(1);
  expect(b.recent_notes.items.map((n) => n.id)).toEqual(["bh_note_live"]);
  expect(b.recent_notes.total).toBe(1);
});

test("a task due today is not overdue; one due yesterday or an hour ago is (F-520-due-date)", () => {
  const ws = createWorkspace({ name: "Brief due", slug: "brief-due" }).id;
  const agent = createAgent({ name: "brief-due-agent", workspaceSlug: "brief-due" }).id;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const insert = db.prepare("INSERT INTO notes (id, workspace_id, agent_id, type, text, metadata) VALUES (?, ?, ?, 'task', ?, ?)");
  const due = (id: string, due_date: string) => insert.run(id, ws, agent, id, JSON.stringify({ due_date }));
  due("bd_today", day(0));
  due("bd_tomorrow", day(1));
  due("bd_later_today_offset", new Date(Date.now() + 3_600_000).toISOString().replace("Z", "+00:00"));
  expect(brief({ workspace_id: ws, caller_agent_id: agent, is_admin: true }).open_tasks.overdue).toBe(0);
  due("bd_yesterday", day(-1));
  due("bd_hour_ago", new Date(Date.now() - 3_600_000).toISOString());
  expect(brief({ workspace_id: ws, caller_agent_id: agent, is_admin: true }).open_tasks.overdue).toBe(2);
});
