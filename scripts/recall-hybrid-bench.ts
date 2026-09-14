#!/usr/bin/env bun
/**
 * Hybrid recall benchmark — reruns the 20-query baseline from
 * docs/recall-baseline.txt with mode='hybrid' and compares the hit
 * counts + top-3 row IDs side-by-side.
 *
 * Output format mirrors docs/recall-baseline.txt so a diff between
 * the two files tells the whole story.
 *
 * Usage:
 *   bun run scripts/recall-hybrid-bench.ts                          # default workspace = alan
 *   bun run scripts/recall-hybrid-bench.ts --workspace=<ws_id>
 *   bun run scripts/recall-hybrid-bench.ts --out=docs/recall-hybrid-bench.txt
 *
 * Prereqs: Ollama up (brew services start ollama) AND embeddings
 * backfilled for the workspace (scripts/backfill-embeddings.ts).
 */
import { assertSchemaCurrent } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { recall } from "../src/services/recall.ts";
import {
  embeddingCoverage,
} from "../src/services/embedding-store.ts";
import { isEmbedderHealthy } from "../src/services/embeddings.ts";
import { logger } from "../src/utils/logger.ts";
import fs from "node:fs";

// Same 20 queries as docs/recall-baseline.txt.
const QUERIES: Array<{ kind: "multi" | "mono"; q: string }> = [
  { kind: "multi", q: "сломал OR failover OR overload" },
  { kind: "multi", q: "context loss cascade" },
  { kind: "multi", q: "aidan amnesia memory loss" },
  { kind: "multi", q: "gmail watcher token refresh" },
  { kind: "multi", q: "crash launchctl kickstart" },
  { kind: "multi", q: "recall AND semantics multi-term" },
  { kind: "multi", q: "note_create body text bug" },
  { kind: "multi", q: "sanitizer regression OR fix" },
  { kind: "multi", q: "качество памяти агентов" },
  { kind: "multi", q: "embeddings hybrid retrieval" },
  { kind: "multi", q: "руфло dactyl benchmark" },
  // Mono-term — the morphology/synonym cases Step 2 should fix.
  { kind: "mono", q: "крашнулся" },
  { kind: "mono", q: "упал" },
  { kind: "mono", q: "лёг" },
  { kind: "mono", q: "инцидент" },
  { kind: "mono", q: "галлюцинация" },
  { kind: "mono", q: "починили" },
  { kind: "mono", q: "сломалась" },
  { kind: "mono", q: "postmortem" },
  { kind: "mono", q: "инфраструктура" },
];

interface Args {
  workspace_id: string | null;
  out: string | null;
}

function parseArgs(): Args {
  const a: Args = { workspace_id: null, out: null };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace=")) a.workspace_id = arg.slice(12);
    else if (arg.startsWith("--out=")) a.out = arg.slice(6);
  }
  return a;
}

function resolveWorkspaceId(arg: string | null): string {
  if (arg) return arg;
  // Default: the workspace named 'alan' (the steward / dogfooding ws).
  const row = db
    .prepare(`SELECT id FROM workspaces WHERE slug = 'alan' OR name = 'alan' LIMIT 1`)
    .get() as { id: string } | undefined;
  if (!row) {
    throw new Error(
      "No workspace 'alan' found. Pass --workspace=<id> explicitly.",
    );
  }
  return row.id;
}

