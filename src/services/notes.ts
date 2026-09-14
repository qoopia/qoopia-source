import { autoEmbedEnabled } from "./embeddings.ts";
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, safeJsonParse } from "../utils/errors.ts";
import { logActivity } from "./activity.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { upsertNoteEmbedding } from "./embedding-store.ts";
import { bitemporalEnabled, temporalFeatureDisabled } from "../utils/temporal.ts";
import {
  assertTemporalWriteAllowed,
  closePredecessor,
  resolveTemporalWrite,
  temporalProvenanceInferred,
  type TemporalWriteFields,
} from "./note-temporal.ts";
import {
  lookupNoteIdempotency,
  noteIdempotencyKeyHash,
  noteRequestHash,
  normalizeNoteIdempotencyKey,
  storeNoteIdempotency,
} from "./note-idempotency.ts";

const MAX_TEXT = 100_000;

/**
 * Auto-embed new / updated notes when QOOPIA_AUTO_EMBED=true (default).
 * Fire-and-forget: createNote/updateNote stay synchronous, the embedding
 * promise runs out-of-band and its failures are swallowed inside
 * upsertNoteEmbedding (the note still saved fine; vector channel just
 * lacks it until the backfill cron picks it up).
 *
 * Disabled by default in tests via QOOPIA_AUTO_EMBED=false to avoid
 * stray HTTP calls to Ollama during unit runs — tests that want to
 * exercise the hybrid path call upsertNoteEmbedding explicitly.
 */


function fireAndForgetEmbed(
  note_id: string,
  workspace_id: string,
  text: string,
): void {
  if (!autoEmbedEnabled()) return;
  // Don't await — upsertNoteEmbedding logs its own failures and never
  // throws, so a rejected promise here would be a programming bug, not
  // a runtime concern. Wrap in .catch() to silence Node's "unhandled
  // rejection" warning out of an abundance of caution.
  upsertNoteEmbedding(note_id, workspace_id, text).catch(() => {
    /* logged inside */
  });
}

export const NOTE_TYPES = [
  "note",
  "task",
  "deal",
  "contact",
  "finance",
  "project",
  "memory",
  "rule",
  "knowledge",
  "context",
  "decision",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface NoteRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  type: string;
  text: string;
  metadata: string;
  project_id: string | null;
  task_bound_id: string | null;
  session_id: string | null;
  source: string;
  tags: string;
  visibility: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  updated_at_ms: number;
  /**
   * V4.1 (migration 033). Присутствуют в строке всегда после миграции, но
   * сериализуются только при включённом QOOPIA_V4_BITEMPORAL (§7.5) — при
   * выключенном флаге вывод байт-идентичен прежнему.
   */
  valid_from?: string | null;
  valid_until?: string | null;
  invalidated_at?: string | null;
  subject_key?: string | null;
  supersedes_id?: string | null;
  created_at_ms?: number | null;
  valid_from_ms?: number | null;
  valid_until_ms?: number | null;
  invalidated_at_ms?: number | null;
}

export type NoteVisibility = "workspace" | "private";

export interface NoteCreateInput {
  workspace_id: string;
  agent_id: string;
  text: string;
  type?: string;
  metadata?: Record<string, unknown>;
  project_id?: string | null;
  task_bound_id?: string | null;
  session_id?: string | null;
  tags?: string[];
  source?: string;
  /**
   * QRERUN-003 / ADR-014: 'workspace' (default) shares the note across all
   * agents in this workspace via MCP recall/brief/note_get/note_list.
   * 'private' restricts reads to the owning agent_id and admin agent
   * types (steward, claude-privileged).
   */
  visibility?: NoteVisibility;
  /**
   * V4.1 (§6.1). Все поля optional и принимаются только при включённом
   * QOOPIA_V4_BITEMPORAL; иначе `FEATURE_DISABLED`.
   * `expected_superseded_updated_at_ms` обязателен вместе с `supersedes_id`.
   */
  supersedes_id?: string | null;
  expected_superseded_updated_at_ms?: number | null;
  subject_key?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  /**
   * V4.1 §6.3. Идемпотентный replay: идентичный повтор возвращает ту же
   * ноту без второй вставки и без повторной супersession; тот же ключ с иным
   * payload -> `CONFLICT` / `IDEMPOTENCY_MISMATCH` (§8).
   */
  idempotency_key?: string | null;
  /** Server-derived connection identity; never accepted from a tool argument. */
  connection_id?: string;
  /** Авторизация предшественника (private-ноты) — как в getNote. */
  is_admin?: boolean;
}

