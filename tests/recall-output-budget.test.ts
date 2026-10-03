import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import { recall, recallBaseline } from "../src/services/recall.ts";
import { getRecallTrace } from "../src/services/recall-traces.ts";
import { saveMessage, sessionExpand } from "../src/services/sessions.ts";

let workspaceId = "";
let agentId = "";

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Recall output budget", slug: "recall-output-budget" });
  workspaceId = workspace.id;
  agentId = createAgent({ name: "recall-budget-agent", workspaceSlug: workspace.slug }).id;
});

function recallNote(query: string, limit?: number) {
  return recall({
    workspace_id: workspaceId,
    caller_agent_id: agentId,
    is_admin: false,
    query,
    scope: "notes",
    ...(limit === undefined ? {} : { limit }),
    mode: "fts5",
    deep: false,
    deep_llm: false,
  });
}

describe("default recall output budget", () => {
  test("long mixed-Unicode note is bounded with honest full-body disclosure", async () => {
    const marker = "recallbudgetunicode";
    const fullText = `${marker}\n${"Привет мир 🌍 café 漢字 — line \\ quoted \"json\"\n".repeat(1_600)}`;
    const created = createNote({ workspace_id: workspaceId, agent_id: agentId, type: "memory", text: fullText });

    const result = await recallNote(marker);
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4_000);
    expect(parsed.completeness.status).toBe("partial");
    expect(parsed.results[0].completeness).toBe("excerpt");
    expect(parsed.results[0].full_body_request).toEqual({ tool: "note_get", arguments: { id: created.id } });
    expect(parsed.results[0].text).toContain(marker);
    expect(parsed.results[0].text).not.toBe(fullText);
    expect(getNote(workspaceId, created.id, agentId, false).text).toBe(fullText);
  });

  test("short note text and existing result fields are preserved", async () => {
    const text = "recallbudgetshort exact short body";
    const created = createNote({ workspace_id: workspaceId, agent_id: agentId, type: "memory", text });

    const result = await recallNote("recallbudgetshort", 1);

    expect(result.results[0]!.id).toBe(created.id);
    expect(result.results[0]!.text).toBe(text);
    expect(result.results[0]!.source).toBe("notes");
    expect(result.results[0]!.completeness).toBe("complete");
    expect(result.completeness.status).toBe("complete");
  });

  test("authorized recall bounds reachable metadata and note_get keeps the full row", async () => {
    const marker = "recallbudgetmetadata";
    const metadata = { detail: "漢字🧪abc123 ".repeat(3_000) };
    const created = createNote({
      workspace_id: workspaceId,
      agent_id: agentId,
      type: "memory",
      text: `${marker} short body`,
      metadata,
    });

    const result = await recallNote(marker, 1);
    const serialized = JSON.stringify(result);
    const row = result.results[0]!;

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4_000);
    expect(result.completeness.status).toBe("partial");
    expect(row.completeness).toBe("excerpt");
    expect(row.omitted_fields).toContain("metadata");
    expect(row.full_body_request).toEqual({ tool: "note_get", arguments: { id: created.id } });
    expect(getNote(workspaceId, created.id, agentId, false).metadata).toEqual(metadata);
  });

  test("default-limit recall bounds reachable top-level and multi-hit overhead without silent drops", async () => {
    const marker = `recallbudgetoverhead${"x".repeat(850)}`;
    const createdIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      createdIds.push(createNote({
        workspace_id: workspaceId,
        agent_id: agentId,
        type: "memory",
        text: `${marker} result ${i}`,
        metadata: { label: `ordinary-${i}`, detail: "normal metadata value" },
      }).id);
    }

    const result = await recallNote(marker);
    const serialized = JSON.stringify(result);
    const disclosedIds = [
      ...result.results.map((row) => row.id),
      ...result.completeness.omitted_results!.ids,
    ];

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4_000);
    expect(result.completeness.status).toBe("partial");
    expect(result.completeness.omitted_fields).toContain("sanitized_query");
    expect(result.results.length + result.completeness.omitted_results!.count).toBe(10);
    expect(new Set(disclosedIds)).toEqual(new Set(createdIds));
  });

  test("max-limit recall preserves retrieval order while disclosing every omitted result", async () => {
    const marker = "recallbudgetresultomission";
    for (let i = 0; i < 50; i++) {
      createNote({
        workspace_id: workspaceId,
        agent_id: agentId,
        type: "memory",
        text: `${marker} ordinary result ${i}`,
        metadata: { label: `ordinary-${i}` },
      });
    }
    const sibling = createAgent({ name: "recall-budget-sibling", workspaceSlug: "recall-output-budget" });
    const privateNote = createNote({
      workspace_id: workspaceId,
      agent_id: sibling.id,
      type: "memory",
      text: `${marker} must remain private`,
      visibility: "private",
    });
    const params = {
      workspace_id: workspaceId,
      caller_agent_id: agentId,
      is_admin: false,
      query: marker,
      scope: "notes" as const,
      limit: 50,
      mode: "fts5" as const,
      deep: false,
      deep_llm: false,
    };

    const baseline = await recallBaseline(params);
    const result = await recall(params);
    if (!("completeness" in result)) throw new Error("notes recall must be bounded");
    const completeness = result.completeness as { omitted_results: { count: number; ids: string[] } };
    const disclosedIds = [
      ...result.results.map((row) => row.id),
      ...completeness.omitted_results.ids,
    ];

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_000);
    expect(completeness.omitted_results.count).toBeGreaterThan(0);
    expect(disclosedIds).toEqual(baseline.results.map((row) => row.id));
    expect(disclosedIds).not.toContain(privateNote.id);
  });

  test("trace=true keeps trace_id and drops results instead (F-104)", async () => {
    const marker = "recallbudgettraceid";
    for (let i = 0; i < 40; i++) {
      createNote({ workspace_id: workspaceId, agent_id: agentId, type: "memory", text: `${marker} filler note ${i} with more words to fill the envelope` });
    }
    process.env.QOOPIA_V4_RECALL_EXPLAIN = "true";
    try {
      const result = await recall({
        workspace_id: workspaceId, caller_agent_id: agentId, is_admin: false, query: marker,
        scope: "notes", limit: 50, mode: "fts5", deep: false, deep_llm: false, explain: true, trace: true,
      }) as Awaited<ReturnType<typeof recall>> & { trace_id?: string };
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_000);
      expect(result.completeness.status).toBe("partial");
      expect(typeof result.trace_id).toBe("string");
      const auth = { workspace_id: workspaceId, agent_id: agentId, agent_name: "recall-budget-agent", type: "standard", source: "api-key" } as const;
      expect(getRecallTrace({ auth, trace_id: result.trace_id! }).items.length).toBeGreaterThan(0);
    } finally {
      delete process.env.QOOPIA_V4_RECALL_EXPLAIN;
    }
  });

  test("scope=sessions and scope=all are bounded too, with a working session_expand pointer (F-107)", async () => {
    const marker = "recallbudgetsessions";
    const body = `${marker} ${"long transcript line about harbour logistics\n".repeat(1_500)}`;
    for (let i = 0; i < 3; i++) {
      saveMessage({ session_id: "recall-budget-session", workspace_id: workspaceId, agent_id: agentId, role: "user", content: `${body} ${i}` });
      createNote({ workspace_id: workspaceId, agent_id: agentId, type: "memory", text: `${body} note ${i}` });
    }
    for (const scope of ["sessions", "all"] as const) {
      const result = await recall({ workspace_id: workspaceId, caller_agent_id: agentId, is_admin: false, query: marker, scope, limit: 50, mode: "fts5" });
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_000);
      expect(result.completeness.status).toBe("partial");
      expect(result.results.length + (result.completeness.omitted_results?.count ?? 0)).toBe(scope === "sessions" ? 3 : 6);
      for (const row of result.results.filter((r) => r.source === "sessions")) {
        const request = row.full_body_request as { tool: string; arguments: { start_id: number; end_id: number; session_id: string } };
        expect(request.tool).toBe("session_expand");
        const expanded = sessionExpand({ workspace_id: workspaceId, agent_id: agentId, ...request.arguments });
        expect(expanded.messages.map((m) => String(m.id))).toEqual([row.id]);
        expect(expanded.messages[0]!.content.startsWith(body)).toBe(true);
      }
    }
  });
});

describe("recall excerpt budget is shared across kept rows (F-305)", () => {
  test("ten 2 KB notes: most rows kept and every kept row carries a useful excerpt", async () => {
    const marker = "recallbudgetsharedexcerpt";
    for (let i = 0; i < 10; i++) {
      createNote({ workspace_id: workspaceId, agent_id: agentId, type: "memory",
        text: `${marker} row ${i} ` + "content words ".repeat(150) });
    }
    const result = await recallNote(marker);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_000);
    expect(result.results.length + result.completeness.omitted_results!.count).toBe(10);
    expect(result.results.length).toBeGreaterThanOrEqual(4);
    for (const row of result.results) expect(Array.from(row.text).length).toBeGreaterThanOrEqual(100);
  });
});
