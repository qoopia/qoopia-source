/**
 * Phase A (классификация) и построение плана Phase B для миграции 033.
 *
 * ВЫНЕСЕНО ИЗ `scripts/migrate-033-preflight.ts` в `src/`, потому что gate
 * миграции обязан УМЕТЬ ПЕРЕСЧИТАТЬ план заново и сверить его со staging
 * построчно. Раньше gate проверял только дайджест живого графа и присутствие
 * целей, поэтому подменённая КЛАССИФИКАЦИЯ (например, linear-цель, переписанная
 * в ложную cyclic-строку `mig033_skipped`) проходила с тем же дайджестом и тем
 * же покрытием — и conservative-гарантия R1 обходилась.
 *
 * Модуль чисто читающий: ни одного write-запроса.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  classifySupersedeComponents,
  DEFAULT_MAX_COMPONENT_SIZE,
  type SupersedeComponent,
} from "../services/temporal-migration.ts";
import { isoFromEpochMs, maxEpochMs, toEpochMs } from "../utils/temporal.ts";

export interface PreflightReportComponent {
  workspace_id: string;
  component_rep: string;
  klass: SupersedeComponent["klass"];
  truncated: boolean;
  node_count: number;
  active_head_count: number;
  node_ids: string[];
  active_head_ids: string[];
}

export interface PreflightReport {
  report_version: 1;
  max_component_size: number;
  totals: {
    components: number;
    nodes: number;
    linear: number;
    split_head: number;
    cyclic: number;
    oversize: number;
    linear_targets: number;
    skipped_nodes: number;
  };
  components: PreflightReportComponent[];
}

export interface LinearTargetRow {
  note_id: string;
  workspace_id: string;
  invalidated_at_ms: number;
  valid_until_ms: number;
  invalidated_at_iso: string;
  valid_until_iso: string;
}

export interface SkippedRow {
  note_id: string;
  workspace_id: string;
  backfill_class: "split_head" | "cyclic" | "oversize";
  skipped_reason: "split_head_component" | "cyclic_component" | "oversize_component";
}

export interface StagingPlan {
  linear_targets: LinearTargetRow[];
  skipped: SkippedRow[];
}

const SKIPPED_REASON = {
  split_head: "split_head_component",
  cyclic: "cyclic_component",
  oversize: "oversize_component",
} as const;

/**
 * Phase A. Чистое чтение: классификация всех компонент и сводка по классам.
 * Ни одного write-запроса.
 */
export function runPhaseA(
  db: Database,
  maxComponentSize = DEFAULT_MAX_COMPONENT_SIZE,
): PreflightReport {
  const components = classifySupersedeComponents(db, { maxComponentSize });
  const totals = {
    components: components.length,
    nodes: 0,
    linear: 0,
    split_head: 0,
    cyclic: 0,
    oversize: 0,
    linear_targets: 0,
    skipped_nodes: 0,
  };
  for (const component of components) {
    totals.nodes += component.node_ids.length;
    totals[component.klass] += 1;
    if (component.klass === "linear") {
      totals.linear_targets += component.node_ids.length - component.active_head_ids.length;
    } else {
      totals.skipped_nodes += component.node_ids.length;
    }
  }
  return {
    report_version: 1,
    max_component_size: maxComponentSize,
    totals,
    components: components.map((component) => ({
      workspace_id: component.workspace_id,
      component_rep: component.component_rep,
      klass: component.klass,
      truncated: component.truncated,
      node_count: component.node_ids.length,
      active_head_count: component.active_head_ids.length,
      node_ids: component.node_ids,
      active_head_ids: component.active_head_ids,
    })),
  };
}

/**
 * Построить содержимое staging по отчёту. Всё время считается здесь, в TS:
 *   invalidated_at_ms = min(Date.parse(relation.created_at)) по входящим
 *                       supersedes-рёбрам (не successor.created_at — §5.4);
 *   valid_until_ms    = max(valid_from_ms, invalidated_at_ms) ЧИСЛЕННО;
 *   *_iso             = new Date(ms).toISOString() (R4).
 */
