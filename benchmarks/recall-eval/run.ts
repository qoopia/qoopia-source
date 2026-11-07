// Recall eval harness: a golden set of questions scored against recall() on a copy of live data.
//
//   run   — inside a disposable container built from the production image, with QOOPIA_DATA_DIR
//           pointing at a snapshot copy: calls recall() directly (no MCP, no live database) and
//           writes the ranked ids, latency and response size per question.
//   score — anywhere: reads golden.jsonl and one or more run files, writes JSON + markdown.
//
// The golden set holds no note text: question, expected ids, stale ids, category.

import { readFileSync, writeFileSync } from "node:fs";

type Category = "durable" | "current_version" | "log_real" | "negative_extra";

export type GoldenCase = {
  id: string;
  category: Category;
  lang: "ru" | "en";
  query: string;
  /** The current note(s) that answer the question; [] when the memory holds no answer. */
  expected_ids: string[];
  /** Older versions of an expected note (superseded / valid_until set). */
  stale_ids: string[];
  /** Other live notes that also answer the question fully; a hit on them counts. */
  alt_ids: string[];
  note_type: string | null;
  caller_agent: string;
  is_admin: boolean;
  scope: "notes";
  logged_scope?: string;
  logged_backend?: string;
  logged_date?: string;
};

type Mode = "hybrid" | "deep" | "deep_llm" | "entity_pages";

type RunRow = {
  id: string;
  ids: string[];
  returned: number;
  ms: number;
  chars: number;
  mode: string | null;
  rerank: string | null;
  completeness: string | null;
  error: string | null;
  /** Note types of the shown rows, in rank order. */
  types?: string[];
  low_confidence?: boolean | null;
  confidence?: { vector_top: number | null; term_coverage: number; channels_agree: boolean } | null;
};

type RunFile = { mode: Mode; label?: string; started_at: string; workspace_id: string; limit: number; env: Record<string, string>; rows: RunRow[] };

// The workspace the golden set was labelled on; passed in, never committed.
const WORKSPACE = process.env.QOOPIA_EVAL_WORKSPACE ?? "";
const LIMIT = 10;
const CHARS_PER_TOKEN = 3;

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`missing ${name}`);
    return fallback;
  }
  return value;
}

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === name && process.argv[index + 1]) out.push(process.argv[index + 1]!);
  });
  return out;
}

export function loadGolden(path: string): GoldenCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GoldenCase);
}

// ---------- run ----------

const MODE_PARAMS: Record<Mode, Record<string, boolean>> = {
  hybrid: { deep: false },
  deep: { deep: true },
  deep_llm: { deep_llm: true },
  entity_pages: { deep: false },
};