function resolveAgentId(workspace_id: string): string {
  // Use the steward agent so the boundary filter doesn't drop private
  // notes from the bench (we want apples-to-apples vs baseline.txt).
  const row = db
    .prepare(
      `SELECT id FROM agents WHERE workspace_id = ? AND active = 1
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(workspace_id) as { id: string } | undefined;
  if (!row) throw new Error(`No agent in workspace ${workspace_id}`);
  return row.id;
}

async function main() {
  const args = parseArgs();
  assertSchemaCurrent("recall hybrid benchmark");

  const healthy = await isEmbedderHealthy();
  if (!healthy) {
    logger.error("Ollama unreachable. Start: brew services start ollama");
    process.exit(1);
  }

  const workspace_id = resolveWorkspaceId(args.workspace_id);
  const caller_agent_id = resolveAgentId(workspace_id);
  const coverage = embeddingCoverage(workspace_id);
  logger.info(
    `bench: ws=${workspace_id} coverage=${coverage.embedded}/${coverage.total_notes} (${coverage.ratio * 100}%) model=${coverage.model}`,
  );
  if (coverage.ratio < 0.9) {
    logger.warn(
      `coverage <90% — run scripts/backfill-embeddings.ts first for a fair comparison`,
    );
  }

  const lines: string[] = [];
  lines.push("HYBRID RECALL BENCH — bge-m3 + RRF k=60");
  lines.push("=========================================");
  lines.push("");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Branch: feat/hybrid-recall`);
  lines.push(`Mode: hybrid (FTS5 + bge-m3 fused via RRF k=60)`);
  lines.push(`Workspace: ${workspace_id}`);
  lines.push(
    `Embedding coverage: ${coverage.embedded}/${coverage.total_notes} (${(coverage.ratio * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("Side-by-side vs docs/recall-baseline.txt (FTS5-only).");
  lines.push("");
  lines.push("===HYBRID-HITS===");
  lines.push(
    "n  | kind  | raw_query                          | fts_only_hits | hybrid_hits | mode",
  );
  lines.push(
    "---+-------+------------------------------------+---------------+-------------+------",
  );

  interface RunRow {
    n: number;
    q: string;
    kind: string;
    ftsOnly: number;
    hybrid: number;
    hybridMode: string;
    top3Hybrid: Array<{ id: string; type: string; text: string }>;
  }
  const runs: RunRow[] = [];

  for (let i = 0; i < QUERIES.length; i++) {
    const { kind, q } = QUERIES[i]!;
    const ftsOnly = await recall({
      workspace_id,
      caller_agent_id,
      is_admin: true,
      query: q,
      scope: "notes",
      limit: 50,
      mode: "fts5",
    });
    const hybrid = await recall({
      workspace_id,
      caller_agent_id,
      is_admin: true,
      query: q,
      scope: "notes",
      limit: 50,
      mode: "hybrid",
    });
    runs.push({
      n: i + 1,
      q,
      kind,
      ftsOnly: ftsOnly.results.length,
      hybrid: hybrid.results.length,
      hybridMode: String(hybrid.mode),
      top3Hybrid: hybrid.results.slice(0, 3).map((r) => ({
        id: r.id,
        type: r.type,
        text: r.text.slice(0, 80),
      })),
    });
    const padQ = q.padEnd(34).slice(0, 34);
    lines.push(
      `${String(i + 1).padStart(2)} | ${kind.padEnd(5)} | ${padQ} | ${String(ftsOnly.results.length).padStart(13)} | ${String(hybrid.results.length).padStart(11)} | ${hybrid.mode}`,
    );
  }

  lines.push("");
  lines.push("===HYBRID-TOP3-PER-QUERY===");
  for (const r of runs) {
    lines.push("");
    lines.push(`n=${r.n}  q="${r.q}"  hits=${r.hybrid}  mode=${r.hybridMode}`);
    if (r.top3Hybrid.length === 0) {
      lines.push("  (no hits)");
    } else {
      for (let i = 0; i < r.top3Hybrid.length; i++) {
        const t = r.top3Hybrid[i]!;
        lines.push(`  ${i + 1}. ${t.id}  ${t.type.padEnd(10)} ${t.text}`);
      }
    }
  }

  // Headline counters.
  const monoZeroBefore = runs.filter(
    (r) => r.kind === "mono" && r.ftsOnly === 0,
  ).length;
  const monoZeroAfter = runs.filter(
    (r) => r.kind === "mono" && r.hybrid === 0,
  ).length;
  const monoRescued = monoZeroBefore - monoZeroAfter;
  const multiTotalBefore = runs
    .filter((r) => r.kind === "multi")
    .reduce((s, r) => s + r.ftsOnly, 0);
  const multiTotalAfter = runs
    .filter((r) => r.kind === "multi")
    .reduce((s, r) => s + r.hybrid, 0);

  lines.push("");
  lines.push("===HEADLINE===");
  lines.push(
    `Mono-term zero-hits: ${monoZeroBefore} (FTS5) → ${monoZeroAfter} (hybrid) — rescued ${monoRescued}/${monoZeroBefore}`,
  );
  lines.push(
    `Multi-term total hits: ${multiTotalBefore} (FTS5) → ${multiTotalAfter} (hybrid)`,
  );
  lines.push("");

  const out = lines.join("\n") + "\n";
  if (args.out) {
    fs.writeFileSync(args.out, out);
    logger.info(`wrote ${args.out}`);
  } else {
    console.log(out);
  }
}

main().catch((e) => {
  logger.error(`bench crashed: ${e?.message || String(e)}`);
  process.exit(1);
});
