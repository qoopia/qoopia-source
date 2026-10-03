import { beforeAll, expect, test } from "bun:test";
import { ulid } from "ulid";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { findTool } from "../src/mcp/tools.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

// session_search isolation lives in session-search-isolation.test.ts.
type Msg = { id: number; agent_id?: string | null; content: string };
let wsA: string, wsB: string, alice: string, bob: string, carol: string;
let aliceSession: string, bobSession: string, carolSession: string;
let a1: number, b1: number, c1: number, a2: number;

const auth = (agent: string, workspace: string) =>
  ({ agent_id: agent, agent_name: agent, workspace_id: workspace, type: "standard", source: "api-key" }) as AuthContext;
const call = (tool: string, agent: string, workspace: string, args: Record<string, unknown>) =>
  findTool(tool)!.handler(args, auth(agent, workspace)) as any;
const code = (run: () => unknown) => {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return "accepted";
};
// F-091: an id held by another agent or workspace must read exactly like a missing one.
const refusal = (run: () => unknown) => {
  try { run(); } catch (error) { const e = error as { code?: string; message?: string }; return `${e.code}: ${e.message}`; }
  return "accepted";
};
const UNAVAILABLE = "NOT_FOUND: Session unavailable";
const count = (session: string) =>
  (db.query("SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?").get(session) as { n: number }).n;
const save = (agent: string, workspace: string, session: string, content: string) =>
  (call("session_save", agent, workspace, { session_id: session, role: "user", content }) as { id: number }).id;

beforeAll(() => {
  runMigrations();
  const a = createWorkspace({ name: "Sessions isolation A", slug: "sessions-isolation-a" });
  const b = createWorkspace({ name: "Sessions isolation B", slug: "sessions-isolation-b" });
  wsA = a.id;
  wsB = b.id;
  alice = createAgent({ name: "sis-alice", workspaceSlug: a.slug }).id;
  bob = createAgent({ name: "sis-bob", workspaceSlug: a.slug }).id;
  carol = createAgent({ name: "sis-carol", workspaceSlug: b.slug }).id;
  aliceSession = `sis-alice-${ulid()}`;
  bobSession = `sis-bob-${ulid()}`;
  carolSession = `sis-carol-${ulid()}`;
  a1 = save(alice, wsA, aliceSession, "alice first");
  b1 = save(bob, wsA, bobSession, "bob private");
  c1 = save(carol, wsB, carolSession, "carol foreign");
  a2 = save(alice, wsA, aliceSession, "alice second");
  // Other sessions are more recent, so "latest" must come from the agent filter, not from order.
  db.query("UPDATE sessions SET last_active = '2999-01-01T00:00:00Z' WHERE id IN (?, ?)").run(bobSession, carolSession);
});

test("session_recent answers another agent's or workspace's session like a missing one", () => {
  expect(refusal(() => call("session_recent", bob, wsA, { session_id: aliceSession }))).toBe(UNAVAILABLE);
  expect(refusal(() => call("session_recent", carol, wsB, { session_id: aliceSession }))).toBe(UNAVAILABLE);
  expect(refusal(() => call("session_recent", carol, wsB, { session_id: `sis-missing-${ulid()}` }))).toBe(UNAVAILABLE);
  const own = call("session_recent", alice, wsA, { session_id: aliceSession });
  expect(own.messages.map((m: Msg) => m.content)).toEqual(["alice first", "alice second"]);
});

test("session_recent 'latest' returns only the caller's own session", () => {
  const latest = call("session_recent", alice, wsA, { session_id: "latest" });
  expect(latest.session_id).toBe(aliceSession);
  expect(latest.messages.map((m: Msg) => m.content)).toEqual(["alice first", "alice second"]);
});

test("session_expand over a range holding other agents' ids returns only the caller's rows", () => {
  // Saved in order, so a1 < b1 < c1 < a2.
  const out = call("session_expand", alice, wsA, { start_id: a1, end_id: a2 });
  expect(out.messages.every((m: Msg) => m.agent_id === alice)).toBe(true);
  expect(out.messages.map((m: Msg) => m.content)).toEqual(["alice first", "alice second"]);
  expect(call("session_expand", alice, wsA, { start_id: a1, end_id: a2, session_id: bobSession }).messages).toEqual([]);
  expect(call("session_expand", carol, wsB, { start_id: a1, end_id: a2 }).messages.map((m: Msg) => m.id)).toEqual([c1]);
});

