import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../../src/db/migrate.ts";
import { createWorkspace } from "../../src/admin/workspaces.ts";
import { createAgent } from "../../src/admin/agents.ts";
import { createNote } from "../../src/services/notes.ts";
import { recall, recallBaseline } from "../../src/services/recall.ts";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

const modes = option("--modes", "baseline,flags-off,flags-on").split(",");
const scales = option("--scales", "1,10").split(",").map(Number);
const runs = Math.max(1, Number(option("--runs", "3")));
const output = option("--json", "artifacts/v4/evidence/P04/recall-smoke.json");

runMigrations();
const report: Record<string, unknown> = {
  format: "qoopia-v4-recall-smoke/1",
  generated_at: new Date().toISOString(),
  network: "offline",
  modes,
  scales,
  runs,
  cases: [] as unknown[],
};

for (const scale of scales) {
  const suffix = `${process.pid}-${scale}`;
  const ws = createWorkspace({ name: `P04 bench ${suffix}`, slug: `p04-bench-${suffix}` });
  const agent = createAgent({ name: `p04-bench-agent-${suffix}`, workspaceSlug: ws.slug });
  const marker = `p04bench${suffix.replace(/[^a-zA-Z0-9]/g, "")}`;
  for (let index = 0; index < 50 * scale; index++) {
    createNote({
      workspace_id: ws.id,
      agent_id: agent.id,
      text: index % 10 === 0
        ? `${marker} relevant russian память benchmark row ${index}`
        : `background deterministic corpus row ${scale}-${index}`,
      type: "memory",
    });
  }
  for (const mode of modes) {
    delete process.env.QOOPIA_V4_RELATIONS;
    delete process.env.QOOPIA_V4_LATEST_ONLY;
    delete process.env.QOOPIA_V4_RECALL_EXPLAIN;
    delete process.env.QOOPIA_V4_LIFECYCLE;
    if (mode === "flags-on") {
      process.env.QOOPIA_V4_RECALL_EXPLAIN = "true";
      process.env.QOOPIA_V4_LIFECYCLE = "true";
    }
    const latencies: number[] = [];
    let lastIds: string[] = [];
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      const params = {
        workspace_id: ws.id,
        caller_agent_id: agent.id,
        is_admin: false,
        query: marker,
        mode: "fts5" as const,
        scope: "notes" as const,
        limit: 5,
      };
      const response = mode === "baseline"
        ? await recallBaseline(params)
        : mode === "flags-on"
          ? await recall({ ...params, explain: true, lifecycle: true })
          : await recall(params);
      latencies.push(performance.now() - started);
      lastIds = response.results.map((row) => row.id);
    }
    (report.cases as unknown[]).push({
      scale,
      mode,
      result_count: lastIds.length,
      result_ids_hash_input_count: lastIds.length,
      p50_ms: Number(percentile(latencies, 0.5).toFixed(3)),
      p95_ms: Number(percentile(latencies, 0.95).toFixed(3)),
      p99_ms: Number(percentile(latencies, 0.99).toFixed(3)),
    });
  }
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, cases: (report.cases as unknown[]).length }));
