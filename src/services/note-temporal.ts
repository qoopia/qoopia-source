/**
 * V4.1 би-темпоральный write-path (ТЗ §6).
 *
 * Явная supersession — одна транзакция: insert B + условный UPDATE A +
 * legacy `supersedes`-ребро + строка `note_temporal_provenance` + activity.
 * `notes.metadata` НЕ трогается ни на одном шаге (R2): legacy-зеркало
 * `metadata.supersedes/superseded_by/status` — это путь `createNoteRelation`,
 * который здесь сознательно НЕ используется.
 *
 * Всё время — целые epoch-ms; отображаемые ISO производятся из ms (R3/R4).
 */
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { logActivity } from "./activity.ts";
import { supersedePathExists } from "./note-relations.ts";
import {
  assertSubjectKey,
  bitemporalEnabled,
  isoFromEpochMs,
  staleVersion,
  temporalFeatureDisabled,
  toEpochMs,
} from "../utils/temporal.ts";

export interface TemporalWriteFields {
  supersedes_id?: string | null;
  expected_superseded_updated_at_ms?: number | null;
  subject_key?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
}

interface PredecessorRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  visibility: string | null;
  deleted_at: string | null;
  updated_at_ms: number;
  subject_key: string | null;
  valid_from_ms: number | null;
  valid_until_ms: number | null;
  invalidated_at_ms: number | null;
}

export interface ResolvedTemporalWrite {
  valid_from_iso: string;
  valid_from_ms: number;
  valid_until_iso: string | null;
  valid_until_ms: number | null;
  subject_key: string | null;
  supersedes_id: string | null;
  predecessor: PredecessorRow | null;
  expected_updated_at_ms: number | null;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Любое темпоральное поле при выключенном флаге -> `FEATURE_DISABLED` (§7.2). */
export function assertTemporalWriteAllowed(fields: TemporalWriteFields): void {
  const used =
    present(fields.supersedes_id) ||
    present(fields.expected_superseded_updated_at_ms) ||
    present(fields.subject_key) ||
    present(fields.valid_from) ||
    present(fields.valid_until);
  if (used && !bitemporalEnabled()) temporalFeatureDisabled();
}

/**
 * Проверить и нормализовать темпоральные поля создаваемой ноты.
 * `now` — момент записи (epoch-ms), выделенный вызывающим внутри его
 * транзакции, чтобы `valid_from` по умолчанию совпадал с `created_at`.
 */
export function resolveTemporalWrite(input: {
  workspace_id: string;
  caller_agent_id: string;
  is_admin: boolean;
  now_ms: number;
  fields: TemporalWriteFields;
}): ResolvedTemporalWrite {
  const { fields } = input;
  const validFromMs = present(fields.valid_from)
    ? toEpochMs(fields.valid_from, "valid_from")
    : input.now_ms;
  const validUntilMs = present(fields.valid_until)
    ? toEpochMs(fields.valid_until, "valid_until")
    : null;
  if (validUntilMs !== null && validUntilMs <= validFromMs) {
    throw new QoopiaError("INVALID_INPUT", "valid_until must be greater than valid_from");
  }

  let subjectKey: string | null = null;
  if (present(fields.subject_key)) {
    subjectKey = String(fields.subject_key);
    assertSubjectKey(subjectKey);
    assertNoSecrets(subjectKey, "note.subject_key");
  }

  if (!present(fields.supersedes_id)) {
    if (present(fields.expected_superseded_updated_at_ms)) {
      throw new QoopiaError(
        "INVALID_INPUT",
        "expected_superseded_updated_at_ms is valid only with supersedes_id",
      );
    }
    return {
      valid_from_iso: isoFromEpochMs(validFromMs),
      valid_from_ms: validFromMs,
      valid_until_iso: validUntilMs === null ? null : isoFromEpochMs(validUntilMs),
      valid_until_ms: validUntilMs,
      subject_key: subjectKey,
      supersedes_id: null,
      predecessor: null,
      expected_updated_at_ms: null,
    };
  }

  if (!present(fields.expected_superseded_updated_at_ms)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "expected_superseded_updated_at_ms is required with supersedes_id",
    );
  }
  // Замена не может вступать в силу в будущем (§6.1, §15).
  if (validFromMs > input.now_ms) {
    throw new QoopiaError("INVALID_INPUT", "valid_from must not be in the future with supersedes_id");
  }