/**
 * V4.1 §7.5: при выключенном флаге объект собирается ровно из прежних полей
 * (explicit-field), поэтому вывод `note_get`/`note_list` байт-идентичен. При
 * включённом флаге добавляются nullable-поля и `valid_until_inferred` из
 * `note_temporal_provenance` (LEFT JOIN / точечное чтение).
 */
function temporalFields(r: NoteRow, inferred: number | null) {
  return {
    valid_from: r.valid_from ?? null,
    valid_until: r.valid_until ?? null,
    invalidated_at: r.invalidated_at ?? null,
    subject_key: r.subject_key ?? null,
    supersedes_id: r.supersedes_id ?? null,
    valid_until_inferred: inferred,
  };
}

export interface NoteView {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  type: string;
  text: string;
  metadata: Record<string, unknown>;
  project_id: string | null;
  task_bound_id: string | null;
  session_id: string | null;
  source: string;
  tags: string[];
  visibility: NoteVisibility;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  updated_at_ms: number;
  /** V4.1 — присутствуют только при включённом QOOPIA_V4_BITEMPORAL. */
  valid_from?: string | null;
  valid_until?: string | null;
  invalidated_at?: string | null;
  subject_key?: string | null;
  supersedes_id?: string | null;
  valid_until_inferred?: number | null;
}

function toNote(r: NoteRow, inferred: number | null = null): NoteView {
  const base = {
    id: r.id,
    workspace_id: r.workspace_id,
    agent_id: r.agent_id,
    type: r.type,
    text: r.text,
    metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    project_id: r.project_id,
    task_bound_id: r.task_bound_id,
    session_id: r.session_id,
    source: r.source,
    tags: safeJsonParse(r.tags, [] as string[]),
    visibility: (r.visibility || "workspace") as NoteVisibility,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    updated_at_ms: r.updated_at_ms,
  };
  return bitemporalEnabled() ? { ...base, ...temporalFields(r, inferred) } : base;
}

/**
 * Allocate a strictly increasing note-write timestamp from the database-backed
 * high-water mark. The caller must invoke this inside the same transaction as
 * the note mutation. That keeps same-millisecond writes deterministically
 * ordered and prevents a wall-clock rollback from moving a row backwards.
 */
function nextNoteWriteTimestamp(previousMs = 0): {
  iso: string;
  ms: number;
} {
  const row = db
    .prepare(`SELECT COALESCE(MAX(updated_at_ms), 0) AS max_ms FROM notes`)
    .get() as { max_ms: number };
  const ms = Math.max(Date.now(), previousMs + 1, row.max_ms + 1);
  return { iso: new Date(ms).toISOString(), ms };
}

export interface NoteCreateResult {
  created: boolean;
  id: string;
  type: string;
  workspace_id: string;
  visibility: NoteVisibility;
  created_at: string;
  updated_at: string;
  updated_at_ms: number;
}

