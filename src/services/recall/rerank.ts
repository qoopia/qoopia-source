import type { RecallParams, ResultRow } from "../recall.ts";
import { memoryProfile } from "../memory-model.ts";
import { logger } from "../../utils/logger.ts";
import {
  jinaRerankEndpoint,
  llmRerankEndpoint,
  llmRerankTimeoutMs,
  passageForRerank,
  rerankDefaultDeep,
  rerankEnabledLegacy,
  rerankMaxDocChars,
  rerankPassageWindow,
  rerankTimeoutMs,
} from "./config.ts";

/**
 * Cross-encoder / LLM rerank stage. Generic over backend — the caller
 * picks an endpoint URL and timeout per request. Input: hydrated
 * candidates already shortlisted by RRF. Output: same rows reordered
 * by pair-wise relevance. On any sidecar error, returns the input
 * unchanged (mode='rerank-fallback') so the caller stays oblivious.
 */
export async function rerankResults(
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
export function chooseRerankBackend(p: RecallParams): {
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
