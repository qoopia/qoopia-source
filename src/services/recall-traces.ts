import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError, safeJsonParse } from "../utils/errors.ts";
import { getNote } from "./notes.ts";

export const RECALL_PIPELINE_VERSION = "v4.0.0-p04.1";
const TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TRACE_ADMIN_TYPES = new Set(["owner", "steward"]);
const NOTE_ADMIN_TYPES = new Set(["owner", "steward", "claude-privileged"]);

export type TraceResultKind = "note" | "entity" | "activity" | "session_message";
export type TraceSourceChannel = "fts5" | "vector" | "both" | "activity_fts" | "session_fts";

export interface RecallDiagnosticItem {
  result_kind: TraceResultKind;
  result_id: string;
  note_id: string | null;
  source_channel: TraceSourceChannel;
  fts_rank: number | null;
  vector_rank: number | null;
  fts_score: number | null;
  vector_score: number | null;
  rrf_score: number;
  rerank_score: number | null;
  lifecycle_factor: number;
  governance_factor: number;
  relation_factor: number;
  final_score: number;
  final_rank: number;
  reason_codes: string[];
}

interface TraceRow {
  id: string;
  workspace_id: string;
  caller_agent_id: string;
  query_hash: string;
  mode: string;
  options: string;
  pipeline_version: string;
  duration_ms: number;
  result_count: number;
  created_at: string;
  expires_at: string;
}

interface TraceItemRow extends Omit<RecallDiagnosticItem, "reason_codes"> {
  reason_codes: string;
}

function isAdmin(auth: AuthContext): boolean {
  return TRACE_ADMIN_TYPES.has(auth.type);
}

