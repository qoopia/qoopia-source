import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import {
  capContext,
  contextDemotionApplies,
  demoteContext,
  demotedContext,
  isSessionQuery,
} from "../src/services/recall/context-demotion.ts";

const marker = "ctxdemotionprobe";
let workspaceId = "";
let agentId = "";
let writerId = "";
const contextIds: string[] = [];
const durableIds: string[] = [];

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Recall Context Demotion", slug: "recall-context-demotion" });
  workspaceId = workspace.id;
  agentId = createAgent({ name: "recall-context-agent", workspaceSlug: workspace.slug }).id;
  writerId = createAgent({ name: "recall-context-writer", workspaceSlug: workspace.slug }).id;
  // Another agent's summaries repeat the marker, so plain BM25 ranks every one of them above the durable notes.
  for (let index = 0; index < 4; index++) {
    contextIds.push(createNote({
      workspace_id: workspaceId,
      agent_id: writerId,
      type: "context",
      text: `Session checkpoint ${index}: ${marker} ${marker} ${marker} discussed, ${marker} again`,
    }).id);
  }
  for (let index = 0; index < 3; index++) {
    durableIds.push(createNote({
      workspace_id: workspaceId,
      agent_id: agentId,
      type: "knowledge",
      text: `Durable fact ${index} about ${marker} and a much longer unrelated tail of words to dilute bm25 weight`,
    }).id);
  }
});

const ENV_KEYS = [
  "QOOPIA_RECALL_CONTEXT_FACTOR",
  "QOOPIA_RECALL_CONTEXT_CAP",
  "QOOPIA_RECALL_CONTEXT_WINDOW",
  "QOOPIA_RECALL_CONTEXT_SCOPE",
  "QOOPIA_V4_LATEST_ONLY",
  "QOOPIA_V4_RELATIONS",
];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function call(query: string, extra: Record<string, unknown> = {}, caller = agentId) {
  return recall({
    workspace_id: workspaceId,
    caller_agent_id: caller,
    is_admin: false,
    query,
    mode: "fts5",
    limit: 10,
    ...extra,
  });
}

describe("context demotion helpers", () => {
  const isCtx = (row: string) => row.startsWith("c");

  test("factor moves a first-place summary below the first ordinary rows", () => {
    process.env.QOOPIA_RECALL_CONTEXT_CAP = "-1";
    const rows = ["c1", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11", "n12", "n13"];
    const out = demoteContext(rows, isCtx);
    expect(out.length).toBe(rows.length);
    expect(out[0]).toBe("n1");
    expect(out.indexOf("c1")).toBeGreaterThan(5);
  });

  test("factor 1 keeps the order, the cap still holds", () => {
    process.env.QOOPIA_RECALL_CONTEXT_FACTOR = "1";
    const rows = ["c1", "c2", "c3", "n1", "c4", "n2"];
    expect(demoteContext(rows, isCtx)).toEqual(["c1", "c2", "n1", "n2", "c3", "c4"]);
  });

  test("the cap only looks at the window and never drops rows", () => {
    const rows = Array.from({ length: 24 }, (_, i) => (i % 2 ? `n${i}` : `c${i}`));
    const out = capContext(rows, isCtx);
    expect(out.slice().sort()).toEqual(rows.slice().sort());
    expect(out.slice(0, 10).filter(isCtx).length).toBe(2);
  });

  test("session queries and explicit filters bypass the demotion", () => {
    for (const q of ["CONTEXT", "на чём остановились", "выжимка сессии", "last handoff", "checkpoint Liam"]) {
      expect(isSessionQuery(q)).toBe(true);
    }
    for (const q of ["Kia Soul insurance VIN", "температура хранения тортов", "Forgejo port"]) {
      expect(isSessionQuery(q)).toBe(false);
    }
    expect(contextDemotionApplies({ query: "Forgejo port" })).toBe(true);
    expect(contextDemotionApplies({ query: "Forgejo port", type: "context" })).toBe(false);
    expect(contextDemotionApplies({ query: "Forgejo port", scope: "sessions" })).toBe(false);
  });

  test("only other agents' summaries are demoted unless the scope is all", () => {
    const own = { type: "context", source: "notes", agent_id: "me" };
    const other = { type: "context", source: "notes", agent_id: "them" };
    const fact = { type: "knowledge", source: "notes", agent_id: "them" };
    const session = { type: "context", source: "sessions", agent_id: "them" };
    const demoted = demotedContext("me");
    expect([own, other, fact, session].map(demoted)).toEqual([false, true, false, false]);
    process.env.QOOPIA_RECALL_CONTEXT_SCOPE = "all";
    expect(demotedContext("me")(own)).toBe(true);
  });
});

describe("recall() with session summaries in the pool", () => {
  test("ordinary query: durable notes first, nothing lost", async () => {
    const result = await call(marker);
    const ids = result.results.map((row) => row.id);
    expect(ids.slice(0, 3).sort()).toEqual(durableIds.slice().sort());
    expect(ids.slice().sort()).toEqual([...contextIds, ...durableIds].sort());
  });

  test("the cap keeps at most two summaries inside the window", async () => {
    process.env.QOOPIA_RECALL_CONTEXT_FACTOR = "1";
    process.env.QOOPIA_RECALL_CONTEXT_WINDOW = "5";
    const result = await call(marker);
    expect(result.results.slice(0, 5).filter((row) => row.type === "context").length).toBe(2);
    expect(result.results.length).toBe(7);
  });

  test("demotion off restores the BM25 order", async () => {
    process.env.QOOPIA_RECALL_CONTEXT_FACTOR = "1";
    process.env.QOOPIA_RECALL_CONTEXT_CAP = "-1";
    const result = await call(marker);
    expect(contextIds).toContain(result.results[0]!.id);
  });

  test("the writer's own summaries keep their place", async () => {
    const result = await call(marker, {}, writerId);
    expect(contextIds).toContain(result.results[0]!.id);
    expect(result.results.slice(0, 4).map((row) => row.id).sort()).toEqual(contextIds.slice().sort());
  });

  test("explicit type=context and a session query keep the summaries on top", async () => {
    const typed = await call(marker, { type: "context" });
    expect(typed.results.map((row) => row.id).sort()).toEqual(contextIds.slice().sort());
    const session = await call(`${marker} checkpoint`);
    expect(contextIds).toContain(session.results[0]!.id);
  });

  test("the V4 path keeps the cap after its own scoring", async () => {
    process.env.QOOPIA_V4_LATEST_ONLY = "true";
    process.env.QOOPIA_V4_RELATIONS = "true";
    process.env.QOOPIA_RECALL_CONTEXT_FACTOR = "1";
    process.env.QOOPIA_RECALL_CONTEXT_WINDOW = "5";
    const result = await call(marker);
    expect(result.pipeline_version).toBeDefined();
    expect(result.results.slice(0, 5).filter((row) => row.type === "context").length).toBe(2);
    expect(result.results.length).toBe(7);
  });
});
