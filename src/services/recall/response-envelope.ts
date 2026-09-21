/** Default recall output is bounded to a conservative byte envelope; what did not fit is
 * named, never silently dropped. */
import type { ResultRow } from "../recall.ts";
import { DEFAULT_RECALL_OUTPUT_BYTES } from "./config.ts";

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