function canReadAllNotes(auth: AuthContext): boolean {
  return NOTE_ADMIN_TYPES.has(auth.type);
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function traceOut(row: TraceRow) {
  return {
    trace_id: row.id,
    caller_agent_id: row.caller_agent_id,
    query_hash: row.query_hash,
    mode: row.mode,
    options: safeJsonParse(row.options, {} as Record<string, unknown>),
    pipeline_version: row.pipeline_version,
    duration_ms: row.duration_ms,
    result_count: row.result_count,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function itemOut(row: TraceItemRow): RecallDiagnosticItem {
  return {
    result_kind: row.result_kind,
    result_id: row.result_id,
    note_id: row.note_id,
    source_channel: row.source_channel,
    fts_rank: row.fts_rank,
    vector_rank: row.vector_rank,
    fts_score: row.fts_score,
    vector_score: row.vector_score,
    rrf_score: row.rrf_score,
    rerank_score: row.rerank_score,
    lifecycle_factor: row.lifecycle_factor,
    governance_factor: row.governance_factor,
    relation_factor: row.relation_factor,
    final_score: row.final_score,
    final_rank: row.final_rank,
    reason_codes: safeJsonParse(row.reason_codes, [] as string[]),
  };
}

function resultStillVisible(auth: AuthContext, item: TraceItemRow): boolean {
  if (item.result_kind === "note") {
    try {
      getNote(auth.workspace_id, item.result_id, auth.agent_id, canReadAllNotes(auth));
      return true;
    } catch {
      return false;
    }
  }
  if (item.result_kind === "entity") {
    return !!db.prepare(
      `SELECT 1 FROM entity_pages WHERE workspace_id = ? AND id = ?`,
    ).get(auth.workspace_id, item.result_id);
  }
  if (item.result_kind === "activity") {
    return !!db.prepare(
      `SELECT 1 FROM activity
        WHERE workspace_id = ? AND id = ?
          AND (visibility = 'workspace' OR agent_id = ? OR ? = 1)`,
    ).get(auth.workspace_id, item.result_id, auth.agent_id, isAdmin(auth) ? 1 : 0);
  }
  return !!db.prepare(
    `SELECT 1 FROM session_messages
      WHERE workspace_id = ? AND id = ? AND (agent_id = ? OR ? = 1)`,
  ).get(auth.workspace_id, Number(item.result_id), auth.agent_id, isAdmin(auth) ? 1 : 0);
}

export function createRecallTrace(input: {
  auth: AuthContext;
  query: string;
  mode: string;
  options: Record<string, unknown>;
  duration_ms: number;
  items: RecallDiagnosticItem[];
}): string {
  const id = ulid();
  const queryHash = createHash("sha256").update(input.query.normalize("NFKC")).digest("hex");
  const options = JSON.stringify(input.options);
  if (options.length > 4096) throw new QoopiaError("SIZE_LIMIT", "recall trace options exceed 4096 bytes");
  if (input.items.length > 100) throw new QoopiaError("SIZE_LIMIT", "recall trace exceeds 100 items");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + TRACE_RETENTION_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO recall_traces
         (id, workspace_id, caller_agent_id, query_hash, mode, options,
          pipeline_version, duration_ms, result_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.auth.workspace_id,
      input.auth.agent_id,
      queryHash,
      input.mode.slice(0, 100),
      options,
      RECALL_PIPELINE_VERSION,
      Math.max(0, Math.round(input.duration_ms)),
      input.items.length,
      createdAt,
      expiresAt,
    );
    const insert = db.prepare(
      `INSERT INTO recall_trace_items
         (workspace_id, trace_id, result_kind, result_id, note_id,
          source_channel, fts_rank, vector_rank, fts_score, vector_score,
          rrf_score, rerank_score, lifecycle_factor, governance_factor,
          relation_factor, final_score, final_rank, reason_codes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of input.items) {
      const reasonCodes = [...new Set(item.reason_codes)].sort();
      if (reasonCodes.length > 50 || reasonCodes.some((code) => !code || code.length > 100)) {
        throw new QoopiaError("SIZE_LIMIT", "recall trace reason codes exceed bounds");
      }
      insert.run(
        input.auth.workspace_id,
        id,
        item.result_kind,
        item.result_id,
        item.note_id,
        item.source_channel,
        item.fts_rank,
        item.vector_rank,
        item.fts_score === null ? null : round6(item.fts_score),
        item.vector_score === null ? null : round6(item.vector_score),
        round6(item.rrf_score),
        item.rerank_score === null ? null : round6(item.rerank_score),
        round6(item.lifecycle_factor),
        round6(item.governance_factor),
        round6(item.relation_factor),
        round6(item.final_score),
        item.final_rank,
        JSON.stringify(reasonCodes),
      );
    }
  })();
  return id;
}

export function getRecallTrace(input: {
  auth: AuthContext;
  trace_id: string;
  limit?: number;
  offset?: number;
}) {
  const row = db.prepare(
    `SELECT * FROM recall_traces WHERE workspace_id = ? AND id = ?`,
  ).get(input.auth.workspace_id, input.trace_id) as TraceRow | undefined;
  if (
    !row ||
    row.expires_at <= new Date().toISOString() ||
    (row.caller_agent_id !== input.auth.agent_id && !isAdmin(input.auth))
  ) {
    throw new QoopiaError("NOT_FOUND", "recall trace not found");
  }
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = db.prepare(
    `SELECT result_kind, result_id, note_id, source_channel, fts_rank,
            vector_rank, fts_score, vector_score, rrf_score, rerank_score,
            lifecycle_factor, governance_factor, relation_factor, final_score,
            final_rank, reason_codes
       FROM recall_trace_items
      WHERE workspace_id = ? AND trace_id = ?
      ORDER BY final_rank ASC LIMIT ? OFFSET ?`,
  ).all(input.auth.workspace_id, input.trace_id, limit, offset) as TraceItemRow[];
  const visible = rows.filter((item) => resultStillVisible(input.auth, item));
  return {
    trace: traceOut(row),
    items: visible.map(itemOut),
    next_cursor: rows.length === limit ? String(offset + limit) : null,
  };
}