test("session_summarize refuses foreign sessions and boundary messages from another session", () => {
  const summary = (agent: string, workspace: string, session: string, start: number, end: number) =>
    () => call("session_summarize", agent, workspace, { session_id: session, content: "summary", msg_start_id: start, msg_end_id: end });
  expect(refusal(summary(bob, wsA, aliceSession, a1, a2))).toBe(UNAVAILABLE);
  expect(refusal(summary(carol, wsB, aliceSession, a1, a2))).toBe(UNAVAILABLE);
  expect(refusal(summary(carol, wsB, `sis-missing-${ulid()}`, a1, a2))).toBe(UNAVAILABLE);
  expect(code(summary(alice, wsA, aliceSession, b1, a2))).toBe("INVALID_INPUT");
  expect(code(summary(alice, wsA, aliceSession, a1, b1))).toBe("INVALID_INPUT");
  expect(code(summary(alice, wsA, aliceSession, a1, a2))).toBe("accepted");
  expect((db.query("SELECT COUNT(*) AS n FROM summaries WHERE session_id = ?").get(aliceSession) as { n: number }).n).toBe(1);
});

test("session_save cannot write into another agent's or another workspace's session", () => {
  const before = db.query("SELECT last_active FROM sessions WHERE id = ?").get(aliceSession);
  // Same refusal as continuity ingest, and the same whichever kind of owner holds the id.
  expect(refusal(() => save(bob, wsA, aliceSession, "bob intrusion"))).toBe(UNAVAILABLE);
  expect(refusal(() => save(carol, wsB, aliceSession, "carol intrusion"))).toBe(UNAVAILABLE);
  expect(count(aliceSession)).toBe(2);
  expect(db.query("SELECT last_active FROM sessions WHERE id = ?").get(aliceSession)).toEqual(before);
});

test("session_expand caps a page at 500 rows and points to the next one", () => {
  const dave = createAgent({ name: "sis-dave", workspaceSlug: "sessions-isolation-a" }).id;
  const session = `sis-dave-${ulid()}`;
  const ids = Array.from({ length: 501 }, (_, i) => save(dave, wsA, session, `dave ${i}`));
  const first = call("session_expand", dave, wsA, { start_id: 1, end_id: Number.MAX_SAFE_INTEGER });
  expect(first.count).toBe(500);
  expect(first.messages.map((m: Msg) => m.id)).toEqual(ids.slice(0, 500));
  expect(first.has_more).toBe(true);
  expect(first.next_start_id).toBe(ids[499]! + 1);
  const rest = call("session_expand", dave, wsA, { start_id: first.next_start_id, end_id: Number.MAX_SAFE_INTEGER });
  expect(rest.messages.map((m: Msg) => m.id)).toEqual([ids[500]]);
  expect(rest.has_more).toBe(false);
  expect(rest.next_start_id).toBeNull();
});

test("session_save with a message_id appends once and every retry returns the original row (F-160)", () => {
  const session = `sis-retry-${ulid()}`;
  const send = (content: string, message_id?: string) =>
    call("session_save", alice, wsA, { session_id: session, role: "user", content, ...(message_id ? { message_id } : {}) });
  const results = Array.from({ length: 20 }, () => send("retried turn", "turn-1"));
  expect(count(session)).toBe(1);
  expect(new Set(results.map((r: { id: number }) => r.id)).size).toBe(1);
  expect(results.slice(1).every((r: { duplicate?: boolean }) => r.duplicate === true)).toBe(true);
  // A reused key must not silently drop a different message.
  expect(refusal(() => send("another turn", "turn-1"))).toBe("CONFLICT: message_id was already used for a different message");
  send("ok");
  send("ok");
  expect(count(session)).toBe(3);
});
