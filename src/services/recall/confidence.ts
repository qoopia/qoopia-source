/**
 * "Not sure" signal for recall.
 *
 * RRF scores depend on positions only, so a query with no answer in memory
 * still gets a confident-looking first place. Two absolute signals separate
 * "found it" from "nearest neighbour of nothing":
 *  - vector_top: the best cosine between the query and the top results;
 *  - term_coverage: the largest share of the query's content words (stemmed)
 *    present in one of the top results.
 * A call is low_confidence when both are below their thresholds, when there
 * are no results, or when the memory model judged the evidence insufficient.
 * The flag adds information and changes no ranking or existing field.
 */
import type { ResultRow } from "../recall.ts";
import { analyzeFtsQuery, russianStem } from "../fts-query.ts";
import { lowConfidenceCoverage, lowConfidenceCosine, lowConfidenceTopN } from "./config.ts";

export interface RecallConfidence {
  /** Best cosine of the top results; null when the vector channel did not run. */
  vector_top: number | null;
  /** Largest share of the query's content words found in one top result, 0..1. */
  term_coverage: number;
  /** Whether a top result was found by both the FTS and the vector channel. */
  channels_agree: boolean;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;

export function contentTerms(query: string, stopWords: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const token of analyzeFtsQuery(query).terms) {
    for (const word of token.match(WORD) ?? []) {
      if (word.length < 3 || stopWords.has(word)) continue;
      out.add(russianStem(word));
    }
  }
  return [...out];
}

export function termCoverage(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  let hit = 0;
  for (const term of terms) if (haystack.includes(term)) hit++;
  return hit / terms.length;
}

export function recallConfidence(
  query: string,
  results: ResultRow[],
  vectorSim: ReadonlyMap<string, number> | null,
  ftsIds: ReadonlySet<string>,
  stopWords: ReadonlySet<string>,
): RecallConfidence {
  const top = results.slice(0, lowConfidenceTopN());
  const terms = contentTerms(query, stopWords);
  let vectorTop: number | null = null;
  let coverage = 0;
  let agree = false;
  for (const row of top) {
    coverage = Math.max(coverage, termCoverage(terms, row.text));
    const sim = row.source === "notes" || row.source === undefined ? vectorSim?.get(row.id) : undefined;
    if (sim !== undefined) {
      vectorTop = Math.max(vectorTop ?? -1, sim);
      if (ftsIds.has(row.id)) agree = true;
    }
  }
  return {
    vector_top: vectorTop === null ? null : Number(vectorTop.toFixed(4)),
    term_coverage: Number(coverage.toFixed(3)),
    channels_agree: agree,
  };
}

export function isLowConfidence(
  confidence: RecallConfidence,
  resultCount: number,
  modelSufficient?: boolean,
): boolean {
  if (resultCount === 0) return true;
  if (modelSufficient !== undefined) return !modelSufficient;
  if (confidence.term_coverage >= lowConfidenceCoverage()) return false;
  const cosine = lowConfidenceCosine();
  return confidence.vector_top === null || cosine <= 0 || confidence.vector_top < cosine;
}
