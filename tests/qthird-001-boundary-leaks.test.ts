/**
 * QTHIRD-001 regression: prove the obscure paths around the visibility
 * boundary are also closed.
 *
 * The 3rd Codex review found that ADR-014's per-note visibility flag
 * leaked through:
 *   1. createNote logs the first 80 chars of the text into the shared
 *      activity table — a non-owner reading activity_list saw private
 *      content.
 *   2. recall(scope='activity'|'all') surfaced those rows too.
 *   3. updateNote / deleteNote had no visibility check, so any agent
 *      with the ID (which they got from #1 or #2) could mutate or
 *      destroy a sibling agent's private note.
 *
 * These tests exercise each path directly and assert the leak is closed.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import {
  createNote,
  getNote,
  updateNote,
  deleteNote,
} from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import { listActivity } from "../src/services/activity.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let WORKSPACE_ID = "";
let AGENT_A = "";
let AGENT_B = "";
let ADMIN_AGENT = "";

let B_PRIVATE_NOTE_ID = "";
const B_SECRET_TEXT =
  "qthirdmarker private payload only b should ever see this content";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "QTHIRD-001 Test",
    slug: "qthird-001-test",
  });
  WORKSPACE_ID = ws.id;
  AGENT_A = createAgent({ name: "qthird-a", workspaceSlug: ws.slug }).id;
  AGENT_B = createAgent({ name: "qthird-b", workspaceSlug: ws.slug }).id;
  ADMIN_AGENT = createAgent({
    name: "qthird-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  }).id;

  B_PRIVATE_NOTE_ID = createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_B,
    text: B_SECRET_TEXT,
    visibility: "private",
  }).id;
});

describe("QTHIRD-001: activity log does not leak private note contents", () => {
  test("createNote — private note's activity row carries no text preview", async () => {
    // Caller is the owner so the row is visible — but its summary must
    // never embed the original text, regardless of who reads it.
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_B,
      is_admin: false,
      entity_type: "note",
      limit: 50,
    });
    const ownRow = result.items.find((r) => r.entity_id === B_PRIVATE_NOTE_ID);
    expect(ownRow).toBeDefined();
    expect(ownRow!.summary).not.toContain(B_SECRET_TEXT);
    expect(ownRow!.summary).not.toContain(B_SECRET_TEXT.slice(0, 40));
  });

  test("listActivity — agent A does not see agent B's private-note activity row", async () => {
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      entity_type: "note",
      limit: 50,
    });
    const ids = result.items.map((r) => r.entity_id);
    expect(ids).not.toContain(B_PRIVATE_NOTE_ID);
    // The summary text must not appear anywhere either.
    for (const r of result.items) {
      expect(r.summary).not.toContain(B_SECRET_TEXT);
    }
  });

  test("listActivity — admin sees agent B's private-note activity row", async () => {
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: ADMIN_AGENT,
      is_admin: true,
      entity_type: "note",
      limit: 50,
    });
    const ids = result.items.map((r) => r.entity_id);
    expect(ids).toContain(B_PRIVATE_NOTE_ID);
  });
});

describe("QTHIRD-001: recall(scope='activity'|'all') does not leak", () => {
  test("recall(scope='activity') — agent A finds nothing for B's private content", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      query: "qthirdmarker",
      scope: "activity",
      limit: 50,
    });
    const ids = result.results.map((r) => r.id);
    // No activity row tied to B's private note may surface.
    // (We match by entity-id leakage indirectly: ensure no result text
    //  references the private payload.)
    for (const r of result.results) {
      expect(r.text).not.toContain(B_SECRET_TEXT);
    }
    expect(ids).not.toContain(B_PRIVATE_NOTE_ID);
  });

  test("recall(scope='all') — agent A still cannot see B's private activity", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      query: "qthirdmarker",
      scope: "all",
      limit: 50,
    });
    for (const r of result.results) {
      expect(r.text).not.toContain(B_SECRET_TEXT);
    }
  });
});

describe("QTHIRD-001: updateNote refuses non-owner non-admin on private", () => {
  test("agent A cannot update agent B's private note (NOT_FOUND, not FORBIDDEN)", async () => {
    let caught: unknown;
    try {
      updateNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_A,
        is_admin: false,
        id: B_PRIVATE_NOTE_ID,
        text: "attacker overwrite attempt",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QoopiaError);
    // Codex required: must be NOT_FOUND (existence-blind), never FORBIDDEN
    // — FORBIDDEN would confirm the ID points at a real note and leak
    // existence to a probing sibling.
    expect((caught as QoopiaError).code).toBe("NOT_FOUND");

    // The note text must be unchanged — verify via owner read.
    const owner = getNote(WORKSPACE_ID, B_PRIVATE_NOTE_ID, AGENT_B, false);
    expect(owner.text).toBe(B_SECRET_TEXT);
  });

  test("agent B (owner) can still update its own private note", async () => {
    const result = updateNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_B,
      is_admin: false,
      id: B_PRIVATE_NOTE_ID,
      metadata: { touched_by_owner: true },
    });
    expect(result.updated).toBe(true);
    const owner = getNote(WORKSPACE_ID, B_PRIVATE_NOTE_ID, AGENT_B, false);
    expect(owner.metadata).toMatchObject({ touched_by_owner: true });
    expect(owner.text).toBe(B_SECRET_TEXT);
  });

  test("admin can update agent B's private note", async () => {
    const result = updateNote({
      workspace_id: WORKSPACE_ID,
      agent_id: ADMIN_AGENT,
      is_admin: true,
      id: B_PRIVATE_NOTE_ID,
      metadata: { touched_by_admin: true },
    });
    expect(result.updated).toBe(true);
  });
});

describe("QTHIRD-001: deleteNote refuses non-owner non-admin on private", () => {
  test("agent A cannot delete agent B's private note", async () => {
    // Create a fresh private note so we don't poison the prior tests.
    const id = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_B,
      text: "qthird-delete-target",
      visibility: "private",
    }).id;

    let caught: unknown;
    try {
      deleteNote(WORKSPACE_ID, AGENT_A, id, false);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QoopiaError);
    expect((caught as QoopiaError).code).toBe("NOT_FOUND");

    // Owner read still succeeds — the note was not deleted.
    const owner = getNote(WORKSPACE_ID, id, AGENT_B, false);
    expect(owner.id).toBe(id);
    expect(owner.deleted_at).toBeNull();
  });

  test("agent B (owner) can delete its own private note", async () => {
    const id = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_B,
      text: "qthird-owner-delete",
      visibility: "private",
    }).id;
    const r = deleteNote(WORKSPACE_ID, AGENT_B, id, false);
    expect(r.deleted).toBe(true);
    expect(() => getNote(WORKSPACE_ID, id, AGENT_B, false)).toThrow(/not found/);
  });

  test("admin can delete agent B's private note", async () => {
    const id = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_B,
      text: "qthird-admin-delete",
      visibility: "private",
    }).id;
    const r = deleteNote(WORKSPACE_ID, ADMIN_AGENT, id, true);
    expect(r.deleted).toBe(true);
  });
});

describe("QTHIRD-001: workspace notes still surface in activity for siblings", () => {
  test("non-private notes' activity is still visible to other agents (no regression)", async () => {
    const id = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_B,
      text: "qthird-shared-marker workspace visible",
    }).id;
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      entity_type: "note",
      limit: 50,
    });
    const row = result.items.find((r) => r.entity_id === id);
    expect(row).toBeDefined();
    // Workspace-visibility activity keeps its informative preview.
    expect(row!.summary).toContain("qthird-shared-marker");
  });
});