export function createNote(input: NoteCreateInput): NoteCreateResult {
  if (!input.text || input.text.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "text is required");
  }
  if (input.text.length > MAX_TEXT) {
    throw new QoopiaError(
      "SIZE_LIMIT",
      `text exceeds ${MAX_TEXT} chars — split into multiple notes`,
    );
  }
  assertNoSecrets(input.text, "note.text");
  if (input.metadata) {
    assertNoSecrets(JSON.stringify(input.metadata), "note.metadata");
  }

  // V4.1: темпоральные поля запрещены при выключенном флаге (§7.2).
  const temporalInput: TemporalWriteFields = {
    supersedes_id: input.supersedes_id,
    expected_superseded_updated_at_ms: input.expected_superseded_updated_at_ms,
    subject_key: input.subject_key,
    valid_from: input.valid_from,
    valid_until: input.valid_until,
  };
  assertTemporalWriteAllowed(temporalInput);

  // §6.3 — ключ идемпотентности принадлежит V4.1-поверхности: при выключенном
  // флаге он, как и остальные новые поля, отклоняется `FEATURE_DISABLED`,
  // поэтому Flag-OFF поведение не меняется ни на байт.
  const idempotencyKey = normalizeNoteIdempotencyKey(input.idempotency_key);
  if (idempotencyKey !== null && !bitemporalEnabled()) {
    const connection=input.connection_id&&db.query("SELECT 1 FROM client_connections WHERE id=? AND agent_id=? AND workspace_id=? AND state!='revoked'")
      .get(input.connection_id,input.agent_id,input.workspace_id);
    if(!connection)temporalFeatureDisabled();
  }
  const idempotency =
    idempotencyKey === null
      ? null
      : {
          key_hash: noteIdempotencyKeyHash(input.workspace_id, input.agent_id, idempotencyKey),
          request_hash: noteRequestHash({
            text: input.text,
            type: input.type ?? null,
            metadata: input.metadata ?? null,
            project_id: input.project_id ?? null,
            task_bound_id: input.task_bound_id ?? null,
            session_id: input.session_id ?? null,
            tags: input.tags ?? null,
            source: input.source ?? null,
            visibility: input.visibility ?? null,
            supersedes_id: input.supersedes_id ?? null,
            expected_superseded_updated_at_ms:
              input.expected_superseded_updated_at_ms ?? null,
            subject_key: input.subject_key ?? null,
            valid_from: input.valid_from ?? null,
            valid_until: input.valid_until ?? null,
          }),
        };

  const type = input.type || "note";
  const visibility: NoteVisibility = input.visibility === "private" ? "private" : "workspace";

  // Validate project_id references an existing project note (M1 fix: enforce type='project')
  if (input.project_id) {
    const p = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL`,
      )
      .get(input.project_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!p) throw new QoopiaError("NOT_FOUND", "project_id not found or not a project");
  }
  if (input.task_bound_id) {
    const t = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(input.task_bound_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!t) throw new QoopiaError("NOT_FOUND", "task_bound_id not found");
    if (t.type !== "task")
      throw new QoopiaError("INVALID_INPUT", "task_bound_id must reference a task");
  }

  const id = ulid();
  // H6 fix: wrap insert + logActivity in a single transaction so partial failure
  // never leaves the note created without an audit entry or vice versa.
  let replayed = false;
  const result: NoteCreateResult = db.transaction((): NoteCreateResult => {
    // Реестр читается ВНУТРИ транзакции: параллельный первый вызов с тем же
    // ключом либо ещё не закоммичен (мы вставим и упадём на PK -> повтор
    // увидит его при следующей попытке), либо уже виден и отдаётся как no-op.
    if (idempotency) {
      const previous = lookupNoteIdempotency(idempotency.key_hash, idempotency.request_hash);
      if (previous) {
        replayed = true;
        return previous as unknown as NoteCreateResult;
      }
    }
    const timestamp = nextNoteWriteTimestamp();
    // §3.1: created_at_ms / valid_from[_ms] заполняются всегда — это
    // структурные колонки, а не поведение. Они не сериализуются при
    // выключенном флаге, поэтому Flag-OFF вывод не меняется, но инвариант
    // «valid_from_ms IS NULL = 0» (R1) держится и для новых строк.
    const temporal = resolveTemporalWrite({
      workspace_id: input.workspace_id,
      caller_agent_id: input.agent_id,
      is_admin: input.is_admin === true,
      now_ms: timestamp.ms,
      fields: temporalInput,
    });
    db.prepare(
      `INSERT INTO notes
        (id, workspace_id, agent_id, type, text, metadata, project_id, task_bound_id, session_id, source, tags, visibility, created_at, updated_at, updated_at_ms,
         created_at_ms, valid_from, valid_from_ms, valid_until, valid_until_ms, subject_key, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspace_id,
      input.agent_id,
      type,
      input.text,
      JSON.stringify(input.metadata || {}),
      input.project_id || null,
      input.task_bound_id || null,
      input.session_id || null,
      input.source || "mcp",
      JSON.stringify(input.tags || []),
      visibility,
      timestamp.iso,
      timestamp.iso,
      timestamp.ms,
      timestamp.ms,
      temporal.valid_from_iso,
      temporal.valid_from_ms,
      temporal.valid_until_iso,
      temporal.valid_until_ms,
      temporal.subject_key,
      temporal.supersedes_id,
    );

    // Явная supersession — в ЭТОЙ же транзакции (§6.2): закрытие A, legacy
    // ребро, provenance. `notes.metadata` не трогается ни у A, ни у B.
    if (temporal.predecessor) {
      closePredecessor({
        workspace_id: input.workspace_id,
        agent_id: input.agent_id,
        is_admin: input.is_admin === true,
        predecessor: temporal.predecessor,
        expected_updated_at_ms: temporal.expected_updated_at_ms!,
        successor_id: id,
        successor_valid_from_ms: temporal.valid_from_ms,
        // ОДНА transaction-time граница на создание B и закрытие A. Раньше
        // здесь было `timestamp.ms + 1`, из-за чего в миллисекунду создания B
        // предикат known_as_of (`T < invalidated_at_ms`) считал известными
        // ОБА убеждения. Теперь A закрывается ровно тем же моментом, в который
        // B становится известным, и пересечения нет.
        close_ms: timestamp.ms,
        visibility,
      });
      logActivity({
        workspace_id: input.workspace_id,
        agent_id: input.agent_id,
        action: "note_superseded",
        entity_type: "note",
        entity_id: id,
        project_id: input.project_id || null,
        summary: `Superseded ${temporal.predecessor.id} with ${id}`,
        details: {
          superseded_note_id: temporal.predecessor.id,
          successor_note_id: id,
          invalidated_at_ms: timestamp.ms,
        },
        visibility,
      });
    }

    // QTHIRD-001: never embed the text of a private note into the
    // shared activity log. Workspace-visibility notes keep the 80-char
    // preview so existing dashboards stay informative; private rows
    // record only the type, and the row itself is stamped 'private'
    // so listActivity / recall(scope='activity'|'all') filter it out
    // for non-owner non-admin callers.
    const summary =
      visibility === "private"
        ? `Created ${type} (private)`
        : `Created ${type}: ${input.text.slice(0, 80)}`;
    logActivity({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      action: "created",
      entity_type: "note",
      entity_id: id,
      project_id: input.project_id || null,
      summary,
      visibility,
    });

    const created: NoteCreateResult = {
      created: true,
      id,
      type,
      workspace_id: input.workspace_id,
      visibility,
      created_at: timestamp.iso,
      updated_at: timestamp.iso,
      updated_at_ms: timestamp.ms,
    };
    if (idempotency) {
      storeNoteIdempotency(
        idempotency.key_hash,
        input.workspace_id,
        idempotency.request_hash,
        created as unknown as Record<string, unknown>,
      );
    }
    return created;
  })();

  // Идемпотентный повтор не создаёт ноту и не переэмбеддит её.
  if (replayed) return result;

  // Trigger embedding out-of-band so the writer doesn't pay the Ollama
  // latency. Failures are swallowed (see fireAndForgetEmbed docstring).
  fireAndForgetEmbed(id, input.workspace_id, input.text);

  return result;
}

