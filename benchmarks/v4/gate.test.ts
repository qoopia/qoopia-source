import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// F-308: synthetic qualification reports drive the real gate script.
const gatePath = join(import.meta.dir, "gate.ts");
const budgetsPath = join(import.meta.dir, "../../docs/v4/performance-budgets.json");
const budgets = JSON.parse(readFileSync(budgetsPath, "utf8"));

function variant(p50: number, p95: number, p99: number) {
  return {
    name: "fixture", result_signature_sha256: "same",
    quality: { exact_lexical_recall_at_5: 1, semantic_paraphrase_recall_at_5: 1, mixed_ru_en_recall_at_5: 1, stale_surfacing: 0, leakage: 0 },
    latency_ms: { p50, p95, p99 },
    token_efficiency: { context_tokens_per_query: 10, answer_accuracy: 1, top_k: 5 },
  };
}

function report(candidateName: string, candidate = variant(1, 2, 3), baseline = variant(1, 2, 3)) {
  return {
    format: "qoopia-v4-qualification-report/1",
    corpus: { sha256: "corpus", version: "v", seed: 400 },
    comparison: { baseline: "v3", candidate: candidateName, runs: 3 },
    extraction: { false_auto_writes: 0, acceptance_rate: 0.5, rejection_rate: 0.5, pass: true },
    qualification_coverage: ["extraction", "agentcomm", "fallback", "security"].map((category) => ({ category, test: "fixture" })),
    scale_reports: [{ scale: 1, baseline, candidate, flags_off_bit_identical: true, fallback: { pass: true } }],
  };
}

function gate(off: object, on = report("v4-flags-on"), budgetOverride?: object) {
  const dir = mkdtempSync(join(tmpdir(), "qoopia-v4-gate-"));
  try {
    writeFileSync(join(dir, "off.json"), JSON.stringify(off));
    writeFileSync(join(dir, "on.json"), JSON.stringify(on));
    const budgetFile = join(dir, "budgets.json.txt");
    writeFileSync(budgetFile, JSON.stringify(budgetOverride ?? budgets));
    const run = spawnSync(process.execPath, [gatePath, "--budgets", budgetFile, "--reports", dir], { encoding: "utf8" });
    return { status: run.status, output: run.stdout + run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a passing flags-off/flags-on pair passes the gate", () => {
  expect(gate(report("v4-flags-off")).status).toBe(0);
});

test("the flags-off (default) path is held to the default recall budgets", () => {
  const p95 = budgets.latency_ms.default_recall_p95_max + 1;
  const result = gate(report("v4-flags-off", variant(1, p95, p95)));
  expect(result.status).toBe(1);
  expect(result.output).toContain("flags-off p95 above budget");
});

test("flags-off may be at most 10 percent slower than V3 at the median, above a 1 ms noise floor", () => {
  expect(gate(report("v4-flags-off", variant(22, 30, 40), variant(20, 30, 40))).status).toBe(0);
  const slow = gate(report("v4-flags-off", variant(22.5, 30, 40), variant(20, 30, 40)));
  expect(slow.status).toBe(1);
  expect(slow.output).toContain("flags-off p50 regressed");
  // Sub-millisecond medians differ by scheduler noise; the floor keeps that from failing CI.
  expect(gate(report("v4-flags-off", variant(1.2, 2, 3), variant(0.3, 2, 3))).status).toBe(0);
});

test("every declared latency budget is either gated or explicitly marked not gated", () => {
  const extra = { ...budgets, latency_ms: { ...budgets.latency_ms, new_unmeasured_p95_max: 10 } };
  const result = gate(report("v4-flags-off"), report("v4-flags-on"), extra);
  expect(result.status).toBe(1);
  expect(result.output).toContain("new_unmeasured_p95_max");
});
