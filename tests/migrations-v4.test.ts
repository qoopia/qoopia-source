import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { executeRelationBackfill, planRelationBackfill } from "../src/db/v4-backfill.ts";
import {
  applyMigrationsToDatabase,
  assertV4Schema,
  computeLogicalDatabaseHash,
  readSchemaVersion,
} from "../src/db/v4-migrations.ts";
import { expireRecallTraceBatch } from "../src/db/v4-trace-retention.ts";
import { configureWritableDatabase } from "../src/db/sqlite.ts";
import { parseBackfillArgs, runBackfillCli } from "../scripts/v4-backfill.ts";

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "..", "migrations");
const cleanupRoots: string[] = [];

interface ScratchDatabase {
  db: Database;
  filename: string;
  root: string;
}

function scratchDatabase(targetVersion = 32): ScratchDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v4-migration-"));
  cleanupRoots.push(root);
  const filename = path.join(root, "fixture.db");
  const db = new Database(filename, { create: true });
  configureWritableDatabase(db);
  applyMigrationsToDatabase(db, {
    migrationsDir: MIGRATIONS_DIR,
    targetVersion,
  });
  return { db, filename, root };
}

function insertWorkspace(db: Database, suffix: string): string {
  const id = `ws-${suffix}`;
  db.query("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(
    id,
    `Workspace ${suffix}`,
    `workspace-${suffix}`,
  );
  return id;
}

function insertAgent(db: Database, workspaceId: string, suffix: string): string {
  const id = `agent-${suffix}`;
  db.query(
    `INSERT INTO agents (id, workspace_id, name, api_key_hash)
     VALUES (?, ?, ?, ?)`,
  ).run(id, workspaceId, `Agent ${suffix}`, `hash-${suffix}`);
  return id;
}

function insertSession(
  db: Database,
  workspaceId: string,
  agentId: string,
  suffix: string,
): string {
  const id = `session-${suffix}`;
  db.query(
    `INSERT INTO sessions (id, workspace_id, agent_id, title)
     VALUES (?, ?, ?, ?)`,
  ).run(id, workspaceId, agentId, `Session ${suffix}`);
  return id;
}