/**
 * QRERUN-003 / ADR-014: getNote enforces the visibility boundary.
 * - 'workspace' notes — visible to any caller in the same workspace.
 * - 'private' notes — only the owning agent_id can read; admin types
 *   (steward, claude-privileged) bypass via isAdmin=true.
 */
export function getNote(
  workspace_id: string,
  id: string,
  caller_agent_id: string,
  isAdmin: boolean,
) {
  // H3 fix: exclude soft-deleted notes
  const r = db
    .prepare(
      `SELECT * FROM notes
        WHERE id = ?
          AND workspace_id = ?
          AND deleted_at IS NULL
          AND (visibility = 'workspace' OR agent_id = ? OR ? = 1)
        LIMIT 1`,
    )
    .get(id, workspace_id, caller_agent_id, isAdmin ? 1 : 0) as NoteRow | undefined;
  if (!r) throw new QoopiaError("NOT_FOUND", `note ${id} not found`);
  // Provenance читается только при включённом флаге (§3.5).
  return toNote(r, bitemporalEnabled() ? temporalProvenanceInferred(r.id) : null);
}

export interface NoteListParams {
  workspace_id: string;
  /** QRERUN-003 / ADR-014: agent_id of the caller — needed to surface
   *  their own private notes alongside workspace-visibility ones. */
  caller_agent_id: string;
  /** QRERUN-003 / ADR-014: true for steward/claude-privileged — bypass
   *  the private filter and see all notes for ops/audit. */
  is_admin: boolean;
  type?: string;
  project_id?: string;
  agent?: string;
  status?: string;
  tags?: string[];
  since?: string;
  until?: string;
  session_id?: string;
  task_bound_id?: string;
  include_deleted?: boolean;
  /** Include notes whose metadata.status = 'archived'. Default false.
   *  Archived rows stay queryable for audit/restore but are hidden from
   *  default list/recall calls so dashboards don't drown in stale state. */
  include_archived?: boolean;
  limit?: number;
  offset?: number;
  order?: "created_desc" | "created_asc" | "updated_desc";
}

