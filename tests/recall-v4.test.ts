import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { db } from "../src/db/connection.ts";
import { createNote } from "../src/services/notes.ts";
import { createNoteRelation } from "../src/services/note-relations.ts";
import { recall, recallBaseline } from "../src/services/recall.ts";
import { getRecallTrace } from "../src/services/recall-traces.ts";
import { recordRecallFeedback } from "../src/services/recall-feedback.ts";

let workspace = "";
let standard: AuthContext;
let sibling: AuthContext;
let owner: AuthContext;

const V4_FLAGS = [
  "QOOPIA_V4_RELATIONS",
  "QOOPIA_V4_LATEST_ONLY",
  "QOOPIA_V4_RECALL_EXPLAIN",
  "QOOPIA_V4_LIFECYCLE",
  "QOOPIA_V4_FEEDBACK",
] as const;

function auth(workspace_id: string, agent: { id: string; name: string }, type: string): AuthContext {
  return { agent_id: agent.id, agent_name: agent.name, workspace_id, type, source: "api-key" };
}

function note(actor: AuthContext, text: string, visibility: "workspace" | "private" = "workspace") {
  return createNote({
    workspace_id: actor.workspace_id,
    agent_id: actor.agent_id,
    text,
    type: "memory",
    visibility,
  }).id;
}

function enable(...names: typeof V4_FLAGS[number][]) {
  for (const name of names) process.env[name] = "true";
}

function disableAll() {
  for (const name of V4_FLAGS) delete process.env[name];
}

function expectAdditiveCompleteness(actual: any, expected: any) {
  const { completeness, ...rest } = actual;
  rest.results = rest.results.map(({ completeness: rowCompleteness, full_body_request: _request, ...row }: any) => {
    expect(rowCompleteness).toBe("complete");
    return row;
  });
  expect(completeness).toEqual({ status: "complete" });
  expect(JSON.stringify(rest)).toBe(JSON.stringify(expected));
}

afterEach(() => {
  disableAll();
});

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "P04 Recall", slug: "p04-recall" });
  workspace = ws.id;
  const a = createAgent({ name: "p04-standard", workspaceSlug: ws.slug });
  const b = createAgent({ name: "p04-sibling", workspaceSlug: ws.slug });
  const o = createAgent({ name: "p04-owner", workspaceSlug: ws.slug, type: "owner" });
  standard = auth(workspace, a, "standard");
  sibling = auth(workspace, b, "standard");
  owner = auth(workspace, o, "owner");
});

describe("P04 baseline bypass and option gates", () => {
  test("flags off is byte-identical to the frozen baseline function", async () => {
    disableAll();
    note(standard, "p04baseline exact frozen response");
    const input = {
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04baseline",
      mode: "fts5" as const,
      scope: "notes" as const,
      limit: 5,
    };
    const expected = await recallBaseline(input);
    const actual = await recall(input);
    expectAdditiveCompleteness(actual, expected);
  });

  test("disabled and invalid combinations fail closed", async () => {
    try {
      await recall({
        workspace_id: workspace,
        caller_agent_id: standard.agent_id,
        is_admin: false,
        query: "anything",
        latest_only: true,
      });
      throw new Error("expected disabled latest-only to fail");
    } catch (error) {
      expect((error as { code: string }).code).toBe("FEATURE_DISABLED");
    }

    process.env.QOOPIA_V4_LATEST_ONLY = "true";
    const partialFlagInput = {
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04baseline",
      mode: "fts5" as const,
      scope: "notes" as const,
      limit: 5,
    };
    expectAdditiveCompleteness(
      await recall(partialFlagInput),
      await recallBaseline(partialFlagInput),
    );
    delete process.env.QOOPIA_V4_LATEST_ONLY;

    enable("QOOPIA_V4_RELATIONS", "QOOPIA_V4_LATEST_ONLY");
    try {
      await recall({
        workspace_id: workspace,
        caller_agent_id: standard.agent_id,
        is_admin: false,
        query: "anything",
        include_history: true,
      });
      throw new Error("expected invalid history request to fail");
    } catch (error) {
      expect((error as { code: string }).code).toBe("INVALID_ARGUMENT");
    }
    await expect(recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "anything",
      include_archived: true,
      include_history: true,
      latest_only: true,
    })).rejects.toThrow(/incompatible/);

    try {
      recordRecallFeedback({
        auth: standard,
        note_id: note(standard, "p04 disabled feedback note"),
        feedback: "helpful",
        idempotency_key: "p04-disabled-feedback",
      });
      throw new Error("expected disabled feedback to fail");
    } catch (error) {
      expect((error as { code: string }).code).toBe("FEATURE_DISABLED");
    }
  });
});

