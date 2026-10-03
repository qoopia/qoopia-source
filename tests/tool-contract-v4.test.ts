import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { createNoteRelation } from "../src/services/note-relations.ts";
import { createExtractionRun } from "../src/services/extraction.ts";
import { createRecallTrace, type RecallDiagnosticItem } from "../src/services/recall-traces.ts";
import { enabledV4Tools, V4_TOOL_NAMES } from "../src/mcp/v4-tools.ts";

const FLAGS = [
  "QOOPIA_V4_RELATIONS",
  "QOOPIA_V4_EXTRACTION",
  "QOOPIA_V4_RECALL_EXPLAIN",
  "QOOPIA_V4_FEEDBACK",
] as const;

let auth: AuthContext;
let senderAuth: AuthContext;

function tool(name: string, schemaVersion?: number) {
  const found = enabledV4Tools(schemaVersion).find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function note(text: string) {
  return createNote({
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    text,
    type: "memory",
  });
}

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "P05 tools", slug: "p05-tools" });
  const agent = createAgent({ name: "p05-owner", workspaceSlug: workspace.slug, type: "owner" });
  auth = {
    workspace_id: workspace.id,
    agent_id: agent.id,
    agent_name: agent.name,
    type: "owner",
    source: "api-key",
  };
  const sender = createAgent({ name: "p05-delivery-sender", workspaceSlug: workspace.slug });
  senderAuth = {
    workspace_id: workspace.id,
    agent_id: sender.id,
    agent_name: sender.name,
    type: "standard",
    source: "api-key",
  };
  for (const flag of FLAGS) process.env[flag] = "true";
});

describe("P05 frozen tool contract", () => {
  test("live P05 tools are canonical, complete, and risk classified", () => {
    expect([...V4_TOOL_NAMES].sort()).toEqual([
      "export_bundle",
      "export_plan",
      "extraction_preview",
      "extraction_review",
      "extraction_run_get",
      "extraction_run_list",
      "import_plan",
      "note_relation_list",
      "note_supersede",
      "recall_feedback",
      "recall_trace_get",
    ]);
    expect(enabledV4Tools().map(({ name, risk }) => [name, risk])).toEqual([
      ["note_relation_list", "read"],
      ["note_supersede", "write-destructive"],
      ["extraction_preview", "write-low"],
      ["extraction_run_get", "read"],
      ["extraction_run_list", "read"],
      ["extraction_review", "write-low"],
      ["recall_trace_get", "read"],
      ["recall_feedback", "write-low"],
    ]);
  });

  test("P08 export tools fail closed without owner/steward, full profile, and OAuth admin scope", () => {
    const handler = tool("export_plan", 32).handler;
    expect(() => handler({ include_ephemeral: false }, {
      ...auth,
      type: "standard",
      tool_profile: "full",
    })).toThrow(/owner or steward/);
    expect(() => handler({ include_ephemeral: false }, {
      ...auth,
      type: "owner",
      tool_profile: "read-only",
    })).toThrow(/full profile/);
    expect(() => handler({ include_ephemeral: false }, {
      ...auth,
      type: "owner",
      tool_profile: "full",
      source: "oauth",
      granted_scope: ["mcp:read"],
    })).toThrow(/mcp:admin/);
  });

  test("relation cursor is opaque and bound to its note scope", async () => {
    const old = note("p05 old cursor fact");
    const head = note("p05 current cursor fact");
    const extra = note("p05 support cursor fact");
    await tool("note_supersede").handler({
      source_note_id: head.id,
      target_note_id: old.id,
      expected_target_updated_at_ms: old.updated_at_ms,
      idempotency_key: "p05-supersede-cursor",
    }, auth);
    createNoteRelation({
      auth,
      source_note_id: head.id,
      target_note_id: extra.id,
      relation_type: "supports",
    });
    const relationList = tool("note_relation_list");
    const first = await relationList.handler({ note_id: head.id, limit: 1 }, auth) as {
      relations: unknown[];
      next_cursor: string | null;
    };
    expect(first.relations).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    expect(() => relationList.handler({
      note_id: extra.id,
      cursor: first.next_cursor!,
    }, auth)).toThrow();
  });

  test("note_supersede is idempotent and rejects key reuse with changed input", async () => {
    const old = note("p05 old idempotent fact");
    const head = note("p05 current idempotent fact");
    const handler = tool("note_supersede").handler;
    const input = {
      source_note_id: head.id,
      target_note_id: old.id,
      expected_target_updated_at_ms: old.updated_at_ms,
      idempotency_key: "p05-idempotency-key",
    };
    const first = await handler(input, auth) as { relation_id: string };
    const replay = await handler(input, auth) as { relation_id: string };
    expect(replay.relation_id).toBe(first.relation_id);
    expect(getNote(auth.workspace_id, old.id, auth.agent_id, true).metadata.status).toBe("archived");
    expect(() => handler({ ...input, source_note_id: note("different head").id }, auth)).toThrow();
  });

  test("extraction preview is idempotent and never writes a canonical note", async () => {
    const before = note("p05 count sentinel");
    const saved = saveMessage({
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      session_id: "p05-extraction-session",
      role: "user",
      content: "Remember this proposed extraction only.",
    });
    if (!saved.id) throw new Error("message was not saved");
    const input = {
      session_id: "p05-extraction-session",
      source_start_id: saved.id,
      source_end_id: saved.id,
      extractor_version: "p05-test-v1",
      idempotency_key: "p05-preview-key",
    };
    const handler = tool("extraction_preview").handler;
    const first = await handler(input, auth) as { run_id: string; reused: boolean };
    const replay = await handler(input, auth) as { run_id: string; reused: boolean };
    expect(replay).toEqual({ ...first, reused: true });
    expect(getNote(auth.workspace_id, before.id, auth.agent_id, true).id).toBe(before.id);
  });
});

