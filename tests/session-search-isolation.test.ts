// ADR-020 (owner decision, supersedes the F-002/F-193 agent-type rules): every agent has one
// shared-context toggle. On (the default) it reads its siblings' notes in its own workspace; off it
// reads only its own. The steward and the owner read the whole workspace. claude-privileged is an
// ordinary agent. A 'private' note stays with its author, the steward and the owner. Nobody reads
// another workspace, even one that records the same owner.
// ADR-022 (owner decision 2026-10-14, 5.0.21): another agent's raw transcript is read only by the
// dreamer, the steward and the owner; the shared-context toggle no longer opens it. The old rule
// returns only with QOOPIA_TRANSCRIPTS_OWN_ONLY=false (the last describe below).
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, setDreamer, setSharedContext } from "../src/admin/agents.ts";
import { env } from "../src/utils/env.ts";
import { legacyPrivilegedAgent } from "./helpers/legacy-agent.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { createNote } from "../src/services/notes.ts";
import { findTool } from "../src/mcp/tools.ts";
import { currentToolAuth } from "../src/auth/policy.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

let ws = "", other = "", owner = "", shared = "", privateNote = "", foreignNote = "";
const ids: Record<string, string> = {};

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Shared context matrix", slug: "adr020-matrix" });
  ws = w.id;
  for (const [name, type] of [["alice", "standard"], ["on", "standard"], ["off", "standard"], ["priv", "claude-privileged"],
    ["privoff", "claude-privileged"], ["dreamer", "standard"], ["dreamoff", "standard"], ["steward", "steward"]] as const) {
    ids[name] = type === "claude-privileged"
      ? legacyPrivilegedAgent(`adr020-${name}`, w.slug).id
      : createAgent({ name: `adr020-${name}`, workspaceSlug: w.slug, type }).id;
  }
  owner = bootstrapOwner(db, "adr020 owner", undefined, ws).agent_id;
  ids.owner = owner;
  setSharedContext({ workspace_id: ws, agent_id: ids.off!, enabled: false, actor_id: owner });
  setSharedContext({ workspace_id: ws, agent_id: ids.privoff!, enabled: false, actor_id: owner });
  setDreamer({ workspace_id: ws, agent_id: ids.dreamer!, enabled: true, actor_id: owner });
  // A dreamer whose shared context is off still reads every transcript, but no sibling note.
  setDreamer({ workspace_id: ws, agent_id: ids.dreamoff!, enabled: true, actor_id: owner });
  setSharedContext({ workspace_id: ws, agent_id: ids.dreamoff!, enabled: false, actor_id: owner });

  shared = createNote({ workspace_id: ws, agent_id: ids.alice!, text: "zebracode alice shared note" }).id;
  privateNote = createNote({ workspace_id: ws, agent_id: ids.alice!, text: "zebracode alice private note", visibility: "private" }).id;
  saveMessage({ session_id: "adr020-alice", workspace_id: ws, agent_id: ids.alice!, role: "user", content: "zebracode alice transcript" });

  // Another workspace (same-owner reach is covered by recall-owner-boundary.test.ts).
  const o = createWorkspace({ name: "Shared context foreign", slug: "adr020-foreign" });
  other = o.id;
  const dora = createAgent({ name: "adr020-dora", workspaceSlug: o.slug }).id;
  foreignNote = createNote({ workspace_id: other, agent_id: dora, text: "zebracode foreign note" }).id;
  saveMessage({ session_id: "adr020-dora", workspace_id: other, agent_id: dora, role: "user", content: "zebracode foreign transcript" });
});

const authOf = (who: string) => {
  const row = db.query("SELECT name, type FROM agents WHERE id=?").get(ids[who]!) as { name: string; type: string };
  return currentToolAuth(db, { agent_id: ids[who]!, agent_name: row.name, workspace_id: ws, type: row.type, source: "api-key", tool_profile: "full" } as AuthContext, "read");
};
const call = (who: string, tool: string, args: Record<string, unknown>) => findTool(tool)!.handler(args, authOf(who));
type Row = { text?: string; content?: string; text_preview?: string };
type Listing = Row[] | { results?: Row[]; items?: Row[] };
const texts = (out: unknown): string[] => {
  const o = out as Listing;
  return (Array.isArray(o) ? o : o.results ?? o.items ?? []).map((r) => r.text ?? r.content ?? r.text_preview ?? "");
};
const zebra = (list: string[]) => list.filter((t) => t?.includes("zebracode")).sort();
const searchAll = async (who: string) => zebra(texts(await call(who, "recall", { query: "zebracode", scope: "all", cross_workspace: true, limit: 50 })));