describe("P04 relation-aware recall", () => {
  test("a stale lexical hit injects its current head and latest-only omits the stale row", async () => {
    const oldId = note(standard, "p04latestmarker obsolete endpoint is port 1000");
    const headId = note(standard, "Current endpoint is port 2000");
    createNoteRelation({
      auth: standard,
      source_note_id: headId,
      target_note_id: oldId,
      relation_type: "supersedes",
    });
    enable("QOOPIA_V4_RELATIONS", "QOOPIA_V4_LATEST_ONLY", "QOOPIA_V4_RECALL_EXPLAIN");
    const result = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04latestmarker",
      mode: "fts5",
      latest_only: true,
      explain: true,
      limit: 5,
    });
    expect(result.results.map((row) => row.id)).toContain(headId);
    expect(result.results.map((row) => row.id)).not.toContain(oldId);
    const head = result.results.find((row) => row.id === headId) as any;
    expect(head.explain.reason_codes).toContain("head_inherited_from_superseded");
  });

  test("history returns stale rows with 0.90 and preserves every conflicting head with 0.95", async () => {
    const oldId = note(standard, "p04conflictmarker obsolete shared fact");
    const leftId = note(standard, "Left corrected shared fact");
    const rightId = note(standard, "Right corrected shared fact");
    createNoteRelation({ auth: standard, source_note_id: leftId, target_note_id: oldId, relation_type: "supersedes" });
    createNoteRelation({ auth: standard, source_note_id: rightId, target_note_id: oldId, relation_type: "supersedes" });
    enable("QOOPIA_V4_RELATIONS", "QOOPIA_V4_LATEST_ONLY", "QOOPIA_V4_RECALL_EXPLAIN");

    const latest = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04conflictmarker",
      mode: "fts5",
      latest_only: true,
      explain: true,
      limit: 10,
    });
    expect(new Set(latest.results.map((row) => row.id))).toEqual(new Set([leftId, rightId]));
    for (const row of latest.results as any[]) {
      expect(row.explain.relation_factor).toBe(0.95);
      expect(row.explain.reason_codes).toContain("multiple_active_heads");
    }

    const history = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04conflictmarker",
      mode: "fts5",
      include_archived: true,
      include_history: true,
      explain: true,
      limit: 10,
    });
    const stale = history.results.find((row) => row.id === oldId) as any;
    expect(stale).toBeDefined();
    expect(stale.explain.relation_factor).toBe(0.9);
    expect(stale.explain.reason_codes).toContain("superseded_history");
  });
});

