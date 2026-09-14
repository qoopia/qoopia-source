import fs from "node:fs";
import path from "node:path";
import { openReadonlyDatabase } from "../src/db/sqlite.ts";
import { createExportPlan, materializeExportBundle } from "../src/services/export.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runExportCli(): void {
  const dbPath = arg("--db");
  const output = arg("--output");
  const reportPath = arg("--manifest");
  const signingKeyPath = arg("--signing-key") ?? process.env.QOOPIA_V4_EXPORT_SIGNING_KEY_FILE;
  if (!dbPath || !output || !reportPath || !signingKeyPath) {
    throw new Error("usage: v4-export --db DB --output DIR --manifest REPORT --signing-key PEM");
  }
  const database = openReadonlyDatabase(dbPath);
  try {
    const workspaces = database.query("SELECT id FROM workspaces ORDER BY id").all() as Array<{ id: string }>;
    const workspaceId = arg("--workspace-id") ?? (workspaces.length === 1 ? workspaces[0]!.id : undefined);
    if (!workspaceId) throw new Error("--workspace-id is required unless the database has exactly one workspace");
    const actors = database.query(
      "SELECT id FROM agents WHERE workspace_id = ? AND type IN ('owner','steward') ORDER BY id",
    ).all(workspaceId) as Array<{ id: string }>;
    const actorId = arg("--actor-id") ?? actors[0]?.id;
    if (!actorId) throw new Error("--actor-id is required when the workspace has no owner/steward");
    const signer = { private_key: fs.readFileSync(signingKeyPath) };
    const releaseSha = arg("--release-sha") ?? process.env.QOOPIA_RELEASE_SHA ?? "offline-qualification";
    const plan = createExportPlan({
      workspace_id: workspaceId,
      actor_id: actorId,
      include_ephemeral: process.argv.includes("--include-ephemeral"),
      release_sha: releaseSha,
      signer,
      database,
    });
    const outputDir = path.resolve(output);
    const result = materializeExportBundle({
      plan_hash: plan.plan_hash,
      idempotency_key: arg("--idempotency-key") ?? "offline-export-qualification",
      workspace_id: workspaceId,
      actor_id: actorId,
      release_sha: releaseSha,
      source_instance_id: arg("--source-instance-id") ?? "offline-scratch",
      signer,
      export_root: path.dirname(outputDir),
      output_dir: outputDir,
      database,
    });
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(reportPath, `${JSON.stringify({ plan, bundle: result }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    database.close();
  }
}

if (import.meta.main) runExportCli();
