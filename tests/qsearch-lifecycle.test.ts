/**
 * Tests for the search & lifecycle PR:
 *  - migration 009 creates activity_fts and AI/AD triggers
 *  - recall(scope='activity') uses FTS5 (rank > 0)
 *  - recall(scope='sessions') hits session_messages_fts and respects
 *    per-agent visibility
 *  - recall(scope='all') unions notes + activity + sessions
 *  - listNotes default-excludes metadata.status='archived'; opting in
 *    via include_archived=true surfaces them
 *  - recall default-excludes archived notes
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, listNotes, updateNote } from "../src/services/notes.ts";
import { logActivity } from "../src/services/activity.ts";
import { saveMessage } from "../src/services/sessions.ts";
import { recall } from "../src/services/recall.ts";
import { brief } from "../src/services/brief.ts";

let WORKSPACE_ID = "";
let AGENT_A_ID = "";
let AGENT_B_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "QSearch Lifecycle",
    slug: "qsearch-lifecycle",
  });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "qsl-agent-a", workspaceSlug: ws.slug });
  AGENT_A_ID = a.id;
  const b = createAgent({ name: "qsl-agent-b", workspaceSlug: ws.slug });
  AGENT_B_ID = b.id;
});

describe("migration 009 — activity_fts", () => {
  test("activity_fts virtual table exists", async () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='activity_fts'",
      )
      .get();
    expect(row).toBeTruthy();
  });

  test("activity_ai trigger is registered", async () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='activity_ai'",
      )
      .get();
    expect(row).toBeTruthy();
  });

  test("activity_ad trigger is registered", async () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='activity_ad'",
      )
      .get();
    expect(row).toBeTruthy();
  });

  test("INSERT into activity propagates to activity_fts via AI trigger", async () => {
    logActivity({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      action: "note_create",
      entity_type: "note",
      entity_id: "00000000000000000000000000",
      project_id: null,
      summary: "fts trigger smoke unique-keyword-zebrafish",
    });
    const hit = db
      .prepare(
        "SELECT rowid FROM activity_fts WHERE activity_fts MATCH ? LIMIT 1",
      )
      .get("zebrafish*") as { rowid: number } | undefined;
    expect(hit).toBeTruthy();
  });
});

describe("recall scope='activity' uses FTS", () => {
  test("returns matching activity row by FTS keyword", async () => {
    logActivity({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      action: "note_update",
      entity_type: "note",
      entity_id: "00000000000000000000000001",
      project_id: null,
      summary: "FTS keyword giraffe quick brown fox",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      query: "giraffe",
      scope: "activity",
    });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.text).toContain("giraffe");
    expect(r.results[0]!.source).toBe("activity");
  });
});

describe("recall scope='sessions'", () => {
  test("matches session messages owned by the caller", async () => {
    saveMessage({
      workspace_id: WORKSPACE_ID,
      session_id: "qsl-session-A",
      agent_id: AGENT_A_ID,
      role: "user",
      content: "discussing pelican migrations in winter",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      query: "pelican",
      scope: "sessions",
    });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.text).toContain("pelican");
    expect(r.results[0]!.source).toBe("sessions");
    expect(r.results[0]!.type).toBe("session_message:user");
    expect((r.results[0]!.metadata as Record<string, unknown>).session_id).toBe(
      "qsl-session-A",
    );
  });

  test("hides another agent's session messages from a non-admin", async () => {
    saveMessage({
      workspace_id: WORKSPACE_ID,
      session_id: "qsl-session-B",
      agent_id: AGENT_B_ID,
      role: "user",
      content: "secret keyword okapi-only-for-B",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      query: "okapi",
      scope: "sessions",
    });
    expect(r.results.length).toBe(0);
  });

  test("admin sees other agents' session messages", async () => {
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: true,
      query: "okapi",
      scope: "sessions",
    });
    expect(r.results.length).toBeGreaterThan(0);
  });
});

describe("recall scope='all' unions every layer", () => {
  test("returns hits from notes, activity, and sessions for one query", async () => {
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "axolotl unique marker for notes layer",
    });
    logActivity({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      action: "note_update",
      entity_type: "note",
      entity_id: "00000000000000000000000002",
      project_id: null,
      summary: "axolotl marker activity layer",
    });
    saveMessage({
      workspace_id: WORKSPACE_ID,
      session_id: "qsl-session-all",
      agent_id: AGENT_A_ID,
      role: "assistant",
      content: "axolotl marker session layer",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      query: "axolotl",
      scope: "all",
      limit: 50,
    });
    const sources = new Set(r.results.map((x) => x.source));
    expect(sources.has("notes")).toBe(true);
    expect(sources.has("activity")).toBe(true);
    expect(sources.has("sessions")).toBe(true);
  });
});

describe("archive lifecycle", () => {
  test("listNotes default-excludes metadata.status='archived'", async () => {
    const live = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "archive-test live note narwhal",
      metadata: { status: "active" },
    });
    const arch = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "archive-test archived note narwhal",
      metadata: { status: "archived" },
    });

    const def = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      limit: 500,
    });
    const ids = def.items.map((n) => n.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(arch.id);
  });

  test("listNotes with include_archived=true surfaces archived rows", async () => {
    const r = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      include_archived: true,
      limit: 500,
    });
    const archived = r.items.find(
      (n) =>
        (n.metadata as Record<string, unknown>).status === "archived" &&
        n.text.includes("narwhal"),
    );
    expect(archived).toBeTruthy();
  });

  test("recall default-excludes archived notes", async () => {
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "umbra-keyword live entry",
      metadata: { status: "active" },
    });
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "umbra-keyword archived entry",
      metadata: { status: "archived" },
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      query: "umbra-keyword",
      scope: "notes",
    });
    const statuses = r.results.map(
      (x) => (x.metadata as Record<string, unknown>).status,
    );
    expect(statuses).toContain("active");
    expect(statuses).not.toContain("archived");
  });

  test("recall with include_archived=true surfaces archived hits", async () => {
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      query: "umbra-keyword",
      scope: "notes",
      include_archived: true,
    });
    const statuses = r.results.map(
      (x) => (x.metadata as Record<string, unknown>).status,
    );
    expect(statuses).toContain("archived");
  });

  test("brief() open tasks excludes archived (P2 codex regression guard)", async () => {
    // Codex P2: a task transitioned by archive-stale.ts from status='done'
    // to status='archived' must NOT reappear in brief() open-task lists.
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "open task — penguin should appear",
      type: "task",
      metadata: { status: "todo" },
    });
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "archived done task — penguin should NOT appear",
      type: "task",
      metadata: { status: "archived" },
    });
    const b = brief({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      limit_per_section: 50,
    });
    const texts = b.open_tasks.items.map((t) => t.text);
    expect(texts.some((t) => t.includes("open task — penguin"))).toBe(true);
    expect(texts.some((t) => t.includes("archived done task — penguin"))).toBe(
      false,
    );
  });

  test("updateNote can flip status to archived (round-trip)", async () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      text: "round-trip target ostrich",
      metadata: { status: "todo" },
    });
    updateNote({
      id: n.id,
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_A_ID,
      is_admin: false,
      metadata: { status: "archived" },
    });
    const def = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      limit: 500,
    });
    expect(def.items.find((x) => x.id === n.id)).toBeUndefined();
    const incl = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A_ID,
      is_admin: false,
      include_archived: true,
      limit: 500,
    });
    const got = incl.items.find((x) => x.id === n.id);
    expect(got).toBeTruthy();
    expect((got!.metadata as Record<string, unknown>).status).toBe("archived");
  });
});