  const predecessor = readPredecessor(
    input.workspace_id,
    String(fields.supersedes_id),
    input.caller_agent_id,
    input.is_admin,
  );
  if (predecessor.valid_from_ms !== null && validFromMs < predecessor.valid_from_ms) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "valid_from must not precede the superseded note's valid_from",
    );
  }
  // Проверка интервала имеет смысл только для ОТКРЫТОГО убеждения. Если
  // предшественник уже закрыт, различать STALE_VERSION и CONFLICT обязан
  // условный UPDATE (§6.2), иначе гонка вернула бы INVALID_INPUT вместо
  // предписанного кода.
  if (
    predecessor.invalidated_at_ms === null &&
    predecessor.valid_until_ms !== null &&
    validFromMs >= predecessor.valid_until_ms
  ) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "valid_from must precede the superseded note's valid_until",
    );
  }
  if (subjectKey === null) {
    subjectKey = predecessor.subject_key;
  } else if (predecessor.subject_key !== null && predecessor.subject_key !== subjectKey) {
    throw new QoopiaError("INVALID_INPUT", "subject_key must be identical along a supersede chain");
  }

  return {
    valid_from_iso: isoFromEpochMs(validFromMs),
    valid_from_ms: validFromMs,
    valid_until_iso: validUntilMs === null ? null : isoFromEpochMs(validUntilMs),
    valid_until_ms: validUntilMs,
    subject_key: subjectKey,
    supersedes_id: predecessor.id,
    predecessor,
    expected_updated_at_ms: Number(fields.expected_superseded_updated_at_ms),
  };
}

/**
 * Прочитать предшественника с соблюдением авторизации. Отсутствующий,
 * удалённый или невидимый — `NOT_FOUND` (существование private-ноты
 * соседа не раскрывается).
 */
function readPredecessor(
  workspaceId: string,
  noteId: string,
  callerAgentId: string,
  isAdmin: boolean,
): PredecessorRow {
  const row = db
    .prepare(
      `SELECT id, workspace_id, agent_id, visibility, deleted_at, updated_at_ms,
              subject_key, valid_from_ms, valid_until_ms, invalidated_at_ms
         FROM notes
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
          AND (visibility = 'workspace' OR agent_id = ? OR ? = 1)
        LIMIT 1`,
    )
    .get(noteId, workspaceId, callerAgentId, isAdmin ? 1 : 0) as PredecessorRow | undefined;
  if (!row) throw new QoopiaError("NOT_FOUND", `note ${noteId} not found`);
  return row;
}

export interface ClosePredecessorInput {
  workspace_id: string;
  agent_id: string;
  is_admin: boolean;
  predecessor: PredecessorRow;
  expected_updated_at_ms: number;
  successor_id: string;
  /** valid_from преемника — им закрывается valid-time предшественника. */
  successor_valid_from_ms: number;
  /**
   * transaction-time закрытия (epoch-ms). Для `note_create` это ТОТ ЖЕ
   * момент, которым создаётся преемник: иначе в интервале [B.created_at_ms,
   * A.invalidated_at_ms) оба убеждения известны одновременно (§3.2).
   */
  close_ms: number;
  visibility: string;
  /**
   * Метаданные legacy-ребра `note_relations` (идемпотентность MCP-вызова).
   * Это НЕ `notes.metadata` — та не трогается ни при каких условиях (R2).
   */
  relation_metadata?: Record<string, unknown>;
}

/**
 * Закрыть предшественника и записать сопутствующие строки. Вызывается ТОЛЬКО
 * внутри транзакции вызывающего — атомарность обеспечивает он.
 */
