import {memoryProfile,memoryText,parseMemoryJson,memoryModelStatus} from './memory-model.ts';
import {z} from 'zod';
import { db } from "../db/connection.ts";
import { QoopiaError, safeJsonParse } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { EMBED_PROVIDER, cosineSim, embedText } from "./embeddings.ts";
import {
  loadAllEmbeddings,
  loadAllEntityEmbeddings,
  loadWorkspaceEmbeddings,
  loadWorkspaceEntityEmbeddings,
} from "./embedding-store.ts";
import { redactQuery } from "./recall_log_redaction.ts";
import { isReadOnlyInstance } from "../utils/instance-role.ts";
import { runV4Recall, v4RecallRequested } from "./recall/v4-pipeline.ts";
import { bitemporalEnabled } from "../utils/temporal.ts";
import {
  resolveTemporalFilter,
  temporalDeletedSql,
  temporalWhereSql,
  VECTOR_TEMPORAL_OVERFETCH,
  type TemporalFilter,
} from "./recall/temporal-filter.ts";

const MAX_QUERY_CHARS = 1000;
const DEFAULT_RECALL_OUTPUT_BYTES = 4_000;

/**
 * RRF (Reciprocal Rank Fusion) constant. k=60 is the value Cormack et
 * al. (2009) report as well-behaved across heterogeneous IR systems
 * and the value most production hybrid-retrieval systems converge on.
 * Larger k flattens the score; smaller k sharpens the top-rank bias.
 *
 * Read at CALL TIME (rrfK()) not module load — capturing at import
 * locks the value for the whole process and breaks tests that mutate
 * QOOPIA_RRF_K. Same precedent as embedEndpoint() in embeddings.ts
 * and getRecallMode() above.
 */
function rrfK(): number {
  return Number(process.env.QOOPIA_RRF_K || 60);
}

/**
 * Number of candidates each channel (FTS5, vector) contributes to RRF
 * fusion before re-ranking. Lowered from 50 → 20 (2026-05-13, noise-
 * filter PR) because the smoke test on prod showed the vector channel's
 * long tail polluting fusion: bge-m3 produces cosine ≈0.40–0.45 for
 * short project labels ("FLOCK", "LOCATIONS") on almost any query, so
 * the bottom half of a 50-row vector channel was noise that still
 * earned a non-trivial RRF weight via 1/(k+rank).
 */
function hybridChannelTopN(): number {
  return Number(process.env.QOOPIA_HYBRID_CHANNEL_TOPN || 20);
}

/**
 * Minimum cosine similarity for a vector-channel candidate to survive.
 * bge-m3 vectors are not centred — random pairs land around 0.30–0.40
 * cosine, so anything below this threshold is statistical noise rather
 * than topical relevance. See docs/cosine-distribution-2026-05-13.txt:
 * the 5 rescued queries ("крашнулся", "упал", "починили", "сломалась",
 * "postmortem") all have their genuinely relevant top results in the
 * 0.44–0.55 band, with the noise tail starting around 0.41–0.42.
 * 0.42 is the conservative midpoint — keeps every legitimate match
 * observed in the probe, cuts the long tail that fed noise into RRF.
 */
function vectorCosineThreshold(): number {
  return Number(process.env.QOOPIA_VECTOR_COSINE_THRESHOLD || 0.42);
}

/**
 * Project-label notes are 1-few-word labels ("FLOCK", "OPENCLAW IS",
 * "LOCATIONS"). bge-m3 averages token vectors, so very-short text
 * collapses near a corpus-mean point and lands at high cosine to almost
 * any query — pure noise in the vector channel. We drop type='project'
 * notes shorter than this many characters BEFORE RRF fusion so they
 * cannot poison the fused ranking. FTS5 is untouched: a user typing the
 * literal label ("FLOCK") will still get the project via the FTS path.
 *
 * 30 chars matches the user's specification — short legitimate notes of
 * other types ("Saule day off Friday", "watchdog node v25 path") pass
 * because they are not type='project'.
 *
 * NOTE: superseded in practice by getVectorTypeFilterMaxLen() below (v2
 * filter — also covers type='task'). Kept for backward compat with the
 * env knob shipped in PR #25; no longer referenced by the filter path.
 */
function projectLabelMinChars(): number {
  return Number(process.env.QOOPIA_PROJECT_LABEL_MIN_CHARS || 30);
}

/**
 * Noise filter v2 (refs PR #25). After PR #25 shipped the type='project'
 * + len<30 filter, re-running the 5 rescued queries showed two queries
 * ("крашнулся", "починили") still 0/3 relevant in top-3 — noise was now
 * coming from short type='task' completion-labels ("Deploy staging
 * health checks", "[Новая] Караганда — приложение", "GitHub Sync
 * настроен") that bge-m3 collapses to corpus-mean just like project
 * labels. Extend the filter to type IN ('project','task') AND
 * length(text) < this knob.
 *
 * Default 40 — probe on prod ~/.qoopia/data/qoopia.db at length<40:
 * task=38, project=7, memory=4. The 45 task+project rows under the
 * threshold were manually reviewed and none carry critical signal that
 * needs vector recall (FTS5 keyword channel still surfaces them).
 *
 * type='memory' is INTENTIONALLY excluded — memory is the primary
 * recall target, and short anchor notes ("Aidan port 18789",
 * "Tailscale IP 100.81.108.26") must remain reachable via vector
 * similarity. Memory hygiene is a separate task.
 *
 * Read at CALL TIME (not module load) — same pattern as rrfK() and
 * getRecallMode(); a module-load const would freeze the value and
 * break per-call env overrides in tests and benchmarks.
 */
function getVectorTypeFilterMaxLen(): number {
  return Number(process.env.QOOPIA_VECTOR_TYPE_FILTER_MAX_LEN || 40);
}

/** Note types subject to the short-length vector-channel filter. */
const VECTOR_TYPE_FILTER_TYPES = new Set(["project", "task"]);

/**
 * Two-tier cross-encoder rerank. Both run in sidecar processes that
 * expose the same {query, documents[]} → {results: [{index, score}]}
 * HTTP contract, so the recall pipeline stays backend-agnostic.
 *
 *  - `deep` (default OFF unless QOOPIA_RERANK_DEFAULT_DEEP=1 or
 *    deep=true per-call) hits the JinaAI cross-encoder sidecar —
 *    bge-reranker-class quality at ~1.5s/call for n=20 RU/EN.
 *    The right balance for interactive recall when enabled.
 *  - `deep_llm` (opt-in per call) hits Claude Haiku via SDK — slower
 *    (~5-15s) but sharper on tricky mono-term / cross-language queries
 *    where pure cross-encoder semantics drift.
 *
 * Both stages are strictly additive: any sidecar failure (timeout, 5xx,
 * network) falls back to the prior RRF ordering. Recall is bounded by
 * QOOPIA_RERANK_{,LLM_}TIMEOUT_MS, then falls back — same contract as
 * the vector channel.
 *
 * Legacy QOOPIA_RERANK_ENABLED is honoured: when set to "1" without any
 * specific {jina, llm} endpoint env, falls back to the historical single
 * endpoint configured via QOOPIA_RERANK_ENDPOINT.
 */
function rerankEnabledLegacy(): boolean {
  return process.env.QOOPIA_RERANK_ENABLED === "1";
}
function rerankDefaultDeep(): boolean {
  // OFF by default; explicit opt-in via QOOPIA_RERANK_DEFAULT_DEEP=1.
  // Safety: a bare deployment with no env vars and no sidecar would
  // otherwise eat QOOPIA_RERANK_TIMEOUT_MS per recall waiting for a
  // missing endpoint before falling back. Default-off keeps backward
  // compat zero-cost; operators opt in once a sidecar is wired up.
  return process.env.QOOPIA_RERANK_DEFAULT_DEEP === "1";
}
function jinaRerankEndpoint(): string {
  return (
    process.env.QOOPIA_RERANK_JINA_ENDPOINT ||
    process.env.QOOPIA_RERANK_ENDPOINT ||
    "http://jina-reranker:8790/rerank"
  );
}
function llmRerankEndpoint(): string {
  return (
    process.env.QOOPIA_RERANK_LLM_ENDPOINT ||
    "http://host.docker.internal:8789/rerank"
  );
}
function rerankTopK(): number {
  return Number(process.env.QOOPIA_RERANK_TOP_K || 30);
}
function rerankTimeoutMs(): number {
  return Number(process.env.QOOPIA_RERANK_TIMEOUT_MS || 5000);
}
function llmRerankTimeoutMs(): number {
  // LLM-judge rerank is materially slower than the cross-encoder; give
  // it its own ceiling so a slow Haiku call doesn't trip the standard
  // (jina) timeout if a caller flips between them.
  return Number(process.env.QOOPIA_RERANK_LLM_TIMEOUT_MS || 45000);
}
/**
 * Подавать ли переранжировщику пассаж вокруг совпадения вместо головы документа.
 * Включено по умолчанию: подача головы измеримо ухудшает порядок на технических
 * идентификаторах, чей терм лежит за пределами окна. `0` возвращает прежнее
 * поведение без пересборки образа.
 */
