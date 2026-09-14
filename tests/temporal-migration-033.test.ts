/**
 * ТЗ §10.1 — preflight/migration 033 (R1/R5/R6).
 *
 * Проверяются: покрытие отчёта, инвариант «нет мутации при провале Phase A
 * или записи отчёта», gate Phase C, идемпотентность/resume, backfill linear,
 * conservative-пометки split/cyclic/oversize, FK и workspace-триггеры
 * provenance при `PRAGMA foreign_keys=ON`, и откат.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migration033GateState } from "../src/db/migration-033-gate.ts";
import { computeLogicalDatabaseHash, readSchemaVersion } from "../src/db/v4-migrations.ts";
import {
  buildStagingPlan,
  runPhaseA,
  runPreflight,
  writeReport,
  REPORT_FILENAME,
} from "../scripts/migrate-033-preflight.ts";
import {
  applyMigration033,
  applyRollback033,
  cleanupScratchRoots,
  scratchDatabase,
  seedClassifierGraph,
  seedNote,
  seedWorkspace,
  stagePreflight,
  type Scratch,
} from "./helpers/temporal-fixtures.ts";

afterAll(() => cleanupScratchRoots());

const MAX = 10;

function noteColumns(db: Scratch["db"]): string[] {
  return (db.query(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function evidenceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v41-evidence-"));
}

function preparedGraph() {
  const scratch = scratchDatabase(32);
  const fixture = seedClassifierGraph(scratch.db, "mig", 12);
  return { scratch, fixture };
}

describe("R1 Phase A — pure read report", () => {
  test("report covers every component by class and writes nothing to the DB", () => {
    const { scratch } = preparedGraph();
    const before = computeLogicalDatabaseHash(scratch.db);
    const report = runPhaseA(scratch.db, MAX);
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(before);

    expect(report.totals.components).toBe(report.components.length);
    expect(report.totals.linear).toBe(2); // lin-* и private-цепочка
    expect(report.totals.split_head).toBe(1);
    expect(report.totals.cyclic).toBe(1);
    expect(report.totals.oversize).toBe(1);
    const classified = report.components.filter((component) =>
      ["linear", "split_head", "cyclic", "oversize"].includes(component.klass),
    );
    expect(classified).toHaveLength(report.components.length);
    expect(report.totals.nodes).toBe(
      report.components.reduce((sum, component) => sum + component.node_count, 0),
    );
  });

  test("a failing report write leaves the schema and rows untouched (0 ADD COLUMN)", () => {
    const { scratch } = preparedGraph();
    const columnsBefore = noteColumns(scratch.db);
    const hashBefore = computeLogicalDatabaseHash(scratch.db);

    // Инъекция сбоя: evidence-путь занят файлом, mkdir провалится.
    const root = evidenceDir();
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    expect(() => {
      const report = runPhaseA(scratch.db, MAX);
      writeReport(path.join(blocked, "nested"), report);
    }).toThrow();

    expect(noteColumns(scratch.db)).toEqual(columnsBefore);
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(hashBefore);
    expect(stagingTables(scratch.db)).toEqual([]);
  });

  test("a failing Phase A leaves the database untouched", () => {
    const { scratch } = preparedGraph();
    const hashBefore = computeLogicalDatabaseHash(scratch.db);
    // Инъекция сбоя чтения: второй handle к тому же файлу закрыт до Phase A.
    const broken = new Database(scratch.filename, { readonly: true });
    broken.close();
    expect(() => runPhaseA(broken, MAX)).toThrow();
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(hashBefore);
    expect(noteColumns(scratch.db)).not.toContain("valid_from_ms");
    expect(stagingTables(scratch.db)).toEqual([]);
  });
});

function stagingTables(db: Scratch["db"]): string[] {
  return (
    db
      .query(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name LIKE 'mig033%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("R1 Phase B — durable staging", () => {
  test("staging holds pre-computed integer ms and derived ISO for linear targets only", () => {
    const { scratch } = preparedGraph();
    const report = runPhaseA(scratch.db, MAX);
    const plan = buildStagingPlan(scratch.db, report);
    stagePreflight(scratch.db, plan, MAX);

    expect(stagingTables(scratch.db)).toEqual([
      "mig033_linear_targets",
      "mig033_skipped",
      "mig033_staging_meta",
    ]);
    const targets = scratch.db
      .query(`SELECT * FROM mig033_linear_targets ORDER BY note_id`)
      .all() as Array<Record<string, any>>;
    expect(targets.map((row) => row.note_id)).toEqual(["lin-a", "lin-b", "prv-a"]);

    const linA = targets.find((row) => row.note_id === "lin-a")!;
    // min(Date.parse(relation.created_at)) по входящим рёбрам
    expect(linA.invalidated_at_ms).toBe(Date.parse("2026-02-01T00:00:00.500Z"));
    // valid_until = max(valid_from_ms, invalidated_at_ms), valid_from = created_at
    expect(linA.valid_until_ms).toBe(Date.parse("2026-02-01T00:00:00.500Z"));
    expect(linA.invalidated_at_iso).toBe("2026-02-01T00:00:00.500Z");
    expect(linA.valid_until_iso).toBe("2026-02-01T00:00:00.500Z");
    expect(new Date(linA.invalidated_at_ms).toISOString()).toBe(linA.invalidated_at_iso);

    const skipped = scratch.db
      .query(`SELECT note_id, backfill_class, skipped_reason FROM mig033_skipped ORDER BY note_id`)
      .all() as Array<{ note_id: string; backfill_class: string; skipped_reason: string }>;
    const classes = new Map(skipped.map((row) => [row.note_id, row.backfill_class]));
    expect(classes.get("spl-a")).toBe("split_head");
    expect(classes.get("cyc-a")).toBe("cyclic");
    expect(classes.get("ovr-000")).toBe("oversize");
    // Активные головы линейных компонент в staging не попадают.
    expect(skipped.some((row) => row.note_id.startsWith("lin-"))).toBe(false);
  });

  test("the CLI entry point runs A then B end to end", () => {
    const { scratch } = preparedGraph();
    const dir = evidenceDir();
    const result = runPreflight({
      db: scratch.filename,
      evidenceDir: dir,
      maxComponentSize: MAX,
      phase: "ab",
    });
    expect(fs.existsSync(path.join(dir, REPORT_FILENAME))).toBe(true);
    expect(result.staged).toBeGreaterThan(0);
    expect(stagingTables(scratch.db)).toEqual([
      "mig033_linear_targets",
      "mig033_skipped",
      "mig033_staging_meta",
    ]);
  });

  test("--phase a opens the database read-only and stages nothing", () => {
    const { scratch } = preparedGraph();
    const dir = evidenceDir();
    runPreflight({ db: scratch.filename, evidenceDir: dir, maxComponentSize: MAX, phase: "a" });
    expect(fs.existsSync(path.join(dir, REPORT_FILENAME))).toBe(true);
    expect(stagingTables(scratch.db)).toEqual([]);
  });
});

describe("Phase C — migration 033", () => {
  function migrated() {
    const { scratch, fixture } = preparedGraph();
    const report = runPhaseA(scratch.db, MAX);
    stagePreflight(scratch.db, buildStagingPlan(scratch.db, report), MAX);
    applyMigration033(scratch.db);
    return { scratch, fixture };
  }

  test("refuses to start without staging when a supersede graph exists", () => {
    const { scratch } = preparedGraph();
    const columnsBefore = noteColumns(scratch.db);
    const gate = migration033GateState(scratch.db);
    expect(gate.ok).toBe(false);
    expect(gate.staging_present).toBe(false);
    expect(gate.supersede_edges).toBeGreaterThan(0);
    expect(() => applyMigration033(scratch.db)).toThrow(/preflight staging is missing/);
    expect(noteColumns(scratch.db)).toEqual(columnsBefore);
    expect(readSchemaVersion(scratch.db)).toBe(32);
  });

  test("applies on a database with no supersede edges (nothing to classify)", () => {
    const scratch = scratchDatabase(32);
    seedWorkspace(scratch.db, "nograph");
    applyMigration033(scratch.db);
    expect(readSchemaVersion(scratch.db)).toBe(33);
    expect(noteColumns(scratch.db)).toContain("valid_from_ms");
  });

  test("linear components are closed from relation time; valid_from_ms is never null", () => {
    const { scratch } = migrated();
    const nulls = scratch.db
      .query(`SELECT COUNT(*) AS c FROM notes WHERE valid_from_ms IS NULL`)
      .get() as { c: number };
    expect(nulls.c).toBe(0);

    const linA = scratch.db
      .query(
        `SELECT invalidated_at, invalidated_at_ms, valid_until, valid_until_ms,
                valid_from, valid_from_ms, created_at_ms
           FROM notes WHERE id = 'lin-a'`,
      )
      .get() as Record<string, any>;
    expect(linA.invalidated_at_ms).toBe(Date.parse("2026-02-01T00:00:00.500Z"));
    expect(linA.invalidated_at).toBe("2026-02-01T00:00:00.500Z");
    expect(Date.parse(linA.valid_until)).toBe(linA.valid_until_ms);
    expect(linA.valid_from).toBe("2026-01-01T00:00:00Z");
    expect(linA.valid_from_ms).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(linA.created_at_ms).toBe(linA.valid_from_ms);

    // Активная голова остаётся открытой.
    const linC = scratch.db
      .query(`SELECT invalidated_at_ms, valid_until_ms FROM notes WHERE id = 'lin-c'`)
      .get() as Record<string, any>;
    expect(linC.invalidated_at_ms).toBeNull();
    expect(linC.valid_until_ms).toBeNull();
  });

  test("split / cyclic / oversize are tagged in provenance and never mutated", () => {
    const { scratch } = migrated();
    const skippedIds = ["spl-a", "spl-b", "spl-c", "cyc-a", "cyc-b", "ovr-000", "ovr-011"];
    for (const id of skippedIds) {
      const note = scratch.db
        .query(`SELECT invalidated_at_ms, valid_until_ms FROM notes WHERE id = ?`)
        .get(id) as Record<string, any>;
      expect(note.invalidated_at_ms).toBeNull();
      expect(note.valid_until_ms).toBeNull();
    }
    const provenance = scratch.db
      .query(
        `SELECT note_id, backfill_class, skipped_reason FROM note_temporal_provenance
          WHERE skipped_reason IS NOT NULL ORDER BY note_id`,
      )
      .all() as Array<{ note_id: string; backfill_class: string; skipped_reason: string }>;
    const map = new Map(provenance.map((row) => [row.note_id, row]));
    expect(map.get("spl-b")!.skipped_reason).toBe("split_head_component");
    expect(map.get("cyc-a")!.skipped_reason).toBe("cyclic_component");
    expect(map.get("ovr-005")!.skipped_reason).toBe("oversize_component");
  });

  test("linear provenance records inferred valid-time and observed transaction-time", () => {
    const { scratch } = migrated();
    const row = scratch.db
      .query(
        `SELECT invalidated_at_source, valid_until_source, valid_until_inferred, backfill_class
           FROM note_temporal_provenance WHERE note_id = 'lin-a'`,
      )
      .get() as Record<string, any>;
    expect(row.invalidated_at_source).toBe("note_relations.created_at");
    expect(row.valid_until_source).toBe("inferred_from_relation");
    expect(row.valid_until_inferred).toBe(1);
    expect(row.backfill_class).toBe("linear");
  });

  test("staging is dropped and schema_versions records 33", () => {
    const { scratch } = migrated();
    expect(stagingTables(scratch.db)).toEqual([]);
    expect(readSchemaVersion(scratch.db)).toBe(33);
  });

  test("notes.metadata is byte-identical across the migration (R2)", () => {
    const { scratch } = preparedGraph();
    const before = scratch.db
      .query(`SELECT id, metadata, updated_at, updated_at_ms FROM notes ORDER BY id`)
      .all();
    const report = runPhaseA(scratch.db, MAX);
    stagePreflight(scratch.db, buildStagingPlan(scratch.db, report), MAX);
    applyMigration033(scratch.db);
    const after = scratch.db
      .query(`SELECT id, metadata, updated_at, updated_at_ms FROM notes ORDER BY id`)
      .all();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("Phase C is idempotent on resume — re-running the backfill statements is a no-op", () => {
    const { scratch } = migrated();
    const snapshot = computeLogicalDatabaseHash(scratch.db);
    // Повторный прогон целиком отвергается (колонки уже есть) — важен именно
    // инвариант «состояние не поехало».
    expect(() => applyMigration033(scratch.db)).toThrow();
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(snapshot);
    expect(readSchemaVersion(scratch.db)).toBe(33);
  });
});

describe("R5 provenance FK and workspace triggers", () => {
  function migratedWithTwoWorkspaces() {
    const scratch = scratchDatabase(32);
    const a = seedWorkspace(scratch.db, "fk-a");
    const b = seedWorkspace(scratch.db, "fk-b");
    seedNote(scratch.db, { id: "fk-note-a", workspace_id: a.workspace_id, agent_id: a.agent_id });
    seedNote(scratch.db, { id: "fk-note-b", workspace_id: b.workspace_id, agent_id: b.agent_id });
    applyMigration033(scratch.db);
    return { scratch, a, b };
  }

  test("PRAGMA foreign_keys is ON for the fixture connection", () => {
    const { scratch } = migratedWithTwoWorkspaces();
    const state = scratch.db.query(`PRAGMA foreign_keys`).get() as { foreign_keys: number };
    expect(state.foreign_keys).toBe(1);
  });

  test("(a)(b) insert for an existing note with the right workspace succeeds", () => {
    const { scratch, a } = migratedWithTwoWorkspaces();
    scratch.db
      .query(
        `INSERT INTO note_temporal_provenance (note_id, workspace_id, backfill_class)
         VALUES (?, ?, 'linear')`,
      )
      .run("fk-note-a", a.workspace_id);
    const row = scratch.db
      .query(`SELECT workspace_id FROM note_temporal_provenance WHERE note_id = 'fk-note-a'`)
      .get() as { workspace_id: string };
    expect(row.workspace_id).toBe(a.workspace_id);
  });

  test("(c) a workspace mismatch is aborted by the trigger", () => {
    const { scratch, b } = migratedWithTwoWorkspaces();
    expect(() =>
      scratch.db
        .query(
          `INSERT INTO note_temporal_provenance (note_id, workspace_id) VALUES (?, ?)`,
        )
        .run("fk-note-a", b.workspace_id),
    ).toThrow(/workspace_id mismatch/);
  });

  test("(c) an UPDATE moving the row to a foreign workspace is aborted too", () => {
    const { scratch, a, b } = migratedWithTwoWorkspaces();
    scratch.db
      .query(`INSERT INTO note_temporal_provenance (note_id, workspace_id) VALUES (?, ?)`)
      .run("fk-note-a", a.workspace_id);
    expect(() =>
      scratch.db
        .query(`UPDATE note_temporal_provenance SET workspace_id = ? WHERE note_id = ?`)
        .run(b.workspace_id, "fk-note-a"),
    ).toThrow(/workspace_id mismatch/);
  });

  test("(d) a non-existent note_id is rejected", () => {
    const { scratch, a } = migratedWithTwoWorkspaces();
    // Триггер срабатывает раньше FK: подзапрос по несуществующему note_id даёт
    // NULL, поэтому условие workspace-совпадения не выполняется. Итог тот же —
    // строка не появляется.
    expect(() =>
      scratch.db
        .query(`INSERT INTO note_temporal_provenance (note_id, workspace_id) VALUES (?, ?)`)
        .run("no-such-note", a.workspace_id),
    ).toThrow();
    const count = scratch.db
      .query(`SELECT COUNT(*) AS c FROM note_temporal_provenance`)
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("(d) the bare FK also rejects a non-existent note_id", () => {
    const { scratch, a } = migratedWithTwoWorkspaces();
    // Снимаем триггер на одноразовой scratch-БД, чтобы проверить именно FK.
    scratch.db.exec(`DROP TRIGGER ntp_ws_consistency_ins`);
    expect(() =>
      scratch.db
        .query(`INSERT INTO note_temporal_provenance (note_id, workspace_id) VALUES (?, ?)`)
        .run("no-such-note", a.workspace_id),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("the FK targets the notes primary key", () => {
    const { scratch } = migratedWithTwoWorkspaces();
    const fks = scratch.db
      .query(`PRAGMA foreign_key_list(note_temporal_provenance)`)
      .all() as Array<{ table: string; from: string; to: string | null }>;
    expect(fks).toHaveLength(1);
    expect(fks[0]!.table).toBe("notes");
    expect(fks[0]!.from).toBe("note_id");
    expect(fks[0]!.to).toBe("id");
  });

  test("rollback removes the table, its triggers and the nine columns", () => {
    const { scratch } = migratedWithTwoWorkspaces();
    applyRollback033(scratch.db);
    const objects = scratch.db
      .query(
        `SELECT name FROM sqlite_master
          WHERE name IN ('note_temporal_provenance','ntp_ws_consistency_ins','ntp_ws_consistency_upd')`,
      )
      .all();
    expect(objects).toEqual([]);
    const columns = noteColumns(scratch.db);
    for (const column of [
      "valid_from",
      "valid_until",
      "invalidated_at",
      "subject_key",
      "supersedes_id",
      "created_at_ms",
      "valid_from_ms",
      "valid_until_ms",
      "invalidated_at_ms",
    ]) {
      expect(columns).not.toContain(column);
    }
    expect(readSchemaVersion(scratch.db)).toBe(32);
  });

  test("DROP COLUMN is supported by the SQLite build under test", () => {
    const { scratch } = migratedWithTwoWorkspaces();
    const version = scratch.db.query(`SELECT sqlite_version() AS v`).get() as { v: string };
    const [major, minor] = version.v.split(".").map((part) => Number(part));
    expect(major! > 3 || (major === 3 && minor! >= 35)).toBe(true);
  });
});
