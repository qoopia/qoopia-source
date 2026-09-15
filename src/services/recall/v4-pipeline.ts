import { db } from "../../db/connection.ts";
import type { AuthContext } from "../../auth/middleware.ts";
import { QoopiaError } from "../../utils/errors.ts";
import { recordRecallMetrics } from "../../utils/observability.ts";
import type {
  RecallBaselineDiagnosticItem,
  RecallBaselineDiagnostics,
  RecallParams,
  ResultRow,
} from "../recall.ts";
import { getNote } from "../notes.ts";
import { getSupersedeChain } from "../note-relations.ts";
import { bitemporalEnabled } from "../../utils/temporal.ts";
import { computeLifecycleFactor, queueAccessReinforcement } from "../memory-lifecycle.ts";
import {
  createRecallTrace,
  RECALL_PIPELINE_VERSION,
  type RecallDiagnosticItem,
  type TraceResultKind,
  type TraceSourceChannel,
} from "../recall-traces.ts";
import { ADMIN_TYPES } from "../../auth/principal.ts";

const RRF_K = 60;

type BaselineResponse = {
  results: ResultRow[];
  total_found: number;
  query: string;
  sanitized_query: string;
  mode: string;
  judging?: {attempted:boolean;applied:boolean;backend:string|null;status?:string;error?:string;sufficient?:boolean};
  cost: {
    tokens_returned: number;
    tokens_full_scan_estimate: number;
    savings_ratio: number;
  };
};

type BaselineRecall = (params: RecallParams) => Promise<BaselineResponse>;

interface Candidate {
  row: ResultRow;
  source: NonNullable<ResultRow["source"]>;
  anchor_rank: number;
  source_rank: number;
  updated_ms: number;
  direct: boolean;
  active_head: boolean;
  conflict: boolean;
  superseded: boolean;
  replacement_available: boolean;
  lifecycle_factor: number;
  governance_factor: number;
  relation_factor: number;
  final_score: number;
  reason_codes: string[];
  diagnostic: RecallBaselineDiagnosticItem | null;
  lifecycle_explain?: Record<string, unknown>;
}

function flag(name: string): boolean {
  return process.env[name] === "true";
}

function featureDisabled(name: string): never {
  const error = new QoopiaError("INVALID_INPUT", name);
  (error as { code: string }).code = "FEATURE_DISABLED";
  throw error;
}

function invalidArgument(message: string): never {
  const error = new QoopiaError("INVALID_INPUT", message);
  (error as { code: string }).code = "INVALID_ARGUMENT";
  throw error;
}

function relationGraphLimit(): never {
  const error = new QoopiaError("SIZE_LIMIT", "supersede component exceeds 1000 nodes or edges");
  (error as { code: string }).code = "RELATION_GRAPH_LIMIT";
  throw error;
}

export function v4RecallRequested(p: RecallParams): boolean {
  if (p.include_history === true || p.latest_only === true || p.explain === true || p.trace === true || p.lifecycle === true) {
    return true;
  }
  if (
    flag("QOOPIA_V4_RELATIONS") &&
    flag("QOOPIA_V4_LATEST_ONLY") &&
    p.latest_only !== false
  ) return true;
  if (flag("QOOPIA_V4_LIFECYCLE") && p.lifecycle !== false) return true;
  return false;
}

function resolveAuth(p: RecallParams): AuthContext {
  const actor = db.prepare(
    `SELECT name, type, tool_profile FROM agents
      WHERE workspace_id = ? AND id = ? AND active = 1`,
  ).get(p.workspace_id, p.caller_agent_id) as
    | { name: string; type: string; tool_profile: string | null }
    | undefined;
  if (!actor) throw new QoopiaError("NOT_FOUND", "recall caller not found");
  return {
    agent_id: p.caller_agent_id,
    agent_name: actor.name,
    workspace_id: p.workspace_id,
    // Authorization is resolved from the live agent row.  A request field is
    // never allowed to promote the caller for relation expansion, lifecycle
    // provenance, or injected-head visibility.
    type: actor.type,
    source: "api-key",
    tool_profile: actor.tool_profile,
  };
}

