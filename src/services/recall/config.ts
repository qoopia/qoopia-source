/**
 * Environment-derived tuning for recall.
 *
 * Twenty-odd readers of process.env sat at the top of recall.ts, ahead of the
 * retrieval code they configure. They depend on nothing else in the module and
 * are the part most often read on its own, so they live here. Values are read
 * per call rather than captured at import time, because tests and operators
 * change them between requests.
 */
export const MAX_QUERY_CHARS = 1000;
export const DEFAULT_RECALL_OUTPUT_BYTES = 4_000;

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
export function rrfK(): number {
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
export function hybridChannelTopN(): number {
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
export function vectorCosineThreshold(): number {
  return Number(process.env.QOOPIA_VECTOR_COSINE_THRESHOLD || 0.42);
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
export function getVectorTypeFilterMaxLen(): number {
  return Number(process.env.QOOPIA_VECTOR_TYPE_FILTER_MAX_LEN || 40);
}

/** Note types subject to the short-length vector-channel filter. */
export const VECTOR_TYPE_FILTER_TYPES = new Set(["project", "task"]);

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
export function rerankEnabledLegacy(): boolean {
  return process.env.QOOPIA_RERANK_ENABLED === "1";
}
export function rerankDefaultDeep(): boolean {
  // OFF by default; explicit opt-in via QOOPIA_RERANK_DEFAULT_DEEP=1.
  // Safety: a bare deployment with no env vars and no sidecar would
  // otherwise eat QOOPIA_RERANK_TIMEOUT_MS per recall waiting for a
  // missing endpoint before falling back. Default-off keeps backward
  // compat zero-cost; operators opt in once a sidecar is wired up.
  return process.env.QOOPIA_RERANK_DEFAULT_DEEP === "1";
}
export function jinaRerankEndpoint(): string {
  return (
    process.env.QOOPIA_RERANK_JINA_ENDPOINT ||
    process.env.QOOPIA_RERANK_ENDPOINT ||
    "http://jina-reranker:8790/rerank"
  );
}
export function llmRerankEndpoint(): string {
  return (
    process.env.QOOPIA_RERANK_LLM_ENDPOINT ||
    "http://host.docker.internal:8789/rerank"
  );
}
export function rerankTopK(): number {
  return Number(process.env.QOOPIA_RERANK_TOP_K || 30);
}
export function rerankTimeoutMs(): number {
  return Number(process.env.QOOPIA_RERANK_TIMEOUT_MS || 5000);
}
export function llmRerankTimeoutMs(): number {
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
export function rerankPassageWindow(): boolean {
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
export function passageForRerank(text: string, query: string, maxChars: number): string {
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

export function rerankMaxDocChars(): number {
  return Number(process.env.QOOPIA_RERANK_MAX_DOC_CHARS || 2000);
}