async function runMode(): Promise<void> {
  const mode = arg("--mode") as Mode;
  if (!(mode in MODE_PARAMS)) throw new Error(`unknown --mode ${mode}`);
  if (mode === "entity_pages" && process.env.QOOPIA_ENTITY_PAGES !== "true") {
    throw new Error("entity_pages mode needs QOOPIA_ENTITY_PAGES=true in the environment");
  }
  if (mode !== "entity_pages" && process.env.QOOPIA_ENTITY_PAGES === "true") {
    throw new Error(`${mode} mode runs with QOOPIA_ENTITY_PAGES=false, as production does`);
  }
  if (!WORKSPACE) throw new Error("set QOOPIA_EVAL_WORKSPACE to the workspace id of the snapshot");
  const src = arg("--src", process.env.QOOPIA_EVAL_SRC ?? "/app/src");
  const golden = [arg("--golden"), ...args("--golden-extra")].flatMap(loadGolden);
  const only = process.argv.includes("--limit-cases") ? Number(arg("--limit-cases")) : golden.length;
  const { recall } = (await import(`${src}/services/recall.ts`)) as {
    recall: (p: Record<string, unknown>) => Promise<any>;
  };

  // One unmeasured call loads the embedding model and warms SQLite pages, so p95 reflects steady state.
  await recall({ workspace_id: WORKSPACE, caller_agent_id: golden[0]!.caller_agent, is_admin: true, query: "warm up", limit: LIMIT });

  const rows: RunRow[] = [];
  for (const c of golden.slice(0, only)) {
    const started = performance.now();
    try {
      const r = await recall({
        workspace_id: WORKSPACE,
        caller_agent_id: c.caller_agent,
        is_admin: c.is_admin,
        query: c.query,
        limit: LIMIT,
        scope: c.scope,
        ...MODE_PARAMS[mode],
      });
      const ms = performance.now() - started;
      // The visible list plus what the size bound moved to completeness.omitted_results, in rank order.
      const shown: string[] = (r.results ?? []).map((row: { id: string }) => row.id);
      const omitted: string[] = r.completeness?.omitted_results?.ids ?? [];
      const ids = [...new Set([...shown, ...omitted])].slice(0, LIMIT);
      rows.push({
        id: c.id,
        ids,
        returned: shown.length,
        ms: Math.round(ms * 10) / 10,
        chars: JSON.stringify(r).length,
        mode: r.mode ?? null,
        rerank: r.judging?.attempted ? `${r.judging.backend}:${r.judging.applied ? "applied" : "failed"}` : null,
        completeness: r.completeness?.status ?? null,
        error: null,
        types: (r.results ?? []).map((row: { type: string }) => row.type),
        low_confidence: r.low_confidence ?? null,
        confidence: r.confidence ?? null,
      });
    } catch (error) {
      rows.push({
        id: c.id,
        ids: [],
        returned: 0,
        ms: Math.round((performance.now() - started) * 10) / 10,
        chars: 0,
        mode: null,
        rerank: null,
        completeness: null,
        error: String((error as Error)?.message ?? error).slice(0, 200),
      });
    }
    console.error(`${mode} ${c.id} ${rows.at(-1)!.ms}ms ${rows.at(-1)!.ids.length} ids${rows.at(-1)!.error ? " ERR" : ""}`);
  }

  const envKeys = [
    "QOOPIA_ENTITY_PAGES",
    "QOOPIA_RERANK_DEFAULT_DEEP",
    "QOOPIA_V4_LATEST_ONLY",
    "QOOPIA_V4_LIFECYCLE",
    "QOOPIA_V4_BITEMPORAL",
    "QOOPIA_V4_RELATIONS",
    "QOOPIA_EMBED_PROVIDER",
    "QOOPIA_RECALL_CONTEXT_FACTOR",
    "QOOPIA_RECALL_CONTEXT_SCOPE",
    "QOOPIA_RECALL_CONTEXT_CAP",
    "QOOPIA_RECALL_CONTEXT_WINDOW",
    "QOOPIA_RECALL_LOW_CONF_COVERAGE",
    "QOOPIA_RECALL_LOW_CONF_COSINE",
  ];
  const env = Object.fromEntries(envKeys.map((key) => [key, process.env[key] ?? "(unset)"]));
  env.src = src;
  const label = process.argv.includes("--label") ? arg("--label") : mode;
  const file: RunFile = { mode, label, started_at: new Date().toISOString(), workspace_id: WORKSPACE, limit: LIMIT, env, rows };
  writeFileSync(arg("--out"), JSON.stringify(file, null, 1));
}

// ---------- score ----------

type Metrics = {
  n: number;
  answerable: number;
  hit1: number;
  hit5: number;
  mrr10: number;
  empty: number;
  stale_above_current: number | null;
  stale_cases: number;
  negatives: number;
  negative_empty: number | null;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  chars: number;
  tokens: number;
  /** Share of type=context among the shown top-10 rows. */
  context_share_top10: number | null;
  /** Cases whose top-1 is a type=context note. */
  context_top1: number | null;
  /** low_confidence: share of answerless questions flagged, share of answerable flagged,
   *  and answerable questions with a correct top-1 that were flagged anyway (lost answers). */
  lowconf_negatives: number | null;
  lowconf_answerable: number | null;
  lowconf_lost_hit1: number | null;
  lowconf_lost_hit1_count: number | null;
};

type ScoreCase = { golden: GoldenCase; row: RunRow };

function wanted(c: GoldenCase): Set<string> {
  return new Set([...c.expected_ids, ...c.alt_ids]);
}

export function firstHit(ids: string[], c: GoldenCase): number {
  const want = wanted(c);
  return ids.findIndex((id) => want.has(id));
}

/** A stale version is in the top 10 above the first current answer (or with no current answer at all). */
export function staleAboveCurrent(ids: string[], c: GoldenCase): boolean {
  if (!c.stale_ids.length) return false;
  const stale = new Set(c.stale_ids);
  const firstStale = ids.findIndex((id) => stale.has(id));
  if (firstStale < 0) return false;
  const hit = firstHit(ids, c);
  return hit < 0 || firstStale < hit;
}