function sourceOf(row: ResultRow): NonNullable<ResultRow["source"]> {
  return row.source ?? "notes";
}

function resultKind(row: ResultRow): TraceResultKind {
  const source = sourceOf(row);
  if (source === "notes") return "note";
  if (source === "entity") return "entity";
  if (source === "activity") return "activity";
  return "session_message";
}

function sourceChannel(candidate: Candidate, mode: string): TraceSourceChannel {
  if (candidate.diagnostic) return candidate.diagnostic.source_channel;
  const row = candidate.row;
  const source = sourceOf(row);
  if (source === "activity") return "activity_fts";
  if (source === "sessions") return "session_fts";
  return mode === "hybrid" ? "both" : "fts5";
}

function archived(row: ResultRow): boolean {
  const metadata = row.metadata as Record<string, unknown>;
  return metadata?.status === "archived";
}

function hydrateVisibleHead(
  auth: AuthContext,
  p: RecallParams,
  noteId: string,
): ResultRow | null {
  try {
    const note = getNote(auth.workspace_id, noteId, auth.agent_id, ADMIN_TYPES.has(auth.type));
    if (p.type && note.type !== p.type) return null;
    if (p.project_id && note.project_id !== p.project_id) return null;
    const temporal = bitemporalEnabled() && "valid_from" in note
      ? {
          valid_from: note.valid_from,
          valid_until: note.valid_until,
          invalidated_at: note.invalidated_at,
          subject_key: note.subject_key,
          supersedes_id: note.supersedes_id,
          valid_until_inferred: note.valid_until_inferred,
        }
      : {};
    return {
      id: note.id,
      type: note.type,
      text: note.text,
      metadata: note.metadata,
      project_id: note.project_id,
      created_at: note.created_at,
      workspace_id: note.workspace_id,
      rank: 0,
      source: "notes",
      ...temporal,
    };
  } catch {
    return null;
  }
}

/** §7.4 — признак «убеждение закрыто». Читается только при включённом флаге. */
function isInvalidatedNote(workspaceId: string, noteId: string): boolean {
  const row = db.prepare(
    `SELECT invalidated_at_ms FROM notes WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, noteId) as { invalidated_at_ms: number | null } | undefined;
  return !!row && row.invalidated_at_ms !== null;
}

function noteUpdatedMs(row: ResultRow): number {
  if (sourceOf(row) !== "notes") {
    const parsed = Date.parse(row.created_at);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const note = db.prepare(
    `SELECT updated_at_ms FROM notes WHERE workspace_id = ? AND id = ?`,
  ).get(row.workspace_id, row.id) as { updated_at_ms: number } | undefined;
  return note?.updated_at_ms ?? 0;
}

function governanceFactor(auth: AuthContext, row: ResultRow): number {
  if (sourceOf(row) !== "notes" || !row.project_id) return 1;
  try {
    const project = getNote(auth.workspace_id, row.project_id, auth.agent_id, ADMIN_TYPES.has(auth.type));
    return (project.metadata as Record<string, unknown>)?.status === "active" ? 1.05 : 1;
  } catch {
    return 1;
  }
}

function relationEdgeCount(workspaceId: string, noteIds: string[]): number {
  if (noteIds.length === 0) return 0;
  const placeholders = noteIds.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM note_relations
      WHERE workspace_id = ? AND relation_type = 'supersedes'
        AND source_note_id IN (${placeholders})
        AND target_note_id IN (${placeholders})`,
  ).get(workspaceId, ...noteIds, ...noteIds) as { c: number };
  return row.c;
}

