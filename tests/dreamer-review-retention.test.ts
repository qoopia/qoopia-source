// ADR-022: the dreamer's workspace read (session_review), the transcript rule on provenance and
// recall traces, and raw retention (dry-run report, deletion off by default). Synthetic data only.
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, setDreamer } from "../src/admin/agents.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { isDreamer, readsAllTranscripts, transcriptLevel } from "../src/auth/principal.ts";
import { saveMessage, sessionReview, sessionSearch, sessionSummarize } from "../src/services/sessions.ts";
import { createNote } from "../src/services/notes.ts";
import { createNoteProvenance } from "../src/services/provenance.ts";
import { pruneRawTranscripts, rawRetentionReport, runMaintenance } from "../src/services/retention.ts";
import { env } from "../src/utils/env.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

let ws = "", other = "", owner = "";
const id: Record<string, string> = {};
const msg: Record<string, number> = {};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const save = (key: string, session: string, agent: string, content: string, created?: string, workspace = ws) => {
  const m = saveMessage({ session_id: session, workspace_id: workspace, agent_id: agent, role: "user", content }) as { id: number };
  if (created) db.query("UPDATE session_messages SET created_at=? WHERE id=?").run(created, m.id);
  msg[key] = m.id;
};
const summarize = (session: string, agent: string, start: string, end: string) =>
  sessionSummarize({ workspace_id: ws, agent_id: agent, session_id: session, content: `summary of ${session}`, msg_start_id: msg[start]!, msg_end_id: msg[end]! });

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Dreamer review", slug: "adr022-review" });
  ws = w.id;
  owner = bootstrapOwner(db, "adr022 owner", undefined, ws).agent_id;
  for (const name of ["alice", "bob", "kiri", "standard"]) id[name] = createAgent({ name: `adr022-${name}`, workspaceSlug: w.slug }).id;
  id.steward = createAgent({ name: "adr022-steward", workspaceSlug: w.slug, type: "steward" }).id;
  setDreamer({ workspace_id: ws, agent_id: id.kiri!, enabled: true, actor_id: owner });

  // Tonight's sessions: alice then bob, interleaved; alice's first two messages are summarized.
  save("a1", "adr022-alice-night", id.alice!, "pelican alice one", daysAgo(0.5));
  save("b1", "adr022-bob-night", id.bob!, "pelican bob one", daysAgo(0.4));
  save("a2", "adr022-alice-night", id.alice!, "pelican alice two", daysAgo(0.3));
  save("a3", "adr022-alice-night", id.alice!, "pelican alice three", daysAgo(0.2));
  summarize("adr022-alice-night", id.alice!, "a1", "a2");
  // Last week: outside a one-day window.
  save("old", "adr022-alice-week", id.alice!, "pelican alice last week", daysAgo(6));

  // Raw retention fixtures, all older than 30 days unless noted.
  save("f1", "adr022-full", id.alice!, "retention full one", daysAgo(40));
  save("f2", "adr022-full", id.alice!, "retention full two", daysAgo(39));
  summarize("adr022-full", id.alice!, "f1", "f2");
  save("p1", "adr022-partial", id.bob!, "retention partial one", daysAgo(40));
  save("p2", "adr022-partial", id.bob!, "retention partial two", daysAgo(39));
  summarize("adr022-partial", id.bob!, "p1", "p1");
  save("n1", "adr022-none", id.bob!, "retention none one", daysAgo(40));
  // Fully summarized, but only its old half is past the window.
  save("m1", "adr022-mixed", id.alice!, "retention mixed old", daysAgo(45));
  save("m2", "adr022-mixed", id.alice!, "retention mixed new", daysAgo(2));
  summarize("adr022-mixed", id.alice!, "m1", "m2");

  const o = createWorkspace({ name: "Dreamer review elsewhere", slug: "adr022-elsewhere" });
  other = o.id;
  const dora = createAgent({ name: "adr022-dora", workspaceSlug: o.slug }).id;
  save("foreign", "adr022-dora", dora, "pelican foreign transcript", daysAgo(0.1), other);
});

