/**
 * Tests for the shadow sync engine.
 * Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A).
 *
 * Three groups:
 *   1. Pure-function unit tests — hash determinism, canonical JSON, SOT map,
 *      ms parsing, apply-gate refusal.
 *   2. Integration tests on scratch DBs — inject known drift between two
 *      synthetic DBs, assert the plan matches the expected candidate set.
 *   3. Idempotency proof — run buildPlan + renderReport twice on the same
 *      scratch pair, assert (a) identical candidate set, (b) identical
 *      report body sha256, (c) scratch DB schema hash + COUNT(*) unchanged
 *      before/after both runs, (d) sync_applied_hashes count unchanged.
 *
 * The integration tests use /tmp scratch DBs only — production and Mac mini
 * DBs are never touched by this suite.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  rowHash,
  SOT_RULES,
  parseIsoToMs,
  checkApplyGate,
  buildPlan,
  renderReport,
  reportBodyHash,
  planNotesSync,
  planActivitySync,
  createApplyAuthorizationManifest,
  type NoteRow,
  type ActivityRow,
  type ApplyAuthorizationManifest,
  type SyncPlan,
} from "../src/services/shadow_sync.ts";

// -------------------- helpers --------------------

const WORKSPACE = "01KMKRVYF2FN68D9N3C8BEGAHS";
const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const MIGRATION_017 = readFileSync(
  join(MIGRATIONS_DIR, "017-updated-at-ms.sql"),
  "utf-8",
);
const MIGRATION_018 = readFileSync(
  join(MIGRATIONS_DIR, "018-activity-origin-host.sql"),
  "utf-8",
);
const MIGRATION_019 = readFileSync(
  join(MIGRATIONS_DIR, "019-sync-conflict-queue.sql"),
  "utf-8",
);
const MIGRATION_020 = readFileSync(
  join(MIGRATIONS_DIR, "020-sync-applied-hashes.sql"),
  "utf-8",
);

function initScratchDb(path: string, applyPhase2Migrations: boolean) {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      description TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT REFERENCES agents(id),
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
      workspace_id TEXT NOT NULL,
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

function semanticSchemaHash(path: string): string {
  // PRAGMA-based snapshot — semantically equivalent across rebuilds; tolerates
  // sqlite_master.sql text re-formatting after ALTER+rebuild.
  const db = new Database(path, { readonly: true });
  const lines: string[] = [];
  try {
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    for (const t of tables) {
      lines.push(`TABLE ${t.name}`);
      const cols = db.query(`PRAGMA table_info(${t.name})`).all();
      lines.push(JSON.stringify(cols));
      const idxs = db.query(`PRAGMA index_list(${t.name})`).all() as Array<{
        name: string;
      }>;
      for (const i of idxs) {
        lines.push(`IDX ${i.name}`);
        lines.push(JSON.stringify(db.query(`PRAGMA index_info(${i.name})`).all()));
      }
    }
    const triggers = db
      .query(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all() as Array<{ name: string; tbl_name: string; sql: string }>;
    for (const tr of triggers) {
      const norm = (tr.sql || "").replace(/\s+/g, " ").toLowerCase();
      lines.push(`TRIGGER ${tr.name}/${tr.tbl_name}: ${norm}`);
    }
  } finally {
    db.close();
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function tableCount(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const r = db.query(`SELECT count(*) as n FROM ${table}`).get() as { n: number };
    return r.n;
  } finally {
    db.close();
  }
}

// -------------------- group 1: pure-function units --------------------

describe("canonicalJson", () => {
  test("sorts object keys deterministically", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
  test("handles nested objects + arrays", () => {
    const x = { a: [{ z: 1, y: 2 }], b: null };
    const y = { b: null, a: [{ y: 2, z: 1 }] };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
    expect(canonicalJson(x)).toBe('{"a":[{"y":2,"z":1}],"b":null}');
  });
});

describe("rowHash", () => {
  const fields = { type: "note", text: "hello", visibility: "workspace" };
  test("same input → same hash (determinism across calls)", () => {
    const h1 = rowHash("notes", "ID1", 1000, fields);
    const h2 = rowHash("notes", "ID1", 1000, fields);
    const h3 = rowHash("notes", "ID1", 1000, fields);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  test("hash changes when any input changes", () => {
    const base = rowHash("notes", "ID1", 1000, fields);
    expect(rowHash("activity", "ID1", 1000, fields)).not.toBe(base);
    expect(rowHash("notes", "ID2", 1000, fields)).not.toBe(base);
    expect(rowHash("notes", "ID1", 2000, fields)).not.toBe(base);
    expect(rowHash("notes", "ID1", 1000, { ...fields, text: "x" })).not.toBe(base);
  });
  test("field key order in input does NOT change hash", () => {
    const a = { type: "note", text: "x", visibility: "workspace" };
    const b = { visibility: "workspace", type: "note", text: "x" };
    expect(rowHash("notes", "ID1", 1, a)).toBe(rowHash("notes", "ID1", 1, b));
  });
});

describe("SOT_RULES (Q-P2-1 / Q1 decision)", () => {
  test("Mac mini priority types", () => {
    expect(SOT_RULES.memory).toBe("M");
    expect(SOT_RULES.contact).toBe("M");
    expect(SOT_RULES.project).toBe("M");
    expect(SOT_RULES.deal).toBe("M");
  });
  test("Corsair priority types", () => {
    expect(SOT_RULES.note).toBe("C");
    expect(SOT_RULES.task).toBe("C");
    expect(SOT_RULES.finance).toBe("C");
    expect(SOT_RULES.knowledge).toBe("C");
    expect(SOT_RULES.rule).toBe("C");
    expect(SOT_RULES.context).toBe("C");
    expect(SOT_RULES.decision).toBe("C");
  });
  test("exactly 11 types in map", () => {
    expect(Object.keys(SOT_RULES).length).toBe(11);
  });
});

describe("parseIsoToMs", () => {
  test("parses seconds-precision ISO", () => {
    // 2026-03-21T08:47:21Z → 1774082841000 (matches the migration backfill formula)
    expect(parseIsoToMs("2026-03-21T08:47:21Z")).toBe(1774082841000);
  });
  test("returns 0 for null / undefined / bad input", () => {
    expect(parseIsoToMs(null)).toBe(0);
    expect(parseIsoToMs(undefined as any)).toBe(0);
    expect(parseIsoToMs("not-a-date")).toBe(0);
  });
});

describe("checkApplyGate", () => {
  let tmp: string;
  let macPath: string;
  let corPath: string;
  let plan: SyncPlan;
  let manifest: ApplyAuthorizationManifest;
  const secret = "shadow-sync-test-authorization-secret-32-bytes";
  const nowMs = Date.parse("2026-07-16T18:30:00.000Z");

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-sync-gate-"));
    macPath = join(tmp, "mac.db");
    corPath = join(tmp, "cor.db");
    initScratchDb(macPath, true);
    initScratchDb(corPath, true);
    plan = buildPlan(macPath, corPath);
    manifest = createApplyAuthorizationManifest({
      secret,
      plan,
      macDbPath: macPath,
      corDbPath: corPath,
      runId: "01KXP22GF0DAFTQ31VY9PYBAAK",
      reviewId: "01KXNVTPBH5XKJVZB4PWXP6YBE",
      ownerApprovalId: "01KXP1KKM2403YX0VFJSAXXESY",
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 15 * 60_000).toISOString(),
    });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("dry-run path bypasses gate entirely", () => {
    expect(checkApplyGate({ apply: false, envToken: undefined })).toBe(null);
  });
  test("valid signed, plan-bound manifest authorizes apply", () => {
    expect(
      checkApplyGate({
        apply: true,
        envToken: secret,
        manifest,
        plan,
        macDbPath: macPath,
        corDbPath: corPath,
        nowMs,
      }),
    ).toBe(null);
  });
  test("missing manifest → HOLD", () => {
    const e = checkApplyGate({ apply: true, envToken: secret });
    expect(e).toContain("--authorization-manifest");
  });
  test("short secret and tampered plan fingerprint are rejected", () => {
    const short = checkApplyGate({
      apply: true,
      envToken: "short",
      manifest,
      plan,
      macDbPath: macPath,
      corDbPath: corPath,
      nowMs,
    });
    expect(short).toContain("at least 32 bytes");

    const tampered = { ...manifest, plan_sha256: "0".repeat(64) };
    const changed = checkApplyGate({
      apply: true,
      envToken: secret,
      manifest: tampered,
      plan,
      macDbPath: macPath,
      corDbPath: corPath,
      nowMs,
    });
    expect(changed).toContain("fingerprint");
  });
  test("expired manifest is rejected", () => {
    const e = checkApplyGate({
      apply: true,
      envToken: secret,
      manifest,
      plan,
      macDbPath: macPath,
      corDbPath: corPath,
      nowMs: nowMs + 16 * 60_000,
    });
    expect(e).toContain("expired");
  });
});

// -------------------- group 2: integration on scratch DBs --------------------

describe("integration: planNotesSync on known drift", () => {
  let tmp: string;
  let macPath: string;
  let corPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-sync-test-"));
    macPath = join(tmp, "mac.db");
    corPath = join(tmp, "cor.db");
    initScratchDb(macPath, true);
    initScratchDb(corPath, true);
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("3 M-only notes + 2 C-only notes + 1 type=note conflict", () => {
    // 3 M-only — one of each type-class
    insertNote(macPath, { id: "01M000000000000000000001", type: "memory", text: "m-only-1", updated_at: "2026-05-01T00:00:00Z" });
    insertNote(macPath, { id: "01M000000000000000000002", type: "decision", text: "m-only-2", updated_at: "2026-05-02T00:00:00Z" });
    insertNote(macPath, { id: "01M000000000000000000003", type: "note", text: "m-only-3", updated_at: "2026-05-03T00:00:00Z" });
    // 2 C-only
    insertNote(corPath, { id: "01C000000000000000000001", type: "knowledge", text: "c-only-1", updated_at: "2026-05-04T00:00:00Z" });
    insertNote(corPath, { id: "01C000000000000000000002", type: "decision", text: "c-only-2", updated_at: "2026-05-05T00:00:00Z" });
    // Same id on both sides, equal timestamp, type='note' → SOT_RULES says C wins → C2M
    const sameTs = "2026-05-06T00:00:00Z";
    insertNote(macPath, { id: "01X000000000000000000001", type: "note", text: "M-version", updated_at: sameTs });
    insertNote(corPath, { id: "01X000000000000000000001", type: "note", text: "C-version", updated_at: sameTs });

    const plan = buildPlan(macPath, corPath);
    expect(plan.notes.filter((c) => c.direction === "M2C").length).toBe(3);
    expect(plan.notes.filter((c) => c.direction === "C2M").length).toBe(2 + 1);
    // 1 of the C2M rows is the tie-break case (the shared id)
    const tieBreak = plan.notes.find((c) => c.rowId === "01X000000000000000000001");
    expect(tieBreak?.direction).toBe("C2M");
    expect(tieBreak?.diffSummary).toMatch(/tie-break SOT=C/);
    expect(plan.notes.filter((c) => c.direction === "conflict").length).toBe(0);
  });

  test("unknown-type same-timestamp conflict → conflict row", () => {
    const sameTs = "2026-05-07T00:00:00Z";
    // type = 'somethingelse' not in SOT_RULES → conflict
    insertNote(macPath, { id: "01CONFLICT0000000000000001", type: "somethingelse", text: "M-side", updated_at: sameTs });
    insertNote(corPath, { id: "01CONFLICT0000000000000001", type: "somethingelse", text: "C-side", updated_at: sameTs });
    const plan = buildPlan(macPath, corPath);
    const c = plan.notes.find((x) => x.rowId === "01CONFLICT0000000000000001");
    expect(c?.direction).toBe("conflict");
    expect(c?.conflictReason).toBe("tie_break_unknown_type");
  });
});

describe("integration: planActivitySync (append-only union)", () => {
  let tmp: string;
  let macPath: string;
  let corPath: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-sync-act-"));
    macPath = join(tmp, "mac.db");
    corPath = join(tmp, "cor.db");
    initScratchDb(macPath, true);
    initScratchDb(corPath, true);
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("M-only + C-only rows union; same-ID rows are hash-compared", () => {
    insertActivity(macPath, { id: "01A0M000000000000000000001", action: "note.created", summary: "m1", created_at: "2026-05-01T00:00:00Z" });
    insertActivity(macPath, { id: "01A0M000000000000000000002", action: "note.updated", summary: "m2", created_at: "2026-05-02T00:00:00Z" });
    insertActivity(corPath, { id: "01A0C000000000000000000001", action: "note.created", summary: "c1", created_at: "2026-05-03T00:00:00Z" });
    insertActivity(macPath, { id: "01A0BOTH00000000000000001", action: "note.created", summary: "both", created_at: "2026-05-04T00:00:00Z" });
    insertActivity(corPath, { id: "01A0BOTH00000000000000001", action: "note.created", summary: "both", created_at: "2026-05-04T00:00:00Z" });
    insertActivity(macPath, { id: "01A0DIVERGE000000000000001", action: "note.created", summary: "mac", created_at: "2026-05-05T00:00:00Z" });
    insertActivity(corPath, { id: "01A0DIVERGE000000000000001", action: "note.created", summary: "corsair", created_at: "2026-05-05T00:00:00Z" });
    const plan = buildPlan(macPath, corPath);
    expect(plan.activity.filter((c) => c.direction === "M2C").length).toBe(2);
    expect(plan.activity.filter((c) => c.direction === "C2M").length).toBe(1);
    expect(plan.activity.find((c) => c.rowId === "01A0BOTH00000000000000001")?.direction).toBe("noop");
    const divergence = plan.activity.find(
      (c) => c.rowId === "01A0DIVERGE000000000000001",
    );
    expect(divergence?.direction).toBe("conflict");
    expect(divergence?.conflictReason).toBe("same_id_activity_divergence");
    expect(divergence?.localHash).not.toBe(divergence?.remoteHash);
  });
});

// -------------------- group 3: idempotency proof --------------------

describe("idempotency: two dry-runs on same scratch pair are byte-identical", () => {
  let tmp: string;
  let macPath: string;
  let corPath: string;
  let macSchemaPre: string;
  let corSchemaPre: string;
  let macNotesPre: number;
  let corNotesPre: number;
  let corAppliedHashesPre: number;
  let corConflictQueuePre: number;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-sync-idem-"));
    macPath = join(tmp, "mac.db");
    corPath = join(tmp, "cor.db");
    initScratchDb(macPath, true);
    initScratchDb(corPath, true);
    // Seed deterministic data
    insertNote(macPath, { id: "01M00000000000000000A001", type: "memory", text: "a", updated_at: "2026-05-01T00:00:00Z" });
    insertNote(macPath, { id: "01M00000000000000000A002", type: "decision", text: "b", updated_at: "2026-05-02T00:00:00Z" });
    insertNote(corPath, { id: "01C00000000000000000B001", type: "knowledge", text: "c", updated_at: "2026-05-03T00:00:00Z" });
    insertActivity(macPath, { id: "01A0M0000000000000000A001", action: "x", summary: "y", created_at: "2026-05-01T00:00:00Z" });
    macSchemaPre = semanticSchemaHash(macPath);
    corSchemaPre = semanticSchemaHash(corPath);
    macNotesPre = tableCount(macPath, "notes");
    corNotesPre = tableCount(corPath, "notes");
    corAppliedHashesPre = tableCount(corPath, "sync_applied_hashes");
    corConflictQueuePre = tableCount(corPath, "sync_conflict_queue");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("two dry-runs produce identical candidate set and identical report body sha256", () => {
    const plan1 = buildPlan(macPath, corPath);
    const plan2 = buildPlan(macPath, corPath);
    expect(JSON.stringify(plan1.notes)).toBe(JSON.stringify(plan2.notes));
    expect(JSON.stringify(plan1.activity)).toBe(JSON.stringify(plan2.activity));
    const report1 = renderReport(plan1, "20260524T035200Z");
    const report2 = renderReport(plan2, "20260524T040000Z");
    expect(reportBodyHash(report1)).toBe(reportBodyHash(report2));
  });

  test("scratch DB schema hash + table counts unchanged after two dry-runs", () => {
    // Two more dry-runs (total 4 since group start including the asserts above)
    buildPlan(macPath, corPath);
    buildPlan(macPath, corPath);
    expect(semanticSchemaHash(macPath)).toBe(macSchemaPre);
    expect(semanticSchemaHash(corPath)).toBe(corSchemaPre);
    expect(tableCount(macPath, "notes")).toBe(macNotesPre);
    expect(tableCount(corPath, "notes")).toBe(corNotesPre);
    expect(tableCount(corPath, "sync_applied_hashes")).toBe(corAppliedHashesPre);
    expect(tableCount(corPath, "sync_applied_hashes")).toBe(0);
    expect(tableCount(corPath, "sync_conflict_queue")).toBe(corConflictQueuePre);
    expect(tableCount(corPath, "sync_conflict_queue")).toBe(0);
  });

  test("report sections present (acceptance (a))", () => {
    const plan = buildPlan(macPath, corPath);
    const r = renderReport(plan, "ts");
    expect(r).toMatch(/^# Shadow sync dry-run/);
    expect(r).toMatch(/## Table: notes/);
    expect(r).toMatch(/## Table: activity/);
    expect(r).toMatch(/## Conflicts/);
    expect(r).toMatch(/## Embeddings to re-compute/);
    expect(r).toMatch(/## Footer/);
    expect(r).toMatch(/Conflicts detected .*: \d+/);
    expect(r).toMatch(/Embeddings to re-compute on M: \d+/);
    expect(r).toMatch(/Estimated apply duration: \d+s/);
  });
});

// -------------------- group 4: pre-017 + post-017 schema cross-compatibility --------------------

describe("engine handles pre-017 (Mac mini) + post-017 (Corsair) schemas", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-sync-mixed-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("mac=pre-017 (no updated_at_ms column), cor=post-017 → engine reads both", () => {
    const macPath = join(tmp, "mac.db");
    const corPath = join(tmp, "cor.db");
    initScratchDb(macPath, false); // pre-017
    initScratchDb(corPath, true); // post-017
    insertNote(macPath, { id: "01PRE17001", type: "memory", text: "from-mac", updated_at: "2026-05-01T00:00:00Z" });
    insertNote(corPath, { id: "01PRE17002", type: "knowledge", text: "from-cor", updated_at: "2026-05-02T00:00:00Z" });
    const plan = buildPlan(macPath, corPath);
    expect(plan.notes.length).toBe(2);
    expect(plan.notes.find((c) => c.rowId === "01PRE17001")?.direction).toBe("M2C");
    expect(plan.notes.find((c) => c.rowId === "01PRE17002")?.direction).toBe("C2M");
  });
});
