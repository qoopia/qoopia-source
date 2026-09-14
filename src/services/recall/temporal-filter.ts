/**
 * Темпоральные предикаты read-path (ТЗ §3.2, §7.1–§7.3).
 *
 * Все предикаты — ТОЛЬКО по целочисленным `*_ms`. `julianday` не
 * используется нигде; единственная конвертация ISO->ms внутри SQL — integer-
 * метод миграции 025 для `deleted_at` в режиме `known_as_of` (R3).
 *
 * Фильтр применяется в каждом notes-канале ДО RRF, а не после, иначе
 * невалидированные строки вытесняли бы актуальные из пула кандидатов.
 */
import { QoopiaError } from "../../utils/errors.ts";
import {
  bitemporalEnabled,
  temporalFeatureDisabled,
  toEpochMs,
} from "../../utils/temporal.ts";

/**
 * Во сколько раз глубже забирает векторный канал, когда действует
 * темпоральный фильтр. Кандидаты отбрасываются уже ПОСЛЕ отбора по косинусу,
 * поэтому без over-fetch длинная цепочка invalidated-ревизий могла бы
 * съесть весь topN и обнулить вклад канала в RRF.
 */
export const VECTOR_TEMPORAL_OVERFETCH = 3;

export interface TemporalFilter {
  /** Default current belief: `invalidated_at_ms IS NULL AND deleted_at IS NULL`. */
  current_only: boolean;
  valid_as_of_ms: number | null;
  known_as_of_ms: number | null;
}

export interface TemporalRequest {
  valid_as_of?: string | null;
  known_as_of?: string | null;
  include_history?: boolean;
}

/**
 * Разобрать темпоральные параметры запроса.
 *
 * Флаг выключен: любой темпоральный параметр -> `FEATURE_DISABLED`; иначе
 * `null` — прежний путь без единого дополнительного предиката.
 * Флаг включён: `include_history=true` снимает темпоральные предикаты и
 * несовместим с `valid_as_of`/`known_as_of`; отсутствие обоих `as_of` даёт
 * режим current belief.
 */
export function resolveTemporalFilter(p: TemporalRequest): TemporalFilter | null {
  const hasValid = p.valid_as_of !== undefined && p.valid_as_of !== null;
  const hasKnown = p.known_as_of !== undefined && p.known_as_of !== null;
  if (!bitemporalEnabled()) {
    if (hasValid || hasKnown) temporalFeatureDisabled();
    return null;
  }
  if (p.include_history === true) {
    if (hasValid || hasKnown) {
      throw new QoopiaError(
        "INVALID_INPUT",
        "include_history is incompatible with valid_as_of/known_as_of",
      );
    }
    return null;
  }
  if (!hasValid && !hasKnown) {
    return { current_only: true, valid_as_of_ms: null, known_as_of_ms: null };
  }
  return {
    current_only: false,
    valid_as_of_ms: hasValid ? toEpochMs(p.valid_as_of, "valid_as_of") : null,
    known_as_of_ms: hasKnown ? toEpochMs(p.known_as_of, "known_as_of") : null,
  };
}

export interface TemporalSql {
  where: string[];
  params: number[];
}

/**
 * Единственное намеренное отличие Flag-ON от legacy `latest_only` —
 * replacement-unavailable (§7.2). Чтобы отличий действительно было ровно
 * одно, current-belief обязан скрывать и вытесненные ноты компонент, которые
 * миграция сознательно НЕ бэкфиллила (split_head / cyclic / oversize, §5.3):
 * их `invalidated_at_ms` остаётся NULL, хотя legacy-путь выводит их активные
 * головы из графа связей и такие узлы прячет.
 *
 * Правило намеренно строже legacy: узел скрывается по факту наличия
 * входящего `supersedes`-ребра, без проверки доступности замены. Тем самым
 * расхождение остаётся ОДНИМ И ТЕМ ЖЕ классом (replacement-unavailable:
 * Flag-ON скрывает, legacy показывает), а не добавляет второй.
 *
 * `notes` при этом не мутируется — conservative-инвариант R1 сохраняется:
 * решение принимается на чтении, по строке provenance и графу связей.
 */
export function skippedComponentExclusionSql(alias: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM note_temporal_provenance ntp
       WHERE ntp.note_id = ${alias}.id
         AND ntp.skipped_reason IS NOT NULL
         AND EXISTS (SELECT 1 FROM note_relations nr
                      WHERE nr.workspace_id = ${alias}.workspace_id
                        AND nr.target_note_id = ${alias}.id
                        AND nr.relation_type = 'supersedes'))`;
}

/**
 * Предикаты §3.2 для таблицы `notes` под указанным алиасом. Условие по
 * `deleted_at` сюда не входит — им управляет `temporalDeletedSql`.
 */
export function temporalWhereSql(alias: string, filter: TemporalFilter | null): TemporalSql {
  const where: string[] = [];
  const params: number[] = [];
  if (!filter) return { where, params };
  if (filter.current_only) {
    where.push(`${alias}.invalidated_at_ms IS NULL`);
    where.push(skippedComponentExclusionSql(alias));
    return { where, params };
  }
  if (filter.valid_as_of_ms !== null) {
    where.push(
      `${alias}.valid_from_ms <= ? AND (${alias}.valid_until_ms IS NULL OR ? < ${alias}.valid_until_ms)`,
    );
    params.push(filter.valid_as_of_ms, filter.valid_as_of_ms);
  }
  if (filter.known_as_of_ms !== null) {
    where.push(
      `${alias}.created_at_ms <= ? AND (${alias}.invalidated_at_ms IS NULL OR ? < ${alias}.invalidated_at_ms)`,
    );
    params.push(filter.known_as_of_ms, filter.known_as_of_ms);
  }
  return { where, params };
}

/**
 * Условие по `deleted_at`. По умолчанию — прежнее `IS NULL`. В режиме
 * `known_as_of` строка, удалённая ПОСЛЕ момента T, в T ещё существовала,
 * поэтому она допускается; конвертация ISO->ms — integer-метод 025 (R3).
 */
export function temporalDeletedSql(alias: string, filter: TemporalFilter | null): TemporalSql {
  if (!filter || filter.known_as_of_ms === null) {
    return { where: [`${alias}.deleted_at IS NULL`], params: [] };
  }
  return {
    where: [
      `(${alias}.deleted_at IS NULL OR ? < (
          CAST(strftime('%s', ${alias}.deleted_at) AS INTEGER) * 1000
          + COALESCE(CAST(substr(strftime('%f', ${alias}.deleted_at), 4, 3) AS INTEGER), 0)))`,
    ],
    params: [filter.known_as_of_ms],
  };
}
