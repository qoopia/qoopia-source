/**
 * Регрессии на замечания независимого review (SHA 47875be).
 *
 * CRITICAL — Phase C не была failure-atomic под bun-раннером: весь `033.sql`
 * исполнялся одним `db.exec`, а `bun:sqlite` молча проглатывает ошибки
 * ВРЕМЕНИ ИСПОЛНЕНИЯ (CHECK / RAISE(ABORT) из триггера / FK). Сбой внутри
 * Phase C доходил до `DROP TABLE` + `schema_versions(33)`, оставляя базу
 * полу-мигрированной с пустым provenance.
 *
 * HIGH — staging Phase B не проверялась на свежесть и полноту: gate смотрел
 * только на присутствие таблиц, staging переживала прогоны (`IF NOT EXISTS`
 * + `INSERT OR REPLACE`), а отчёт Phase A и staging Phase B не были связаны
 * одним снимком графа.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  applyMigration033Sql,
  assertMigration033Postconditions,
  captureMigration033Snapshot,
  splitSqlStatements,
} from "../src/db/migration-033-exec.ts";
import {
  migration033GateState,
  supersedeGraphDigest,
} from "../src/db/migration-033-gate.ts";
import { computeLogicalDatabaseHash, readSchemaVersion } from "../src/db/v4-migrations.ts";
import {
  readStagingPlan,
  runPreflight,
  stagingPlanDigest,
} from "../scripts/migrate-033-preflight.ts";
import {
  MIGRATION_033,
  applyMigration033,
  cleanupScratchRoots,
  scratchDatabase,
  seedClassifierGraph,
  seedNote,
  stagePreflight,
  type Scratch,
} from "./helpers/temporal-fixtures.ts";

afterAll(() => cleanupScratchRoots());

const MAX = 10;
const SQL = fs.readFileSync(MIGRATION_033, "utf8");

function preparedGraph(): { scratch: Scratch; fixture: ReturnType<typeof seedClassifierGraph> } {
  const scratch = scratchDatabase(32);
  const fixture = seedClassifierGraph(scratch.db, "atomicity", MAX + 2);
  return { scratch, fixture };
}

function noteColumns(scratch: Scratch): string[] {
  return (scratch.db.query(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .sort();
}

function evidenceDir(): string {
  const dir = fs.mkdtempSync(path.join(scratchDatabase(32).root, "evidence-"));
  return dir;
}

describe("CRITICAL — Phase C is failure-atomic under the bun runner", () => {
  test("splitSqlStatements keeps CREATE TRIGGER ... BEGIN ... END as one statement", () => {
    const statements = splitSqlStatements(SQL);
    const triggers = statements.filter((s) => /CREATE TRIGGER/i.test(s));
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger).toContain("RAISE(ABORT");
      expect(trigger.trimEnd().endsWith("END")).toBe(true);
    }
    // Последний оператор — запись версии схемы; постусловия обязаны идти до неё.
    expect(statements.at(-1)).toMatch(/INSERT INTO schema_versions/i);
    expect(statements.filter((s) => /ALTER TABLE notes ADD COLUMN/i.test(s))).toHaveLength(9);
  });

  test("bun db.exec swallows the runtime trigger failure — the reason the runner cannot use it", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    // Строка staging, ссылающаяся на несуществующую ноту: provenance-триггер
    // обязан выбросить RAISE(ABORT).
    scratch.db.run(
      `INSERT INTO mig033_skipped (note_id, workspace_id, backfill_class, skipped_reason)
       VALUES ('ghost-note', 'ghost-ws', 'cyclic', 'cyclic_component')`,
    );
    let swallowed = true;
    try {
      scratch.db.transaction(() => scratch.db.exec(SQL))();
    } catch {
      swallowed = false;
    }
    // Именно это и есть дефект: exec «успешен», хотя provenance неполон.
    expect(swallowed).toBe(true);
    expect(readSchemaVersion(scratch.db)).toBe(33);
  });

  test("the statement-wise runner aborts on the same trigger failure and changes nothing", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    scratch.db.run(
      `INSERT INTO mig033_skipped (note_id, workspace_id, backfill_class, skipped_reason)
       VALUES ('ghost-note', 'ghost-ws', 'cyclic', 'cyclic_component')`,
    );
    const columnsBefore = noteColumns(scratch);
    const hashBefore = computeLogicalDatabaseHash(scratch.db);

    expect(() =>
      scratch.db.transaction(() => applyMigration033Sql(scratch.db, SQL))(),
    ).toThrow();

    expect(readSchemaVersion(scratch.db)).toBe(32);
    expect(noteColumns(scratch)).toEqual(columnsBefore);
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(hashBefore);
    // Нулевые частичные записи: ни колонок, ни provenance, ни снятой staging.
    const provenance = scratch.db
      .query(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'note_temporal_provenance'`)
      .get() as { c: number };
    expect(provenance.c).toBe(0);
    const staging = scratch.db
      .query(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'mig033_linear_targets'`)
      .get() as { c: number };
    expect(staging.c).toBe(1);
  });

  test("the gate refuses the same bad staging before a single statement runs", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    scratch.db.run(
      `INSERT INTO mig033_skipped (note_id, workspace_id, backfill_class, skipped_reason)
       VALUES ('ghost-note', 'ghost-ws', 'cyclic', 'cyclic_component')`,
    );
    const state = migration033GateState(scratch.db);
    expect(state.ok).toBe(false);
    expect(state.orphan_staging_rows).toBe(1);
    expect(() => applyMigration033(scratch.db)).toThrow(/absent from notes/);
    expect(readSchemaVersion(scratch.db)).toBe(32);
  });

  test("a Phase C that silently skips a backfill fails the postconditions before schema_versions", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    // Скрипт без INSERT provenance для skipped-узлов: раньше такой прогон
    // был «успешен» и записывал schema_versions(33) с неполным provenance.
    const mutilated = splitSqlStatements(SQL)
      .filter((statement) => !/FROM mig033_skipped/i.test(statement))
      .join(";\n");
    expect(() =>
      scratch.db.transaction(() => applyMigration033Sql(scratch.db, mutilated))(),
    ).toThrow(/postcondition failed/);
    expect(readSchemaVersion(scratch.db)).toBe(32);
    expect(noteColumns(scratch)).not.toContain("valid_from_ms");
  });

  test("postconditions reject a run that leaves valid_from_ms NULL", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    const mutilated = splitSqlStatements(SQL)
      .filter((statement) => !/SET valid_from = created_at/i.test(statement))
      .join(";\n");
    expect(() =>
      scratch.db.transaction(() => applyMigration033Sql(scratch.db, mutilated))(),
    ).toThrow(/valid_from_ms IS NULL/);
    expect(readSchemaVersion(scratch.db)).toBe(32);
  });

  test("the postcondition helper is usable standalone and rejects a count mismatch", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    const snapshot = captureMigration033Snapshot(scratch.db);
    expect(snapshot.linear_target_count).toBeGreaterThan(0);
    expect(snapshot.skipped_count).toBeGreaterThan(0);
    applyMigration033(scratch.db);
    expect(readSchemaVersion(scratch.db)).toBe(33);
    // Реальный снимок проходит; завышенный ожидаемый счётчик — нет.
    expect(() => assertMigration033Postconditions(scratch.db, snapshot)).not.toThrow();
    expect(() =>
      assertMigration033Postconditions(scratch.db, {
        ...snapshot,
        skipped_count: snapshot.skipped_count + 1,
      }),
    ).toThrow(/postcondition failed/);
  });

  test("both runners share the failure-atomic path", () => {
    const migrate = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "src/db/migrate.ts"),
      "utf8",
    );
    const v4 = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "src/db/v4-migrations.ts"),
      "utf8",
    );
    for (const source of [migrate, v4]) {
      expect(source).toContain("applyMigration033Sql");
      expect(source).toContain("assertMigration033Gate");
    }
  });
});

describe("HIGH — preflight staging freshness and coverage", () => {
  test("Phase B drops and recreates staging so rows from an earlier run cannot survive", () => {
    const { scratch } = preparedGraph();
    const dir = evidenceDir();
    runPreflight({ db: scratch.filename, evidenceDir: dir, maxComponentSize: MAX, phase: "ab" });
    const firstCount = (
      scratch.db.query(`SELECT COUNT(*) AS c FROM mig033_linear_targets`).get() as { c: number }
    ).c;
    expect(firstCount).toBeGreaterThan(0);

    // Граф сжимается: удаляем все рёбра linear-цепочки.
    scratch.db.run(`DELETE FROM note_relations WHERE target_note_id = 'lin-a'`);
    runPreflight({ db: scratch.filename, evidenceDir: dir, maxComponentSize: MAX, phase: "ab" });
    const stale = scratch.db
      .query(`SELECT COUNT(*) AS c FROM mig033_linear_targets WHERE note_id = 'lin-a'`)
      .get() as { c: number };
    expect(stale.c).toBe(0);
  });

  test("stale staging is refused: 0 ADD COLUMN and an unchanged database hash", () => {
    const { scratch } = preparedGraph();
    const dir = evidenceDir();
    runPreflight({ db: scratch.filename, evidenceDir: dir, maxComponentSize: MAX, phase: "ab" });
    // Граф расходится ПОСЛЕ preflight: новая нота и новое ребро.
    seedNote(scratch.db, {
      id: "late-a",
      workspace_id: "ws-atomicity",
      agent_id: "agent-atomicity",
    });
    scratch.db.run(
      `INSERT INTO note_relations
         (id, workspace_id, source_note_id, target_note_id, relation_type,
          created_by_agent_id, metadata, created_at)
       VALUES ('rel-late', 'ws-atomicity', 'lin-c', 'late-a', 'supersedes',
               'agent-atomicity', '{}', '2026-04-01T00:00:00.000Z')`,
    );

    const state = migration033GateState(scratch.db);
    expect(state.ok).toBe(false);
    expect(state.staging_present).toBe(true);
    expect(state.staged_graph_digest).not.toBe(state.live_graph_digest);

    const columnsBefore = noteColumns(scratch);
    const hashBefore = computeLogicalDatabaseHash(scratch.db);
    expect(() => applyMigration033(scratch.db)).toThrow(/staging is stale/);
    expect(noteColumns(scratch)).toEqual(columnsBefore);
    expect(noteColumns(scratch)).not.toContain("valid_from_ms");
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(hashBefore);
    expect(readSchemaVersion(scratch.db)).toBe(32);
  });

  test("incomplete staging coverage is refused even when the digest matches", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    scratch.db.run(`DELETE FROM mig033_linear_targets WHERE note_id = 'lin-a'`);
    const state = migration033GateState(scratch.db);
    expect(state.ok).toBe(false);
    expect(state.uncovered_targets).toBe(1);
    expect(() => applyMigration033(scratch.db)).toThrow(/not covered by preflight staging/);
    expect(readSchemaVersion(scratch.db)).toBe(32);
  });

  test("staging without its meta row is refused (no digest to verify against)", () => {
    const { scratch } = preparedGraph();
    stagePreflight(scratch.db);
    scratch.db.run(`DELETE FROM mig033_staging_meta WHERE key = 'graph_digest'`);
    expect(migration033GateState(scratch.db).ok).toBe(false);
    expect(() => applyMigration033(scratch.db)).toThrow(/graph_digest/);
  });

  test("Phase A report and Phase B staging come from one locked snapshot", () => {
    const { scratch } = preparedGraph();
    const dir = evidenceDir();
    const result = runPreflight({
      db: scratch.filename,
      evidenceDir: dir,
      maxComponentSize: MAX,
      phase: "ab",
    });
    // Дайджест, зафиксированный вместе со staging, равен дайджесту графа,
    // по которому построен отчёт, и живому графу сразу после коммита.
    expect(result.graph_digest).toBe(supersedeGraphDigest(scratch.db));
    const staged = scratch.db
      .query(`SELECT value FROM mig033_staging_meta WHERE key = 'graph_digest'`)
      .get() as { value: string };
    expect(staged.value).toBe(result.graph_digest);
    expect(migration033GateState(scratch.db).ok).toBe(true);
  });

  test("a failed report write rolls the whole preflight back — no staging at all", () => {
    const { scratch } = preparedGraph();
    const hashBefore = computeLogicalDatabaseHash(scratch.db);
    // Каталог отчёта занят файлом -> mkdir падает уже после Phase A.
    const blocked = path.join(scratch.root, "blocked");
    fs.writeFileSync(blocked, "not a directory\n");
    expect(() =>
      runPreflight({
        db: scratch.filename,
        evidenceDir: blocked,
        maxComponentSize: MAX,
        phase: "ab",
      }),
    ).toThrow();
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(hashBefore);
    const staging = scratch.db
      .query(
        `SELECT COUNT(*) AS c FROM sqlite_master
          WHERE name IN ('mig033_linear_targets', 'mig033_skipped', 'mig033_staging_meta')`,
      )
      .get() as { c: number };
    expect(staging.c).toBe(0);
  });
});

/**
 * HIGH-1 (fix-pass #2) — gate обязан аттестовать СОДЕРЖАНИЕ staging.
 *
 * Прошлая версия сверяла дайджест живого графа и присутствие целей. Проба
 * независимого review переписала linear-цель `lin-a` в ложную cyclic-строку
 * `mig033_skipped`: граф не менялся, покрытие целей осталось полным — gate
 * возвращал ok:true и пропускал заведомо неверный backfill, обходя
 * conservative-гарантию R1.
 */
