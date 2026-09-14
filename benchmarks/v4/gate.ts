import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string {
  const at = process.argv.indexOf(name);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`${name} is required`);
  return process.argv[at + 1]!;
}

type Variant = {
  name: string;
  result_signature_sha256: string;
  quality: {
    exact_lexical_recall_at_5: number;
    semantic_paraphrase_recall_at_5: number;
    mixed_ru_en_recall_at_5: number;
    stale_surfacing: number;
    leakage: number;
  };
  latency_ms: { p50: number; p95: number; p99: number };
  token_efficiency: { context_tokens_per_query: number; answer_accuracy: number; top_k: number };
};

type Report = {
  format: string;
  corpus: { sha256: string; version: string; seed: number };
  comparison: { baseline: string; candidate: string; runs: number };
  extraction: { false_auto_writes: number; acceptance_rate: number; rejection_rate: number; pass: boolean };
  qualification_coverage: Array<{ category: string; test: string }>;
  scale_reports: Array<{
    scale: number;
    baseline: Variant;
    candidate: Variant;
    flags_off_bit_identical: boolean;
    fallback: { pass: boolean };
  }>;
};

const budgetPath = arg("--budgets");
const reportsDir = arg("--reports");
const budgets = JSON.parse(readFileSync(budgetPath, "utf8")) as {
  latency_ms: Record<string, number>;
  quality: Record<string, number>;
};
const reports = readdirSync(reportsDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(reportsDir, name), "utf8")) as Report)
  .filter((report) => report.format === "qoopia-v4-qualification-report/1");

const failures: string[] = [];
const requireGate = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
const byCandidate = new Map(reports.map((report) => [report.comparison.candidate, report]));
const off = byCandidate.get("v4-flags-off");
const on = byCandidate.get("v4-flags-on");
requireGate(!!off, "missing v4-flags-off report");
requireGate(!!on, "missing v4-flags-on report");

if (off && on) {
  requireGate(off.corpus.sha256 === on.corpus.sha256, "off/on corpus hashes differ");
  requireGate(off.corpus.version === on.corpus.version && off.corpus.seed === 400, "corpus version/seed mismatch");
  requireGate(off.comparison.runs >= 3 && on.comparison.runs >= 3, "at least three measured runs are required");
  const categories = new Set(on.qualification_coverage.map((item) => item.category));
  for (const category of ["extraction", "agentcomm", "fallback", "security"]) {
    requireGate(categories.has(category), `qualification coverage missing ${category}`);
  }
  requireGate(off.extraction.false_auto_writes === 0 && on.extraction.false_auto_writes === 0, "extraction false auto-write must be zero");
  requireGate(off.extraction.pass && on.extraction.pass, "extraction accept/reject qualification failed");
  requireGate(off.extraction.acceptance_rate === 0.5 && on.extraction.rejection_rate === 0.5, "extraction acceptance/rejection metrics drifted");

  for (const scale of off.scale_reports) {
    requireGate(scale.flags_off_bit_identical, `scale ${scale.scale}: flags OFF result IDs differ from V3`);
    requireGate(scale.baseline.result_signature_sha256 === scale.candidate.result_signature_sha256, `scale ${scale.scale}: flags OFF signature mismatch`);
    requireGate(scale.fallback.pass, `scale ${scale.scale}: unavailable embedder fallback failed`);
  }
  for (const scale of on.scale_reports) {
    const quality = scale.candidate.quality;
    const latency = scale.candidate.latency_ms;
    requireGate(quality.exact_lexical_recall_at_5 >= budgets.quality.exact_lexical_recall_at_5_min!, `scale ${scale.scale}: lexical Recall@5 below budget`);
    requireGate(quality.semantic_paraphrase_recall_at_5 >= budgets.quality.semantic_paraphrase_recall_at_5_min!, `scale ${scale.scale}: semantic Recall@5 below budget`);
    requireGate(quality.mixed_ru_en_recall_at_5 >= budgets.quality.mixed_ru_en_recall_at_5_min!, `scale ${scale.scale}: mixed Recall@5 below budget`);
    requireGate(quality.stale_surfacing <= budgets.quality.latest_only_stale_surfacing_max!, `scale ${scale.scale}: stale surfacing above budget`);
    requireGate(quality.leakage <= budgets.quality.workspace_private_secret_leakage_max!, `scale ${scale.scale}: leakage is nonzero`);
    requireGate(latency.p50 <= budgets.latency_ms.default_recall_p50_max!, `scale ${scale.scale}: p50 above budget`);
    requireGate(latency.p95 <= budgets.latency_ms.lifecycle_on_recall_p95_max!, `scale ${scale.scale}: lifecycle p95 above budget`);
    requireGate(latency.p99 <= budgets.latency_ms.default_recall_p99_max!, `scale ${scale.scale}: p99 above budget`);
    requireGate(scale.candidate.token_efficiency.top_k === 5, `scale ${scale.scale}: top-k drifted`);
    requireGate(scale.candidate.token_efficiency.answer_accuracy >= 0.9, `scale ${scale.scale}: answer accuracy below 0.9`);
    requireGate(scale.fallback.pass, `scale ${scale.scale}: unavailable embedder fallback failed`);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  pass: true,
  reports: reports.length,
  corpus_sha256: on!.corpus.sha256,
  scales: on!.scale_reports.map((item) => item.scale),
  gates: ["flags-off-identical", "quality", "latency", "leakage", "fallback", "token-budget", "extraction-no-auto-write"],
}));