export function listNotes(p: NoteListParams) {
  const where: string[] = [`workspace_id = ?`];
  const params: any[] = [p.workspace_id];
  if (!p.include_deleted) where.push(`deleted_at IS NULL`);
  // QRERUN-003 / ADR-014: hide private notes from non-owners (admins exempt).
  where.push(`(visibility = 'workspace' OR agent_id = ? OR ? = 1)`);
  params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
  if (p.type) {
    where.push(`type = ?`);
    params.push(p.type);
  }
  if (p.project_id) {
    where.push(`project_id = ?`);
    params.push(p.project_id);
  }
  if (p.session_id) {
    where.push(`session_id = ?`);
    params.push(p.session_id);
  }
  if (p.task_bound_id) {
    where.push(`task_bound_id = ?`);
    params.push(p.task_bound_id);
  }
  if (p.agent) {
    where.push(
      `agent_id IN (SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1)`,
    );
    params.push(p.agent, p.workspace_id);
  }
  if (p.status) {
    where.push(`json_extract(metadata, '$.status') = ?`);
    params.push(p.status);
  } else if (!p.include_archived) {
    // Default: hide archived rows. Caller can still ask for them
    // explicitly via status='archived' (above) or include_archived=true.
    where.push(
      `(json_extract(metadata, '$.status') IS NULL OR json_extract(metadata, '$.status') != 'archived')`,
    );
  }
  if (p.tags && p.tags.length > 0) {
    for (const tag of p.tags) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = ?)`,
      );
      params.push(tag);
    }
  }
  if (p.since) {
    where.push(`created_at >= ?`);
    params.push(p.since);
  }
  if (p.until) {
    where.push(`created_at <= ?`);
    params.push(p.until);
  }

  const orderSql =
    p.order === "created_asc"
      ? "created_at ASC"
      : p.order === "updated_desc"
        ? `CASE
             WHEN updated_at_ms > 0 THEN updated_at_ms
             ELSE CAST((julianday(updated_at) - 2440587.5) * 86400000 AS INTEGER)
           END DESC, id DESC`
        : "created_at DESC";
  const limit = Math.min(Math.max(p.limit || 50, 1), 500);
  const offset = Math.max(p.offset || 0, 0);

  const rows = db
    .prepare(
      `SELECT * FROM notes
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as NoteRow[];

  const totalRow = db
    .prepare(`SELECT COUNT(*) as c FROM notes WHERE ${where.join(" AND ")}`)
    .get(...params) as { c: number };

  // Одно чтение provenance на страницу вместо N точечных (LEFT JOIN-эквивалент).
  const inferredByNote = new Map<string, number>();
  if (bitemporalEnabled() && rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    const provenance = db
      .prepare(
        `SELECT note_id, valid_until_inferred FROM note_temporal_provenance
          WHERE workspace_id = ? AND note_id IN (${placeholders})`,
      )
      .all(p.workspace_id, ...rows.map((r) => r.id)) as Array<{
      note_id: string;
      valid_until_inferred: number;
    }>;
    for (const row of provenance) inferredByNote.set(row.note_id, row.valid_until_inferred);
  }

  const items = rows.map((r) => {
    const full = toNote(r, inferredByNote.get(r.id) ?? null);
    // List view: cap text_preview to 500 chars so responses stay light.
    const text_preview = full.text.length > 500 ? full.text.slice(0, 500) : full.text;
    return { ...full, text_preview, text_preview_only: full.text.length > 500 ? true : false };
  });

  return {
    items,
    total: totalRow.c,
    limit,
    offset,
    has_more: offset + items.length < totalRow.c,
  };
}