async function metricsFor(cases: ScoreCase[]): Promise<Metrics> {
  const { mean, percentile } = await import("../v4/metrics.ts");
  const answerable = cases.filter((x) => x.golden.expected_ids.length > 0);
  const negatives = cases.filter((x) => x.golden.expected_ids.length === 0);
  const staleCases = cases.filter((x) => x.golden.stale_ids.length > 0);
  const ranks = answerable.map((x) => firstHit(x.row.ids, x.golden));
  const ms = cases.filter((x) => !x.row.error).map((x) => x.row.ms);
  const chars = mean(cases.filter((x) => !x.row.error).map((x) => x.row.chars));
  const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    n: cases.length,
    answerable: answerable.length,
    hit1: round(mean(ranks.map((rank) => (rank === 0 ? 1 : 0)))),
    hit5: round(mean(ranks.map((rank) => (rank >= 0 && rank < 5 ? 1 : 0)))),
    mrr10: round(mean(ranks.map((rank) => (rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0)))),
    empty: round(mean(cases.map((x) => (x.row.ids.length === 0 ? 1 : 0)))),
    stale_above_current: staleCases.length
      ? round(mean(staleCases.map((x) => (staleAboveCurrent(x.row.ids, x.golden) ? 1 : 0))))
      : null,
    stale_cases: staleCases.length,
    negatives: negatives.length,
    negative_empty: negatives.length ? round(mean(negatives.map((x) => (x.row.ids.length === 0 ? 1 : 0)))) : null,
    errors: cases.filter((x) => x.row.error).length,
    p50_ms: round(percentile(ms, 0.5), 0),
    p95_ms: round(percentile(ms, 0.95), 0),
    chars: Math.round(chars),
    tokens: Math.round(chars / CHARS_PER_TOKEN),
    ...contextMetrics(cases),
    ...lowConfidenceMetrics(cases, (row) => row.low_confidence ?? null),
  };
}

function contextMetrics(cases: ScoreCase[]) {
  const withTypes = cases.filter((x) => x.row.types);
  const shown = withTypes.flatMap((x) => x.row.types!.slice(0, LIMIT));
  return {
    context_share_top10: shown.length
      ? Math.round((shown.filter((t) => t === "context").length / shown.length) * 1000) / 1000
      : null,
    context_top1: withTypes.length ? withTypes.filter((x) => x.row.types![0] === "context").length : null,
  };
}

/** `flag` returns null when the run has no low_confidence field (code without the change). */
export function lowConfidenceMetrics(cases: ScoreCase[], flag: (row: RunRow) => boolean | null) {
  if (!cases.length || cases.every((x) => flag(x.row) === null)) {
    return { lowconf_negatives: null, lowconf_answerable: null, lowconf_lost_hit1: null, lowconf_lost_hit1_count: null };
  }
  const share = (xs: ScoreCase[]) =>
    xs.length ? Math.round((xs.filter((x) => flag(x.row) === true).length / xs.length) * 1000) / 1000 : null;
  const negatives = cases.filter((x) => x.golden.expected_ids.length === 0);
  const answerable = cases.filter((x) => x.golden.expected_ids.length > 0);
  const hit1 = answerable.filter((x) => firstHit(x.row.ids, x.golden) === 0);
  return {
    lowconf_negatives: share(negatives),
    lowconf_answerable: share(answerable),
    lowconf_lost_hit1: share(hit1),
    lowconf_lost_hit1_count: hit1.filter((x) => flag(x.row) === true).length,
  };
}

const COVERAGE_GRID = [0.25, 0.34, 0.4, 0.5, 0.6, 0.67];
const COSINE_GRID = [0, 0.8, 0.82, 0.84, 0.85, 0.86, 0.88];

/** Same rule as isLowConfidence() in src/services/recall/confidence.ts, replayed on stored signals. */
function replayFlag(row: RunRow, coverage: number, cosine: number): boolean | null {
  if (row.low_confidence == null || !row.confidence) return null;
  if (row.ids.length === 0) return true;
  if (row.confidence.term_coverage >= coverage) return false;
  return row.confidence.vector_top === null || cosine <= 0 || row.confidence.vector_top < cosine;
}

/** Threshold grid: tune on `tune` (synthetic + extra negatives), report `holdout` (log_real) untouched. */
function lowConfidenceGrid(tune: ScoreCase[], holdout: ScoreCase[]) {
  const out: Array<Record<string, number | null>> = [];
  for (const coverage of COVERAGE_GRID) {
    for (const cosine of COSINE_GRID) {
      const flag = (row: RunRow) => replayFlag(row, coverage, cosine);
      const t = lowConfidenceMetrics(tune, flag);
      const h = lowConfidenceMetrics(holdout, flag);
      out.push({
        coverage, cosine,
        tune_negatives: t.lowconf_negatives, tune_answerable: t.lowconf_answerable, tune_lost_hit1: t.lowconf_lost_hit1,
        holdout_negatives: h.lowconf_negatives, holdout_answerable: h.lowconf_answerable, holdout_lost_hit1: h.lowconf_lost_hit1,
      });
    }
  }
  return out;
}

const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);

function table(rows: Array<{ label: string; m: Metrics }>): string {
  const head =
    "| Режим | n | hit@1 | hit@5 | MRR@10 | пустых | устар. выше актуальной | p50, мс | p95, мс | символов | ~токенов | ошибок |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    ({ label, m }) =>
      `| ${label} | ${m.n} (${m.answerable} с ответом) | ${pct(m.hit1)} | ${pct(m.hit5)} | ${m.mrr10.toFixed(3)} | ${pct(m.empty)} | ${
        m.stale_above_current === null ? "—" : `${pct(m.stale_above_current)} из ${m.stale_cases}`
      } | ${m.p50_ms} | ${m.p95_ms} | ${m.chars} | ${m.tokens} | ${m.errors} |`,
  );
  return [head, ...body].join("\n");
}

