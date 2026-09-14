import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import { recall, recallBaseline } from "../src/services/recall.ts";

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
      ...result.completeness.omitted_results.ids,
    ];

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4_000);
    expect(result.completeness.status).toBe("partial");
    expect(result.completeness.omitted_fields).toContain("sanitized_query");
    expect(result.results.length + result.completeness.omitted_results.count).toBe(10);
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
});
