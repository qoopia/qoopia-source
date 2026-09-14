/**
 * ТЗ §10.2 / §7.5 / §10.6 — паритет при выключенном флаге, MCP-поверхность
 * и планы запросов.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { createNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import {
  resolveTemporalFilter,
  temporalDeletedSql,
  temporalWhereSql,
} from "../src/services/recall/temporal-filter.ts";
import { effectiveToolSchema, bitemporalToolFields, findTool } from "../src/mcp/tools.ts";
import { V4_TOOL_NAMES } from "../src/mcp/v4-tools.ts";
import {
  applyMigration033,
  applyRollback033,
  cleanupScratchRoots,
  scratchDatabase,
  seedNote,
  seedWorkspace,
} from "./helpers/temporal-fixtures.ts";

let WORKSPACE_ID = "";
let OTHER_WORKSPACE_ID = "";
let AGENT_ID = "";
let OTHER_AGENT_ID = "";
let FOREIGN_AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Temporal Parity", slug: "temporal-parity" });
  WORKSPACE_ID = workspace.id;
  AGENT_ID = createAgent({ name: "parity-a", workspaceSlug: workspace.slug }).id;
  OTHER_AGENT_ID = createAgent({ name: "parity-b", workspaceSlug: workspace.slug }).id;
  const foreign = createWorkspace({ name: "Temporal Foreign", slug: "temporal-foreign" });
  OTHER_WORKSPACE_ID = foreign.id;
  FOREIGN_AGENT_ID = createAgent({ name: "parity-foreign", workspaceSlug: foreign.slug }).id;
});

afterAll(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
  cleanupScratchRoots();
});

describe("R2 raw metadata parity across migration and rollback", () => {
  function seeded() {
    const scratch = scratchDatabase(32);
    const ws = seedWorkspace(scratch.db, "parity");
    for (const [index, metadata] of [
      '{"status":"active","n":1}',
      '{"deep":{"a":[1,2,3]},"unicode":"Абай"}',
      "{}",
    ].entries()) {
      seedNote(scratch.db, {
        id: `p-${index}`,
        workspace_id: ws.workspace_id,
        agent_id: ws.agent_id,
        metadata,
      });
    }
    return scratch;
  }

  function metadataSnapshot(scratch: ReturnType<typeof seeded>): string {
    return JSON.stringify(
      scratch.db.query(`SELECT id, metadata FROM notes ORDER BY id`).all(),
    );
  }

  test("metadata bytes are identical before, after 033 and after rollback", () => {
    const scratch = seeded();
    const before = metadataSnapshot(scratch);
    applyMigration033(scratch.db);
    expect(metadataSnapshot(scratch)).toBe(before);
    applyRollback033(scratch.db);
    expect(metadataSnapshot(scratch)).toBe(before);
  });

  test("after rollback the notes row shape is exactly the pre-033 shape", () => {
    const scratch = seeded();
    const columnsBefore = (
      scratch.db.query(`PRAGMA table_info(notes)`).all() as Array<{ name: string; type: string }>
    ).map((row) => `${row.name}:${row.type}`);
    const rowsBefore = JSON.stringify(scratch.db.query(`SELECT * FROM notes ORDER BY id`).all());
    applyMigration033(scratch.db);
    applyRollback033(scratch.db);
    const columnsAfter = (
      scratch.db.query(`PRAGMA table_info(notes)`).all() as Array<{ name: string; type: string }>
    ).map((row) => `${row.name}:${row.type}`);
    expect(columnsAfter).toEqual(columnsBefore);
    expect(JSON.stringify(scratch.db.query(`SELECT * FROM notes ORDER BY id`).all())).toBe(
      rowsBefore,
    );
  });

  test("provenance is only ever written to its own table, never to notes.metadata", () => {
    const scratch = seeded();
    applyMigration033(scratch.db);
    const withProvenanceKeys = scratch.db
      .query(
        `SELECT COUNT(*) AS c FROM notes
          WHERE metadata LIKE '%valid_until_inferred%'
             OR metadata LIKE '%backfill_class%'
             OR metadata LIKE '%invalidated_at_source%'`,
      )
      .get() as { c: number };
    expect(withProvenanceKeys.c).toBe(0);
  });
});

describe("§7.5 MCP surface follows the flag (live probe)", () => {
  function schemaKeys(name: string): string[] {
    const tool = { name, rawSchema: {}, description: "", risk: "read" as const, handler: () => null };
    return Object.keys(effectiveToolSchema(tool));
  }

  test("flag OFF adds no field to recall or note_create", () => {
    delete process.env.QOOPIA_V4_BITEMPORAL;
    expect(bitemporalToolFields("recall")).toEqual({});
    expect(bitemporalToolFields("note_create")).toEqual({});
    expect(schemaKeys("recall")).toEqual([]);
    expect(schemaKeys("note_create")).toEqual([]);
  });

  test("flag ON adds exactly the specified fields", () => {
    process.env.QOOPIA_V4_BITEMPORAL = "1";
    expect(Object.keys(bitemporalToolFields("recall")).sort()).toEqual([
      "known_as_of",
      "valid_as_of",
    ]);
    // ВНИМАНИЕ: этот список — контракт MCP-поверхности. Ранее он перечислял
    // ровно пять полей и тем самым МАСКИРОВАЛ отсутствие `idempotency_key`:
    // реестр идемпотентности существовал в сервисе, но клиент не мог его
    // использовать. Любое новое V4.1-поле обязано появиться и здесь.
    expect(Object.keys(bitemporalToolFields("note_create")).sort()).toEqual([
      "expected_superseded_updated_at_ms",
      "idempotency_key",
      "subject_key",
      "supersedes_id",
      "valid_from",
      "valid_until",
    ]);
    expect(schemaKeys("note_create")).toContain("idempotency_key");
    expect(bitemporalToolFields("note_get")).toEqual({});
    delete process.env.QOOPIA_V4_BITEMPORAL;
  });

  test("flag OFF keeps idempotency_key off the note_create schema", () => {
    delete process.env.QOOPIA_V4_BITEMPORAL;
    expect(schemaKeys("note_create")).not.toContain("idempotency_key");
    expect(Object.keys(effectiveToolSchema(findTool("note_create")!))).not.toContain(
      "idempotency_key",
    );
  });

  test("no new MCP tool name is introduced by V4.1", () => {
    process.env.QOOPIA_V4_BITEMPORAL = "1";
    expect(V4_TOOL_NAMES).not.toContain("note_temporal");
    expect(V4_TOOL_NAMES.filter((name) => name.includes("temporal"))).toEqual([]);
    delete process.env.QOOPIA_V4_BITEMPORAL;
  });
});

describe("§10.6 query plans and isolation", () => {
  test("the hot current slice uses the partial index and never scans notes", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM notes
          WHERE workspace_id = ? AND invalidated_at_ms IS NULL AND deleted_at IS NULL
          ORDER BY created_at_ms DESC LIMIT 10`,
      )
      .all(WORKSPACE_ID) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_notes_current_ws");
    expect(detail).not.toContain("SCAN notes");
  });

  test("the EXACT flag-ON current-belief predicate is index-driven (production helpers)", () => {
    // Прошлый артефакт EXPLAIN писался вручную и потерял
    // skippedComponentExclusionSql, поэтому показывал НЕ тот предикат.
    // Здесь SQL собирается теми же хелперами, что и на read-path.
    process.env.QOOPIA_V4_BITEMPORAL = "1";
    const filter = resolveTemporalFilter({});
    expect(filter?.current_only).toBe(true);
    const deleted = temporalDeletedSql("n", filter);
    const temporal = temporalWhereSql("n", filter);
    delete process.env.QOOPIA_V4_BITEMPORAL;

    const sql =
      `SELECT n.id FROM notes n WHERE n.workspace_id = ? AND ` +
      `${[...deleted.where, ...temporal.where].join(" AND ")} ` +
      `ORDER BY n.created_at_ms DESC LIMIT 10`;
    expect(sql).toContain("note_temporal_provenance");
    expect(sql).toContain("relation_type = 'supersedes'");

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(WORKSPACE_ID, ...deleted.params, ...temporal.params) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_notes_current_ws");
    expect(detail).toContain("idx_note_relations_target");
    // Корреляции идут по индексам, полного прохода по notes нет.
    for (const line of plan.map((row) => row.detail)) {
      if (/\bSCAN\b/.test(line) && /\bnotes\b/.test(line)) {
        expect(line).toMatch(/USING (COVERING )?INDEX/);
      }
    }
  });

  test("the COMMITTED explain artifacts show the exact flag-ON predicate", () => {
    // §7.3 требует зафиксированный EXPLAIN точного предиката. Проверяем сам
    // закоммиченный артефакт свежайшего бандла, а не только живой план.
    const root = path.resolve(import.meta.dir, "..", "release-evidence");
    const bundles = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(bundles.length).toBeGreaterThan(0);
    const latest = path.join(root, bundles.at(-1)!);

    const currentSlice = fs.readFileSync(path.join(latest, "explain-current-slice.txt"), "utf8");
    expect(currentSlice).toContain("note_temporal_provenance");
    expect(currentSlice).toContain("skipped_reason IS NOT NULL");
    expect(currentSlice).toContain("idx_notes_current_ws");
    expect(currentSlice).toContain("idx_note_relations_target");
    for (const line of currentSlice.split("\n")) {
      if (/\bSCAN\b/.test(line) && /\bnotes\b/.test(line)) {
        expect(line).toMatch(/USING (COVERING )?INDEX/);
      }
    }

    const subjectChain = fs.readFileSync(path.join(latest, "explain-subject-chain.txt"), "utf8");
    expect(subjectChain).toContain("idx_notes_subject_valid");
    expect(subjectChain).toContain("note_temporal_provenance");
    for (const line of subjectChain.split("\n")) {
      if (/\bSCAN\b/.test(line) && /\bnotes\b/.test(line)) {
        expect(line).toMatch(/USING (COVERING )?INDEX/);
      }
    }
  });

  test("the subject chain slice uses its partial index", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM notes
          WHERE workspace_id = ? AND subject_key = ? ORDER BY valid_from_ms`,
      )
      .all(WORKSPACE_ID, "office.address") as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_notes_subject_valid");
    expect(detail).not.toContain("SCAN notes");
  });

  test("workspace isolation and private visibility hold in every temporal mode", async () => {
    process.env.QOOPIA_V4_BITEMPORAL = "1";
    const term = "krellon";
    createNote({
      workspace_id: OTHER_WORKSPACE_ID,
      agent_id: FOREIGN_AGENT_ID,
      text: `${term} foreign workspace`,
      type: "memory",
    });
    const secret = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: OTHER_AGENT_ID,
      text: `${term} private sibling`,
      type: "memory",
      visibility: "private",
    });
    const mine = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: `${term} mine`,
      type: "memory",
    });
    // Аллокатор note-времени монотонен по high-water mark базы, поэтому
    // valid_from_ms только что записанной ноты может опережать стенные часы.
    // Момент наблюдения берём от самой строки, а не от Date.now().
    const mineValidFrom = (
      db.prepare(`SELECT valid_from_ms FROM notes WHERE id = ?`).get(mine.id) as {
        valid_from_ms: number;
      }
    ).valid_from_ms;
    const later = new Date(mineValidFrom + 1000).toISOString();
    const modes: Array<Record<string, unknown>> = [
      {},
      { valid_as_of: later },
      { known_as_of: later },
    ];
    for (const mode of modes) {
      const response = await recall({
        workspace_id: WORKSPACE_ID,
        caller_agent_id: AGENT_ID,
        is_admin: false,
        query: term,
        limit: 50,
        ...mode,
      } as never);
      const found = response.results.map((row) => row.id);
      expect(found).toContain(mine.id);
      expect(found).not.toContain(secret.id);
      for (const row of response.results) {
        expect(row.workspace_id).toBe(WORKSPACE_ID);
      }
    }
    delete process.env.QOOPIA_V4_BITEMPORAL;
  });
});