function normalizeOptions(p: RecallParams) {
  const relations = flag("QOOPIA_V4_RELATIONS");
  const latestFlag = flag("QOOPIA_V4_LATEST_ONLY");
  const explainFlag = flag("QOOPIA_V4_RECALL_EXPLAIN");
  const lifecycleFlag = flag("QOOPIA_V4_LIFECYCLE");
  const includeHistory = p.include_history === true;
  if (includeHistory && !p.include_archived) {
    invalidArgument("include_history=true requires include_archived=true");
  }
  if (includeHistory && p.latest_only === true) {
    invalidArgument("include_history=true is incompatible with latest_only=true");
  }
  const latestOnly = includeHistory ? false : (p.latest_only ?? (relations && latestFlag));
  if (p.latest_only === true && (!relations || !latestFlag)) {
    featureDisabled("QOOPIA_V4_RELATIONS/QOOPIA_V4_LATEST_ONLY");
  }
  if ((latestOnly || includeHistory) && !relations) featureDisabled("QOOPIA_V4_RELATIONS");
  if ((p.explain === true || p.trace === true) && !explainFlag) {
    featureDisabled("QOOPIA_V4_RECALL_EXPLAIN");
  }
  if (p.lifecycle === true && !lifecycleFlag) featureDisabled("QOOPIA_V4_LIFECYCLE");
  const lifecycle = p.lifecycle ?? lifecycleFlag;
  return {
    latest_only: latestOnly,
    include_history: includeHistory,
    explain: p.explain === true,
    trace: p.trace === true,
    lifecycle,
    relation_aware: latestOnly || includeHistory,
  };
}

function plainResult(candidate: Candidate, explain: boolean) {
  const row = { ...candidate.row, rank: -candidate.final_score } as ResultRow & {
    explain?: Record<string, unknown>;
  };
  if (explain) {
    row.explain = {
      source_rank: candidate.source_rank,
      retrieval_score: Number((61 / (RRF_K + candidate.source_rank)).toFixed(6)),
      relation_factor: Number(candidate.relation_factor.toFixed(6)),
      governance_factor: Number(candidate.governance_factor.toFixed(6)),
      lifecycle_factor: Number(candidate.lifecycle_factor.toFixed(6)),
      final_score: Number(candidate.final_score.toFixed(6)),
      reason_codes: [...candidate.reason_codes].sort(),
      ...(candidate.lifecycle_explain ? { lifecycle: candidate.lifecycle_explain } : {}),
    };
  }
  return row;
}

