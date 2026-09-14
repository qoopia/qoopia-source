/**
 * Tests for the shadow sync --apply data-mutation path.
 * WS-4 apply engine safety and integrity coverage.
 *
 * The apply path mutates ONLY the target (Corsair) DB for direction M2C.
 * The Mac mini DB is opened read-only and is NEVER written. These tests use
 * /tmp scratch DBs only — production and Mac mini DBs are never touched.
 *
 * Coverage:
 *   1. M2C INSERT  — row only on Mac realized on target.
 *   2. M2C UPDATE  — row on both, Mac newer, overwrites target; post-apply parity.
 *   3. activity M2C append + origin_host stamped by receiver.
 *   4. sync_applied_hashes populated per mutated row; re-apply is a NO-OP.
 *   5. Conflict in scope ⇒ apply ABORTS, target unchanged.
 *   6. Forced mid-apply error ⇒ full rollback, ZERO partial writes.
 *   7. Apply never mutates the Mac source DB.
 *   8. C2M apply refused (would mutate Mac source).
 *   9. Post-apply: buildPlan shows the applied direction empty (parity).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlan,
  applyPlan,
  configureWritableSyncConnection,
  renderApplyReport,
  parseIsoToMs,
  SYNC_BUSY_TIMEOUT_MS,
  type ApplyResult,
} from "../src/services/shadow_sync.ts";

// -------------------- fixtures --------------------

const WORKSPACE = "01KMKRVYF2FN68D9N3C8BEGAHS";
const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const MIGRATION_017 = readFileSync(join(MIGRATIONS_DIR, "017-updated-at-ms.sql"), "utf-8");
const MIGRATION_018 = readFileSync(join(MIGRATIONS_DIR, "018-activity-origin-host.sql"), "utf-8");
const MIGRATION_019 = readFileSync(join(MIGRATIONS_DIR, "019-sync-conflict-queue.sql"), "utf-8");
const MIGRATION_020 = readFileSync(join(MIGRATIONS_DIR, "020-sync-applied-hashes.sql"), "utf-8");

function initScratchDb(path: string, applyPhase2Migrations: boolean) {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      description TEXT
    );
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      project_id TEXT,
      task_bound_id TEXT,
      session_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      tags TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      visibility TEXT NOT NULL DEFAULT 'workspace'
    );
    CREATE TABLE activity (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      project_id TEXT,
      summary TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      visibility TEXT NOT NULL DEFAULT 'workspace'
    );
    INSERT INTO workspaces (id, name) VALUES ('${WORKSPACE}', 'scratch');
    INSERT INTO schema_versions (version, description) VALUES (16, 'scratch baseline');
  `);
  if (applyPhase2Migrations) {
    db.exec(MIGRATION_017);
    db.exec(MIGRATION_018);
    db.exec(MIGRATION_019);
    db.exec(MIGRATION_020);
  }
  db.close();
}

function insertNote(
  path: string,
  row: {
    id: string;
    type: string;
    text: string;
    updated_at: string;
    updated_at_ms?: number;
    metadata?: string;
    tags?: string;
    deleted_at?: string | null;
  },
) {
  const db = new Database(path);
  const hasMs = db
    .query("PRAGMA table_info(notes)")
    .all()
    .some((c: any) => c.name === "updated_at_ms");
  if (hasMs) {
    db.query(
      `INSERT INTO notes (id, workspace_id, type, text, metadata, tags, deleted_at, updated_at, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      WORKSPACE,
      row.type,
      row.text,
      row.metadata ?? "{}",
      row.tags ?? "[]",
      row.deleted_at ?? null,
      row.updated_at,
      row.updated_at_ms ?? parseIsoToMs(row.updated_at),
    );
  } else {
    db.query(
      `INSERT INTO notes (id, workspace_id, type, text, metadata, tags, deleted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      WORKSPACE,
      row.type,
      row.text,
      row.metadata ?? "{}",
      row.tags ?? "[]",
      row.deleted_at ?? null,
      row.updated_at,
    );
  }
  db.close();
}

function insertActivity(
  path: string,
  row: { id: string; action: string; summary: string; created_at: string },
) {
  const db = new Database(path);
  db.query(
    `INSERT INTO activity (id, workspace_id, action, entity_type, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, WORKSPACE, row.action, "note", row.summary, row.created_at);
  db.close();
}

function getNote(path: string, id: string): any {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT * FROM notes WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

function getActivity(path: string, id: string): any {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT * FROM activity WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

function count(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(`SELECT count(*) n FROM ${table}`).get() as any).n;
  } finally {
    db.close();
  }
}

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// -------------------- harness --------------------

let tmp: string;
let macPath: string;
let corPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "shadow-sync-apply-"));
  macPath = join(tmp, "mac.db");
  corPath = join(tmp, "cor.db");
  // Mac mini is pre-017 (no updated_at_ms / origin_host); Corsair is post-020.
  initScratchDb(macPath, false);
  initScratchDb(corPath, true);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// -------------------- 1. M2C INSERT --------------------

describe("applyPlan M2C INSERT", () => {
  test("note present only on Mac is inserted on target + hash recorded", () => {
    insertNote(macPath, {
      id: "01M00000000000000000I001",
      type: "memory",
      text: "mac-only insert",
      updated_at: "2026-05-10T00:00:00Z",
      metadata: '{"k":"v"}',
      tags: '["a","b"]',
    });
    const plan = buildPlan(macPath, corPath);
    const res = applyPlan(plan, { macDbPath: macPath, corDbPath: corPath });

    expect(res.notes.inserted).toBe(1);
    expect(res.notes.updated).toBe(0);
    expect(res.notes.hashesRecorded).toBe(1);
    expect(res.transaction).toBe("committed");

    const got = getNote(corPath, "01M00000000000000000I001");
    expect(got).toBeTruthy();
    expect(got.text).toBe("mac-only insert");
    expect(got.type).toBe("memory");
    expect(got.metadata).toBe('{"k":"v"}');
    // Receiver computed updated_at_ms from the source effective ts.
    expect(got.updated_at_ms).toBe(parseIsoToMs("2026-05-10T00:00:00Z"));

    expect(count(corPath, "sync_applied_hashes")).toBe(1);
    const h = getNote; // noop ref to keep lints quiet
    void h;

    // Post-apply parity: M2C direction is now empty.
    const verify = buildPlan(macPath, corPath);
    expect(verify.notes.filter((c) => c.direction === "M2C").length).toBe(0);
  });
});

// -------------------- 2. M2C UPDATE --------------------

describe("applyPlan M2C UPDATE", () => {
  test("note on both sides, Mac newer, overwrites target; parity after", () => {
    const id = "01X00000000000000000U001";
    // Older on Corsair, newer on Mac → Mac wins LWW → M2C UPDATE.
    insertNote(corPath, {
      id,
      type: "memory",
      text: "OLD corsair text",
      updated_at: "2026-05-01T00:00:00Z",
    });
    insertNote(macPath, {
      id,
      type: "memory",
      text: "NEW mac text",
      updated_at: "2026-05-20T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    const cand = plan.notes.find((c) => c.rowId === id);
    expect(cand?.direction).toBe("M2C");
    expect(cand?.remoteUpdatedAtMs).toBeGreaterThan(0); // UPDATE, not insert

    const res = applyPlan(plan, { macDbPath: macPath, corDbPath: corPath });
    expect(res.notes.updated).toBe(1);
    expect(res.notes.inserted).toBe(0);

    const got = getNote(corPath, id);
    expect(got.text).toBe("NEW mac text");
    expect(got.updated_at).toBe("2026-05-20T00:00:00Z");
    expect(got.updated_at_ms).toBe(parseIsoToMs("2026-05-20T00:00:00Z"));
    expect(count(corPath, "notes")).toBe(1); // no duplicate row

    const verify = buildPlan(macPath, corPath);
    expect(verify.notes.filter((c) => c.direction === "M2C").length).toBe(0);
  });
});

// -------------------- 3. activity M2C + origin_host --------------------

describe("applyPlan activity M2C", () => {
  test("Mac-only activity appended with origin_host stamped by receiver", () => {
    insertActivity(macPath, {
      id: "01A0M000000000000000A001",
      action: "note.created",
      summary: "from mac",
      created_at: "2026-05-11T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    const res = applyPlan(plan, {
      macDbPath: macPath,
      corDbPath: corPath,
      sourceHost: "mac-mini",
    });
    expect(res.activity.inserted).toBe(1);
    expect(res.activity.hashesRecorded).toBe(1);

    const got = getActivity(corPath, "01A0M000000000000000A001");
    expect(got.summary).toBe("from mac");
    expect(got.origin_host).toBe("mac-mini");

    const verify = buildPlan(macPath, corPath);
    expect(verify.activity.filter((c) => c.direction === "M2C").length).toBe(0);
  });
});

// -------------------- 4. idempotency --------------------

describe("applyPlan idempotency", () => {
  test("re-apply of the same plan is a NO-OP (hashes already recorded)", () => {
    insertNote(macPath, {
      id: "01M00000000000000000D001",
      type: "memory",
      text: "idem",
      updated_at: "2026-05-12T00:00:00Z",
    });
    insertActivity(macPath, {
      id: "01A0M000000000000000D001",
      action: "x",
      summary: "y",
      created_at: "2026-05-12T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    const r1 = applyPlan(plan, { macDbPath: macPath, corDbPath: corPath });
    expect(r1.notes.inserted + r1.activity.inserted).toBe(2);
    expect(count(corPath, "sync_applied_hashes")).toBe(2);

    // Re-apply the SAME (now stale) plan — every row's hash is present → skip.
    const r2 = applyPlan(plan, { macDbPath: macPath, corDbPath: corPath });
    expect(r2.notes.inserted).toBe(0);
    expect(r2.notes.updated).toBe(0);
    expect(r2.notes.skippedIdempotent).toBe(1);
    expect(r2.activity.skippedIdempotent).toBe(1);
    expect(count(corPath, "sync_applied_hashes")).toBe(2); // unchanged
    expect(count(corPath, "notes")).toBe(1);
    expect(count(corPath, "activity")).toBe(1);
  });
});

// -------------------- apply-time stale-plan revalidation --------------------

describe("applyPlan stale-plan revalidation", () => {
  test("source drift after planning aborts the entire apply", () => {
    const id = "01M000000000000000STALE01";
    insertNote(macPath, {
      id,
      type: "memory",
      text: "planned source",
      updated_at: "2026-05-12T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    const source = new Database(macPath);
    source.query("UPDATE notes SET text = 'drifted source' WHERE id = ?").run(id);
    source.close();

    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /STALE_PLAN: source row changed/,
    );
    expect(getNote(corPath, id)).toBeFalsy();
    expect(count(corPath, "sync_applied_hashes")).toBe(0);
  });

  test("target drift after planning aborts instead of overwriting", () => {
    const id = "01X000000000000000STALE02";
    insertNote(macPath, {
      id,
      type: "memory",
      text: "new source",
      updated_at: "2026-05-20T00:00:00Z",
    });
    insertNote(corPath, {
      id,
      type: "memory",
      text: "planned target",
      updated_at: "2026-05-01T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    const target = new Database(corPath);
    target.query("UPDATE notes SET text = 'concurrent target edit' WHERE id = ?").run(id);
    target.close();

    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /STALE_PLAN: target row changed/,
    );
    expect(getNote(corPath, id).text).toBe("concurrent target edit");
    expect(count(corPath, "sync_applied_hashes")).toBe(0);
  });
});

// -------------------- 5. conflict abort --------------------

describe("applyPlan conflict safety", () => {
  test("conflicts are queued transactionally while data mutations stay blocked", () => {
    const sameTs = "2026-05-13T00:00:00Z";
    // type not in SOT_RULES + equal ts + differing content → conflict.
    insertNote(macPath, {
      id: "01CONFLICT0000000000000001",
      type: "weirdtype",
      text: "M-side",
      updated_at: sameTs,
    });
    insertNote(corPath, {
      id: "01CONFLICT0000000000000001",
      type: "weirdtype",
      text: "C-side",
      updated_at: sameTs,
    });
    // Also a clean M2C insert that must NOT leak through.
    insertNote(macPath, {
      id: "01M00000000000000000C001",
      type: "memory",
      text: "should-not-apply",
      updated_at: "2026-05-14T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    const notesBefore = count(corPath, "notes");
    const hashesBefore = count(corPath, "sync_applied_hashes");
    const queueBefore = count(corPath, "sync_conflict_queue");

    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /conflict candidate\(s\) queued/i,
    );
    // Nothing written — the clean insert did not leak.
    expect(count(corPath, "notes")).toBe(notesBefore);
    expect(count(corPath, "sync_applied_hashes")).toBe(hashesBefore);
    expect(getNote(corPath, "01M00000000000000000C001")).toBeFalsy();
    expect(count(corPath, "sync_conflict_queue")).toBe(queueBefore + 1);
    const queueDb = new Database(corPath, { readonly: true });
    const queued = queueDb.query(
        `SELECT table_name, row_id, direction, local_hash, remote_hash, status
           FROM sync_conflict_queue WHERE row_id = ?`,
      )
      .get("01CONFLICT0000000000000001") as any;
    queueDb.close();
    expect(queued.table_name).toBe("notes");
    expect(queued.direction).toBe("M2C");
    expect(queued.status).toBe("pending");
    expect(queued.local_hash).not.toBe(queued.remote_hash);

    // Replaying the same conflict plan does not duplicate the pending envelope.
    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /queued/i,
    );
    expect(count(corPath, "sync_conflict_queue")).toBe(queueBefore + 1);
  });

  test("same-ID activity divergence is queued instead of silently discarded", () => {
    const id = "01ACTIVITYCONFLICT000000001";
    insertActivity(macPath, {
      id,
      action: "note.updated",
      summary: "Mac envelope",
      created_at: "2026-05-16T00:00:00Z",
    });
    insertActivity(corPath, {
      id,
      action: "note.updated",
      summary: "Corsair envelope",
      created_at: "2026-05-16T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);
    expect(plan.activity.find((candidate) => candidate.rowId === id)?.direction).toBe(
      "conflict",
    );

    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /queued/i,
    );
    const db = new Database(corPath, { readonly: true });
    const queued = db
      .query(
        `SELECT table_name, row_id, status
           FROM sync_conflict_queue WHERE row_id = ?`,
      )
      .get(id) as { table_name: string; row_id: string; status: string };
    db.close();
    expect(queued).toEqual({ table_name: "activity", row_id: id, status: "pending" });
    expect(getActivity(corPath, id).summary).toBe("Corsair envelope");
    expect(count(corPath, "sync_applied_hashes")).toBe(0);
  });
});

describe("applyPlan writable connection safeguards", () => {
  test("writable handles enable FK checks and a bounded busy timeout", () => {
    const db = new Database(corPath);
    configureWritableSyncConnection(db);
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const busy = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    db.close();
    expect(fk.foreign_keys).toBe(1);
    expect(busy.timeout).toBe(SYNC_BUSY_TIMEOUT_MS);
  });

  test("foreign_keys=ON rejects an orphaned source workspace", () => {
    const id = "01M00000000000000000FK001";
    insertNote(macPath, {
      id,
      type: "memory",
      text: "must not orphan",
      updated_at: "2026-05-15T00:00:00Z",
    });
    const plan = buildPlan(macPath, corPath);

    const target = new Database(corPath);
    target.query("DELETE FROM workspaces WHERE id = ?").run(WORKSPACE);
    target.close();

    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    expect(getNote(corPath, id)).toBeFalsy();
    expect(count(corPath, "sync_applied_hashes")).toBe(0);
  });

  test("integrity preflight refuses an already-corrupt target before apply", () => {
    const plan = buildPlan(macPath, corPath);
    const target = new Database(corPath);
    target.query(
      `INSERT INTO notes (id, workspace_id, type, text, updated_at)
       VALUES ('01CORRUPT0000000000000001', 'missing-workspace', 'memory', 'orphan', ?)`
    ).run("2026-05-15T00:00:00Z");
    target.close();

    expect(() => applyPlan(plan, { macDbPath: macPath, corDbPath: corPath })).toThrow(
      /shadow-sync target integrity preflight failed/i,
    );
    expect(count(corPath, "sync_applied_hashes")).toBe(0);
  });
});

// -------------------- 6. rollback on mid-apply error --------------------

describe("applyPlan rollback", () => {
  test("forced mid-apply error ⇒ full rollback, zero partial writes", () => {
    insertNote(macPath, { id: "01M0000000000000000R001", type: "memory", text: "r1", updated_at: "2026-05-01T00:00:00Z" });
    insertNote(macPath, { id: "01M0000000000000000R002", type: "memory", text: "r2", updated_at: "2026-05-02T00:00:00Z" });
    insertNote(macPath, { id: "01M0000000000000000R003", type: "memory", text: "r3", updated_at: "2026-05-03T00:00:00Z" });
    const plan = buildPlan(macPath, corPath);
    const notesBefore = count(corPath, "notes");
    const hashesBefore = count(corPath, "sync_applied_hashes");

    expect(() =>
      applyPlan(plan, {
        macDbPath: macPath,
        corDbPath: corPath,
        // Inject a fault on the 2nd row mutation.
        _injectFault: (rowId: string) => {
          if (rowId === "01M0000000000000000R002") throw new Error("injected fault");
        },
      }),
    ).toThrow(/injected fault/);

    // Row 1 was mutated before the fault — must be rolled back too.
    expect(count(corPath, "notes")).toBe(notesBefore);
    expect(count(corPath, "sync_applied_hashes")).toBe(hashesBefore);
    expect(getNote(corPath, "01M0000000000000000R001")).toBeFalsy();
  });
});

// -------------------- 7. source DB never mutated --------------------

describe("applyPlan leaves Mac source untouched", () => {
  test("Mac DB file sha + counts unchanged after M2C apply", () => {
    insertNote(macPath, { id: "01M0000000000000000S001", type: "memory", text: "s", updated_at: "2026-05-15T00:00:00Z" });
    const macShaBefore = fileSha(macPath);
    const macNotesBefore = count(macPath, "notes");
    const plan = buildPlan(macPath, corPath);
    applyPlan(plan, { macDbPath: macPath, corDbPath: corPath });
    expect(fileSha(macPath)).toBe(macShaBefore);
    expect(count(macPath, "notes")).toBe(macNotesBefore);
  });
});

// -------------------- 8. C2M refused --------------------

describe("applyPlan direction guard", () => {
  test("C2M apply is refused (would mutate Mac source)", () => {
    insertNote(corPath, { id: "01C0000000000000000G001", type: "knowledge", text: "c", updated_at: "2026-05-16T00:00:00Z" });
    const plan = buildPlan(macPath, corPath);
    expect(() =>
      applyPlan(plan, { macDbPath: macPath, corDbPath: corPath, direction: "C2M" as any }),
    ).toThrow(/M2C/);
  });
});

// -------------------- 9. table filter + dry-run isolation --------------------

describe("applyPlan table filter", () => {
  test("table=notes applies notes only; activity untouched", () => {
    insertNote(macPath, { id: "01M0000000000000000F001", type: "memory", text: "n", updated_at: "2026-05-17T00:00:00Z" });
    insertActivity(macPath, { id: "01A0M000000000000F001", action: "x", summary: "y", created_at: "2026-05-17T00:00:00Z" });
    const plan = buildPlan(macPath, corPath);
    const res = applyPlan(plan, { macDbPath: macPath, corDbPath: corPath, table: "notes" });
    expect(res.notes.inserted).toBe(1);
    expect(res.activity.inserted).toBe(0);
    expect(count(corPath, "notes")).toBe(1);
    expect(count(corPath, "activity")).toBe(0);
  });
});

// -------------------- apply report --------------------

describe("renderApplyReport", () => {
  test("counts-only report with no body bytes", () => {
    insertNote(macPath, { id: "01M0000000000000000P001", type: "memory", text: "SECRET-BODY-TEXT", updated_at: "2026-05-18T00:00:00Z" });
    const plan = buildPlan(macPath, corPath);
    const res: ApplyResult = applyPlan(plan, { macDbPath: macPath, corDbPath: corPath });
    const report = renderApplyReport(res, "20260518T000000Z", { residualNotesM2c: 0, residualActivityM2c: 0 });
    expect(report).toMatch(/# Shadow sync apply/);
    expect(report).toMatch(/notes/);
    expect(report).toMatch(/inserted/);
    expect(report).not.toContain("SECRET-BODY-TEXT");
  });
});
