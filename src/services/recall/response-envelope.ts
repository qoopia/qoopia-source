/** Recall output of every scope is bounded to a conservative byte envelope; what did not
 * fit is named, never silently dropped. */
import type { ResultRow } from "../recall.ts";
import { DEFAULT_RECALL_OUTPUT_BYTES } from "./config.ts";

interface RecallCompleteness {
  status: "complete" | "partial";
  reason?: "default_recall_output_budget";
  max_tokens?: 4_000;
  enforcement?: "conservative_utf8_bytes";
  max_serialized_bytes?: 4_000;
  /** Present when every excerpt points at note_get; mixed scopes rely on each row's request. */
  full_body_tool?: "note_get";
  omitted_fields?: string[];
  omitted_results?: { count: number; ids: string[] };
}

type BoundedRecall<T> = Omit<T, "results"> & {
  results: ResultRow[];
  completeness: RecallCompleteness;
};

/** Where an excerpt's full body lives, by source (F-107). */
export type FullBodyRequest =
  | { tool: "note_get"; arguments: { id: string } }
  | { tool: "entity_get"; arguments: { id: string } }
  // session_expand returns only the caller's own messages; an admin's view of another agent's
  // message has no full-body tool (ponytail: add an admin read path if that is ever needed).
  | { tool: "session_expand"; arguments: { start_id: number; end_id: number; session_id?: string } };

function fullBodyRequest(row: ResultRow): FullBodyRequest | undefined {
  if (row.source === "sessions") {
    const id = Number(row.id);
    const sessionId = (row.metadata as { session_id?: unknown } | null)?.session_id;
    return { tool: "session_expand", arguments: { start_id: id, end_id: id, ...(typeof sessionId === "string" ? { session_id: sessionId } : {}) } };
  }
  if (row.source === "entity") return { tool: "entity_get", arguments: { id: row.id } };
  // Activity summaries are short and activity_list cannot select one row.
  if (row.source === "activity") return undefined;
  return { tool: "note_get", arguments: { id: row.id } };
}

/** A kept row's minimum useful excerpt; rows beyond what fits at this size are omitted by id. */
const MIN_EXCERPT_CHARACTERS = 120;

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function boundDefaultRecall<T extends { results: ResultRow[] }>(response: T): BoundedRecall<T> {
  const complete = {
    ...response,
    results: response.results.map((row) => ({ ...row, completeness: "complete" as const })),
    completeness: { status: "complete" as const },
  };
  if (serializedBytes(complete) <= DEFAULT_RECALL_OUTPUT_BYTES) return complete;

  const originals = response.results.map((row) => row.text);
  const results = response.results.map((row) => {
    const { metadata: _metadata, ...rest } = row;
    const request = fullBodyRequest(row);
    return {
      ...rest,
      completeness: "excerpt" as const,
      omitted_fields: ["metadata"],
      ...(request ? { full_body_request: request } : {}),
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
      ...(results.every((row) => row.full_body_request?.tool === "note_get") ? { full_body_tool: "note_get" } : {}),
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
  // trace_id is never dropped (F-104): it is the only handle to a persisted trace. Results go first.
  for (const field of ["sanitized_query", "query", "cost", "effective_options", "pipeline_version"]) {
    if (serializedBytes(partial) <= DEFAULT_RECALL_OUTPUT_BYTES) break;
    if (Object.hasOwn(partial, field)) {
      delete mutablePartial[field];
      partial.completeness.omitted_fields!.push(field);
    }
  }
  // Rows share the text budget (F-305): drop trailing rows until each kept row fits a useful
  // excerpt, give all of them one equal cap, then hand what is left to rows in order.
  const characters = originals.map((text) => Array.from(text));
  const fill = (cap: number) => results.forEach((row, i) => { row.text = characters[i]!.slice(0, cap).join(""); });
  const omitLast = () => {
    const omitted = results.pop()!;
    partial.completeness.omitted_results!.ids.unshift(omitted.id);
    partial.completeness.omitted_results!.count++;
  };
  fill(MIN_EXCERPT_CHARACTERS);
  while (serializedBytes(partial) > DEFAULT_RECALL_OUTPUT_BYTES && results.length > 1) omitLast();
  fill(0);
  while (serializedBytes(partial) > DEFAULT_RECALL_OUTPUT_BYTES && results.length > 0) omitLast();

  const fits = () => serializedBytes(partial) <= DEFAULT_RECALL_OUTPUT_BYTES;
  let low = 0;
  let high = Math.max(0, ...characters.slice(0, results.length).map((text) => text.length));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    fill(middle);
    if (fits()) low = middle;
    else high = middle - 1;
  }
  fill(low);
  for (let i = 0; i < results.length; i++) {
    let rowLow = Math.min(low, characters[i]!.length);
    let rowHigh = characters[i]!.length;
    while (rowLow < rowHigh) {
      const middle = Math.ceil((rowLow + rowHigh) / 2);
      results[i]!.text = characters[i]!.slice(0, middle).join("");
      if (fits()) rowLow = middle;
      else rowHigh = middle - 1;
    }
    results[i]!.text = characters[i]!.slice(0, rowLow).join("");
    if (rowLow === characters[i]!.length) {
      results[i]!.omitted_fields = results[i]!.omitted_fields.filter((field) => field !== "text");
    }
  }
  return partial;
}