function rerankPassageWindow(): boolean {
  return (process.env.QOOPIA_RERANK_PASSAGE_WINDOW ?? "1") !== "0";
}

/**
 * Термы запроса, по которым ищем место совпадения в документе.
 *
 * Подчёркивания и дефисы намеренно НЕ разбиваются: в `event_outbox` и
 * `no-destructive` отличительная часть — именно составной идентификатор, и
 * искать по «event» отдельно значит центрировать окно на случайном вхождении.
 * Термы короче трёх символов отбрасываются как шумовые.
 */
function passageTerms(query: string): string[] {
  const out: string[] = [];
  for (const t of query.toLowerCase().split(/[^\p{L}\p{N}_\-]+/u)) {
    if (t.length >= 3) out.push(t);
  }
  return out;
}

/**
 * Окно `maxChars` символов, центрированное на первом вхождении любого терма
 * запроса. Если ни один терм не найден — голова документа, как раньше.
 */
function passageForRerank(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const low = text.toLowerCase();
  let best = -1;
  for (const t of passageTerms(query)) {
    const p = low.indexOf(t);
    if (p >= 0 && (best < 0 || p < best)) best = p;
  }
  if (best < 0) return text.slice(0, maxChars);
  const half = Math.floor(maxChars / 2);
  let end = Math.min(text.length, Math.max(0, best - half) + maxChars);
  const start = Math.max(0, end - maxChars);
  return text.slice(start, end);
}

function rerankMaxDocChars(): number {
  return Number(process.env.QOOPIA_RERANK_MAX_DOC_CHARS || 2000);
}

export type RecallMode = "fts5" | "hybrid";

/**
 * Read the recall mode from the environment. `fts5` (default) preserves
 * the existing FTS5-only behaviour; `hybrid` adds a bge-m3 vector
 * channel fused with FTS5 via RRF(k=60). Hybrid still requires Ollama
 * up; if the query embedding fails, recall() degrades to FTS5-only and
 * sets `mode='fts5-fallback'` in the response so callers can observe.
 */
export function getRecallMode(): RecallMode {
  const v = (process.env.QOOPIA_RECALL_MODE || (EMBED_PROVIDER==='builtin'?'hybrid':'fts5')).toLowerCase();
  return v === "hybrid" ? "hybrid" : "fts5";
}

/**
 * Sanitize a free-text query into an FTS5 MATCH expression.
 * Rules:
 *  - Strip FTS5 operators that confuse users (AND/OR/NOT/NEAR when not in quotes)
 *  - Escape double quotes
 *  - Each term gets prefix match (word*)
 *  - Terms joined with OR (any term matches), ranking handled by bm25 via
 *    ORDER BY rank in the SQL caller. Prior behaviour was implicit AND which
 *    zero'd out multi-word recall on morphology/synonym mismatches — see
 *    docs/recall-baseline.txt for the 20-query measurement.
 *  - Truncate to MAX_QUERY_CHARS
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || !query.trim()) {
    throw new QoopiaError("INVALID_INPUT", "query is required");
  }
  let raw = query.slice(0, MAX_QUERY_CHARS).trim();

  // Remove characters that break FTS5 parsing
  raw = raw.replace(/["`]/g, " ");
  raw = raw.replace(/[()[\]{}]/g, " ");

  // Drop boolean operators (uppercase) so plain typing works. We apply our
  // own OR-join below; user-typed AND/OR/NOT/NEAR are not honoured (yet).
  const terms = raw
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .filter((tok) => !/^(AND|OR|NOT|NEAR)$/i.test(tok))
    .map((tok) => tok.toLowerCase())
    .filter((t) => t.length >= 2);

  if (terms.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "query has no usable terms");
  }

  // Prefix match each term, join with OR. Single-term queries collapse to
  // `"term"*` (no OR), unchanged from the prior AND-join behaviour for
  // mono-term cases.
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

export interface RecallParams {
  workspace_id: string;
  /** QRERUN-003 / ADR-014: agent_id of the caller — needed to surface
   *  their own private notes alongside workspace-visibility ones. */
  caller_agent_id: string;
  /** QRERUN-003 / ADR-014: true for steward/claude-privileged; bypasses
   *  the private-note filter. Distinct from `privileged` below, which
   *  controls cross-workspace search. */
  is_admin: boolean;
  query: string;
  limit?: number;
  scope?: "notes" | "activity" | "sessions" | "entities" | "all";
  type?: string;
  project_id?: string;
  cross_workspace?: boolean;
  privileged?: boolean;
  /** Include notes whose metadata.status = 'archived'. Default false — archived
   *  rows are hidden from recall to keep results focused on live state. */
  include_archived?: boolean;
  /**
   * Override the env-derived recall mode. Used by tests and the
   * benchmark harness to force fts5 / hybrid per call without
   * mutating process.env.
   */
  mode?: RecallMode;
  /**
   * Cross-encoder rerank stage on top of the hybrid pool.
   * Default OFF unless QOOPIA_RERANK_DEFAULT_DEEP=1 or this param is
   * set to true per call. Set false to skip rerank entirely (~50ms
   * hybrid only). Ignored when mode='fts5'.
   */
  deep?: boolean;
  /**
   * LLM-judge rerank (Claude Haiku via SDK sidecar). Opt-in per call —
   * use for tricky / high-precision recall where the cross-encoder
   * misses (mono-term cross-language, intent-heavy queries). Slower
   * (~5-15s). When true, overrides `deep` (LLM replaces the
   * cross-encoder rather than running both).
   */
  deep_llm?: boolean;
  /** V4 relation-aware head selection. Effective default is flag-controlled. */
  latest_only?: boolean;
  /** V4 audit mode. Requires include_archived=true and disables latest_only. */
  include_history?: boolean;
  /** Return privacy-safe score components for visible results. */
  explain?: boolean;
  /** Persist a bounded privacy-safe trace and return its opaque ID. */
  trace?: boolean;
  /** Per-call lifecycle override. true requires QOOPIA_V4_LIFECYCLE. */
  lifecycle?: boolean;
  /** V4.1 §7.1 — истина в мире в момент T. Требует QOOPIA_V4_BITEMPORAL. */
  valid_as_of?: string | null;
  /** V4.1 §7.1 — знание системы в момент T. Требует QOOPIA_V4_BITEMPORAL. */
  known_as_of?: string | null;
  /** Internal P04 diagnostics sink; never exposed in MCP schemas. */
  _v4_diagnostics?: (diagnostics: RecallBaselineDiagnostics) => void;
  /**
   * Internal V4.1 — разобранный темпоральный фильтр. Никогда не входит в
   * MCP-схему: его выставляет `recall()` один раз на запрос.
   */
  _temporal?: TemporalFilter | null;
}

export interface RecallBaselineDiagnosticItem {
  source_channel: "fts5" | "vector" | "both" | "activity_fts" | "session_fts";
  fts_rank: number | null;
  vector_rank: number | null;
  fts_score: number | null;
  vector_score: number | null;
  inner_rrf: number | null;
  rerank_score: number | null;
  post_rerank_rank: number | null;
  fallback_reason: string | null;
}

export interface RecallBaselineDiagnostics {
  items: Record<string, RecallBaselineDiagnosticItem>;
}

type RecallDiagnosticCollector = Map<string, RecallBaselineDiagnosticItem>;

function diagnosticKey(source: NonNullable<ResultRow["source"]>, id: string): string {
  return `${source}:${id}`;
}

function mergeDiagnostic(
  collector: RecallDiagnosticCollector | null,
  source: NonNullable<ResultRow["source"]>,
  id: string,
  patch: Partial<RecallBaselineDiagnosticItem>,
): void {
  if (!collector) return;
  const key = diagnosticKey(source, id);
  collector.set(key, {
    source_channel: source === "activity"
      ? "activity_fts"
      : source === "sessions"
        ? "session_fts"
        : "fts5",
    fts_rank: null,
    vector_rank: null,
    fts_score: null,
    vector_score: null,
    inner_rrf: null,
    rerank_score: null,
    post_rerank_rank: null,
    fallback_reason: null,
    ...collector.get(key),
    ...patch,
  });
}