describe("HIGH-1 — the gate attests staging CONTENT, not just presence", () => {
  function staged(): Scratch {
    const scratch = scratchDatabase(32);
    seedClassifierGraph(scratch.db, `content-${contentSeq++}`, MAX + 2);
    stagePreflight(scratch.db, undefined, MAX);
    return scratch;
  }

  /** Проверить, что gate отказал И база осталась нетронутой. */
  function expectRefusal(scratch: Scratch, pattern: RegExp): void {
    const columnsBefore = noteColumns(scratch);
    const hashBefore = computeLogicalDatabaseHash(scratch.db);
    const state = migration033GateState(scratch.db);
    expect(state.ok).toBe(false);
    expect(state.reason ?? "").toMatch(pattern);
    expect(() => applyMigration033(scratch.db)).toThrow(pattern);
    expect(noteColumns(scratch)).toEqual(columnsBefore);
    expect(noteColumns(scratch)).not.toContain("valid_from_ms");
    expect(computeLogicalDatabaseHash(scratch.db)).toBe(hashBefore);
    expect(readSchemaVersion(scratch.db)).toBe(32);
  }

  test("a correctly staged database still passes", () => {
    const scratch = staged();
    const state = migration033GateState(scratch.db);
    expect(state.ok).toBe(true);
    expect(state.staged_plan_digest).toBe(state.recomputed_plan_digest!);
    expect(state.staged_plan_digest).not.toBeNull();
  });

  test("CLASS substitution: a linear target rewritten as a false cyclic skip is refused", () => {
    // Дословная проба ревьюера: тот же граф, то же покрытие целей.
    const scratch = staged();
    const before = migration033GateState(scratch.db);
    expect(before.ok).toBe(true);

    scratch.db.run(`DELETE FROM mig033_linear_targets WHERE note_id = 'lin-a'`);
    scratch.db.run(
      `INSERT INTO mig033_skipped (note_id, workspace_id, backfill_class, skipped_reason)
       SELECT 'lin-a', workspace_id, 'cyclic', 'cyclic_component'
         FROM notes WHERE id = 'lin-a'`,
    );
    const after = migration033GateState(scratch.db);
    // Граф и покрытие по-прежнему в порядке — раньше именно это и пропускало.
    expect(after.staged_graph_digest).toBe(after.live_graph_digest);
    expect(after.uncovered_targets).toBe(0);
    expect(after.orphan_staging_rows).toBe(0);
    expectRefusal(scratch, /staging content does not match|does not match the plan digest/);
  });

  test("CLASS substitution the other way: a skipped node promoted to a linear target is refused", () => {
    const scratch = staged();
    const ws = (
      scratch.db.query(`SELECT workspace_id FROM notes WHERE id = 'spl-a'`).get() as {
        workspace_id: string;
      }
    ).workspace_id;
    scratch.db.run(`DELETE FROM mig033_skipped WHERE note_id = 'spl-a'`);
    scratch.db.run(
      `INSERT INTO mig033_linear_targets
         (note_id, workspace_id, invalidated_at_ms, valid_until_ms,
          invalidated_at_iso, valid_until_iso)
       VALUES ('spl-a', ?, 1770000000000, 1770000000000,
               '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
      [ws],
    );
    expectRefusal(scratch, /staging content does not match|does not match the plan digest/);
  });

  test("FIELD substitution: a tampered invalidated_at_ms is refused", () => {
    const scratch = staged();
    scratch.db.run(
      `UPDATE mig033_linear_targets SET invalidated_at_ms = invalidated_at_ms + 1000
        WHERE note_id = 'lin-a'`,
    );
    expectRefusal(scratch, /staging content does not match|does not match the plan digest/);
  });

  test("FIELD substitution: a tampered derived ISO is refused even when the ms match", () => {
    const scratch = staged();
    scratch.db.run(
      `UPDATE mig033_linear_targets SET valid_until_iso = '2099-01-01T00:00:00.000Z'
        WHERE note_id = 'lin-a'`,
    );
    // Целые ms не тронуты — ловится только построчной сверкой полей.
    const ms = scratch.db
      .query(`SELECT valid_until_ms FROM mig033_linear_targets WHERE note_id = 'lin-a'`)
      .get() as { valid_until_ms: number };
    expect(ms.valid_until_ms).toBeGreaterThan(0);
    expectRefusal(scratch, /staging content does not match|does not match the plan digest/);
  });

  test("FIELD substitution: an altered skipped_reason or backfill_class is refused", () => {
    const scratch = staged();
    scratch.db.run(
      `UPDATE mig033_skipped SET backfill_class = 'oversize', skipped_reason = 'oversize_component'
        WHERE note_id = 'spl-a'`,
    );
    expectRefusal(scratch, /staging content does not match|does not match the plan digest/);
  });

  test("an extra fabricated linear target is refused", () => {
    const scratch = staged();
    const ws = (
      scratch.db.query(`SELECT workspace_id FROM notes WHERE id = 'lin-c'`).get() as {
        workspace_id: string;
      }
    ).workspace_id;
    scratch.db.run(
      `INSERT INTO mig033_linear_targets
         (note_id, workspace_id, invalidated_at_ms, valid_until_ms,
          invalidated_at_iso, valid_until_iso)
       VALUES ('lin-c', ?, 1770000000000, 1770000000000,
               '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
      [ws],
    );
    // `lin-c` — активная голова, закрывать её нельзя ни при каких условиях.
    expectRefusal(scratch, /staging content does not match|does not match the plan digest/);
  });

  test("a tampered plan_digest cannot whitewash tampered rows", () => {
    const scratch = staged();
    scratch.db.run(
      `UPDATE mig033_linear_targets SET invalidated_at_ms = invalidated_at_ms + 1000
        WHERE note_id = 'lin-a'`,
    );
    // Атакующий пересчитывает записанный дайджест под свои строки: сверка с
    // ПЕРЕСЧИТАННЫМ из живого графа планом всё равно не сходится.
    const tampered = stagingPlanDigest(readStagingPlan(scratch.db));
    scratch.db.run(`UPDATE mig033_staging_meta SET value = ? WHERE key = 'plan_digest'`, [
      tampered,
    ]);
    expectRefusal(scratch, /staging content does not match the plan recomputed/);
  });

  test("a missing plan_digest row is refused", () => {
    const scratch = staged();
    scratch.db.run(`DELETE FROM mig033_staging_meta WHERE key = 'plan_digest'`);
    expectRefusal(scratch, /no plan_digest row/);
  });

  test("a tampered max_component_size changes the recomputed plan and is refused", () => {
    // Классификация oversize зависит от порога: подмена порога в meta даёт
    // другой пересчитанный план, и сверка это ловит.
    const scratch = staged();
    scratch.db.run(
      `UPDATE mig033_staging_meta SET value = '1000' WHERE key = 'max_component_size'`,
    );
    expectRefusal(scratch, /staging content does not match the plan recomputed/);
  });
});

let contentSeq = 0;