export interface NoteUpdateInput {
  workspace_id: string;
  agent_id: string;
  /**
   * QTHIRD-001: true for steward / claude-privileged. Required to
   * mutate another agent's `private` note. Standard agents can only
   * update notes they own or notes with workspace visibility.
   */
  is_admin: boolean;
  id: string;
  text?: string;
  metadata?: Record<string, unknown>;
  metadata_replace?: Record<string, unknown>;
  project_id?: string | null;
  task_bound_id?: string | null;
  tags?: string[];
}

export function updateNote(input: NoteUpdateInput) {
  // H2 fix: exclude soft-deleted notes, consistent with getNote
  const existing = db
    .prepare(
      `SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(input.id, input.workspace_id) as NoteRow | undefined;
  if (!existing)
    throw new QoopiaError("NOT_FOUND", `note ${input.id} not found`);

  // QTHIRD-001: refuse non-owner non-admin mutation of a private note.
  // Throw NOT_FOUND (not FORBIDDEN) so the caller cannot probe for
  // existence of private notes belonging to siblings.
  const existingVisibility = (existing.visibility || "workspace") as NoteVisibility;
  if (
    existingVisibility === "private" &&
    existing.agent_id !== input.agent_id &&
    !input.is_admin
  ) {
    throw new QoopiaError("NOT_FOUND", `note ${input.id} not found`);
  }

  if (input.metadata && input.metadata_replace) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "metadata and metadata_replace are mutually exclusive",
    );
  }
  if (input.text !== undefined && input.text.length > MAX_TEXT) {
    throw new QoopiaError("SIZE_LIMIT", `text exceeds ${MAX_TEXT} chars`);
  }
  if (input.text !== undefined) {
    assertNoSecrets(input.text, "note.text");
  }
  if (input.metadata) {
    assertNoSecrets(JSON.stringify(input.metadata), "note.metadata");
  }
  if (input.metadata_replace) {
    assertNoSecrets(JSON.stringify(input.metadata_replace), "note.metadata");
  }

  // H2 fix: re-validate project_id and task_bound_id on update (same as create)
  if (input.project_id !== undefined && input.project_id !== null) {
    const p = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL`,
      )
      .get(input.project_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!p) throw new QoopiaError("NOT_FOUND", "project_id not found or not a project");
  }
  if (input.task_bound_id !== undefined && input.task_bound_id !== null) {
    const t = db
      .prepare(
        `SELECT id, type FROM notes WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .get(input.task_bound_id, input.workspace_id) as
      | { id: string; type: string }
      | undefined;
    if (!t) throw new QoopiaError("NOT_FOUND", "task_bound_id not found");
    if (t.type !== "task")
      throw new QoopiaError("INVALID_INPUT", "task_bound_id must reference a task");
  }

  const fields: string[] = [];
  const values: any[] = [];
  const updated: string[] = [];

  if (input.text !== undefined) {
    fields.push(`text = ?`);
    values.push(input.text);
    updated.push("text");
  }
  if (input.metadata_replace !== undefined) {
    fields.push(`metadata = ?`);
    values.push(JSON.stringify(input.metadata_replace));
    updated.push("metadata");
  } else if (input.metadata !== undefined) {
    const merged = {
      ...safeJsonParse(existing.metadata, {} as Record<string, unknown>),
      ...input.metadata,
    };
    fields.push(`metadata = ?`);
    values.push(JSON.stringify(merged));
    for (const k of Object.keys(input.metadata)) updated.push(`metadata.${k}`);
  }
  if (input.project_id !== undefined) {
    fields.push(`project_id = ?`);
    values.push(input.project_id);
    updated.push("project_id");
  }
  if (input.task_bound_id !== undefined) {
    fields.push(`task_bound_id = ?`);
    values.push(input.task_bound_id);
    updated.push("task_bound_id");
  }
  if (input.tags !== undefined) {
    fields.push(`tags = ?`);
    values.push(JSON.stringify(input.tags));
    updated.push("tags");
  }

  if (fields.length === 0) {
    return {
      updated: false,
      id: input.id,
      fields_updated: [],
      updated_at: existing.updated_at,
      updated_at_ms: existing.updated_at_ms,
    };
  }

  // H6 fix: wrap update + logActivity atomically
  const result = db.transaction(() => {
    const timestamp = nextNoteWriteTimestamp(existing.updated_at_ms);
    const writeFields = [...fields, `updated_at = ?`, `updated_at_ms = ?`];
    const writeValues = [...values, timestamp.iso, timestamp.ms];
    db.prepare(
      `UPDATE notes SET ${writeFields.join(", ")} WHERE id = ? AND workspace_id = ?`,
    ).run(...writeValues, input.id, input.workspace_id);

    // Use the new project_id if it was changed, otherwise keep the existing one
    const effectiveProjectId =
      input.project_id !== undefined ? input.project_id : existing.project_id;
    // QTHIRD-001: inherit the note's visibility for the activity row so a
    // private note's update history isn't surfaced to non-owner non-admin
    // callers via listActivity / recall(scope='activity').
    const summaryUpd =
      existingVisibility === "private"
        ? `Updated ${existing.type} (private): ${updated.join(", ")}`
        : `Updated ${existing.type}: ${updated.join(", ")}`;
    logActivity({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      action: "updated",
      entity_type: "note",
      entity_id: input.id,
      project_id: effectiveProjectId,
      summary: summaryUpd,
      details: { fields_updated: updated },
      visibility: existingVisibility,
    });

    return {
      updated: true,
      id: input.id,
      fields_updated: updated,
      updated_at: timestamp.iso,
      updated_at_ms: timestamp.ms,
    };
  })();

  // Re-embed only when text actually changed — metadata / tags edits
  // don't move the vector. upsertNoteEmbedding hashes text and skips
  // identical content even if we did call it.
  if (input.text !== undefined && input.text !== existing.text) {
    fireAndForgetEmbed(input.id, input.workspace_id, input.text);
  }

  return result;
}

/**
 * QTHIRD-001: deleteNote enforces the visibility boundary.
 * Non-owner non-admin callers cannot delete a private note; the call
 * surfaces NOT_FOUND (not FORBIDDEN) to avoid leaking existence.
 */
export function deleteNote(
  workspace_id: string,
  agent_id: string,
  id: string,
  isAdmin: boolean,
) {
  const existing = db
    .prepare(
      `SELECT id, type, project_id, agent_id, visibility, updated_at_ms FROM notes
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(id, workspace_id) as
    | {
        id: string;
        type: string;
        project_id: string | null;
        agent_id: string | null;
        visibility: string | null;
        updated_at_ms: number;
      }
    | undefined;
  if (!existing) throw new QoopiaError("NOT_FOUND", `note ${id} not found`);

  const existingVisibility = (existing.visibility || "workspace") as NoteVisibility;
  if (
    existingVisibility === "private" &&
    existing.agent_id !== agent_id &&
    !isAdmin
  ) {
    // Match the read-side error to avoid leaking existence.
    throw new QoopiaError("NOT_FOUND", `note ${id} not found`);
  }

  // H6 fix: wrap soft-delete + logActivity atomically
  // M12 fix: remove from FTS index on soft-delete to prevent monotonic index growth
  const result = db.transaction(() => {
    const timestamp = nextNoteWriteTimestamp(existing.updated_at_ms);
    db.prepare(
      `UPDATE notes
          SET deleted_at = ?, updated_at = ?, updated_at_ms = ?
        WHERE id = ? AND workspace_id = ?`,
    ).run(timestamp.iso, timestamp.iso, timestamp.ms, id, workspace_id);

    // Remove from FTS index — find rowid via the notes row we just soft-deleted
    db.prepare(
      `DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)`,
    ).run(id);

    // QTHIRD-001: inherit the note's visibility for the deletion activity
    // row, and never embed any text — the row already only carried `id`,
    // but we also drop the id from the summary for private notes so the
    // workspace-wide audit can't even reveal the ID.
    const summaryDel =
      existingVisibility === "private"
        ? `Deleted ${existing.type} (private)`
        : `Deleted ${existing.type} ${id}`;
    logActivity({
      workspace_id,
      agent_id,
      action: "deleted",
      entity_type: "note",
      entity_id: id,
      project_id: existing.project_id,
      summary: summaryDel,
      visibility: existingVisibility,
    });

    return {
      deleted: true,
      id,
      updated_at: timestamp.iso,
      updated_at_ms: timestamp.ms,
    };
  })();

  return result;
}
