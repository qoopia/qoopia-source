/**
 * Gate протокола миграции 033 (ТЗ §5.1) на стороне раннера.
 *
 * ПОЧЕМУ не только SQL. Файл `033-notes-bitemporal.sql` содержит CHECK-gate,
 * и при применении через `sqlite3`/`sqlite3_exec` он корректно прерывает
 * миграцию. Раннеры bun исполняют Phase C через `applyMigration033Sql`
 * (оператор за оператором), поэтому CHECK там тоже срабатывает — но gate
 * всё равно обязан отработать ДО первой мутации, чтобы отказ был чистым и
 * с внятным сообщением.
 *
 * ЧТО именно проверяется (усилено после review):
 *  1. staging из Phase B присутствует ЛИБО supersedes-граф пуст;
 *  2. staging СВЕЖАЯ — дайджест supersedes-графа, зафиксированный Phase B,
 *     совпадает с дайджестом живого графа. Иначе staging от прошлого
 *     прогона молча забэкфиллила бы устаревшую классификацию;
 *  3. staging ПОЛНАЯ — каждый узел, являющийся целью supersedes-ребра,
 *     присутствует в `mig033_linear_targets` или в `mig033_skipped`;
 *  4. staging СОГЛАСОВАНА с `notes` — (note_id, workspace_id) существует;
 *  5. staging СОДЕРЖАТЕЛЬНО СОВПАДАЕТ с планом, пересчитанным из живого
 *     графа, — построчно и по каждому полю.
 *
 * Почему (5) обязателен. Пункты (2)–(4) смотрят на граф и на присутствие
 * целей, но не на КЛАССИФИКАЦИЮ. Adversarial-проба независимого review
 * переписала linear-цель `lin-a` в ложную cyclic-строку `mig033_skipped`:
 * дайджест графа не изменился, покрытие целей осталось полным — и gate
 * пропускал заведомо неверный backfill. Тем самым обходилась conservative-
 * гарантия R1 (нота, которую следовало закрыть, оставалась бы current, и
 * наоборот). Поэтому gate пересчитывает план Phase B сам и сверяет его со
 * staging по каждому полю, включая целые ms и производные ISO.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { DEFAULT_MAX_COMPONENT_SIZE } from "./temporal-migration.ts";
import {
  readStagingPlan,
  recomputeStagingPlan,
  stagingPlanDigest,
} from "./migration-033-plan.ts";
import { tableExists } from "./introspect.ts";

export const MIGRATION_033_FILENAME = "033-notes-bitemporal.sql";
const STAGING_TABLES = [
  "mig033_linear_targets",
  "mig033_skipped",
  "mig033_staging_meta",
] as const;

interface Migration033GateState {
  staging_present: boolean;
  supersede_edges: number;
  live_graph_digest: string;
  staged_graph_digest: string | null;
  uncovered_targets: number;
  orphan_staging_rows: number;
  /** sha256 по строкам staging, как они реально записаны. */
  staged_plan_digest: string | null;
  /** sha256 по плану, пересчитанному gate'ом из живого графа. */
  recomputed_plan_digest: string | null;
  ok: boolean;
  reason: string | null;
}

/**
 * Дайджест живого supersedes-графа. Считается одинаково в preflight (Phase B
 * записывает его в `mig033_staging_meta`) и в gate, поэтому расхождение графа
 * между preflight и миграцией детектируется точно, а не по счётчику.
 */
export function supersedeGraphDigest(db: Database): string {
  const hash = createHash("sha256");
  hash.update("mig033-supersede-graph/v1\n");
  if (tableExists(db, "note_relations")) {
    const rows = db
      .query(
        `SELECT workspace_id, source_note_id, target_note_id, created_at
           FROM note_relations WHERE relation_type = 'supersedes'
          ORDER BY workspace_id, source_note_id, target_note_id, created_at`,
      )
      .all() as Array<{
      workspace_id: string;
      source_note_id: string;
      target_note_id: string;
      created_at: string;
    }>;
    for (const row of rows) {
      hash.update(
        `${row.workspace_id}\u0000${row.source_note_id}\u0000${row.target_note_id}\u0000${row.created_at}\n`,
      );
    }
  }
  return hash.digest("hex");
}

