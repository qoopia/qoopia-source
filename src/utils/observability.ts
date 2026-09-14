const METRIC_NAME = /^[a-z][a-z0-9_]{0,99}$/;
const LABEL_NAME = /^[a-z][a-z0-9_]{0,49}$/;
const MAX_LABELS = 8;
const MAX_LABEL_VALUE = 64;

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricPoint {
  name: string;
  labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
}

function normalizedLabels(labels: MetricLabels): MetricLabels {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > MAX_LABELS) throw new Error("metric label count exceeds bounded catalog");
  for (const [name, value] of entries) {
    if (!LABEL_NAME.test(name)) throw new Error(`invalid metric label name: ${name}`);
    if (value.length > MAX_LABEL_VALUE) throw new Error(`metric label value too long: ${name}`);
    if (/^(?:id|workspace|agent|note|session|message|trace|artifact)_?$/i.test(name) || name.endsWith("_id")) {
      throw new Error(`high-cardinality metric label forbidden: ${name}`);
    }
  }
  return Object.fromEntries(entries);
}

/** Bounded-cardinality metrics; identifiers and raw content are refused. */
export class MetricRegistry {
  #points = new Map<string, MetricPoint>();
  constructor(private readonly maxSeries = 1_000) {}

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name: ${name}`);
    if (!Number.isFinite(value)) throw new Error(`invalid metric value for ${name}`);
    const safeLabels = normalizedLabels(labels);
    const key = `${name}\u0000${JSON.stringify(safeLabels)}`;
    let point = this.#points.get(key);
    if (!point) {
      if (this.#points.size >= this.maxSeries) throw new Error("metric series limit exceeded");
      point = { name, labels: safeLabels, count: 0, sum: 0, min: value, max: value };
      this.#points.set(key, point);
    }
    point.count += 1;
    point.sum += value;
    point.min = Math.min(point.min, value);
    point.max = Math.max(point.max, value);
  }

  increment(name: string, labels: MetricLabels = {}): void {
    this.observe(name, 1, labels);
  }

  snapshot(): MetricPoint[] {
    return [...this.#points.values()]
      .map((point) => ({ ...point, labels: { ...point.labels } }))
      .sort((a, b) => a.name.localeCompare(b.name) || JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
  }

  reset(): void {
    this.#points.clear();
  }
}

export const v4Metrics = new MetricRegistry();

function closedLabel(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "other";
}

export function recordRecallMetrics(input: {
  mode: string;
  result: "ok" | "empty" | "error";
  duration_ms: number;
  result_count: number;
}): void {
  const labels = {
    mode: closedLabel(input.mode, ["fts", "semantic", "hybrid"]),
    result: input.result,
  };
  v4Metrics.observe("v4_recall_latency_ms", input.duration_ms, labels);
  v4Metrics.observe("v4_recall_results", input.result_count, labels);
}

export function recordExtractionOutcome(outcome: string, riskClass: string): void {
  v4Metrics.increment("v4_extraction_outcome_total", {
    outcome: closedLabel(outcome, ["accepted", "edited", "rejected", "idempotent"]),
    risk_class: closedLabel(riskClass, ["normal", "conflict", "prompt_injection", "secret"]),
  });
}

export function recordConflict(kind: string): void {
  v4Metrics.increment("v4_conflict_total", {
    kind: closedLabel(kind, ["relation", "extraction", "import", "idempotency", "optimistic_concurrency"]),
  });
}

export function recordLifecycleChange(action: string, result: "success" | "failed"): void {
  v4Metrics.increment("v4_lifecycle_change_total", {
    action: closedLabel(action, ["confirm", "pin", "unpin", "reinforce"]),
    result,
  });
}

export function recordMigrationStatus(status: "applied" | "noop" | "failed"): void {
  v4Metrics.increment("v4_migration_status_total", { status });
}
