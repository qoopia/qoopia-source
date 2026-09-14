/**
 * Note service tests — exercise createNote / getNote / listNotes /
 * updateNote / deleteNote against a fresh in-temp-dir SQLite (set by
 * tests/setup.ts).  Each test file gets its own workspace+agent so suites
 * don't collide.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
} from "../src/services/notes.ts";
import { QoopiaError } from "../src/utils/errors.ts";
import { db } from "../src/db/connection.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Notes Test", slug: "notes-test" });
  WORKSPACE_ID = ws.id;
  const ag = createAgent({ name: "notes-tester", workspaceSlug: ws.slug });
  AGENT_ID = ag.id;
});

afterAll(() => {
  // setup.ts unlinks the temp dir on process exit; nothing to do here.
});

describe("createNote", () => {
  test("creates a basic note and assigns an id", () => {
    const result = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "first note",
    });
    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[0-9A-Z]{26}$/); // ULID format
    expect(result.type).toBe("note");

    const fetched = getNote(WORKSPACE_ID, result.id, AGENT_ID, false);
    expect(fetched.text).toBe("first note");
    expect(fetched.workspace_id).toBe(WORKSPACE_ID);
    expect(fetched.deleted_at).toBeNull();
  });

  test("rejects empty text", () => {
    expect(() =>
      createNote({ workspace_id: WORKSPACE_ID, agent_id: AGENT_ID, text: "" }),
    ).toThrow(QoopiaError);
  });

  test("rejects text containing a Qoopia secret", () => {
    expect(() =>
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "leaked q_EXAMPLE_PLACEHOLDER_KEY",
      }),
    ).toThrow(QoopiaError);
  });

  test("rejects unknown project_id", () => {
    expect(() =>
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "with bogus project",
        project_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toThrow(/project_id not found/);
  });

  test("typed notes are persisted with their type", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "remember the milk",
      type: "memory",
      tags: ["chore"],
    });
    const fetched = getNote(WORKSPACE_ID, r.id, AGENT_ID, false);
    expect(fetched.type).toBe("memory");
    expect(fetched.tags).toEqual(["chore"]);
  });
});

describe("listNotes", () => {
  test("filters by type and respects limit", () => {
    for (let i = 0; i < 3; i++) {
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: `task #${i}`,
        type: "task",
      });
    }

    const result = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      type: "task",
      limit: 2,
    });
    expect(result.items.length).toBe(2);
    expect(result.items.every((n) => n.type === "task")).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.has_more).toBe(true);
  });
});

describe("updateNote", () => {
  test("merges metadata by default and replaces with metadata_replace", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "merge target",
      metadata: { a: 1, b: 2 },
    });

    updateNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      is_admin: false,
      id: r.id,
      metadata: { b: 99, c: 3 },
    });
    const merged = getNote(WORKSPACE_ID, r.id, AGENT_ID, false);
    expect(merged.metadata).toEqual({ a: 1, b: 99, c: 3 });

    updateNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      is_admin: false,
      id: r.id,
      metadata_replace: { only: "this" },
    });
    const replaced = getNote(WORKSPACE_ID, r.id, AGENT_ID, false);
    expect(replaced.metadata).toEqual({ only: "this" });
  });

  test("rejects mutually exclusive metadata args", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "exclusive args",
    });
    expect(() =>
      updateNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        is_admin: false,
        id: r.id,
        metadata: { x: 1 },
        metadata_replace: { y: 2 },
      }),
    ).toThrow(/mutually exclusive/);
  });
});

describe("deleteNote", () => {
  test("soft-deletes the note and hides it from getNote", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "to be deleted",
    });
    const result = deleteNote(WORKSPACE_ID, AGENT_ID, r.id, false);
    expect(result.deleted).toBe(true);
    expect(() => getNote(WORKSPACE_ID, r.id, AGENT_ID, false)).toThrow(/not found/);
  });

  test("listNotes hides soft-deleted notes by default", () => {
    const r = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "hide-after-delete",
      type: "decision",
    });
    deleteNote(WORKSPACE_ID, AGENT_ID, r.id, false);
    const visible = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      type: "decision",
    });
    expect(visible.items.find((n) => n.id === r.id)).toBeUndefined();
  });
});

describe("updated_at_ms invariant", () => {
  test("create/update/delete remain strictly ordered inside one wall-clock second", () => {
    const realDateNow = Date.now;
    const fixedMs = realDateNow() + 60_000;
    Date.now = () => fixedMs;
    try {
      const first = createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "same-second-first",
      });
      const second = createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "same-second-second",
      });
      // nextNoteWriteTimestamp() takes max(Date.now(), previous+1, MAX(updated_at_ms)+1),
      // so an earlier row already at or past fixedMs legitimately pushes this one
      // higher. The invariant under test is strict ordering, not the absolute value —
      // asserting equality here coupled the test to whatever else had written to the
      // shared database first, and that is what failed in CI but not locally.
      expect(first.updated_at_ms).toBeGreaterThanOrEqual(fixedMs);
      expect(second.updated_at_ms).toBe(first.updated_at_ms + 1);
      expect(Date.parse(first.updated_at)).toBe(first.updated_at_ms);
      expect(Date.parse(second.updated_at)).toBe(second.updated_at_ms);

      const firstUpdate = updateNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        is_admin: false,
        id: first.id,
        text: "same-second-first-updated",
      });
      expect(firstUpdate.updated_at_ms).toBe(second.updated_at_ms + 1);

      const ordered = listNotes({
        workspace_id: WORKSPACE_ID,
        caller_agent_id: AGENT_ID,
        is_admin: false,
        order: "updated_desc",
        limit: 100,
      });
      expect(ordered.items.findIndex((item) => item.id === first.id)).toBeLessThan(
        ordered.items.findIndex((item) => item.id === second.id),
      );

      const deleted = deleteNote(WORKSPACE_ID, AGENT_ID, first.id, false);
      expect(deleted.updated_at_ms).toBe(firstUpdate.updated_at_ms + 1);
      const deletedRow = db
        .prepare(`SELECT deleted_at, updated_at, updated_at_ms FROM notes WHERE id = ?`)
        .get(first.id) as {
        deleted_at: string;
        updated_at: string;
        updated_at_ms: number;
      };
      expect(deletedRow.updated_at_ms).toBe(deleted.updated_at_ms);
      expect(deletedRow.deleted_at).toBe(deletedRow.updated_at);
      expect(Date.parse(deletedRow.updated_at)).toBe(deletedRow.updated_at_ms);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("migration trigger prevents a direct insert from creating another zero row", () => {
    const id = "01WS3DIRECTINSERT00000000001";
    const updatedAt = "2026-07-16T18:20:30.456Z";
    db.prepare(
      `INSERT INTO notes
         (id, workspace_id, agent_id, type, text, updated_at, updated_at_ms)
       VALUES (?, ?, ?, 'note', 'trigger backstop', ?, 0)`,
    ).run(id, WORKSPACE_ID, AGENT_ID, updatedAt);
    const row = db
      .prepare(`SELECT updated_at_ms FROM notes WHERE id = ?`)
      .get(id) as { updated_at_ms: number };
    expect(row.updated_at_ms).toBe(Date.parse(updatedAt));
  });
});