function extraTable(rows: Array<{ label: string; m: Metrics }>): string {
  const head =
    "| Режим | доля context в топ-10 | context на 1-м месте | без ответа с флагом | с ответом с флагом | верных top-1 с флагом (потеряно) |\n" +
    "|---|---|---|---|---|---|";
  const body = rows.map(
    ({ label, m }) =>
      `| ${label} | ${pct(m.context_share_top10)} | ${m.context_top1 ?? "—"} | ${pct(m.lowconf_negatives)} | ${pct(m.lowconf_answerable)} | ${
        m.lowconf_lost_hit1 === null ? "—" : `${pct(m.lowconf_lost_hit1)} (${m.lowconf_lost_hit1_count})`
      } |`,
  );
  return [head, ...body].join("\n");
}

async function score(): Promise<void> {
  const golden = [arg("--golden"), ...args("--golden-extra")].flatMap(loadGolden);
  const byId = new Map(golden.map((c) => [c.id, c]));
  const runs = args("--raw").map((path) => JSON.parse(readFileSync(path, "utf8")) as RunFile);
  // synthetic = durable + current_version (written from the notes); log_real = real queries from recall_log;
  // negative_extra = extra answerless questions used only for the low_confidence flag.
  const categories: Array<Category | "all" | "synthetic"> = ["all", "synthetic", "durable", "current_version", "log_real", "negative_extra"];
  const inCategory = (c: GoldenCase, category: string) =>
    category === "all"
      ? c.category !== "negative_extra"
      : category === "synthetic"
        ? c.category === "durable" || c.category === "current_version"
        : c.category === category;
  const result: Record<string, Record<string, Metrics>> = {};
  const perCase: Record<string, Record<string, Record<string, unknown>>> = {};
  const grids: Record<string, ReturnType<typeof lowConfidenceGrid>> = {};

  for (const run of runs) {
    const cases: ScoreCase[] = run.rows
      .filter((row) => byId.has(row.id))
      .map((row) => ({ golden: byId.get(row.id)!, row }));
    const key = run.label ?? run.mode;
    result[key] = {};
    for (const category of categories) {
      const subset = cases.filter((x) => inCategory(x.golden, category));
      if (subset.length) result[key]![category] = await metricsFor(subset);
    }
    if (cases.some((x) => x.row.confidence)) {
      grids[key] = lowConfidenceGrid(
        cases.filter((x) => x.golden.category !== "log_real"),
        cases.filter((x) => x.golden.category === "log_real"),
      );
    }
    for (const x of cases) {
      perCase[x.golden.id] ??= {};
      perCase[x.golden.id]![key] = {
        rank: firstHit(x.row.ids, x.golden),
        stale_above: staleAboveCurrent(x.row.ids, x.golden),
        ids: x.row.ids.slice(0, 5),
        ...(x.row.low_confidence == null ? {} : { low_confidence: x.row.low_confidence, confidence: x.row.confidence }),
      };
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    golden_cases: golden.length,
    limit: LIMIT,
    chars_per_token: CHARS_PER_TOKEN,
    runs: runs.map((run) => ({ label: run.label ?? run.mode, mode: run.mode, started_at: run.started_at, env: run.env })),
    metrics: result,
    low_confidence_grid: grids,
    per_case: perCase,
  };
  writeFileSync(arg("--out-json"), JSON.stringify(out, null, 1));

  const sections = categories.map((category) => {
    const rows = runs
      .map((run) => run.label ?? run.mode)
      .filter((key) => result[key]?.[category])
      .map((key) => ({ label: key, m: result[key]![category]! }));
    const title = category === "all" ? "Все вопросы" : category === "synthetic" ? "Синтетика (durable + current_version)" : category;
    return `### ${title}\n\n${table(rows)}\n\n${extraTable(rows)}`;
  });
  const md = `<!-- generated by benchmarks/recall-eval/run.ts score -->\n\n${sections.join("\n\n")}\n`;
  writeFileSync(arg("--out-md"), md);
  console.log(md);
}

// ---------- main ----------

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "run") await runMode();
  else if (command === "score") await score();
  else {
    console.error("usage: run.ts run --mode hybrid|deep|deep_llm|entity_pages --golden FILE --out FILE [--src DIR]");
    console.error("       run.ts score --golden FILE --raw FILE [--raw FILE ...] --out-json FILE --out-md FILE");
    process.exit(2);
  }
}