const review = (who: string, type: string, args: Partial<Parameters<typeof sessionReview>[0]> = {}) =>
  sessionReview({ workspace_id: ws, agent_id: id[who] ?? who, type, since: daysAgo(1), ...args });
const contents = (r: ReturnType<typeof sessionReview>) => r.sessions.flatMap((s) => (s.messages as Array<{ content: string }>).map((m) => m.content));

describe("roles", () => {
  test("isDreamer, readsAllTranscripts and transcriptLevel agree for every role", () => {
    expect(isDreamer(id.kiri!)).toBe(true);
    expect(isDreamer(id.standard!)).toBe(false);
    expect(readsAllTranscripts({ agent_id: id.kiri!, type: "standard" })).toBe(true);
    expect(readsAllTranscripts({ agent_id: id.standard!, type: "standard" })).toBe(false);
    expect(readsAllTranscripts({ agent_id: id.steward!, type: "steward" })).toBe(true);
    expect([transcriptLevel(id.standard!, false), transcriptLevel(id.kiri!, false), transcriptLevel(id.steward!, true)]).toEqual([0, 2, 2]);
  });

  test("a deactivated dreamer is no dreamer", () => {
    const gone = createAgent({ name: "adr022-gone", workspaceSlug: "adr022-review" }).id;
    setDreamer({ workspace_id: ws, agent_id: gone, enabled: true, actor_id: owner });
    db.query("UPDATE agents SET active=0 WHERE id=?").run(gone);
    expect(isDreamer(gone)).toBe(false);
  });
});