describe("P04 explain, traces, lifecycle and feedback", () => {
  test("trace contains only caller-visible results, hashes the query, and re-filters on read", async () => {
    const visibleId = note(standard, "p04tracemarker visible result");
    const hiddenId = note(sibling, "p04tracemarker hidden private result", "private");
    enable("QOOPIA_V4_RECALL_EXPLAIN");
    const result = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04tracemarker",
      mode: "fts5",
      explain: true,
      trace: true,
      limit: 10,
    });
    expect(result.results.map((row) => row.id)).toContain(visibleId);
    expect(result.results.map((row) => row.id)).not.toContain(hiddenId);
    const trace = getRecallTrace({ auth: standard, trace_id: result.trace_id! });
    expect(trace.trace.query_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(trace)).not.toContain("p04tracemarker");
    expect(trace.items.map((item) => item.result_id)).not.toContain(hiddenId);

    db.prepare(`UPDATE notes SET visibility = 'private', agent_id = ? WHERE id = ? AND workspace_id = ?`)
      .run(sibling.agent_id, visibleId, workspace);
    const refiltered = getRecallTrace({ auth: standard, trace_id: result.trace_id! });
    expect(refiltered.items.map((item) => item.result_id)).not.toContain(visibleId);

    db.prepare(`UPDATE recall_traces SET expires_at = ? WHERE workspace_id = ? AND id = ?`)
      .run("2000-01-01T00:00:00.000Z", workspace, result.trace_id);
    expect(() => getRecallTrace({ auth: standard, trace_id: result.trace_id! })).toThrow(/not found/);
  });

  test("request-supplied caller type cannot promote relation or trace authorization", async () => {
    const privateId = note(sibling, "p04authmarker private sibling head", "private");
    enable("QOOPIA_V4_RECALL_EXPLAIN");
    const recalled = await recall({
      workspace_id: workspace,
      caller_agent_id: sibling.agent_id,
      is_admin: false,
      query: "p04authmarker",
      mode: "fts5",
      explain: true,
      trace: true,
      limit: 5,
    });
    expect(recalled.results.map((row) => row.id)).toContain(privateId);

    const promoted = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      caller_type: "owner",
      is_admin: true,
      query: "p04authmarker",
      mode: "fts5",
      explain: true,
      limit: 5,
    } as any);
    expect(promoted.results.map((row) => row.id)).not.toContain(privateId);

    const privileged = { ...standard, type: "claude-privileged" };
    expect(() => getRecallTrace({ auth: privileged, trace_id: recalled.trace_id! })).toThrow(/not found/);
    expect(getRecallTrace({ auth: owner, trace_id: recalled.trace_id! }).trace.trace_id).toBe(recalled.trace_id);
  });

  test("lifecycle affects only enabled calls and reinforcement changes only a later score", async () => {
    const id = note(standard, "p04lifecyclemarker aging note");
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    db.prepare(`UPDATE notes SET updated_at = ?, updated_at_ms = ? WHERE workspace_id = ? AND id = ?`)
      .run(old.toISOString(), old.getTime(), workspace, id);
    enable("QOOPIA_V4_LIFECYCLE", "QOOPIA_V4_RECALL_EXPLAIN");
    const first = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04lifecyclemarker",
      mode: "fts5",
      lifecycle: true,
      explain: true,
      limit: 1,
    });
    const firstFactor = (first.results[0] as any).explain.lifecycle_factor;
    expect(firstFactor).toBeLessThan(1);
    await Promise.resolve();
    const second = await recall({
      workspace_id: workspace,
      caller_agent_id: standard.agent_id,
      is_admin: false,
      query: "p04lifecyclemarker",
      mode: "fts5",
      lifecycle: true,
      explain: true,
      limit: 1,
    });
    expect((second.results[0] as any).explain.lifecycle_factor).toBeGreaterThan(firstFactor);
  });

  test("feedback is trace-bound, idempotent, and confirm/pin changes subsequent lifecycle state", async () => {
    const id = note(owner, "p04feedbackmarker owner note");
    enable("QOOPIA_V4_RECALL_EXPLAIN", "QOOPIA_V4_LIFECYCLE", "QOOPIA_V4_FEEDBACK");
    const recalled = await recall({
      workspace_id: workspace,
      caller_agent_id: owner.agent_id,
      is_admin: true,
      query: "p04feedbackmarker",
      mode: "fts5",
      explain: true,
      trace: true,
      lifecycle: true,
      limit: 1,
    });
    const confirmed = recordRecallFeedback({
      auth: owner,
      note_id: id,
      trace_id: recalled.trace_id,
      feedback: "confirm",
      idempotency_key: "p04-confirm-0001",
    });
    const retry = recordRecallFeedback({
      auth: owner,
      note_id: id,
      trace_id: recalled.trace_id,
      feedback: "confirm",
      idempotency_key: "p04-confirm-0001",
    });
    expect(retry.feedback_id).toBe(confirmed.feedback_id);
    expect((db.prepare(`SELECT confirmation_count FROM memory_lifecycle WHERE workspace_id = ? AND note_id = ?`)
      .get(workspace, id) as { confirmation_count: number }).confirmation_count).toBe(1);
    recordRecallFeedback({
      auth: owner,
      note_id: id,
      feedback: "pin",
      idempotency_key: "p04-pin-00000001",
    });
    expect((db.prepare(`SELECT owner_pinned FROM memory_lifecycle WHERE workspace_id = ? AND note_id = ?`)
      .get(workspace, id) as { owner_pinned: number }).owner_pinned).toBe(1);
  });
});