function insertNote(
  db: Database,
  workspaceId: string,
  agentId: string,
  id: string,
  metadata: string | Record<string, unknown> = {},
): void {
  db.query(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, tags)
     VALUES (?, ?, ?, 'memory', ?, ?, '[]')`,
  ).run(
    id,
    workspaceId,
    agentId,
    `Fixture text ${id}`,
    typeof metadata === "string" ? metadata : JSON.stringify(metadata),
  );
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function tableColumns(db: Database): Map<string, string[]> {
  const tables = db
    .query(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return new Map(tables.map(({ name }) => [
    name,
    (db.query(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as
      Array<{ name: string }>).map((column) => column.name),
  ]));
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("V4 migrations 027-032", () => {
  test("upgrade schema 26 additively and first/second/third runs are apply/no-op/no-op", () => {
    const fixture = scratchDatabase(26);
    const before = tableColumns(fixture.db);
    expect(readSchemaVersion(fixture.db)).toBe(26);

    const first = applyMigrationsToDatabase(fixture.db, {
      migrationsDir: MIGRATIONS_DIR,
    });
    const second = applyMigrationsToDatabase(fixture.db, {
      migrationsDir: MIGRATIONS_DIR,
    });
    const third = applyMigrationsToDatabase(fixture.db, {
      migrationsDir: MIGRATIONS_DIR,
    });

    expect(first.initial_schema).toBe(26);
    expect(first.final_schema).toBe(32);
    expect(first.applied).toEqual([
      "027-note-relations-provenance.sql",
      "028-memory-lifecycle.sql",
      "029-extraction-review.sql",
      "030-recall-traces-feedback.sql",
      "031-event-outbox.sql",
      "032-agentcomm-delivery-receipts.sql",
    ]);
    expect(second.no_op).toBe(true);
    expect(third.no_op).toBe(true);
    assertV4Schema(fixture.db);

    const after = tableColumns(fixture.db);
    for (const [table, columns] of before) {
      expect(after.get(table)).toEqual(columns);
    }
    expect(fixture.db.query("PRAGMA quick_check").get()).toEqual({
      quick_check: "ok",
    });
    expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    fixture.db.close();
  });

  test("fresh 001-032 install is valid and V3 note access remains compatible", () => {
    const fixture = scratchDatabase();
    const workspaceId = insertWorkspace(fixture.db, "fresh");
    const agentId = insertAgent(fixture.db, workspaceId, "fresh");
    insertNote(fixture.db, workspaceId, agentId, "note-v3-client");

    const row = fixture.db
      .query(
        `SELECT id, type, text, metadata, tags
         FROM notes WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, "note-v3-client");
    expect(row).toEqual({
      id: "note-v3-client",
      type: "memory",
      text: "Fixture text note-v3-client",
      metadata: "{}",
      tags: "[]",
    });
    expect(readSchemaVersion(fixture.db)).toBe(32);
    expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    fixture.db.close();
  });

  test("V4 SQL is additive and historical migration files remain outside its range", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((filename) => /^0(?:2[7-9]|3[0-2])[-_].+\.sql$/.test(filename))
      .sort();
    expect(files).toHaveLength(6);
    for (const filename of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME)\b/i);
      expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    }
  });

  test("unknown forward schema fails closed", () => {
    const fixture = scratchDatabase();
    fixture.db.query(
      "INSERT INTO schema_versions (version, description) VALUES (33, 'future')",
    ).run();
    expect(() => applyMigrationsToDatabase(fixture.db, {
      migrationsDir: MIGRATIONS_DIR,
    })).toThrow("Unsupported forward schema 33");
    fixture.db.close();
  });
});

describe("V4 workspace constraints", () => {
  test("composite foreign keys reject cross-workspace relations and runs", () => {
    const fixture = scratchDatabase();
    const workspaceA = insertWorkspace(fixture.db, "a");
    const workspaceB = insertWorkspace(fixture.db, "b");
    const agentA = insertAgent(fixture.db, workspaceA, "a");
    const agentB = insertAgent(fixture.db, workspaceB, "b");
    const sessionB = insertSession(fixture.db, workspaceB, agentB, "b");
    insertNote(fixture.db, workspaceA, agentA, "note-a");
    insertNote(fixture.db, workspaceB, agentB, "note-b");

    expect(() => fixture.db.query(
      `INSERT INTO note_relations
       (id, workspace_id, source_note_id, target_note_id, relation_type,
        created_by_agent_id)
       VALUES ('relation-cross', ?, 'note-a', 'note-b', 'supports', ?)`,
    ).run(workspaceA, agentA)).toThrow();
    expect(() => fixture.db.query(
      `INSERT INTO extraction_runs
       (id, workspace_id, session_id, source_start_id, source_end_id,
        source_range_hash, extractor_version, prompt_hash, status,
        initiated_by_agent_id)
       VALUES ('run-cross', ?, ?, 1, 1, ?, 'v1', ?, 'queued', ?)`,
    ).run(workspaceA, sessionB, "a".repeat(64), "b".repeat(64), agentA)).toThrow();

    fixture.db.query(
      `INSERT INTO agent_comm_sessions
       (id, workspace_id, topic, created_by_agent_id)
       VALUES ('comm-b', ?, 'fixture', ?)`,
    ).run(workspaceB, agentB);
    fixture.db.query(
      `INSERT INTO agent_comm_messages
       (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
        kind, body)
       VALUES ('message-b', ?, 'comm-b', ?, ?, 'request', 'fixture')`,
    ).run(workspaceB, agentB, agentB);
    expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    fixture.db.close();
  });

  test("normalized conflict and bounded hash constraints fail closed", () => {
    const fixture = scratchDatabase();
    const workspaceId = insertWorkspace(fixture.db, "checks");
    const agentId = insertAgent(fixture.db, workspaceId, "checks");
    insertNote(fixture.db, workspaceId, agentId, "a-note");
    insertNote(fixture.db, workspaceId, agentId, "z-note");

    expect(() => fixture.db.query(
      `INSERT INTO note_relations
       (id, workspace_id, source_note_id, target_note_id, relation_type,
        created_by_agent_id)
       VALUES ('bad-order', ?, 'z-note', 'a-note', 'conflicts_with', ?)`,
    ).run(workspaceId, agentId)).toThrow();
    expect(() => fixture.db.query(
      `INSERT INTO note_provenance
       (id, workspace_id, note_id, source_kind, source_id, source_hash,
        confidence, created_by_agent_id)
       VALUES ('bad-hash', ?, 'a-note', 'manual', 'source', ?, 0.5, ?)`,
    ).run(workspaceId, "A".repeat(64), agentId)).toThrow();
    fixture.db.close();
  });
});

