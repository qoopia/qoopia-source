import fs from "node:fs";
import path from "node:path";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export interface RuntimeAcceptanceReport {
  ring: number;
  release_sha: string;
  generated_at: string;
  production_actions: false;
  live_agent_resolution: { source: "canonical_entity_search"; count: number; resolved_at: string };
  evidence: { native_codex: "pending"; native_claude: "pending"; mako_telegram: "pending"; agentcomm_e2e: "pending" };
  status: "offline_harness_ready";
}

export function buildRuntimeAcceptanceReport(input: {
  ring: number;
  release_sha: string;
  live_agent_manifest: Record<string, unknown>;
  now?: Date;
}): RuntimeAcceptanceReport {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.ring) || input.ring < 0 || input.ring > 6) throw new Error("ring must be an integer from 0 through 6");
  if (!/^[0-9a-f]{40}$/.test(input.release_sha)) throw new Error("exact 40-character release SHA is required");
  const manifest = input.live_agent_manifest;
  if (manifest.source !== "canonical_entity_search" || !Array.isArray(manifest.agents) ||
      typeof manifest.resolved_at !== "string" || manifest.agents.length === 0) {
    throw new Error("runtime acceptance requires a current canonical entity_search agent manifest");
  }
  const resolvedAt = new Date(manifest.resolved_at as string);
  const age = now.getTime() - resolvedAt.getTime();
  if (!Number.isFinite(resolvedAt.getTime()) || age < 0 || age > 15 * 60_000) {
    throw new Error("canonical entity_search agent manifest is stale or invalid");
  }
  for (const agent of manifest.agents as Array<Record<string, unknown>>) {
    if (typeof agent.id !== "string" || !agent.id || typeof agent.slug !== "string" || !agent.slug) {
      throw new Error("live agent manifest must contain opaque IDs and slugs");
    }
  }
  return {
    ring: input.ring,
    release_sha: input.release_sha,
    generated_at: now.toISOString(),
    production_actions: false,
    live_agent_resolution: { source: "canonical_entity_search", count: manifest.agents.length, resolved_at: manifest.resolved_at as string },
    evidence: { native_codex: "pending", native_claude: "pending", mako_telegram: "pending", agentcomm_e2e: "pending" },
    status: "offline_harness_ready",
  };
}

export function runRuntimeAcceptanceCli(): void {
  const ring = arg("--ring");
  const releaseSha = arg("--release-sha");
  const manifestPath = arg("--live-agent-manifest");
  const reportPath = arg("--report");
  if (ring === undefined || !releaseSha || !manifestPath || !reportPath) {
    throw new Error("usage: v4-runtime-acceptance --ring N --release-sha SHA --live-agent-manifest JSON --report JSON");
  }
  const report = buildRuntimeAcceptanceReport({
    ring: Number(ring),
    release_sha: releaseSha,
    live_agent_manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>,
  });
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) runRuntimeAcceptanceCli();
