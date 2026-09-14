import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { createNoteRelation } from "../src/services/note-relations.ts";
import { agentSend } from "../src/services/agent-comm.ts";
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