describe("V4 relation backfill", () => {
  test("plans only conservative relations and reports malformed graph inputs", () => {
    const fixture = scratchDatabase();
    const workspaceA = insertWorkspace(fixture.db, "plan-a");
    const workspaceB = insertWorkspace(fixture.db, "plan-b");
    const agentA = insertAgent(fixture.db, workspaceA, "plan-a");
    const agentB = insertAgent(fixture.db, workspaceB, "plan-b");

    insertNote(fixture.db, workspaceA, agentA, "old-1", { superseded_by: "new-1" });
    insertNote(fixture.db, workspaceA, agentA, "new-1", { supersedes: "old-1" });
    insertNote(fixture.db, workspaceA, agentA, "malformed", "not-json");
    insertNote(fixture.db, workspaceA, agentA, "orphan", { supersedes: "missing" });
    insertNote(fixture.db, workspaceA, agentA, "cycle-a", { supersedes: "cycle-b" });
    insertNote(fixture.db, workspaceA, agentA, "cycle-b", { supersedes: "cycle-a" });
    insertNote(fixture.db, workspaceA, agentA, "root", {});
    insertNote(fixture.db, workspaceA, agentA, "head-a", { supersedes: "root" });
    insertNote(fixture.db, workspaceA, agentA, "head-b", { supersedes: "root" });
    insertNote(fixture.db, workspaceB, agentB, "foreign", {});
    insertNote(fixture.db, workspaceA, agentA, "cross", { supersedes: "foreign" });

    const plan = planRelationBackfill(fixture.db);
    expect(plan.counts.eligible).toBe(1);
    expect(plan.proposals.find((proposal) =>
      proposal.source_note_id === "new-1" && proposal.target_note_id === "old-1"
    )?.disposition).toBe("eligible");
    expect(plan.issue_counts.invalid_metadata_json).toBe(1);
    expect(plan.issue_counts.orphan_reference).toBe(1);
    expect(plan.issue_counts.cross_workspace_reference).toBe(1);
    expect(plan.issue_counts.cycle).toBeGreaterThan(0);
    expect(plan.issue_counts.multiple_heads).toBe(1);
    expect(JSON.stringify(plan)).not.toContain("Fixture text");
    expect(JSON.stringify(plan)).not.toContain("not-json");
    fixture.db.close();
  });

  test("dry-run is non-mutating and interrupted resume equals uninterrupted apply", () => {
    const base = scratchDatabase();
    const workspaceId = insertWorkspace(base.db, "resume");
    const agentId = insertAgent(base.db, workspaceId, "resume");
    insertNote(base.db, workspaceId, agentId, "old-a", { superseded_by: "new-a" });
    insertNote(base.db, workspaceId, agentId, "new-a", { supersedes: "old-a" });
    insertNote(base.db, workspaceId, agentId, "old-b", { superseded_by: "new-b" });
    insertNote(base.db, workspaceId, agentId, "new-b", { supersedes: "old-b" });
    const baseHash = computeLogicalDatabaseHash(base.db);
    const plan = planRelationBackfill(base.db);
    const dryRun = executeRelationBackfill(base.db, plan, { dryRun: true });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.inserted).toBe(2);
    expect(computeLogicalDatabaseHash(base.db)).toBe(baseHash);
    base.db.close();

    const uninterruptedPath = path.join(base.root, "uninterrupted.db");
    const resumedPath = path.join(base.root, "resumed.db");
    fs.copyFileSync(base.filename, uninterruptedPath);
    fs.copyFileSync(base.filename, resumedPath);

    const uninterrupted = new Database(uninterruptedPath, { readwrite: true });
    configureWritableDatabase(uninterrupted);
    const uninterruptedPlan = planRelationBackfill(uninterrupted);
    const uninterruptedResult = executeRelationBackfill(
      uninterrupted,
      uninterruptedPlan,
    );
    expect(uninterruptedResult.interrupted).toBe(false);
    const uninterruptedHash = computeLogicalDatabaseHash(uninterrupted);
    uninterrupted.close();

    const resumed = new Database(resumedPath, { readwrite: true });
    configureWritableDatabase(resumed);
    const first = executeRelationBackfill(resumed, planRelationBackfill(resumed), {
      stopAfter: 1,
      batchSize: 1,
    });
    expect(first.interrupted).toBe(true);
    expect(first.last_processed_note_id).not.toBeNull();
    const second = executeRelationBackfill(resumed, planRelationBackfill(resumed), {
      resumeAfter: first.last_processed_note_id,
      batchSize: 1,
    });
    expect(second.interrupted).toBe(false);
    expect(computeLogicalDatabaseHash(resumed)).toBe(uninterruptedHash);
    resumed.close();
  });

  test("resume cursor is globally ordered across workspaces", () => {
    const fixture = scratchDatabase();
    const workspaceA = insertWorkspace(fixture.db, "resume-a");
    const workspaceB = insertWorkspace(fixture.db, "resume-b");
    const agentA = insertAgent(fixture.db, workspaceA, "resume-a");
    const agentB = insertAgent(fixture.db, workspaceB, "resume-b");
    insertNote(fixture.db, workspaceA, agentA, "old-z", { superseded_by: "z-new" });
    insertNote(fixture.db, workspaceA, agentA, "z-new", { supersedes: "old-z" });
    insertNote(fixture.db, workspaceB, agentB, "old-a", { superseded_by: "a-new" });
    insertNote(fixture.db, workspaceB, agentB, "a-new", { supersedes: "old-a" });

    const first = executeRelationBackfill(
      fixture.db,
      planRelationBackfill(fixture.db),
      { stopAfter: 1, batchSize: 1 },
    );
    expect(first.interrupted).toBe(true);
    expect(first.last_processed_note_id).toBe("a-new");
    const second = executeRelationBackfill(
      fixture.db,
      planRelationBackfill(fixture.db),
      { resumeAfter: first.last_processed_note_id, batchSize: 1 },
    );
    expect(second.inserted).toBe(1);
    expect(second.interrupted).toBe(false);
    expect(fixture.db.query(
      "SELECT COUNT(*) AS count FROM note_relations",
    ).get()).toEqual({ count: 2 });
    fixture.db.close();
  });

  test("plan and dry-run CLI preserve the database file hash", () => {
    const fixture = scratchDatabase();
    const workspaceId = insertWorkspace(fixture.db, "cli");
    const agentId = insertAgent(fixture.db, workspaceId, "cli");
    insertNote(fixture.db, workspaceId, agentId, "old-cli", {
      superseded_by: "new-cli",
    });
    insertNote(fixture.db, workspaceId, agentId, "new-cli", {
      supersedes: "old-cli",
    });
    fixture.db.close();

    const before = sha256File(fixture.filename);
    const planOptions = parseBackfillArgs(["--plan", "--db", fixture.filename]);
    expect(runBackfillCli(planOptions).exitCode).toBe(0);
    expect(sha256File(fixture.filename)).toBe(before);

    const dryRunOptions = parseBackfillArgs([
      "--dry-run",
      "--db",
      fixture.filename,
    ]);
    expect(runBackfillCli(dryRunOptions).exitCode).toBe(0);
    expect(sha256File(fixture.filename)).toBe(before);
  });
});

