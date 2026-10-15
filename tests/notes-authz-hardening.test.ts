// Audit 5.0.21 A3d-01..06: note/entity authorization edges found by the MCP authz probe.
import { afterEach, beforeAll, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, deleteNote, getNote, listNotes, updateNote } from "../src/services/notes.ts";
import { listActivity } from "../src/services/activity.ts";
import { createNoteRelation } from "../src/services/note-relations.ts";
import { supersedeExistingNote } from "../src/services/note-temporal.ts";
import { setMemoryPolicy } from "../src/services/memory-policy.ts";
import { addLink, upsertEntity } from "../src/services/entities.ts";
import { registerBridgeTools } from "../src/bridges/api.ts";
import { registerTools } from "../src/mcp/tools.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

let ws = "";
const id: Record<string, string> = {};
const as = (who: string, type = "standard") =>
  ({ agent_id: id[who]!, agent_name: `w2-${who}`, workspace_id: ws, type, source: "api-key" }) as AuthContext;
const code = (fn: () => unknown) => {
  try { fn(); return "OK"; } catch (e: any) { return e.code ?? String(e); }
};
const manual = (who: string, on: boolean) =>
  setMemoryPolicy({ workspace_id: ws, agent_id: id[who]!, mode: on ? "manual" : "auto", actor_id: id.owner! });

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "W2 authz", slug: "w2-authz" });
  ws = w.id;
  for (const [n, t] of [["owner", "owner"], ["alice", "standard"], ["bob", "standard"]] as const)
    id[n] = createAgent({ name: `w2-${n}`, workspaceSlug: w.slug, type: t }).id;
});
afterEach(() => { delete process.env.QOOPIA_V4_BITEMPORAL; });

test("A3d-01: a private note is never superseded by a shared one, so its id cannot leak", () => {
  process.env.QOOPIA_V4_BITEMPORAL = "true";
  const priv = createNote({ workspace_id: ws, agent_id: id.alice!, text: "alice private plan", visibility: "private" });
  expect(code(() => createNote({ workspace_id: ws, agent_id: id.alice!, text: "public successor", visibility: "workspace",
    supersedes_id: priv.id, expected_superseded_updated_at_ms: priv.updated_at_ms }))).toBe("INVALID_INPUT");
  // Nothing of the refused write is visible to the sibling: no successor, no activity naming the id.
  const acts = listActivity({ workspace_id: ws, caller_agent_id: id.bob!, is_admin: false }).items;
  expect(acts.some((a: any) => JSON.stringify(a).includes(priv.id))).toBe(false);
  // The existing-successor path shares the rule.
  const shared = createNote({ workspace_id: ws, agent_id: id.alice!, text: "shared note" });
  expect(code(() => supersedeExistingNote({ workspace_id: ws, agent_id: id.alice!, is_admin: false,
    successor_id: shared.id, predecessor_id: priv.id, expected_updated_at_ms: priv.updated_at_ms }))).toBe("INVALID_INPUT");
  // A private chain of one author still works.
  const next = createNote({ workspace_id: ws, agent_id: id.alice!, text: "private successor", visibility: "private",
    supersedes_id: priv.id, expected_superseded_updated_at_ms: priv.updated_at_ms });
  expect((getNote(ws, next.id, id.alice!, false) as any).supersedes_id).toBe(priv.id);
});

test("A3d-02: manual holds supersede and delete the way it holds note_update", () => {
  const a = createNote({ workspace_id: ws, agent_id: id.alice!, text: "alice note A" });
  const b = createNote({ workspace_id: ws, agent_id: id.alice!, text: "alice note B" });
  const c = createNote({ workspace_id: ws, agent_id: id.alice!, text: "alice note C" });
  manual("alice", true);
  try {
    expect(code(() => updateNote({ workspace_id: ws, agent_id: id.alice!, is_admin: false, id: a.id, metadata: { status: "archived" } }))).toBe("APPROVAL_REQUIRED");
    expect(code(() => createNoteRelation({ auth: as("alice"), source_note_id: b.id, target_note_id: a.id, relation_type: "supersedes" }))).toBe("APPROVAL_REQUIRED");
    expect((db.query("SELECT json_extract(metadata,'$.status') s FROM notes WHERE id=?").get(a.id) as any).s).toBeNull();
    expect(db.query("SELECT 1 FROM note_relations WHERE source_note_id=? AND target_note_id=?").get(b.id, a.id)).toBeNull();
    expect(code(() => deleteNote(ws, id.alice!, c.id, false))).toBe("APPROVAL_REQUIRED");
    expect((db.query("SELECT deleted_at FROM notes WHERE id=?").get(c.id) as any).deleted_at).toBeNull();
    // A non-supersede relation is not memory content and stays available.
    expect(code(() => createNoteRelation({ auth: as("alice"), source_note_id: b.id, target_note_id: a.id, relation_type: "related" as never }))).not.toBe("APPROVAL_REQUIRED");
    process.env.QOOPIA_V4_BITEMPORAL = "true";
    const d = createNote({ workspace_id: ws, agent_id: id.bob!, text: "bob d" });
    expect(code(() => supersedeExistingNote({ workspace_id: ws, agent_id: id.alice!, is_admin: false,
      successor_id: b.id, predecessor_id: c.id, expected_updated_at_ms: c.updated_at_ms }))).toBe("APPROVAL_REQUIRED");
    expect(d.id).toBeTruthy();
  } finally {
    manual("alice", false);
  }
  expect(code(() => deleteNote(ws, id.alice!, c.id, false))).toBe("OK");
});