const SHARED_NOTE = ["zebracode alice shared note"];
const SIBLING = ["zebracode alice shared note", "zebracode alice transcript"];
const TRANSCRIPT = ["zebracode alice transcript"];
const WHOLE = ["zebracode alice private note", "zebracode alice shared note", "zebracode alice transcript"];
// ADR-022: "on" and "priv" lost the sibling transcript; the dreamer reads it whatever its toggle says.
const EXPECTED: Record<string, string[]> = {
  alice: WHOLE, on: SHARED_NOTE, priv: SHARED_NOTE, off: [], privoff: [], dreamer: SIBLING, dreamoff: TRANSCRIPT, steward: WHOLE, owner: WHOLE,
};

describe("ADR-020/022 visibility matrix", () => {
  for (const [who, expected] of Object.entries(EXPECTED)) {
    test(`${who}: recall (notes, activity, sessions) sees exactly its share and never another workspace`, async () => {
      // Activity rows repeat a note's text in their summary, so hidden texts are checked as substrings.
      const seen = await searchAll(who);
      for (const t of expected) expect(seen).toContain(t);
      for (const t of WHOLE.filter((x) => !expected.includes(x))) expect(seen.some((s) => s.includes(t))).toBe(false);
      expect(JSON.stringify(seen)).not.toContain("foreign");
    });

    test(`${who}: session_search workspace and all agree with recall and stay home`, () => {
      const transcript = expected.includes("zebracode alice transcript") ? ["zebracode alice transcript"] : [];
      for (const scope of ["workspace", "all"]) expect(zebra(texts(call(who, "session_search", { query: "zebracode", scope })))).toEqual(transcript);
      expect(zebra(texts(call(who, "session_search", { query: "zebracode" })))).toEqual(who === "alice" ? transcript : []);
    });

    test(`${who}: note_get, note_list and brief follow the same rule`, () => {
      const canRead = (id: string) => { try { call(who, "note_get", { id }); return true; } catch { return false; } };
      expect(canRead(shared)).toBe(expected.includes("zebracode alice shared note"));
      expect(canRead(privateNote)).toBe(expected.includes("zebracode alice private note"));
      expect(canRead(foreignNote)).toBe(false);
      const listed = zebra(texts(call(who, "note_list", {})));
      expect(listed).toEqual(expected.filter((t) => t.endsWith("note")));
      const briefText = JSON.stringify(call(who, "brief", {}));
      expect(briefText.includes("zebracode alice shared note")).toBe(expected.includes("zebracode alice shared note"));
      expect(briefText.includes("zebracode alice private note")).toBe(expected.includes("zebracode alice private note"));
    });

    test(`${who}: activity_list shows a sibling's audit rows only with shared context`, () => {
      const rows = (call(who, "activity_list", { limit: 500 }) as { items: Array<{ agent_id: string }> }).items;

      const sees = rows.some((r) => r.agent_id === ids.alice);
      expect(sees).toBe(who === "alice" || expected.some((t) => t.endsWith("note")));
    });
  }

  test("opening another agent's session by id stays refused for everyone (F-091)", () => {
    for (const who of ["on", "dreamer", "steward", "owner"]) {
      expect(() => call(who, "session_recent", { session_id: "adr020-alice" })).toThrow();
    }
  });

  test("switching the toggle takes effect on the next call, both ways", async () => {
    setSharedContext({ workspace_id: ws, agent_id: ids.on!, enabled: false, actor_id: owner });
    expect(await searchAll("on")).toEqual([]);
    setSharedContext({ workspace_id: ws, agent_id: ids.on!, enabled: true, actor_id: owner });
    expect(await searchAll("on")).toEqual(SHARED_NOTE);
  });

  test("granting and withdrawing the dreamer role takes effect on the next call", async () => {
    setDreamer({ workspace_id: ws, agent_id: ids.on!, enabled: true, actor_id: owner });
    expect(await searchAll("on")).toEqual(SIBLING);
    setDreamer({ workspace_id: ws, agent_id: ids.on!, enabled: false, actor_id: owner });
    expect(await searchAll("on")).toEqual(SHARED_NOTE);
  });
});

describe("QOOPIA_TRANSCRIPTS_OWN_ONLY=false restores the ADR-020 transcript rule", () => {
  test("shared context opens the sibling transcript again; off still reads only its own", async () => {
    env.TRANSCRIPTS_OWN_ONLY = false;
    try {
      expect(await searchAll("on")).toEqual(SIBLING);
      expect(zebra(texts(call("on", "session_search", { query: "zebracode", scope: "workspace" })))).toEqual(TRANSCRIPT);
      expect(await searchAll("off")).toEqual([]);
      expect(await searchAll("dreamoff")).toEqual(TRANSCRIPT);
    } finally { env.TRANSCRIPTS_OWN_ONLY = true; }
  });
});
