/**
 * F-267: a note write that starts while another process holds the write lock
 * waits on busy_timeout instead of failing at once. A deferred transaction
 * that has already read cannot wait to become a writer, so note writes take
 * the write lock up front (BEGIN IMMEDIATE).
 *
 * The writes under test run in a child process with a fresh connection, so a
 * statement another test file left open on this process's shared connection
 * cannot turn the wait into an immediate SQLITE_BUSY.
 */
import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.ts";
import { DB_PATH } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";

let WS = "", AGENT = "";
const notes = path.resolve(import.meta.dir, "../src/services/notes.ts");
const sessions = path.resolve(import.meta.dir, "../src/services/sessions.ts"), continuity = path.resolve(import.meta.dir, "../src/services/continuity.ts");

beforeAll(() => {
  runMigrations();
  WS = createWorkspace({ name: "Busy writes", slug: "busy-writes" }).id;
  AGENT = createAgent({ name: "busy-writer", workspaceSlug: "busy-writes" }).id;
});

/** Hold the write lock here while a child process performs `write`; it must wait, then succeed. */
async function writeBehindForeignLock(write: string): Promise<string> {
  const lock = new Database(DB_PATH);
  lock.run("PRAGMA busy_timeout=5000");
  lock.run("BEGIN IMMEDIATE");
  lock.query("UPDATE workspaces SET updated_at = updated_at WHERE id = ?").run(WS);
  const child = Bun.spawn([process.execPath, "-e", `
    const { createNote, updateNote, deleteNote } = await import(${JSON.stringify(notes)});
    const { saveMessage, saveTurn, sessionSummarize } = await import(${JSON.stringify(sessions)});
    const { continuityEvent } = await import(${JSON.stringify(continuity)});
    const WS = ${JSON.stringify(WS)}, AGENT = ${JSON.stringify(AGENT)};
    console.log(JSON.stringify(${write}));
  `], { env: process.env, stdout: "pipe", stderr: "pipe" });
  Bun.sleepSync(400);
  lock.run("COMMIT");
  lock.close();
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(err).not.toContain("SQLITE_BUSY");
  expect(code).toBe(0);
  return out.trim().split("\n").pop()!;
}

test("note create, update and delete wait for a foreign writer instead of failing BUSY", async () => {
  const id = JSON.parse(await writeBehindForeignLock(`createNote({ workspace_id: WS, agent_id: AGENT, text: "written behind a foreign lock" }).id`)) as string;
  expect(id).toBeString();
  await writeBehindForeignLock(`updateNote({ workspace_id: WS, agent_id: AGENT, is_admin: false, id: ${JSON.stringify(id)}, text: "updated behind a foreign lock" }) && true`);
  await writeBehindForeignLock(`deleteNote(WS, AGENT, ${JSON.stringify(id)}, false) && true`);
}, 30_000);

// 5.0.25: the nightly maintenance is a second process writing to the same database. A session write that met
// its lock failed at once, and the memory hook got «Continuity request refused» instead of waiting.
test("session turns, hook deliveries and summaries wait for a foreign writer instead of failing BUSY", async () => {
  const first = JSON.parse(await writeBehindForeignLock(`saveMessage({ workspace_id: WS, agent_id: AGENT, session_id: "busy-session", role: "user", content: "a turn behind a foreign lock" })`)) as { id: number };
  expect(first.id).toBeGreaterThan(0);
  await writeBehindForeignLock(`saveTurn({ workspace_id: WS, agent_id: AGENT, session_id: "busy-session", user: "question", assistant: "answer" }) && true`);
  const hook = JSON.parse(await writeBehindForeignLock(`continuityEvent(WS, AGENT, { session_id: "claude_code:busy-hook", project: "/busy", runtime: "claude_code", event: "progress",
    messages: [{ id: "busy-1", role: "user", content: "a hook turn behind a foreign lock" }] })`)) as { accepted: string[] };
  expect(hook.accepted).toEqual(["busy-1"]);
  await writeBehindForeignLock(`sessionSummarize({ workspace_id: WS, agent_id: AGENT, session_id: "busy-session", content: "summary behind a foreign lock", msg_start_id: ${first.id}, msg_end_id: ${first.id} }) && true`);
}, 60_000);