test("A3d-03: include_deleted shows a caller only its own deleted notes", () => {
  const n = createNote({ workspace_id: ws, agent_id: id.alice!, text: "alice retracted fact XYZZY" });
  deleteNote(ws, id.alice!, n.id, false);
  const seen = (caller: string, admin: boolean) =>
    listNotes({ workspace_id: ws, caller_agent_id: id[caller]!, is_admin: admin, include_deleted: true, limit: 500 })
      .items.some((r: any) => r.id === n.id);
  expect(seen("bob", false)).toBe(false);
  expect(seen("alice", false)).toBe(true);
  expect(seen("owner", true)).toBe(true);
});

test("A3d-04: entity_link respects page authorship, private pages and manual", () => {
  const page = upsertEntity({ workspace_id: ws, type: "knowledge", slug: "w2-alice-page", title: "Alice page" }, as("alice"));
  const other = upsertEntity({ workspace_id: ws, type: "knowledge", slug: "w2-bob-page", title: "Bob page" }, as("bob"));
  // bob may cite alice's page from his own page, but not write links into hers.
  expect(code(() => addLink({ workspace_id: ws, source_entity_id: other.id, target_entity_id: page.id, relation_type: "related_to" }, as("bob")))).toBe("OK");
  expect(code(() => addLink({ workspace_id: ws, source_entity_id: page.id, target_entity_id: other.id, relation_type: "related_to" }, as("bob")))).toBe("FORBIDDEN");
  const privId = "01W2PRIVATESKILL00000000000";
  db.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title,metadata,authority_private,authority_owner_id) VALUES (?,?,'skill','w2-priv-skill','Private skill','{}',1,?)").run(privId, ws, id.alice!);
  const probe = (target: string) => code(() => addLink({ workspace_id: ws, source_entity_id: other.id, target_entity_id: target, relation_type: "x" }, as("bob")));
  expect(probe(privId)).toBe(probe("01NOPE000000000000000000000"));
  expect(probe(privId)).toBe("NOT_FOUND");
  manual("bob", true);
  try {
    expect(code(() => addLink({ workspace_id: ws, source_entity_id: other.id, target_entity_id: page.id, relation_type: "depends_on" }, as("bob")))).toBe("APPROVAL_REQUIRED");
  } finally {
    manual("bob", false);
  }
});

test("A3d-05/06: a bootstrapped connection gets neither V2 aliases nor bridge tools", () => {
  const names: string[] = [];
  const recorder = { registerTool(name: string) { names.push(name); return {}; }, tool(name: string) { names.push(name); return {}; } } as unknown as McpServer;
  const auth = { ...as("owner", "owner"), tool_profile: "full" } as AuthContext;
  const previous = process.env.QOOPIA_ENABLE_V2_COMPAT;
  process.env.QOOPIA_ENABLE_V2_COMPAT = "true";
  try {
    registerTools(recorder, () => auth, "full", { isSteward: true, bootstrapProfile: "memory-worker" });
    registerBridgeTools(recorder, () => auth, "memory-worker");
  } finally {
    if (previous === undefined) delete process.env.QOOPIA_ENABLE_V2_COMPAT; else process.env.QOOPIA_ENABLE_V2_COMPAT = previous;
  }
  for (const alias of ["create", "update", "delete", "list", "get", "note"]) expect(names).not.toContain(alias);
  expect(names.some((name) => name.startsWith("bridge_"))).toBe(false);
  expect(names).toContain("note_create");
});

test("A3d-05: the V2 'note' alias does not resolve a sibling's private project", async () => {
  const project = createNote({ workspace_id: ws, agent_id: id.alice!, text: "Secret project W2", type: "project", visibility: "private" });
  const handlers = new Map<string, (args: any) => any>();
  const recorder = { registerTool(name: string, _c: unknown, handler: (args: any) => any) { handlers.set(name, handler); return {}; }, tool() { return {}; } } as unknown as McpServer;
  const previous = process.env.QOOPIA_ENABLE_V2_COMPAT;
  process.env.QOOPIA_ENABLE_V2_COMPAT = "true";
  try { registerTools(recorder, () => as("bob"), "full", {}); }
  finally { if (previous === undefined) delete process.env.QOOPIA_ENABLE_V2_COMPAT; else process.env.QOOPIA_ENABLE_V2_COMPAT = previous; }
  for (const ref of [project.id, "Secret project W2"]) {
    await handlers.get("note")!({ text: `bob note for ${ref}`, project: ref });
    const row = db.query("SELECT project_id FROM notes WHERE text=?").get(`bob note for ${ref}`) as { project_id: string | null };
    expect(row.project_id).toBeNull();
  }
});