describe("V4 MCP wrappers: cursors, guards and replay", () => {
  const PAGE_SESSION = "p05-paging-session";
  const PROMPT_HASH = "a".repeat(64);
  type RunPage = { runs: { run_id: string }[]; next_cursor: string | null };
  let messageId = 0;
  let firstPage: RunPage;

  function errorCode(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  function listRuns(args: Record<string, unknown>, who = auth) {
    return tool("extraction_run_list").handler({ session_id: PAGE_SESSION, ...args }, who) as RunPage;
  }

  beforeAll(() => {
    const saved = saveMessage({
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      session_id: PAGE_SESSION,
      role: "user",
      content: "Paging fixture message.",
    });
    if (!saved.id) throw new Error("message was not saved");
    messageId = saved.id;
    // More than the old 200-row fetch cap.
    for (let i = 0; i < 205; i++) {
      createExtractionRun({
        auth,
        session_id: PAGE_SESSION,
        source_start_id: messageId,
        source_end_id: messageId,
        extractor_version: `p05-page-${i}`,
        prompt_hash: PROMPT_HASH,
        candidates: [],
      });
    }
    firstPage = listRuns({ limit: 100 });
  });

  test("extraction_run_list second page is reachable and paging passes 200 runs", () => {
    const seen = new Set<string>();
    let page = firstPage;
    let pages = 1;
    for (;;) {
      for (const run of page.runs) seen.add(run.run_id);
      if (!page.next_cursor || pages > 5) break;
      page = listRuns({ limit: 100, cursor: page.next_cursor });
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(205);
  });

  test("tampered cursor rejected", () => {
    const [body, mac] = firstPage.next_cursor!.split(".");
    const tampered = `${body}.${mac![0] === "A" ? "B" : "A"}${mac!.slice(1)}`;
    expect(errorCode(() => listRuns({ limit: 100, cursor: tampered }))).toBe("INVALID_ARGUMENT");
  });

  test("cursor is bound to agent, tool and scope", () => {
    const cursor = firstPage.next_cursor!;
    expect(errorCode(() => listRuns({ limit: 100, cursor }, senderAuth))).toBe("INVALID_ARGUMENT");
    expect(errorCode(() => listRuns({ limit: 100, cursor, status: "completed" }))).toBe("INVALID_ARGUMENT");
    const runId = firstPage.runs[0]!.run_id;
    expect(errorCode(() => tool("extraction_run_get").handler({ run_id: runId, candidate_cursor: cursor }, auth)))
      .toBe("INVALID_ARGUMENT");
  });

  test("extraction_run_get pages candidates and extraction_review replays by idempotency key", () => {
    const proposal = (text: string) => ({ text, source_message_ids: [messageId], confidence: 0.9 });
    const created = createExtractionRun({
      auth,
      session_id: PAGE_SESSION,
      source_start_id: messageId,
      source_end_id: messageId,
      extractor_version: "p05-review-run",
      prompt_hash: PROMPT_HASH,
      candidates: [proposal("p05 review candidate one"), proposal("p05 review candidate two")],
    });
    const runGet = tool("extraction_run_get").handler;
    type RunGet = { candidates: { candidate_id: string }[]; next_cursor: string | null };
    const page1 = runGet({ run_id: created.run.id, candidate_limit: 1 }, auth) as RunGet;
    expect(page1.next_cursor).not.toBeNull();
    const page2 = runGet({ run_id: created.run.id, candidate_limit: 1, candidate_cursor: page1.next_cursor }, auth) as RunGet;
    expect(page2.next_cursor).toBeNull();
    const [first, second] = [page1.candidates[0]!.candidate_id, page2.candidates[0]!.candidate_id];
    expect(new Set([first, second]).size).toBe(2);

    const review = tool("extraction_review").handler;
    const input = {
      candidate_id: first,
      action: "reject",
      reason_code: "not_useful",
      expected_review_version: 0,
      idempotency_key: "p05-review-key",
    };
    const done = review(input, auth) as { status: string; review_version: number };
    expect(done.status).toBe("rejected");
    expect(review(input, auth)).toEqual(done);
    expect(errorCode(() => review({ ...input, reason_code: "other" }, auth))).toBe("CONFLICT");
    expect(errorCode(() => review({ ...input, candidate_id: second }, auth))).toBe("CONFLICT");
  });

  test("recall_trace_get pages items through its cursor", () => {
    const item = (id: string, rank: number): RecallDiagnosticItem => ({
      result_kind: "note",
      result_id: id,
      note_id: id,
      source_channel: "fts5",
      fts_rank: rank,
      vector_rank: null,
      fts_score: 1,
      vector_score: null,
      rrf_score: 1,
      rerank_score: null,
      lifecycle_factor: 1,
      governance_factor: 1,
      relation_factor: 1,
      final_score: 1 / rank,
      final_rank: rank,
      reason_codes: ["fts"],
    });
    const traceId = createRecallTrace({
      auth,
      query: "p05 trace",
      mode: "hybrid",
      options: {},
      duration_ms: 1,
      items: [item(note("p05 trace a").id, 1), item(note("p05 trace b").id, 2)],
    });
    const traceGet = tool("recall_trace_get").handler;
    type TracePage = { items: RecallDiagnosticItem[]; next_cursor: string | null };
    const page1 = traceGet({ trace_id: traceId, limit: 1 }, auth) as TracePage;
    expect(page1.items.map((i) => i.final_rank)).toEqual([1]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = traceGet({ trace_id: traceId, limit: 1, cursor: page1.next_cursor }, auth) as TracePage;
    expect(page2.items.map((i) => i.final_rank)).toEqual([2]);
  });

  test("recall_feedback pin and unpin require owner or steward", () => {
    const target = note("p05 pin target");
    for (const feedback of ["pin", "unpin"]) {
      expect(errorCode(() => tool("recall_feedback").handler({
        note_id: target.id,
        feedback,
        idempotency_key: `p05-${feedback}-standard`,
      }, senderAuth))).toBe("FORBIDDEN");
    }
  });
});

describe("V4 MCP idempotency keys belong to the calling agent", () => {
  function code(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  test("note_supersede: two agents can use one key for their own notes", () => {
    const handler = tool("note_supersede").handler;
    const pair = (who: AuthContext, tag: string) => {
      const mk = (text: string) => createNote({ workspace_id: who.workspace_id, agent_id: who.agent_id, text, type: "memory" });
      return { old: mk(`${tag} shared-key old`), head: mk(`${tag} shared-key head`) };
    };
    const a = pair(auth, "owner");
    const b = pair(senderAuth, "sender");
    const input = (p: typeof a) => ({
      source_note_id: p.head.id,
      target_note_id: p.old.id,
      expected_target_updated_at_ms: p.old.updated_at_ms,
      idempotency_key: "shared-supersede-0001",
    });
    const first = handler(input(a), auth) as { relation_id: string };
    const other = handler(input(b), senderAuth) as { relation_id: string; target_note_id: string };
    expect(other.target_note_id).toBe(b.old.id);
    expect(other.relation_id).not.toBe(first.relation_id);
    expect((handler(input(a), auth) as { relation_id: string }).relation_id).toBe(first.relation_id);
    expect(code(() => handler({ ...input(a), source_note_id: b.head.id }, auth))).toBe("CONFLICT");
  });

  test("extraction_review: two agents can use one key for their own candidates", () => {
    const candidate = (who: AuthContext, session: string) => {
      const saved = saveMessage({
        workspace_id: who.workspace_id,
        agent_id: who.agent_id,
        session_id: session,
        role: "user",
        content: `remember ${who.agent_name} likes tea`,
      });
      if (!saved.id) throw new Error("message was not saved");
      const run = createExtractionRun({
        auth: who,
        session_id: session,
        source_start_id: saved.id,
        source_end_id: saved.id,
        extractor_version: "shared-key-v1",
        prompt_hash: "b".repeat(64),
        candidates: [{ text: `${who.agent_name} likes tea`, source_message_ids: [saved.id], confidence: 0.9 }],
      });
      return run.candidates[0]!.id as string;
    };
    const review = tool("extraction_review").handler;
    const input = (candidate_id: string) => ({
      candidate_id,
      action: "reject",
      expected_review_version: 0,
      idempotency_key: "shared-review-0001",
    });
    const ca = candidate(auth, "shared-key-owner");
    const cb = candidate(senderAuth, "shared-key-sender");
    const done = review(input(ca), auth);
    expect((review(input(cb), senderAuth) as { candidate_id: string }).candidate_id).toBe(cb);
    expect(review(input(ca), auth)).toEqual(done);
    expect(code(() => review(input(cb), auth))).toBe("CONFLICT");
  });
});