function metaValue(db: Database, key: string): string | null {
  if (!tableExists(db, "mig033_staging_meta")) return null;
  const row = db
    .query(`SELECT value FROM mig033_staging_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function migration033GateState(db: Database): Migration033GateState {
  const stagingPresent = STAGING_TABLES.every((table) => tableExists(db, table));
  const supersedeEdges = tableExists(db, "note_relations")
    ? (
        db
          .query(
            `SELECT COUNT(*) AS c FROM note_relations WHERE relation_type = 'supersedes'`,
          )
          .get() as { c: number }
      ).c
    : 0;
  const liveDigest = supersedeGraphDigest(db);
  const staged = stagingPresent ? metaValue(db, "graph_digest") : null;

  const base: Migration033GateState = {
    staging_present: stagingPresent,
    supersede_edges: supersedeEdges,
    live_graph_digest: liveDigest,
    staged_graph_digest: staged,
    uncovered_targets: 0,
    orphan_staging_rows: 0,
    staged_plan_digest: null,
    recomputed_plan_digest: null,
    ok: false,
    reason: null,
  };

  if (!stagingPresent) {
    // Пустой граф — классифицировать и backfill'ить нечего; отчёт Phase A по
    // построению пуст (свежая БД, тесты, dev-инсталляции).
    if (supersedeEdges === 0) return { ...base, ok: true };
    return {
      ...base,
      reason:
        `preflight staging is missing while ${supersedeEdges} supersedes relation(s) exist`,
    };
  }

  if (staged === null) {
    return { ...base, reason: "mig033_staging_meta has no graph_digest row" };
  }
  if (staged !== liveDigest) {
    return {
      ...base,
      reason:
        "staging is stale: the supersedes graph changed after the preflight run " +
        `(staged digest ${staged.slice(0, 16)}…, live digest ${liveDigest.slice(0, 16)}…)`,
    };
  }

  // Покрытие: любой узел-цель supersedes-ребра обязан быть в staging.
  const uncovered = (
    db
      .query(
        `SELECT COUNT(*) AS c FROM (
           SELECT DISTINCT r.workspace_id AS ws, r.target_note_id AS id
             FROM note_relations r WHERE r.relation_type = 'supersedes'
         ) t
          WHERE NOT EXISTS (SELECT 1 FROM mig033_linear_targets l
                             WHERE l.note_id = t.id AND l.workspace_id = t.ws)
            AND NOT EXISTS (SELECT 1 FROM mig033_skipped s
                             WHERE s.note_id = t.id AND s.workspace_id = t.ws)`,
      )
      .get() as { c: number }
  ).c;
  if (uncovered !== 0) {
    return {
      ...base,
      uncovered_targets: uncovered,
      reason: `${uncovered} superseded note(s) are not covered by preflight staging`,
    };
  }

  // Согласованность со `notes`: строка staging без своей ноты уронила бы
  // provenance-триггер уже внутри Phase C.
  const orphans = (
    db
      .query(
        `SELECT (
           (SELECT COUNT(*) FROM mig033_linear_targets l
             WHERE NOT EXISTS (SELECT 1 FROM notes n
                                WHERE n.id = l.note_id AND n.workspace_id = l.workspace_id))
           +
           (SELECT COUNT(*) FROM mig033_skipped s
             WHERE NOT EXISTS (SELECT 1 FROM notes n
                                WHERE n.id = s.note_id AND n.workspace_id = s.workspace_id))
         ) AS c`,
      )
      .get() as { c: number }
  ).c;
  if (orphans !== 0) {
    return {
      ...base,
      orphan_staging_rows: orphans,
      reason: `${orphans} staging row(s) reference a note_id/workspace_id absent from notes`,
    };
  }

  // Содержательная аттестация. Присутствие целей ничего не говорит о том, КАК
  // они классифицированы, поэтому план пересчитывается из живого графа и
  // сверяется со staging построчно и по каждому полю.
  const recordedMax = metaValue(db, "max_component_size");
  const maxComponentSize =
    recordedMax !== null && Number.isFinite(Number(recordedMax))
      ? Number(recordedMax)
      : DEFAULT_MAX_COMPONENT_SIZE;
  const actual = stagingPlanDigest(readStagingPlan(db));
  let expected: string;
  try {
    expected = stagingPlanDigest(recomputeStagingPlan(db, maxComponentSize));
  } catch (error) {
    return {
      ...base,
      staged_plan_digest: actual,
      reason: `the Phase B plan could not be recomputed for verification: ${
        (error as Error).message
      }`,
    };
  }
  const withDigests = { ...base, staged_plan_digest: actual, recomputed_plan_digest: expected };

  if (actual !== expected) {
    return {
      ...withDigests,
      reason:
        "staging content does not match the plan recomputed from the live graph " +
        `(staged rows ${actual.slice(0, 16)}…, recomputed ${expected.slice(0, 16)}…). ` +
        "A row was reclassified or a field was altered after Phase B",
    };
  }

  // Дайджест, записанный самим Phase B, — независимая третья точка: он ловит
  // подмену, при которой изменили бы И строки, И живой граф согласованно.
  const recorded = metaValue(db, "plan_digest");
  if (recorded === null) {
    return { ...withDigests, reason: "mig033_staging_meta has no plan_digest row" };
  }
  if (recorded !== actual) {
    return {
      ...withDigests,
      reason:
        "staging rows do not match the plan digest recorded by Phase B " +
        `(recorded ${recorded.slice(0, 16)}…, actual ${actual.slice(0, 16)}…)`,
    };
  }

  return { ...withDigests, ok: true };
}

/** Бросает до любой мутации `notes`, если staging отсутствует/устарела/неполна. */
export function assertMigration033Gate(db: Database): void {
  const state = migration033GateState(db);
  if (state.ok) return;
  throw new Error(
    `${MIGRATION_033_FILENAME} refused: ${state.reason}. Run ` +
      `scripts/migrate-033-preflight.ts (Phase A report + Phase B staging) first.`,
  );
}
