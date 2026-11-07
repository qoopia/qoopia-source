import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall, type ResultRow } from "../src/services/recall.ts";
import {
  contentTerms,
  isLowConfidence,
  recallConfidence,
  termCoverage,
} from "../src/services/recall/confidence.ts";

const STOP = new Set(["the", "and", "для", "про"]);
let workspaceId = "";
let agentId = "";

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Recall Low Confidence", slug: "recall-low-confidence" });
  workspaceId = workspace.id;
  agentId = createAgent({ name: "recall-lowconf-agent", workspaceSlug: workspace.slug }).id;
  createNote({
    workspace_id: workspaceId,
    agent_id: agentId,
    type: "knowledge",
    text: "Lowconfprobe bakery freezer keeps cakes at minus eighteen degrees",
  });
});

const ENV_KEYS = ["QOOPIA_RECALL_LOW_CONF_COVERAGE", "QOOPIA_RECALL_LOW_CONF_COSINE"];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function row(id: string, text: string): ResultRow {
  return { id, type: "knowledge", text, metadata: {}, project_id: null, created_at: "", workspace_id: "w", rank: 0, source: "notes" };
}

describe("confidence signals", () => {
  test("content terms drop stop words and stem Russian words", () => {
    expect(contentTerms("the температура для холодильника", STOP)).toEqual(["температур", "холодильник"]);
  });

  test("coverage is the share of terms present in one text", () => {
    expect(termCoverage(["freezer", "cake", "vin"], "Freezer keeps cakes cold")).toBeCloseTo(2 / 3);
    expect(termCoverage([], "anything")).toBe(0);
  });

  test("best of the top results; both channels agree only on a shared id", () => {
    const rows = [row("a", "freezer temperature"), row("b", "unrelated")];
    const sims = new Map([["a", 0.81], ["b", 0.9]]);
    const signal = recallConfidence("freezer temperature norm", rows, sims, new Set(["a"]), STOP);
    expect(signal.vector_top).toBe(0.9);
    expect(signal.term_coverage).toBeCloseTo(0.667, 3);
    expect(signal.channels_agree).toBe(true);
  });

  test("low only when both signals are weak, or nothing came back, or the model said so", () => {
    process.env.QOOPIA_RECALL_LOW_CONF_COVERAGE = "0.5";
    process.env.QOOPIA_RECALL_LOW_CONF_COSINE = "0.85";
    expect(isLowConfidence({ vector_top: 0.8, term_coverage: 0.2, channels_agree: false }, 5)).toBe(true);
    expect(isLowConfidence({ vector_top: 0.9, term_coverage: 0.2, channels_agree: false }, 5)).toBe(false);
    expect(isLowConfidence({ vector_top: 0.8, term_coverage: 0.6, channels_agree: false }, 5)).toBe(false);
    expect(isLowConfidence({ vector_top: null, term_coverage: 0.2, channels_agree: false }, 5)).toBe(true);
    expect(isLowConfidence({ vector_top: 0.99, term_coverage: 1, channels_agree: true }, 0)).toBe(true);
    expect(isLowConfidence({ vector_top: 0.99, term_coverage: 1, channels_agree: true }, 5, false)).toBe(true);
    expect(isLowConfidence({ vector_top: 0.1, term_coverage: 0, channels_agree: false }, 5, true)).toBe(false);
  });

  test("defaults: coverage 0.6, cosine 0.86", () => {
    expect(isLowConfidence({ vector_top: 0.855, term_coverage: 0.5, channels_agree: false }, 5)).toBe(true);
    expect(isLowConfidence({ vector_top: 0.865, term_coverage: 0.5, channels_agree: false }, 5)).toBe(false);
    expect(isLowConfidence({ vector_top: 0.8, term_coverage: 0.6, channels_agree: false }, 5)).toBe(false);
  });
});

describe("recall() response", () => {
  async function call(query: string) {
    return recall({ workspace_id: workspaceId, caller_agent_id: agentId, is_admin: false, query, mode: "fts5", limit: 5 });
  }

  test("a covered question is confident and keeps every existing field", async () => {
    const result = await call("lowconfprobe freezer cakes");
    expect(result.results.length).toBe(1);
    expect(result.low_confidence).toBe(false);
    expect(result.confidence).toEqual({ vector_top: null, term_coverage: 1, channels_agree: false });
    for (const key of ["results", "total_found", "query", "sanitized_query", "mode", "judging", "cost"]) {
      expect(Object.hasOwn(result, key)).toBe(true);
    }
  });

  test("a stray one-word match is flagged, results are still returned", async () => {
    const result = await call("lowconfprobe insurance policy vehicle number");
    expect(result.results.length).toBe(1);
    expect(result.low_confidence).toBe(true);
  });

  test("no results is low confidence", async () => {
    const result = await call("zzqnonexistentterm");
    expect(result.results.length).toBe(0);
    expect(result.low_confidence).toBe(true);
  });
});