export interface ResultRow {
  id: string;
  type: string;
  text: string;
  metadata: unknown;
  project_id: string | null;
  created_at: string;
  workspace_id: string;
  rank: number;
  source?: "notes" | "activity" | "sessions" | "entity";
  /**
   * Phase 2 Item C — populated on `source='entity'` rows so callers can
   * resolve the canonical entity by slug without a second lookup.
   * Undefined for notes/activity/sessions rows.
   */
  slug?: string;
  /**
   * V4.1 §7.5 — присутствуют только на notes-строках и только при
   * включённом QOOPIA_V4_BITEMPORAL. При выключенном флаге ни одно из этих
   * полей не сериализуется, поэтому вывод байт-идентичен прежнему.
   */
  valid_from?: string | null;
  valid_until?: string | null;
  invalidated_at?: string | null;
  subject_key?: string | null;
  supersedes_id?: string | null;
  valid_until_inferred?: number | null;
  completeness?: "complete" | "excerpt";
  omitted_fields?: string[];
  full_body_request?: { tool: "note_get"; arguments: { id: string } };
}

interface RecallCompleteness {
  status: "complete" | "partial";
  reason?: "default_recall_output_budget";
  max_tokens?: 4_000;
  enforcement?: "conservative_utf8_bytes";
  max_serialized_bytes?: 4_000;
  full_body_tool?: "note_get";
  omitted_fields?: string[];
  omitted_results?: { count: number; ids: string[] };
}

type BoundedRecall<T> = Omit<T, "results"> & {
  results: ResultRow[];
  completeness: RecallCompleteness;
};

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundDefaultRecall<T extends { results: ResultRow[] }>(response: T): BoundedRecall<T> {
  const complete = {
    ...response,
    results: response.results.map((row) => ({ ...row, completeness: "complete" as const })),
    completeness: { status: "complete" as const },
  };
  if (serializedBytes(complete) <= DEFAULT_RECALL_OUTPUT_BYTES) return complete;

  const originals = response.results.map((row) => row.text);
  const results = response.results.map((row) => {
    const { metadata: _metadata, ...rest } = row;
    return {
      ...rest,
      completeness: "excerpt" as const,
      omitted_fields: ["metadata"],
      full_body_request: { tool: "note_get" as const, arguments: { id: row.id } },
    };
  });
  const partial = {
    ...response,
    results,
    completeness: {
      status: "partial" as const,
      reason: "default_recall_output_budget",
      max_tokens: 4_000,
      enforcement: "conservative_utf8_bytes",
      max_serialized_bytes: DEFAULT_RECALL_OUTPUT_BYTES,
      full_body_tool: "note_get",
      omitted_fields: [] as string[],
      omitted_results: { count: 0, ids: [] as string[] },
    },
  } as BoundedRecall<T>;
  const mutablePartial = partial as BoundedRecall<T> & Record<string, unknown>;
  if (serializedBytes(partial) <= DEFAULT_RECALL_OUTPUT_BYTES) return partial;

  for (const result of results) {
    result.text = "";
    result.omitted_fields.push("text");
  }
  for (const field of ["sanitized_query", "query", "cost", "effective_options", "pipeline_version", "trace_id"]) {
    if (serializedBytes(partial) <= DEFAULT_RECALL_OUTPUT_BYTES) break;
    if (Object.hasOwn(partial, field)) {
      delete mutablePartial[field];
      partial.completeness.omitted_fields!.push(field);
    }
  }
  while (serializedBytes(partial) > DEFAULT_RECALL_OUTPUT_BYTES && results.length > 0) {
    const omitted = results.pop()!;
    partial.completeness.omitted_results!.ids.unshift(omitted.id);
    partial.completeness.omitted_results!.count++;
  }

  for (let i = 0; i < results.length; i++) {
    const characters = Array.from(originals[i]!);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      results[i]!.text = characters.slice(0, middle).join("");
      if (serializedBytes(partial) <= DEFAULT_RECALL_OUTPUT_BYTES) low = middle;
      else high = middle - 1;
    }
    results[i]!.text = characters.slice(0, low).join("");
    if (low === characters.length) {
      results[i]!.omitted_fields = results[i]!.omitted_fields.filter((field) => field !== "text");
    }
  }
  return partial;
}

const GLOBAL_SOURCE_PRIORITY: Record<NonNullable<ResultRow["source"]>, number> = {
  // Canonical entity pages win an equal ordinal tie, followed by memory notes.
  // Activity and private session transcripts remain available without being
  // allowed to dominate merely because their FTS corpus has a larger BM25
  // magnitude.
  entity: 0,
  notes: 1,
  activity: 2,
  sessions: 3,
};

/**
 * Fuse independently-ranked source lists on one comparable scale.
 *
 * Raw FTS/BM25 values are corpus-relative and cannot be compared across
 * notes, entities, activity, and sessions. Each channel therefore contributes
 * its ordinal position via RRF. A result belongs to exactly one source, so
 * equal ordinals are resolved by an explicit source priority and then stable
 * row fields. The caller applies `limit` once, after this global sort.
 */