export async function runV4Recall(p: RecallParams, baselineRecall: BaselineRecall) {
  const started = performance.now();
  const options = normalizeOptions(p);
  if (!options.relation_aware && !options.explain && !options.trace && !options.lifecycle) {
    const response = await baselineRecall(p);
    recordRecallMetrics({
      mode: response.mode,
      result: response.results.length ? "ok" : "empty",
      duration_ms: performance.now() - started,
      result_count: response.results.length,
    });
    return response;
  }
  const auth = resolveAuth(p);
  const limit = Math.min(Math.max(p.limit ?? 10, 1), 50);
  const baselineDiagnostics: { value?: RecallBaselineDiagnostics } = {};
  const baseline = await baselineRecall({
    ...p,
    is_admin: ADMIN_TYPES.has(auth.type),
    limit: 50,
    include_archived: options.relation_aware ? true : p.include_archived,
    _v4_diagnostics: (diagnostics) => {
      baselineDiagnostics.value = diagnostics;
    },
  });

  const sourcePositions = new Map<string, number>();
  const candidates = new Map<string, Candidate>();
  for (const row of baseline.results) {
    const source = sourceOf(row);
    const sourceRank = (sourcePositions.get(source) ?? 0) + 1;
    sourcePositions.set(source, sourceRank);
    const key = `${source}:${row.id}`;
    candidates.set(key, {
      row,
      source,
      anchor_rank: sourceRank,
      source_rank: sourceRank,
      updated_ms: noteUpdatedMs(row),
      direct: true,
      active_head: true,
      conflict: false,
      superseded: false,
      replacement_available: false,
      lifecycle_factor: 1,
      governance_factor: 1,
      relation_factor: 1,
      final_score: 0,
      reason_codes: [],
      diagnostic: baselineDiagnostics.value?.items[key] ?? null,
    });
  }

  if (options.relation_aware) {
    for (const candidate of [...candidates.values()]) {
      if (candidate.source !== "notes" || candidate.row.workspace_id !== auth.workspace_id) continue;
      const chain = getSupersedeChain({ auth, note_id: candidate.row.id });
      if (chain.note_ids.length > 1000 || relationEdgeCount(auth.workspace_id, chain.note_ids) > 1000) {
        relationGraphLimit();
      }
      const heads = new Set(chain.active_heads);
      candidate.active_head = heads.has(candidate.row.id);
      candidate.superseded = chain.note_ids.length > 1 && !candidate.active_head;
      candidate.conflict = chain.conflict;
      let eligibleHeads = 0;
      for (const headId of chain.active_heads) {
        const row = hydrateVisibleHead(auth, p, headId);
        if (!row) continue;
        if (!p.include_archived && archived(row)) continue;
        eligibleHeads++;
        const key = `notes:${headId}`;
        const existing = candidates.get(key);
        if (existing) {
          existing.anchor_rank = Math.min(existing.anchor_rank, candidate.anchor_rank);
          existing.active_head = true;
          existing.conflict ||= chain.conflict;
          const inheritedRrf = candidate.diagnostic?.inner_rrf ?? null;
          if (
            inheritedRrf !== null &&
            (existing.diagnostic?.inner_rrf ?? Number.NEGATIVE_INFINITY) < inheritedRrf
          ) {
            existing.diagnostic = {
              ...(candidate.diagnostic ?? existing.diagnostic!),
              fts_rank: existing.diagnostic?.fts_rank ?? null,
              vector_rank: existing.diagnostic?.vector_rank ?? null,
              fts_score: existing.diagnostic?.fts_score ?? null,
              vector_score: existing.diagnostic?.vector_score ?? null,
              rerank_score: existing.diagnostic?.rerank_score ?? null,
              post_rerank_rank: existing.diagnostic?.post_rerank_rank ?? null,
              inner_rrf: inheritedRrf,
            };
          }
          continue;
        }
        candidates.set(key, {
          row,
          source: "notes",
          anchor_rank: candidate.anchor_rank,
          source_rank: candidate.anchor_rank,
          updated_ms: noteUpdatedMs(row),
          direct: false,
          active_head: true,
          conflict: chain.conflict,
          superseded: false,
          replacement_available: false,
          lifecycle_factor: 1,
          governance_factor: 1,
          relation_factor: 1,
          final_score: 0,
          reason_codes: ["head_inherited_from_superseded"],
          diagnostic: candidate.diagnostic
            ? {
                ...candidate.diagnostic,
                fts_rank: null,
                vector_rank: null,
                fts_score: null,
                vector_score: null,
                rerank_score: null,
              }
            : null,
        });
      }
      candidate.replacement_available = eligibleHeads > 0;
      if (candidate.superseded && !candidate.replacement_available) {
        candidate.reason_codes.push("relation_head_unavailable");
      }
    }
  }

  let pool = [...candidates.values()];
  if (!p.include_archived) {
    pool = pool.filter((candidate) => candidate.source !== "notes" || !archived(candidate.row));
  }
  if (options.latest_only) {
    pool = pool.filter((candidate) =>
      candidate.source !== "notes" || !candidate.superseded || !candidate.replacement_available
    );
  }

  const bySource = new Map<NonNullable<ResultRow["source"]>, Candidate[]>();
  for (const candidate of pool) {
    if (candidate.diagnostic?.fallback_reason) {
      candidate.reason_codes.push(candidate.diagnostic.fallback_reason);
    }
    const list = bySource.get(candidate.source) ?? [];
    list.push(candidate);
    bySource.set(candidate.source, list);
  }
  for (const list of bySource.values()) {
    list.sort((a, b) => {
      if (a.anchor_rank !== b.anchor_rank) return a.anchor_rank - b.anchor_rank;
      if (a.active_head !== b.active_head) return a.active_head ? -1 : 1;
      if (a.updated_ms !== b.updated_ms) return b.updated_ms - a.updated_ms;
      return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
    });
    list.forEach((candidate, index) => {
      candidate.source_rank = index + 1;
    });
  }

  for (const candidate of pool) {
    if (candidate.source === "notes") {
      if (options.include_history && candidate.superseded) {
        candidate.relation_factor = 0.9;
        candidate.reason_codes.push("superseded_history");
      } else if (candidate.active_head && candidate.conflict) {
        candidate.relation_factor = 0.95;
        candidate.reason_codes.push("multiple_active_heads");
      }
      candidate.governance_factor = governanceFactor(auth, candidate.row);
      if (candidate.governance_factor > 1) candidate.reason_codes.push("active_project");
      if (options.lifecycle && candidate.row.workspace_id === auth.workspace_id) {
        const lifecycle = computeLifecycleFactor({ auth, note_id: candidate.row.id });
        candidate.lifecycle_factor = lifecycle.factor;
        candidate.lifecycle_explain = lifecycle.explain as Record<string, unknown>;
        if (lifecycle.factor !== 1) candidate.reason_codes.push("lifecycle_adjusted");
      }
    }
    const retrievalScore = 61 / (RRF_K + candidate.source_rank);
    candidate.final_score = retrievalScore * candidate.relation_factor *
      candidate.governance_factor * candidate.lifecycle_factor;
  }

  pool.sort((a, b) => {
    if (a.final_score !== b.final_score) return b.final_score - a.final_score;
    if (a.updated_ms !== b.updated_ms) return b.updated_ms - a.updated_ms;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
  const selected = pool.slice(0, limit);
  const results = selected.map((candidate) => plainResult(candidate, options.explain));
  const diagnostics: RecallDiagnosticItem[] = selected.map((candidate, index) => ({
    result_kind: resultKind(candidate.row),
    result_id: candidate.row.id,
    note_id: candidate.source === "notes" ? candidate.row.id : null,
    source_channel: sourceChannel(candidate, baseline.mode),
    fts_rank: candidate.diagnostic?.fts_rank ?? null,
    vector_rank: candidate.diagnostic?.vector_rank ?? null,
    fts_score: candidate.diagnostic?.fts_score ?? null,
    vector_score: candidate.diagnostic?.vector_score ?? null,
    rrf_score: candidate.diagnostic?.inner_rrf ?? (1 / (RRF_K + candidate.source_rank)),
    rerank_score: candidate.diagnostic?.rerank_score ?? null,
    lifecycle_factor: candidate.lifecycle_factor,
    governance_factor: candidate.governance_factor,
    relation_factor: candidate.relation_factor,
    final_score: candidate.final_score,
    final_rank: index + 1,
    reason_codes: candidate.reason_codes,
  }));

  const tokensReturned = results.reduce((sum, row) => sum + Math.ceil(row.text.length / 4), 0);
  const response: BaselineResponse & {
    trace_id?: string;
    pipeline_version: string;
    effective_options: Record<string, boolean>;
  } = {
    ...baseline,
    results,
    total_found: results.length,
    cost: {
      ...baseline.cost,
      tokens_returned: tokensReturned,
      savings_ratio: baseline.cost.tokens_full_scan_estimate > 0
        ? Math.max(0, Math.min(1, Number((1 - tokensReturned / baseline.cost.tokens_full_scan_estimate).toFixed(3))))
        : 0,
    },
    pipeline_version: RECALL_PIPELINE_VERSION,
    effective_options: {
      latest_only: options.latest_only,
      include_history: options.include_history,
      lifecycle: options.lifecycle,
      explain: options.explain,
      trace: options.trace,
    },
  };
  if (options.trace) {
    response.trace_id = createRecallTrace({
      auth,
      query: p.query,
      mode: baseline.mode,
      options: {
        scope: p.scope ?? null,
        limit,
        latest_only: options.latest_only,
        include_archived: !!p.include_archived,
        include_history: options.include_history,
        lifecycle: options.lifecycle,
      },
      duration_ms: performance.now() - started,
      items: diagnostics,
    });
  }
  if (options.lifecycle) {
    for (const candidate of selected) {
      if (candidate.source !== "notes" || candidate.row.workspace_id !== auth.workspace_id) continue;
      // V4.1 §7.4: невалидированное убеждение не подкрепляется.
      if (bitemporalEnabled() && isInvalidatedNote(auth.workspace_id, candidate.row.id)) continue;
      void queueAccessReinforcement({
        workspace_id: auth.workspace_id,
        note_id: candidate.row.id,
      });
    }
  }
  recordRecallMetrics({
    mode: baseline.mode,
    result: results.length ? "ok" : "empty",
    duration_ms: performance.now() - started,
    result_count: results.length,
  });
  return response;
}