export function closePredecessor(input: ClosePredecessorInput): { relation_id: string } {
  const closeIso = isoFromEpochMs(input.close_ms);
  const successorValidFromIso = isoFromEpochMs(input.successor_valid_from_ms);
  const changed = db
    .prepare(
      `UPDATE notes
          SET invalidated_at = ?, invalidated_at_ms = ?,
              valid_until = ?, valid_until_ms = ?,
              updated_at = ?, updated_at_ms = ?
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
          AND invalidated_at_ms IS NULL AND updated_at_ms = ?`,
    )
    .run(
      closeIso,
      input.close_ms,
      successorValidFromIso,
      input.successor_valid_from_ms,
      closeIso,
      input.close_ms,
      input.predecessor.id,
      input.workspace_id,
      input.expected_updated_at_ms,
    ).changes;

  if (changed === 0) {
    // Ноль строк — перечитываем и различаем три исхода (§6.2).
    const current = db
      .prepare(
        `SELECT updated_at_ms, invalidated_at_ms, deleted_at FROM notes
          WHERE id = ? AND workspace_id = ?`,
      )
      .get(input.predecessor.id, input.workspace_id) as
      | { updated_at_ms: number; invalidated_at_ms: number | null; deleted_at: string | null }
      | undefined;
    if (!current || current.deleted_at !== null) {
      throw new QoopiaError("NOT_FOUND", `note ${input.predecessor.id} not found`);
    }
    if (current.updated_at_ms !== input.expected_updated_at_ms) {
      staleVersion("superseded note changed since it was read");
    }
    throw new QoopiaError("CONFLICT", "superseded note is already invalidated");
  }

  // Legacy `supersedes`-ребро. Прямая вставка, а не createNoteRelation:
  // тот путь зеркалит состояние в `notes.metadata`, что запрещено (R2).
  const relationMetadata = JSON.stringify(input.relation_metadata ?? {});
  assertNoSecrets(relationMetadata, "note_relation.metadata");
  const relationId = ulid();
  db.prepare(
    `INSERT OR IGNORE INTO note_relations
       (id, workspace_id, source_note_id, target_note_id, relation_type,
        created_by_agent_id, metadata, created_at)
     VALUES (?, ?, ?, ?, 'supersedes', ?, ?, ?)`,
  ).run(
    relationId,
    input.workspace_id,
    input.successor_id,
    input.predecessor.id,
    input.agent_id,
    relationMetadata,
    closeIso,
  );
  const existing = db
    .prepare(
      `SELECT id FROM note_relations
        WHERE workspace_id = ? AND source_note_id = ? AND target_note_id = ?
          AND relation_type = 'supersedes'`,
    )
    .get(input.workspace_id, input.successor_id, input.predecessor.id) as
    | { id: string }
    | undefined;

  db.prepare(
    `INSERT OR REPLACE INTO note_temporal_provenance
       (note_id, workspace_id, invalidated_at_source, valid_until_source,
        valid_until_inferred, backfill_class, skipped_reason, created_at)
     VALUES (?, ?, 'explicit_write', 'observed', 0, NULL, NULL, ?)`,
  ).run(input.predecessor.id, input.workspace_id, closeIso);

  return { relation_id: existing?.id ?? relationId };
}

/**
 * §6.4 — supersession для УЖЕ существующего преемника (`note_supersede` при
 * включённом флаге). Отличие от createNote только в том, что B не создаётся:
 * ему проставляется `supersedes_id`, а предшественник закрывается тем же
 * `closePredecessor` в одной транзакции.
 */