export function buildStagingPlan(db: Database, report: PreflightReport): StagingPlan {
  const linearTargets: LinearTargetRow[] = [];
  const skipped: SkippedRow[] = [];

  const wanted = new Map<string, Set<string>>();
  for (const component of report.components) {
    if (component.klass !== "linear") {
      for (const noteId of component.node_ids) {
        skipped.push({
          note_id: noteId,
          workspace_id: component.workspace_id,
          backfill_class: component.klass,
          skipped_reason: SKIPPED_REASON[component.klass],
        });
      }
      continue;
    }
    const heads = new Set(component.active_head_ids);
    const targets = component.node_ids.filter((id) => !heads.has(id));
    if (targets.length === 0) continue;
    const bucket = wanted.get(component.workspace_id) ?? new Set<string>();
    for (const id of targets) bucket.add(id);
    wanted.set(component.workspace_id, bucket);
  }

  for (const [workspaceId, noteIds] of [...wanted.entries()].sort()) {
    const ids = [...noteIds].sort();
    // Минимальное время входящего ребра на каждый target — transaction-time.
    const incoming = new Map<string, number>();
    for (const chunk of chunked(ids, 400)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT target_note_id, created_at FROM note_relations
            WHERE workspace_id = ? AND relation_type = 'supersedes'
              AND target_note_id IN (${placeholders})`,
        )
        .all(workspaceId, ...chunk) as Array<{ target_note_id: string; created_at: string }>;
      for (const row of rows) {
        const ms = toEpochMs(row.created_at, "note_relations.created_at");
        const current = incoming.get(row.target_note_id);
        if (current === undefined || ms < current) incoming.set(row.target_note_id, ms);
      }
    }
    // valid_from по умолчанию = created_at ноты (колонки ещё не существуют).
    const createdAt = new Map<string, number>();
    for (const chunk of chunked(ids, 400)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT id, created_at FROM notes
            WHERE workspace_id = ? AND id IN (${placeholders})`,
        )
        .all(workspaceId, ...chunk) as Array<{ id: string; created_at: string }>;
      for (const row of rows) {
        createdAt.set(row.id, toEpochMs(row.created_at, "notes.created_at"));
      }
    }
    for (const noteId of ids) {
      const invalidatedAtMs = incoming.get(noteId);
      const validFromMs = createdAt.get(noteId);
      if (invalidatedAtMs === undefined) {
        throw new Error(`preflight: no incoming supersedes edge for target ${noteId}`);
      }
      if (validFromMs === undefined) {
        throw new Error(`preflight: note ${noteId} missing in workspace ${workspaceId}`);
      }
      const validUntilMs = maxEpochMs(validFromMs, invalidatedAtMs);
      linearTargets.push({
        note_id: noteId,
        workspace_id: workspaceId,
        invalidated_at_ms: invalidatedAtMs,
        valid_until_ms: validUntilMs,
        invalidated_at_iso: isoFromEpochMs(invalidatedAtMs),
        valid_until_iso: isoFromEpochMs(validUntilMs),
      });
    }
  }

  linearTargets.sort((a, b) =>
    a.workspace_id === b.workspace_id
      ? a.note_id.localeCompare(b.note_id)
      : a.workspace_id.localeCompare(b.workspace_id),
  );
  skipped.sort((a, b) =>
    a.workspace_id === b.workspace_id
      ? a.note_id.localeCompare(b.note_id)
      : a.workspace_id.localeCompare(b.workspace_id),
  );
  return { linear_targets: linearTargets, skipped };
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}


/**
 * Канонический sha256 по КАЖДОЙ строке и КАЖДОМУ полю плана.
 *
 * Порядок строк нормализуется, поэтому дайджест зависит только от содержания.
 * Любая подмена класса (`linear` <-> `skipped`), причины, `note_id`,
 * `workspace_id`, целочисленных ms или производных ISO меняет дайджест.
 */
export function stagingPlanDigest(plan: StagingPlan): string {
  const hash = createHash("sha256");
  hash.update("mig033-staging-plan/v1\n");
  const linear = [...plan.linear_targets].sort(compareStagingRows);
  hash.update(`linear ${linear.length}\n`);
  for (const row of linear) {
    hash.update(
      `L ${row.workspace_id}\u0000${row.note_id}\u0000${row.invalidated_at_ms}\u0000` +
        `${row.valid_until_ms}\u0000${row.invalidated_at_iso}\u0000${row.valid_until_iso}\n`,
    );
  }
  const skipped = [...plan.skipped].sort(compareStagingRows);
  hash.update(`skipped ${skipped.length}\n`);
  for (const row of skipped) {
    hash.update(
      `S ${row.workspace_id}\u0000${row.note_id}\u0000${row.backfill_class}\u0000` +
        `${row.skipped_reason}\n`,
    );
  }
  return hash.digest("hex");
}

function compareStagingRows(
  a: { workspace_id: string; note_id: string },
  b: { workspace_id: string; note_id: string },
): number {
  return a.workspace_id === b.workspace_id
    ? a.note_id.localeCompare(b.note_id)
    : a.workspace_id.localeCompare(b.workspace_id);
}

/** Прочитать план ОБРАТНО из staging-таблиц — как он реально записан. */
export function readStagingPlan(db: Database): StagingPlan {
  return {
    linear_targets: db
      .query(
        `SELECT note_id, workspace_id, invalidated_at_ms, valid_until_ms,
                invalidated_at_iso, valid_until_iso
           FROM mig033_linear_targets`,
      )
      .all() as LinearTargetRow[],
    skipped: db
      .query(
        `SELECT note_id, workspace_id, backfill_class, skipped_reason FROM mig033_skipped`,
      )
      .all() as SkippedRow[],
  };
}

/** Пересчитать план Phase B из ЖИВОГО графа. Чистое чтение. */
export function recomputeStagingPlan(db: Database, maxComponentSize: number): StagingPlan {
  return buildStagingPlan(db, runPhaseA(db, maxComponentSize));
}