describe("V4 recall trace retention", () => {
  function seedTrace(db: Database, suffix: string): {
    workspaceId: string;
    traceId: string;
    feedbackId: string;
  } {
    const workspaceId = insertWorkspace(db, `trace-${suffix}`);
    const agentId = insertAgent(db, workspaceId, `trace-${suffix}`);
    const noteId = `note-trace-${suffix}`;
    const traceId = `trace-${suffix}`;
    const feedbackId = `feedback-${suffix}`;
    insertNote(db, workspaceId, agentId, noteId);
    db.query(
      `INSERT INTO recall_traces
       (id, workspace_id, caller_agent_id, query_hash, mode,
        pipeline_version, duration_ms, result_count, expires_at)
       VALUES (?, ?, ?, ?, 'normal', 'v4', 1, 1, '2026-01-01T00:00:00.000Z')`,
    ).run(traceId, workspaceId, agentId, "a".repeat(64));
    db.query(
      `INSERT INTO recall_trace_items
       (workspace_id, trace_id, result_kind, result_id, note_id,
        source_channel, rrf_score, final_score, final_rank)
       VALUES (?, ?, 'note', ?, ?, 'fts5', 1.0, 1.0, 1)`,
    ).run(workspaceId, traceId, noteId, noteId);
    db.query(
      `INSERT INTO recall_feedback
       (id, workspace_id, note_id, trace_id, actor_agent_id,
        feedback, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'helpful', ?)`,
    ).run(feedbackId, workspaceId, noteId, traceId, agentId, `feedback-key-${suffix}`);
    return { workspaceId, traceId, feedbackId };
  }

  test("expiry detaches durable feedback and atomically deletes trace diagnostics", () => {
    const fixture = scratchDatabase();
    const seeded = seedTrace(fixture.db, "commit");
    const result = expireRecallTraceBatch(fixture.db, {
      cutoff: "2026-02-01T00:00:00.000Z",
    });
    expect(result).toEqual({
      selected: 1,
      detached_feedback: 1,
      deleted_items: 1,
      deleted_traces: 1,
    });
    expect(fixture.db.query(
      "SELECT trace_id FROM recall_feedback WHERE id = ?",
    ).get(seeded.feedbackId)).toEqual({ trace_id: null });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM recall_traces").get())
      .toEqual({ count: 0 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM recall_trace_items").get())
      .toEqual({ count: 0 });
    expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    expect(() => fixture.db.query(
      `INSERT INTO recall_feedback
       (id, workspace_id, note_id, trace_id, actor_agent_id,
        feedback, idempotency_key)
       SELECT 'feedback-late', workspace_id, note_id, ?, actor_agent_id,
              'helpful', 'feedback-key-late'
       FROM recall_feedback WHERE id = ?`,
    ).run(seeded.traceId, seeded.feedbackId)).toThrow();
    fixture.db.close();
  });

  test("failure after detach rolls back feedback and trace mutations", () => {
    const fixture = scratchDatabase();
    const seeded = seedTrace(fixture.db, "rollback");
    expect(() => expireRecallTraceBatch(fixture.db, {
      cutoff: "2026-02-01T00:00:00.000Z",
      afterDetach: () => {
        throw new Error("injected retention fault");
      },
    })).toThrow("injected retention fault");
    expect(fixture.db.query(
      "SELECT trace_id FROM recall_feedback WHERE id = ?",
    ).get(seeded.feedbackId)).toEqual({ trace_id: seeded.traceId });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM recall_traces").get())
      .toEqual({ count: 1 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM recall_trace_items").get())
      .toEqual({ count: 1 });
    fixture.db.close();
  });
});