export function supersedeExistingNote(input: {
  workspace_id: string;
  agent_id: string;
  is_admin: boolean;
  successor_id: string;
  predecessor_id: string;
  expected_updated_at_ms: number;
  relation_metadata?: Record<string, unknown>;
}): { relation_id: string; invalidated_at_ms: number } {
  if (!bitemporalEnabled()) temporalFeatureDisabled();
  if (input.successor_id === input.predecessor_id) {
    throw new QoopiaError("INVALID_INPUT", "a note cannot supersede itself");
  }
  return db.transaction(() => {
    const successor = readPredecessor(
      input.workspace_id,
      input.successor_id,
      input.agent_id,
      input.is_admin,
    );
    const predecessor = readPredecessor(
      input.workspace_id,
      input.predecessor_id,
      input.agent_id,
      input.is_admin,
    );
    // Защита от цикла — та же, что на legacy-пути `createNoteRelation`
    // (note-relations.ts): ребро successor -> predecessor замкнуло бы цепочку,
    // если predecessor уже достигает successor.
    if (supersedePathExists(input.workspace_id, predecessor.id, successor.id)) {
      throw new QoopiaError("CONFLICT", "supersede relation would create a cycle");
    }
    const successorValidFromMs = successor.valid_from_ms;
    if (successorValidFromMs === null) {
      throw new QoopiaError("INVALID_INPUT", "successor note has no valid_from");
    }
    if (predecessor.valid_from_ms !== null && successorValidFromMs < predecessor.valid_from_ms) {
      throw new QoopiaError(
        "INVALID_INPUT",
        "successor valid_from must not precede the superseded note's valid_from",
      );
    }
    if (
      predecessor.subject_key !== null &&
      successor.subject_key !== null &&
      predecessor.subject_key !== successor.subject_key
    ) {
      throw new QoopiaError("INVALID_INPUT", "subject_key must be identical along a supersede chain");
    }
    // Ретаргет уже проставленного supersedes_id запрещён: строка связи B->A
    // иммутабельна, иначе одна нота могла бы «переехать» на другого
    // предшественника, оставив первого закрытым без замены.
    const successorLink = db
      .prepare(`SELECT supersedes_id FROM notes WHERE id = ? AND workspace_id = ?`)
      .get(successor.id, input.workspace_id) as
      | { supersedes_id: string | null }
      | undefined;
    if (!successorLink) throw new QoopiaError("NOT_FOUND", `note ${successor.id} not found`);
    if (successorLink.supersedes_id !== null) {
      throw new QoopiaError(
        "CONFLICT",
        `note ${successor.id} already supersedes ${successorLink.supersedes_id}`,
      );
    }
    // Тот же инвариант строго возрастающего updated_at_ms, что и в
    // notes.nextNoteWriteTimestamp: high-water mark из БД, а не только часы.
    const highWater = db
      .prepare(`SELECT COALESCE(MAX(updated_at_ms), 0) AS max_ms FROM notes`)
      .get() as { max_ms: number };
    const closeMs = Math.max(
      Date.now(),
      highWater.max_ms + 1,
      successor.updated_at_ms + 1,
      predecessor.updated_at_ms + 1,
    );
    // Ровно одна изменённая строка — предусловие закрытия предшественника.
    // Ноль строк означал бы гонку (кто-то проставил supersedes_id между
    // чтением и записью); закрывать A в этом случае нельзя.
    const linked = db
      .prepare(
        `UPDATE notes SET supersedes_id = ?
          WHERE id = ? AND workspace_id = ? AND supersedes_id IS NULL`,
      )
      .run(predecessor.id, successor.id, input.workspace_id).changes;
    if (linked !== 1) {
      staleVersion(
        `successor ${successor.id} changed since it was read (${linked} rows linked)`,
      );
    }
    const relation = closePredecessor({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      is_admin: input.is_admin,
      predecessor,
      expected_updated_at_ms: input.expected_updated_at_ms,
      successor_id: successor.id,
      successor_valid_from_ms: successorValidFromMs,
      close_ms: closeMs,
      visibility: successor.visibility ?? "workspace",
      relation_metadata: input.relation_metadata,
    });
    logActivity({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      action: "note_superseded",
      entity_type: "note",
      entity_id: successor.id,
      project_id: null,
      summary: `Superseded ${predecessor.id} with ${successor.id}`,
      details: {
        superseded_note_id: predecessor.id,
        successor_note_id: successor.id,
        invalidated_at_ms: closeMs,
      },
      visibility:
        successor.visibility === "private" || predecessor.visibility === "private"
          ? "private"
          : "workspace",
    });
    return { relation_id: relation.relation_id, invalidated_at_ms: closeMs };
  })();
}

/** `valid_until_inferred` из provenance. Читается только при флаге ON. */
export function temporalProvenanceInferred(noteId: string): number | null {
  const row = db
    .prepare(`SELECT valid_until_inferred FROM note_temporal_provenance WHERE note_id = ?`)
    .get(noteId) as { valid_until_inferred: number } | undefined;
  return row ? row.valid_until_inferred : null;
}