describe("session_review", () => {
  test("only the dreamer, the steward and the owner", () => {
    expect(() => review("standard", "standard")).toThrow(/dreamer, the steward and the owner/);
    for (const [who, type] of [["kiri", "standard"], ["steward", "steward"], [owner, "owner"]] as const)
      expect(contents(review(who, type))).toEqual(["pelican alice one", "pelican alice two", "pelican alice three", "pelican bob one"]);
  });

  test("tonight's messages oldest first, grouped by session with its agent and covering summaries; never another workspace", () => {
    const r = review("kiri", "standard");
    expect(r.order).toBe("message_id_ascending");
    expect(r.sessions.map((s) => [s.id, s.agent_name])).toEqual([["adr022-alice-night", "adr022-alice"], ["adr022-bob-night", "adr022-bob"]]);
    expect((r.sessions[0]!.summaries as Array<{ content: string }>).map((s) => s.content)).toEqual(["summary of adr022-alice-night"]);
    expect(r.sessions[1]!.summaries).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("foreign");
    expect(JSON.stringify(r)).not.toContain("last week");
    expect(r).toMatchObject({ has_more: false, next_after_id: null, count: 4 });
  });

  test("pages with after_id without gaps or repeats", () => {
    const seen: string[] = [];
    let after: number | undefined, pages = 0;
    do {
      const page = review("kiri", "standard", { limit: 3, after_id: after });
      seen.push(...contents(page));
      after = page.next_after_id ?? undefined;
      pages++;
    } while (after !== undefined && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toEqual(["pelican alice one", "pelican alice two", "pelican bob one", "pelican alice three"]);
  });

  test("a page stops near 200k characters but always carries one message", () => {
    const big = "x".repeat(99_000);
    save("big1", "adr022-big", id.alice!, `pelican big one ${big}`, daysAgo(0.05));
    save("big2", "adr022-big", id.alice!, `pelican big two ${big}`, daysAgo(0.04));
    save("big3", "adr022-big", id.alice!, `pelican big three ${big}`, daysAgo(0.03));
    const first = review("kiri", "standard", { since: daysAgo(0.06) });
    expect(first.count).toBe(2);
    expect(first.has_more).toBe(true);
    const second = review("kiri", "standard", { since: daysAgo(0.06), after_id: first.next_after_id! });
    expect(second).toMatchObject({ count: 1, has_more: false });
    db.query("DELETE FROM session_messages WHERE session_id='adr022-big'").run();
  });

  test("the window is bounded and ordered", () => {
    expect(() => review("kiri", "standard", { since: daysAgo(40) })).toThrow(/at most 31 days/);
    expect(() => review("kiri", "standard", { since: daysAgo(1), until: daysAgo(2) })).toThrow(/until must not be before since/);
    expect(contents(review("kiri", "standard", { since: daysAgo(7), until: daysAgo(5) }))).toEqual(["pelican alice last week"]);
  });
});

describe("other raw transcript paths follow the same rule", () => {
  const auth = (who: string, type = "standard") =>
    ({ agent_id: id[who]!, agent_name: who, workspace_id: ws, type, source: "api-key", tool_profile: "full" }) as AuthContext;
  test("provenance: a sibling's message is a citable source for the dreamer only", () => {
    const cite = (who: string) => createNoteProvenance({
      auth: auth(who), note_id: createNote({ workspace_id: ws, agent_id: id[who]!, text: `${who} cites alice` }).id,
      source_kind: "session_message", source_id: String(msg.a1), source_hash: "0".repeat(64), confidence: 1,
    });
    expect(() => cite("standard")).toThrow(/not found/);
    expect(cite("kiri").created).toBe(true);
  });

  test("session_search scope workspace: own only for a standard agent, everything for the dreamer", () => {
    const search = (who: string) => sessionSearch({ workspace_id: ws, agent_id: id[who]!, query: "pelican", scope: "workspace" }).results.length;
    expect(search("standard")).toBe(0);
    expect(search("kiri")).toBe(5);
  });
});

describe("raw retention", () => {
  test("the dry-run report lists only fully summarized sessions past the window, counts only", () => {
    const report = rawRetentionReport(30);
    const ours = report.by_session.filter((s) => s.workspace_id === ws);
    expect(ours.map((s) => [s.session_id, s.messages]).sort()).toEqual([["adr022-full", 2], ["adr022-mixed", 1]]);
    expect(report).toMatchObject({ dry_run: true, retention_days: 30, delete_enabled: false });
    expect(report.by_agent.find((a) => a.agent_id === id.alice)).toMatchObject({ sessions: 2, messages: 3, agent_name: "adr022-alice" });
    expect(report.by_agent.find((a) => a.agent_id === id.bob)).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("retention full");
  });

  test("deletion is off by default: the daily job reports it and deletes nothing", () => {
    expect(env.RAW_RETENTION_DELETE).toBe(false);
    const before = (db.query("SELECT COUNT(*) AS n FROM session_messages").get() as { n: number }).n;
    const result = runMaintenance();
    expect(result.ok).toBe(true);
    expect(result.report.raw_retention).toEqual({ enabled: false, sessions: 0, messages_deleted: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM session_messages").get() as { n: number }).n).toBe(before);
  });

  test("turned on, it deletes exactly the reported messages; summaries and newer messages stay", () => {
    env.RAW_RETENTION_DELETE = true;
    try {
      const expected = rawRetentionReport(30).messages;
      expect(pruneRawTranscripts(30)).toEqual({ enabled: true, sessions: 2, messages_deleted: expected });
    } finally { env.RAW_RETENTION_DELETE = false; }
    const left = (session: string) => (db.query("SELECT content FROM session_messages WHERE session_id=? ORDER BY id").all(session) as { content: string }[]).map((m) => m.content);
    expect(left("adr022-full")).toEqual([]);
    expect(left("adr022-mixed")).toEqual(["retention mixed new"]);
    expect(left("adr022-partial")).toHaveLength(2);
    expect(left("adr022-none")).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) AS n FROM summaries WHERE session_id IN ('adr022-full','adr022-mixed')").get() as { n: number }).n).toBe(2);
    // The full-text index forgets the deleted rows too.
    expect(sessionSearch({ workspace_id: ws, agent_id: id.alice!, query: "full" }).results).toEqual([]);
    expect(rawRetentionReport(30).by_session.filter((s) => s.workspace_id === ws)).toEqual([]);
  });
});