export function fuseRecallSources(
  channels: ResultRow[][],
  limit: number,
): ResultRow[] {
  const k = rrfK();
  const fused = channels.flatMap((rows) =>
    rows.map((row, index) => ({
      ...row,
      rank: -(1 / (k + index + 1)),
    })),
  );
  fused.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const sourceDelta =
      GLOBAL_SOURCE_PRIORITY[a.source ?? "notes"] -
      GLOBAL_SOURCE_PRIORITY[b.source ?? "notes"];
    if (sourceDelta !== 0) return sourceDelta;
    if (a.created_at !== b.created_at) {
      return a.created_at > b.created_at ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return fused.slice(0, limit);
}

/**
 * Run the FTS5 notes query and return candidate rows in bm25 rank
 * order. Factored out of recall() so the hybrid path can call it
 * symmetrically with the vector path.
 */
function ftsNoteCandidates(
  p: RecallParams,
  sanitized: string,
  topN: number,
): Array<ResultRow & { rowid_rank: number }> {
  const canCrossWorkspace = !!(p.cross_workspace && p.privileged);
  const includeArchived = !!p.include_archived;
  const temporal = p._temporal ?? null;
  const deleted = temporalDeletedSql("n", temporal);
  const where: string[] = [`notes_fts MATCH ?`, ...deleted.where];
  const params: any[] = [sanitized, ...deleted.params];
  if (!canCrossWorkspace) {
    where.push(`n.workspace_id = ?`);
    params.push(p.workspace_id);
  }
  where.push(`(n.visibility = 'workspace' OR n.agent_id = ? OR ? = 1)`);
  params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
  if (p.type) {
    where.push(`n.type = ?`);
    params.push(p.type);
  }
  if (p.project_id) {
    where.push(`n.project_id = ?`);
    params.push(p.project_id);
  }
  if (!includeArchived) {
    where.push(
      `(json_extract(n.metadata, '$.status') IS NULL OR json_extract(n.metadata, '$.status') != 'archived')`,
    );
  }
  // §7.3: темпоральный предикат применяется в канале, ДО RRF.
  const temporalSql = temporalWhereSql("n", temporal);
  where.push(...temporalSql.where);
  params.push(...temporalSql.params);
  const withTemporalColumns = bitemporalEnabled();
  const sql = `
    SELECT n.id, n.type, n.text, n.metadata, n.project_id, n.created_at, n.workspace_id, n.agent_id, n.visibility, rank
    ${withTemporalColumns ? TEMPORAL_SELECT : ""}
    FROM notes_fts f
    JOIN notes n ON n.rowid = f.rowid
    ${withTemporalColumns ? TEMPORAL_JOIN : ""}
    WHERE ${where.join(" AND ")}
    ORDER BY rank
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, topN) as Array<
    TemporalColumns & {
      id: string;
      type: string;
      text: string;
      metadata: string;
      project_id: string | null;
      created_at: string;
      workspace_id: string;
      agent_id: string | null;
      visibility: string | null;
      rank: number;
    }
  >;
  return rows.map((r, idx) => ({
    id: r.id,
    type: r.type,
    text: r.text,
    metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    project_id: r.project_id,
    created_at: r.created_at,
    workspace_id: r.workspace_id,
    rank: r.rank,
    source: "notes" as const,
    ...(withTemporalColumns ? temporalRowFields(r) : {}),
    rowid_rank: idx + 1, // 1-based rank for RRF
  }));
}

/**
 * V4.1: дополнительные колонки notes-каналов и LEFT JOIN provenance.
 * Читаются только при включённом флаге — при выключенном ни один из
 * фрагментов в SQL не попадает.
 */
const TEMPORAL_SELECT = `,
    n.valid_from AS t_valid_from, n.valid_until AS t_valid_until,
    n.invalidated_at AS t_invalidated_at, n.subject_key AS t_subject_key,
    n.supersedes_id AS t_supersedes_id,
    ntp.valid_until_inferred AS t_valid_until_inferred`;

const TEMPORAL_JOIN = `LEFT JOIN note_temporal_provenance ntp ON ntp.note_id = n.id`;

interface TemporalColumns {
  t_valid_from?: string | null;
  t_valid_until?: string | null;
  t_invalidated_at?: string | null;
  t_subject_key?: string | null;
  t_supersedes_id?: string | null;
  t_valid_until_inferred?: number | null;
}

function temporalRowFields(r: TemporalColumns) {
  return {
    valid_from: r.t_valid_from ?? null,
    valid_until: r.t_valid_until ?? null,
    invalidated_at: r.t_invalidated_at ?? null,
    subject_key: r.t_subject_key ?? null,
    supersedes_id: r.t_supersedes_id ?? null,
    valid_until_inferred: r.t_valid_until_inferred ?? null,
  };
}

/**
 * Run the vector channel for `scope='notes'` (and the notes portion of
 * `scope='all'`). Returns up to topN note_ids ordered by cosine
 * similarity to the query vector. Falls back silently to an empty list
 * if Ollama is unreachable or no embeddings exist for the workspace.
 */
async function vectorNoteCandidates(
  p: RecallParams,
  topN: number,
): Promise<Array<{ note_id: string; sim: number; vector_rank: number }>> {
  try {
    const queryVec = await embedText(p.query);
    const canCrossWorkspace = !!(p.cross_workspace && p.privileged);
    const rows = canCrossWorkspace
      ? loadAllEmbeddings()
      : loadWorkspaceEmbeddings(p.workspace_id);
    if (rows.length === 0) return [];

    // Noise filter step 1 (v2, refs PR #25): drop short project/task
    // notes BEFORE scoring. bge-m3 collapses 1-few-word labels and short
    // completion-strings to corpus-mean-ish vectors that score 0.40+
    // against almost any query, poisoning RRF. type='memory' is NOT
    // covered — short memory anchors ("Aidan port 18789") must remain
    // reachable via vector. Lookup (type, length) for the embedding ids
    // in one round-trip.
    const minLen = getVectorTypeFilterMaxLen();
    const ids = [...new Set(rows.map(r=>r.note_id))];
    const metaRows:Array<{id:string;type:string;len:number}>=[];
    for(let offset=0;offset<ids.length;offset+=500){const batch=ids.slice(offset,offset+500);
      metaRows.push(...db.query(`SELECT id,type,length(text) AS len FROM notes WHERE id IN (${batch.map(()=>'?').join(',')})`).all(...batch) as typeof metaRows);}
    const dropIds = new Set<string>();
    for (const m of metaRows) {
      if (VECTOR_TYPE_FILTER_TYPES.has(m.type) && m.len < minLen) {
        dropIds.add(m.id);
      }
    }
    const eligible = new Set<string>();
    // SQLite variable limits stay bounded even for a large workspace.
    for (let offset=0; offset<ids.length; offset+=500) {
      const batch=ids.slice(offset,offset+500);
      for (const row of hydrateFusedNotes(p,batch.map(id=>({id,rrf:0})),batch.length)) eligible.add(row.id);
    }
    const filteredRows = rows.filter((r) => eligible.has(r.note_id) && !dropIds.has(r.note_id));

    // Score every surviving candidate. 700 × cosine over 1024-d = ~3ms.
    const best=new Map<string,number>();
    for(const r of filteredRows){const sim=cosineSim(queryVec,r.vector);if(Number.isFinite(sim))best.set(r.note_id,Math.max(best.get(r.note_id)??-1,sim));}
    const scored=[...best].map(([note_id,sim])=>({note_id,sim}));
    scored.sort((a, b) => b.sim - a.sim);

    // Noise filter step 2: drop everything below the cosine threshold.
    // Applied AFTER the project-label filter and BEFORE topN slicing —
    // so the threshold trims the long tail rather than the head, and
    // topN sees only signal candidates.
    const threshold = EMBED_PROVIDER==='builtin' ? -1 : vectorCosineThreshold();
    const passed = scored.filter((s) => s.sim >= threshold);

    // V4.1 §7.3: под темпоральным фильтром канал забирает глубже и только
    // ПОТОМ отбрасывает нерелевантные по времени строки — иначе цепочка
    // invalidated-ревизий вытеснила бы актуальные из topN.
    const temporal = p._temporal ?? null;
    return applyVectorTemporalWindow(passed, topN, temporal).map((r, idx) => ({
      ...r,
      vector_rank: idx + 1,
    }));
  } catch (e: any) {
    logger.warn(
      `vector channel skipped (FTS5 still returns): ${e?.message || String(e)}`,
    );
    return [];
  }
}

/**
 * Окно векторного канала под темпоральным фильтром (§7.3).
 *
 * Вынесено отдельной чистой (кроме одного SELECT) функцией, чтобы вытеснение
 * можно было воспроизвести детерминированно, без embedding-бэкенда: именно
 * этот код исполняется в проде.
 *
 * Без over-fetch голова, целиком состоящая из темпорально невалидных строк,
 * съедала бы весь topN и обнуляла вклад канала в RRF.
 */
export function applyVectorTemporalWindow<T extends { note_id: string }>(
  passed: T[],
  topN: number,
  temporal: TemporalFilter | null,
): T[] {
  if (!temporal) return passed.slice(0, topN);
  const pool = passed.slice(0, topN * VECTOR_TEMPORAL_OVERFETCH);
  const eligible = temporalEligibleNoteIds(
    pool.map((r) => r.note_id),
    temporal,
  );
  return pool.filter((r) => eligible.has(r.note_id)).slice(0, topN);
}

/**
 * Отобрать из набора note_id те, что проходят темпоральный предикат.
 * Отдельным запросом, потому что векторный канал приходит без SQL-фильтра.
 */
function temporalEligibleNoteIds(
  noteIds: string[],
  filter: TemporalFilter,
): Set<string> {
  if (noteIds.length === 0) return new Set();
  const placeholders = noteIds.map(() => "?").join(",");
  const deleted = temporalDeletedSql("n", filter);
  const temporal = temporalWhereSql("n", filter);
  const rows = db
    .prepare(
      `SELECT n.id FROM notes n
        WHERE n.id IN (${placeholders})
          AND ${[...deleted.where, ...temporal.where].join(" AND ")}`,
    )
    .all(...noteIds, ...deleted.params, ...temporal.params) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * RRF (Reciprocal Rank Fusion). For each candidate note that appears
 * in either channel, sum 1/(k + rank) across channels. Higher score
 * wins. Notes that appear in only one channel still rank — the union
 * is what fixes the "вектор знал, FTS5 не знал" zero-recall cases.
 */
function rrfFuse(
  fts: Array<{ id: string; rowid_rank: number }>,
  vec: Array<{ note_id: string; vector_rank: number }>,
  k: number = rrfK(),
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const r of fts) {
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + r.rowid_rank));
  }
  for (const r of vec) {
    scores.set(
      r.note_id,
      (scores.get(r.note_id) || 0) + 1 / (k + r.vector_rank),
    );
  }
  return scores;
}

/**
 * Hydrate the notes portion of a result set: take the fused note_ids,
 * load the rows from `notes`, apply the same visibility / archived /
 * type / project_id filters as ftsNoteCandidates so a row reaching
 * recall() via the vector channel still respects the boundary.
 */
function hydrateFusedNotes(
  p: RecallParams,
  rankedIds: Array<{ id: string; rrf: number }>,
  limit: number,
): ResultRow[] {
  if (rankedIds.length === 0) return [];
  const includeArchived = !!p.include_archived;
  const canCrossWorkspace = !!(p.cross_workspace && p.privileged);
  // Build a parameterised IN clause. SQLite has no array binding, so
  // generate `?,?,?...` placeholders.
  const ids = rankedIds.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const temporal = p._temporal ?? null;
  const deleted = temporalDeletedSql("n", temporal);
  const where: string[] = [`n.id IN (${placeholders})`, ...deleted.where];
  const params: any[] = [...ids, ...deleted.params];
  if (!canCrossWorkspace) {
    where.push(`n.workspace_id = ?`);
    params.push(p.workspace_id);
  }
  where.push(`(n.visibility = 'workspace' OR n.agent_id = ? OR ? = 1)`);
  params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
  if (p.type) {
    where.push(`n.type = ?`);
    params.push(p.type);
  }
  if (p.project_id) {
    where.push(`n.project_id = ?`);
    params.push(p.project_id);
  }
  if (!includeArchived) {
    where.push(
      `(json_extract(n.metadata, '$.status') IS NULL OR json_extract(n.metadata, '$.status') != 'archived')`,
    );
  }
  const temporalSql = temporalWhereSql("n", temporal);
  where.push(...temporalSql.where);
  params.push(...temporalSql.params);
  const withTemporalColumns = bitemporalEnabled();
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.text, n.metadata, n.project_id, n.created_at, n.workspace_id
       ${withTemporalColumns ? TEMPORAL_SELECT : ""}
       FROM notes n
       ${withTemporalColumns ? TEMPORAL_JOIN : ""}
       WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as Array<
    TemporalColumns & {
      id: string;
      type: string;
      text: string;
      metadata: string;
      project_id: string | null;
      created_at: string;
      workspace_id: string;
    }
  >;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ResultRow[] = [];
  for (const { id, rrf } of rankedIds) {
    const r = byId.get(id);
    if (!r) continue; // filtered out by visibility/archived/type
    out.push({
      id: r.id,
      type: r.type,
      text: r.text,
      metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
      project_id: r.project_id,
      created_at: r.created_at,
      workspace_id: r.workspace_id,
      // Carry the RRF score in `rank` for transparency. Negate so the
      // existing "smaller rank == better" caller contract holds.
      rank: -rrf,
      source: "notes",
      ...(withTemporalColumns ? temporalRowFields(r) : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Phase 2 Item C — entity channel. Mirrors the notes channel structure:
 * FTS5 candidates from entity_pages_fts, optional vector candidates from
 * entity_embeddings, fused via the same RRF (k=60) when mode='hybrid'.
 * Returns up to `limit` rows tagged `source='entity'` and
 * `type='entity:<entity_type>'` so downstream callers can branch on the
 * type marker without touching the table.
 *
 * Behaviour matches the notes channel:
 *  - Hybrid + zero vector candidates → fts5-fallback (silent, returns
 *    FTS-only ordering).
 *  - FTS5-only mode → pure FTS path.
 *  - Failure of the vector channel (Ollama down) is swallowed; FTS
 *    results still flow.
 *
 * Archived/deprecated entities are excluded unless `include_archived=true`.
 */
async function entityCandidates(
  p: RecallParams,
  sanitized: string,
  topN: number,
  diagnostics: RecallDiagnosticCollector | null = null,
): Promise<ResultRow[]> {
  if (topN <= 0) return [];
  const canCrossWorkspace = !!(p.cross_workspace && p.privileged);
  const includeArchived = !!p.include_archived;
  const requestedMode = p.mode || getRecallMode();

  const where: string[] = [`entity_pages_fts MATCH ?`, `e.authority_private=0`];
  const params: any[] = [sanitized];
  if (!canCrossWorkspace) {
    where.push(`e.workspace_id = ?`);
    params.push(p.workspace_id);
  }
  if (!includeArchived) {
    where.push(`e.status = 'active'`);
  }
  const ftsSql = `
    SELECT e.id, e.workspace_id, e.type, e.slug, e.title, e.summary, e.status,
           e.metadata, e.created_at, e.updated_at, rank
      FROM entity_pages_fts f
      JOIN entity_pages e ON e.rowid = f.rowid
     WHERE ${where.join(" AND ")}
     ORDER BY rank
     LIMIT ?
  `;
  type EntityFtsRow = {
    id: string;
    workspace_id: string;
    type: string;
    slug: string;
    title: string;
    summary: string | null;
    status: string;
    metadata: string;
    created_at: string;
    updated_at: string;
    rank: number;
  };
  const ftsRows = db
    .prepare(ftsSql)
    .all(...params, topN) as EntityFtsRow[];
  ftsRows.forEach((row, index) => mergeDiagnostic(diagnostics, "entity", row.id, {
    source_channel: "fts5",
    fts_rank: index + 1,
    fts_score: row.rank,
    inner_rrf: 1 / (rrfK() + index + 1),
  }));

  // Materialize FTS rows as ResultRow shape so we can return them as-is
  // when hybrid is off, or after RRF when hybrid is on.
  const toResult = (
    r: EntityFtsRow,
    rank: number,
  ): ResultRow & { rowid_rank: number } => ({
    id: r.id,
    type: `entity:${r.type}`,
    text: r.summary ? `${r.title}\n\n${r.summary}` : r.title,
    metadata: {
      ...safeJsonParse(r.metadata, {} as Record<string, unknown>),
      entity_slug: r.slug,
      entity_status: r.status,
      entity_type: r.type,
    },
    project_id: null,
    created_at: r.created_at,
    workspace_id: r.workspace_id,
    rank,
    source: "entity",
    slug: r.slug,
    rowid_rank: 0, // filled below
  });

  if (requestedMode !== "hybrid") {
    return ftsRows.map((r) => {
      const { rowid_rank: _rr, ...clean } = toResult(r, r.rank);
      return clean;
    });
  }

  // Hybrid: also pull entity vector candidates.
  let vecHits: Array<{ entity_id: string; sim: number; vector_rank: number }> = [];
  try {
    const queryVec = await embedText(p.query);
    const rows = canCrossWorkspace
      ? loadAllEntityEmbeddings()
      : loadWorkspaceEntityEmbeddings(p.workspace_id);
    if (rows.length > 0) {
      const scored = rows
        .map((r) => ({
          entity_id: r.entity_id,
          sim: cosineSim(queryVec, r.vector),
        }))
        .filter((x) => x.sim >= vectorCosineThreshold())
        .sort((a, b) => b.sim - a.sim)
        .slice(0, topN);
      vecHits = scored.map((s, idx) => ({
        entity_id: s.entity_id,
        sim: s.sim,
        vector_rank: idx + 1,
      }));
      vecHits.forEach((row) => mergeDiagnostic(diagnostics, "entity", row.entity_id, {
        source_channel: diagnostics?.get(diagnosticKey("entity", row.entity_id))?.fts_rank
          ? "both"
          : "vector",
        vector_rank: row.vector_rank,
        vector_score: row.sim,
      }));
    }
  } catch (e: any) {
    logger.warn(
      `entity vector channel skipped (FTS5 still returns): ${e?.message || String(e)}`,
    );
  }

  if (vecHits.length === 0) {
    return ftsRows.map((r) => {
      const { rowid_rank: _rr, ...clean } = toResult(r, r.rank);
      return clean;
    });
  }

  // RRF fusion on entity ids.
  const k = rrfK();
  const scores = new Map<string, number>();
  ftsRows.forEach((r, idx) => {
    const rrf = 1 / (k + idx + 1);
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrf);
  });
  for (const v of vecHits) {
    const rrf = 1 / (k + v.vector_rank);
    scores.set(v.entity_id, (scores.get(v.entity_id) ?? 0) + rrf);
  }
  const ranked = [...scores.entries()]
    .map(([id, rrf]) => ({ id, rrf }))
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topN);
  ranked.forEach((row) => mergeDiagnostic(diagnostics, "entity", row.id, {
    inner_rrf: row.rrf,
  }));

  // Hydrate the fused set (only those not already in ftsRows).
  const ftsIndex = new Map(ftsRows.map((r) => [r.id, r]));
  const missingIds = ranked
    .map((r) => r.id)
    .filter((id) => !ftsIndex.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => "?").join(",");
    const hydrateSql = `
      SELECT e.id, e.workspace_id, e.type, e.slug, e.title, e.summary,
             e.status, e.metadata, e.created_at, e.updated_at, 0 AS rank
        FROM entity_pages e
       WHERE e.id IN (${placeholders}) AND e.authority_private=0
         ${canCrossWorkspace ? "" : "AND e.workspace_id = ?"}
         ${includeArchived ? "" : "AND e.status = 'active'"}
    `;
    const hydrateParams = canCrossWorkspace
      ? missingIds
      : [...missingIds, p.workspace_id];
    const more = db.prepare(hydrateSql).all(...hydrateParams) as EntityFtsRow[];
    for (const r of more) ftsIndex.set(r.id, r);
  }

  const out: ResultRow[] = [];
  for (const r of ranked) {
    const row = ftsIndex.get(r.id);
    if (!row) continue;
    // Carry RRF as a NEGATIVE rank so the cross-source "smaller =
    // better" contract holds against bm25 ranks (negative) and the
    // notes-channel `-rrf` convention used by hydrateFusedNotes.
    // Without this negation, hybrid entity hits would always sort
    // BELOW any FTS-only note that came with a negative bm25 rank,
    // re-introducing the appended-after-notes bug from R1.
    const { rowid_rank: _rr, ...clean } = toResult(row, -r.rrf);
    out.push(clean);
    if (out.length >= topN) break;
  }
  return out;
}

/**
 * Cross-encoder / LLM rerank stage. Generic over backend — the caller
 * picks an endpoint URL and timeout per request. Input: hydrated
 * candidates already shortlisted by RRF. Output: same rows reordered
 * by pair-wise relevance. On any sidecar error, returns the input
 * unchanged (mode='rerank-fallback') so the caller stays oblivious.
 */
async function rerankResults(
  query: string,
  candidates: ResultRow[],
  endpoint: string,
  timeoutMs: number,
  backendLabel: string,
): Promise<{
  rows: ResultRow[];
  mode: "rerank" | "rerank-fallback";
  fallback_reason?: string;
}> {
  if (candidates.length <= 1) return { rows: candidates, mode: "rerank" };
  const maxChars = rerankMaxDocChars();
  // Пассаж вокруг совпадения, а не голова документа: голова у длинных нот не
  // содержит отличительного терма, и переранжировщик судит по тексту, в котором
  // искомого нет. Измерено: precision@5 2/5 -> 5/5 на головном кейсе аудита.
  const usePassage = rerankPassageWindow();
  const documents = candidates.map((c) =>
    usePassage ? passageForRerank(c.text, query, maxChars) : c.text.slice(0, maxChars),
  );
  const t0 = performance.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ query, documents }),
    });
    if (!resp.ok) {
      logger.warn(
        `rerank[${backendLabel}]: sidecar HTTP ${resp.status}; falling back to RRF order`,
      );
      return { rows: candidates, mode: "rerank-fallback", fallback_reason: "rerank_http_error" };
    }
    const data = (await resp.json()) as {
      results: Array<{ index: number; score: number }>;
      latency_ms?: number;
    };
    if (!Array.isArray(data.results) || data.results.length !== candidates.length ||
      new Set(data.results.map(r=>r.index)).size !== candidates.length ||
      data.results.some(r=>!Number.isInteger(r.index)||r.index<0||r.index>=candidates.length||!Number.isFinite(r.score))) {
      return { rows: candidates, mode: "rerank-fallback", fallback_reason: "rerank_invalid_response" };
    }
    const wallMs = performance.now() - t0;
    logger.info(
      `rerank[${backendLabel}]: n=${candidates.length} sidecar=${data.latency_ms ?? "?"}ms wall=${wallMs.toFixed(0)}ms`,
    );
    const reordered: ResultRow[] = [];
    for (const r of data.results) {
      const src = candidates[r.index];
      if (!src) continue;
      reordered.push({
        ...src,
        // Carry rerank score in `rank` for transparency; negate so the
        // existing "smaller rank == better" caller contract holds.
        rank: -r.score,
      });
    }
    return { rows: reordered, mode: "rerank" };
  } catch (e: any) {
    logger.warn(
      `rerank[${backendLabel}]: failed (${e?.message ?? e}); falling back to RRF order`,
    );
    return { rows: candidates, mode: "rerank-fallback", fallback_reason: "rerank_exception" };
  }
}

/**
 * Decide which rerank backend (if any) to use for this call.
 *
 * Precedence:
 *   1. `deep_llm=true` → Claude Haiku sidecar (opt-in, slow but precise)
 *   2. `deep=true` (or QOOPIA_RERANK_DEFAULT_DEEP=1) → JinaAI cross-encoder
 *   3. Otherwise → null (no rerank, raw RRF order)
 *
 * Legacy QOOPIA_RERANK_ENABLED=1 keeps the historical "always-on with the
 * single env-configured endpoint" behaviour, even when the caller didn't
 * pass `deep`. This lets existing deployments upgrade without coordinated
 * call-site changes.
 */
function chooseRerankBackend(p: RecallParams): {
  endpoint: string;
  timeoutMs: number;
  label: "jina" | "llm" | "legacy";
} | null {
  if (memoryProfile(p.workspace_id)) return null;
  if (p.deep_llm === true) {
    return {
      endpoint: llmRerankEndpoint(),
      timeoutMs: llmRerankTimeoutMs(),
      label: "llm",
    };
  }
  const deepRequested = p.deep ?? rerankDefaultDeep();
  if (deepRequested) {
    return {
      endpoint: jinaRerankEndpoint(),
      timeoutMs: rerankTimeoutMs(),
      label: "jina",
    };
  }
  if (rerankEnabledLegacy() && p.deep !== false) {
    return {
      endpoint: jinaRerankEndpoint(),
      timeoutMs: rerankTimeoutMs(),
      label: "legacy",
    };
  }
  return null;
}

export async function recallBaseline(p: RecallParams) {
  const t0 = performance.now();
  const principalQuery=db.query('SELECT active,type,tool_profile,policy_epoch,session_version FROM agents WHERE id=? AND workspace_id=?');
  const principalBefore=JSON.stringify(principalQuery.get(p.caller_agent_id,p.workspace_id));
  const subscription=memoryProfile(p.workspace_id);
  let modelApplied=false,modelFailure:string|undefined,evidenceSufficient:boolean|undefined;
  let recallBackendUsed: "fts" | "vector" | "hybrid" | "deep" | "deep_llm" = "fts";
  const limit = Math.min(Math.max(p.limit || 10, 1), 50);
  const sanitized = sanitizeFtsQuery(p.query);
  const scope = p.scope || "notes";
  const canCrossWorkspace = !!(p.cross_workspace && p.privileged);
  const requestedMode = p.mode || getRecallMode();
  const diagnostics: RecallDiagnosticCollector | null = p._v4_diagnostics ? new Map() : null;
  // Pull a bounded pool from each eligible source. The extra depth gives the
  // final global fusion room to mix sources without any channel retrieving an
  // unbounded corpus.
  const candidateLimit = Math.min(50, Math.max(limit * 3, 10));
  // `effectiveMode` tracks what actually ran — it may degrade to
  // `fts5-fallback` if the vector channel was requested but produced
  // no candidates (Ollama down, no embeddings). Visible in the
  // response so callers can detect silent degradation.
  let effectiveMode: RecallMode | "fts5-fallback" = requestedMode;
  // Phase 1 item 6 (recall_log): track which rerank backend the call
  // chose and whether it actually returned (vs fell back to RRF order).
  // Resolved post-hoc just before the recall_log insert.
  let rerankBackendLabel: "jina" | "llm" | "legacy" | null = null;
  let rerankSucceeded = false;

  const results: ResultRow[] = [];
  let tokensReturned = 0;

  // Phase 2 Item C R2 — feature flag. Default OFF until the owner signs the
  // exact fusion contract in docs/operations/entity-pages-production-enable.md.
  // When false, the entity channel short-circuits — recall behaves
  // exactly as it did pre-Item-C.
  const entityPagesEnabled = process.env.QOOPIA_ENTITY_PAGES === "true";

  // Source channels preserve their own internal ordering here. The final
  // fusion below maps those ordinal positions to one comparable RRF scale.
  const noteResults: ResultRow[] = [];
  const entityResults: ResultRow[] = [];

  if (scope === "notes" || scope === "all") {
    if (requestedMode === "hybrid") {
      // Pull more candidates per channel than the final limit so RRF
      // has room to promote items ranked low in one channel but high
      // in the other.
      const channelTopN = hybridChannelTopN();
      const [ftsRows, vecRows] = await Promise.all([
        Promise.resolve(ftsNoteCandidates(p, sanitized, channelTopN)),
        vectorNoteCandidates(p, channelTopN),
      ]);
      ftsRows.forEach((row) => mergeDiagnostic(diagnostics, "notes", row.id, {
        source_channel: "fts5",
        fts_rank: row.rowid_rank,
        fts_score: row.rank,
      }));
      vecRows.forEach((row) => mergeDiagnostic(diagnostics, "notes", row.note_id, {
        source_channel: diagnostics?.get(diagnosticKey("notes", row.note_id))?.fts_rank
          ? "both"
          : "vector",
        vector_rank: row.vector_rank,
        vector_score: row.sim,
      }));
      if (vecRows.length === 0 && ftsRows.length >= 0) {
        // Pure FTS — record the fallback for observability but still
        // use the FTS-only ordering.
        effectiveMode = "fts5-fallback";
        recallBackendUsed = "fts";
        ftsRows.forEach((row) => mergeDiagnostic(diagnostics, "notes", row.id, {
          inner_rrf: 1 / (rrfK() + row.rowid_rank),
          post_rerank_rank: row.rowid_rank,
        }));
        for (const r of ftsRows.slice(0, candidateLimit)) {
          // Drop the internal rowid_rank field.
          const { rowid_rank: _rr, ...clean } = r;
          noteResults.push(clean);
        }
      } else {
        recallBackendUsed = "hybrid";
        const scores = rrfFuse(ftsRows, vecRows);
        for (const [id, innerRrf] of scores) {
          mergeDiagnostic(diagnostics, "notes", id, { inner_rrf: innerRrf });
        }
        const ranked = [...scores.entries()]
          .map(([id, rrf]) => ({ id, rrf }))
          .sort((a, b) => b.rrf - a.rrf);
        noteResults.push(...hydrateFusedNotes(p, ranked, Math.min(50, Math.max(candidateLimit, rerankTopK()))));
      }
    } else {
      // Pure FTS5 path — original behaviour.
      const ftsRows = ftsNoteCandidates(p, sanitized, candidateLimit);
      ftsRows.forEach((row) => mergeDiagnostic(diagnostics, "notes", row.id, {
        source_channel: "fts5",
        fts_rank: row.rowid_rank,
        fts_score: row.rank,
        inner_rrf: 1 / (rrfK() + row.rowid_rank),
        post_rerank_rank: row.rowid_rank,
      }));
      for (const r of ftsRows) {
        const { rowid_rank: _rr, ...clean } = r;
        noteResults.push(clean);
      }
    }
  }

  if(subscription&&(scope==='notes'||scope==='all')) {
    if(noteResults.length<3)try {
      const expanded=await memoryText(p.workspace_id,'Suggest up to three short alternative search queries: synonyms or translations in the likely source languages. Preserve exact names and identifiers. Return a JSON array of strings inside result.',{query:p.query});
      const queries=z.array(z.string().min(1).max(300)).max(3).parse(parseMemoryJson(expanded.text));
      const seen=new Set(noteResults.map(r=>r.id));
      for(const query of queries)for(const row of ftsNoteCandidates(p,sanitizeFtsQuery(query),20))if(!seen.has(row.id)){seen.add(row.id);noteResults.push(row);}
    } catch(error){modelFailure=error instanceof QoopiaError?error.code:'MODEL_INVALID_RESPONSE';}
    // One hop over existing explicit note relations; the normal hydration path
    // applies workspace, privacy, project and time predicates before disclosure.
    const seeds=noteResults.slice(0,5).map(r=>r.id);
    if(seeds.length) {
      const marks=seeds.map(()=>'?').join(',');
      const links=db.query(`SELECT source_note_id,target_note_id FROM note_relations WHERE workspace_id=?
        AND (source_note_id IN (${marks}) OR target_note_id IN (${marks})) LIMIT 20`).all(p.workspace_id,...seeds,...seeds) as Array<{source_note_id:string;target_note_id:string}>;
      const known=new Set(noteResults.map(r=>r.id)),ids=[...new Set(links.flatMap(r=>[r.source_note_id,r.target_note_id]))].filter(id=>!known.has(id));
      const neighbors=hydrateFusedNotes(p,ids.map(id=>({id,rrf:0})),5);
      // Reserve bounded space for supporting or contradicting evidence.
      noteResults.splice(15,0,...neighbors);
    }
  }

  // Judging is independent of vector availability; FTS candidates deserve the
  // same final selection when the embedder is unavailable or explicitly off.
  const backend=chooseRerankBackend(p);
  if (backend && noteResults.length) {
    recallBackendUsed=backend.label==='llm'?'deep_llm':'deep';
    rerankBackendLabel=backend.label;
    const judged=await rerankResults(p.query,noteResults,backend.endpoint,backend.timeoutMs,backend.label);
    rerankSucceeded=judged.mode==='rerank';
    noteResults.splice(0,noteResults.length,...judged.rows.slice(0,candidateLimit));
    noteResults.forEach((row,index)=>mergeDiagnostic(diagnostics,'notes',row.id,{
      post_rerank_rank:index+1,rerank_score:rerankSucceeded?-row.rank:null,
      fallback_reason:rerankSucceeded?null:(judged.fallback_reason??'rerank_fallback'),
    }));
  }

  if (
    entityPagesEnabled &&
    (scope === "entities" || scope === "notes" || scope === "all")
  ) {
    // Phase 2 Item C — entity channel. Pulls up to `limit` entity
    // candidates so global merge has full visibility (the R1 cap of
    // min(limit, 5) made entities second-class). Hybrid (FTS5 +
    // bge-m3) mirrors the notes pipeline with the same RRF fusion;
    // FTS-only fallback when the vector channel returns nothing.
    const entityRows = await entityCandidates(p, sanitized, candidateLimit, diagnostics);
    for (const r of entityRows) entityResults.push(r);
  }

  const activityResults: ResultRow[] = [];
  const sessionResults: ResultRow[] = [];

  if (scope === "activity" || scope === "all") {
    // Migration 009 added activity_fts (mirrors notes_fts pattern).
    // No vector channel for activity — summaries are short, FTS suffices.
    const where: string[] = [`activity_fts MATCH ?`];
    const params: any[] = [sanitized];
    if (!canCrossWorkspace) {
      where.push(`a.workspace_id = ?`);
      params.push(p.workspace_id);
    }
    // QTHIRD-001: hide activity rows tied to sibling private notes.
    where.push(`(a.visibility = 'workspace' OR a.agent_id = ? OR ? = 1)`);
    params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
    const sql = `
      SELECT a.id, 'activity' as type, a.summary as text, a.details as metadata,
             a.project_id, a.created_at, a.workspace_id, rank
      FROM activity_fts f
      JOIN activity a ON a.rowid = f.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, candidateLimit) as Array<{
      id: string;
      type: string;
      text: string;
      metadata: string;
      project_id: string | null;
      created_at: string;
      workspace_id: string;
      rank: number;
    }>;
    for (const [index, r] of rows.entries()) {
      mergeDiagnostic(diagnostics, "activity", r.id, {
        fts_rank: index + 1,
        fts_score: r.rank,
        inner_rrf: 1 / (rrfK() + index + 1),
        post_rerank_rank: index + 1,
      });
      activityResults.push({
        id: r.id,
        type: r.type,
        text: r.text,
        metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
        project_id: r.project_id,
        created_at: r.created_at,
        workspace_id: r.workspace_id,
        rank: r.rank,
        source: "activity",
      });
    }
  }

  if (scope === "sessions" || scope === "all") {
    // session_messages_fts — same private-message-only policy.
    const where: string[] = [`session_messages_fts MATCH ?`];
    const params: any[] = [sanitized];
    if (!canCrossWorkspace) {
      where.push(`m.workspace_id = ?`);
      params.push(p.workspace_id);
    }
    where.push(`(m.agent_id = ? OR ? = 1)`);
    params.push(p.caller_agent_id, p.is_admin ? 1 : 0);
    const sql = `
      SELECT m.id, m.role as type, m.content as text, m.metadata, NULL as project_id,
             m.created_at, m.workspace_id, m.session_id, rank
      FROM session_messages_fts f
      JOIN session_messages m ON m.id = f.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, candidateLimit) as Array<{
      id: number;
      type: string;
      text: string;
      metadata: string;
      project_id: null;
      created_at: string;
      workspace_id: string;
      session_id: string;
      rank: number;
    }>;
    for (const [index, r] of rows.entries()) {
      mergeDiagnostic(diagnostics, "sessions", String(r.id), {
        fts_rank: index + 1,
        fts_score: r.rank,
        inner_rrf: 1 / (rrfK() + index + 1),
        post_rerank_rank: index + 1,
      });
      const metadata = safeJsonParse(r.metadata, {} as Record<string, unknown>);
      (metadata as Record<string, unknown>).session_id = r.session_id;
      sessionResults.push({
        id: String(r.id),
        type: `session_message:${r.type}`,
        text: r.text,
        metadata,
        project_id: null,
        created_at: r.created_at,
        workspace_id: r.workspace_id,
        rank: r.rank,
        source: "sessions",
      });
    }
  }

  // Apply one ranking and one limit at the outermost layer. `scope=all`
  // therefore cannot return 2x/3x the requested count, and notes/entities no
  // longer compare raw BM25 values from independent FTS corpora.
  const poolLimit=subscription?Math.max(limit,20):limit;
  let finalResults: ResultRow[];
  if (scope === "all") {
    finalResults = fuseRecallSources(
      [entityResults, noteResults, activityResults, sessionResults],
      poolLimit,
    );
  } else if (scope === "notes") {
    finalResults = fuseRecallSources([entityResults, noteResults], poolLimit);
  } else if (scope === "entities") {
    finalResults = fuseRecallSources([entityResults], poolLimit);
  } else if (scope === "activity") {
    finalResults = activityResults.slice(0, poolLimit);
  } else {
    finalResults = sessionResults.slice(0, poolLimit);
  }
  if(subscription&&finalResults.length)try {
    const pool=finalResults.slice(0,20),documents=pool.map((r,i)=>({id:String(i),source:r.source,created_at:r.created_at,
      text:passageForRerank(r.text,p.query,1600),metadata:{valid_from:r.valid_from,valid_until:r.valid_until,invalidated_at:r.invalidated_at}}));
    const output=await memoryText(p.workspace_id,
      'Select and rank only documents useful for answering the query. Consider time, explicit corrections, contradictions and exact names. Include conflicting evidence when relevant. An empty list is correct when nothing fits. Return JSON {"ids":["candidate id",...],"sufficient":true|false} inside result. Sufficient means these sources support an answer; this is an assessment, not a probability. Do not answer the query or invent candidate IDs.',
      {query:p.query,documents});
    const judged=z.object({ids:z.array(z.string()).max(20),sufficient:z.boolean()}).strict().parse(parseMemoryJson(output.text));
    if(new Set(judged.ids).size!==judged.ids.length||judged.ids.some(id=>!/^\d+$/.test(id)||!pool[Number(id)]))throw new Error('Unknown or duplicate candidate');
    // Re-check permissions and live content after the asynchronous model call.
    // Concurrent deletion/restriction/edit must not publish an old cached body.
    const authorized=new Map(hydrateFusedNotes(p,pool.filter(r=>r.source==='notes').map(r=>({id:r.id,rrf:0})),20).map(r=>[r.id,r]));
    finalResults=judged.ids.map(id=>pool[Number(id)]!).filter(r=>r.source!=='notes'||authorized.get(r.id)?.text===r.text).slice(0,limit);
    evidenceSufficient=judged.sufficient;modelApplied=true;modelFailure=undefined;rerankSucceeded=true;rerankBackendLabel='llm';
  } catch(error){modelFailure=error instanceof QoopiaError?error.code:'MODEL_INVALID_RESPONSE';finalResults=finalResults.slice(0,limit);}
  else finalResults=finalResults.slice(0,limit);
  if(JSON.stringify(principalQuery.get(p.caller_agent_id,p.workspace_id))!==principalBefore)throw new QoopiaError('REVOKED','Authority changed during recall');
  const liveNotes=new Map(hydrateFusedNotes(p,finalResults.filter(r=>r.source==='notes').map(r=>({id:r.id,rrf:0})),50).map(r=>[r.id,r]));
  finalResults=finalResults.filter(r=>r.source==='notes'?liveNotes.get(r.id)?.text===r.text:r.source==='sessions'?!!db.query('SELECT 1 FROM session_messages WHERE id=? AND workspace_id=? AND (agent_id=? OR ?=1)').get(r.id,r.workspace_id,p.caller_agent_id,p.is_admin?1:0):r.source==='activity'?!!db.query("SELECT 1 FROM activity WHERE id=? AND workspace_id=? AND (visibility='workspace' OR agent_id=? OR ?=1)").get(r.id,r.workspace_id,p.caller_agent_id,p.is_admin?1:0):true);
  results.push(...finalResults);
  if (p._v4_diagnostics && diagnostics) {
    p._v4_diagnostics({ items: Object.fromEntries(diagnostics) });
  }
  tokensReturned = results.reduce(
    (sum, row) => sum + Math.ceil(row.text.length / 4),
    0,
  );

  // Rough cost metric: compare to a naive full scan estimate (avg note 200
  // chars × rows). Good enough to demonstrate savings to the agent.
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(length(text)),0) as total_chars FROM notes WHERE workspace_id = ? AND deleted_at IS NULL`,
    )
    .get(p.workspace_id) as { c: number; total_chars: number };
  const fullScanTokens = Math.ceil(totalRow.total_chars / 4);
  const savings =
    fullScanTokens > 0 ? 1 - tokensReturned / fullScanTokens : 0;

  // Phase 1 item 6 — recall_log telemetry. Insert AFTER computing the
  // response so latency reflects the full call, BEFORE returning to the
  // caller. Wrapped in try/catch: insertion failures (table missing on
  // an un-migrated DB, FK violation, etc.) MUST NOT fail the recall
  // itself. The redaction step is mandatory and runs synchronously
  // here — query_text NEVER goes into recall_log raw. Legacy-readonly exports
  // skip telemetry entirely so the read tool has no hidden write attempt.
  if (!isReadOnlyInstance()) {
    try {
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      let backendPath: "fts" | "vector" | "hybrid" | "deep" | "deep_llm";
      if (rerankBackendLabel === "llm") {
        backendPath = "deep_llm";
      } else if (rerankBackendLabel === "jina" || rerankBackendLabel === "legacy") {
        backendPath = "deep";
      } else {
        backendPath = effectiveMode === "hybrid" ? "hybrid" : "fts";
      }
      const deepUsed = rerankSucceeded ? 1 : 0;
      db.prepare(
        `INSERT INTO recall_log
           (caller_agent, workspace_id, query_text, top_k, result_ids,
            result_scores, latency_ms, backend_path, scope, deep_used, error_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        p.caller_agent_id,
        p.workspace_id,
        redactQuery(p.query),
        limit,
        JSON.stringify(results.map((r) => r.id)),
        JSON.stringify(
          results.map((r) =>
            Number.isFinite(r.rank) ? Number(r.rank.toFixed(6)) : 0,
          ),
        ),
        latencyMs,
        backendPath,
        scope,
        deepUsed,
      );
    } catch (e: any) {
      // Swallow — telemetry must never break the recall path. The most
      // common cause on an un-migrated DB is "no such table: recall_log".
      logger.warn(`recall_log insert skipped: ${e?.message ?? String(e)}`);
    }
  }

  return {
    results,
    total_found: results.length,
    query: p.query,
    sanitized_query: sanitized,
    mode: effectiveMode,
    judging: { attempted: !!subscription||!!rerankBackendLabel, applied: subscription?modelApplied:rerankSucceeded, backend: subscription?'subscription':rerankBackendLabel,
      ...(subscription?{status:memoryModelStatus(p.workspace_id).state,error:modelFailure,sufficient:evidenceSufficient}: {}) },
    cost: {
      tokens_returned: tokensReturned,
      tokens_full_scan_estimate: fullScanTokens,
      savings_ratio: Math.max(0, Math.min(1, Number(savings.toFixed(3)))),
    },
  };
}

/**
 * Stable public orchestrator. With every V4 behavior flag off and no V4
 * request fields, this calls the frozen V3 implementation directly so its
 * ordering and response bytes remain unchanged.
 */
export async function recall(p: RecallParams) {
  // V4.1: темпоральные параметры разбираются один раз на запрос. При
  // выключенном флаге фильтр — null, объект параметров не пересоздаётся и
  // ни один запрос ниже не меняется (Flag-OFF byte-identical).
  const temporal = resolveTemporalFilter(p);
  const params = temporal === null ? p : { ...p, _temporal: temporal };
  const response = !v4RecallRequested(params)
    ? await recallBaseline(params)
    : await runV4Recall(params, recallBaseline);
  return (params.scope ?? "notes") === "notes" ? boundDefaultRecall(response) : response;
}
