import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { openReadonlyDatabase } from "../src/db/sqlite.ts";
import { validateImportPlan } from "../src/services/export.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function keyId(publicKeyFile: string): string {
  const key = createPublicKey(fs.readFileSync(publicKeyFile));
  const der = Buffer.from(key.export({ format: "der", type: "spki" }));
  return createHash("sha256").update(der.subarray(-32)).digest("hex");
}

export function runImportCli(): void {
  if (!process.argv.includes("--plan")) throw new Error("import apply is unavailable; pass --plan");
  const bundle = arg("--bundle");
  const dbPath = arg("--db");
  const reportPath = arg("--report");
  const publicKeyPath = arg("--public-key") ?? process.env.QOOPIA_V4_EXPORT_PUBLIC_KEY_FILE;
  if (!bundle || !dbPath || !reportPath || !publicKeyPath) {
    throw new Error("usage: v4-import --plan --bundle DIR --db DB --report JSON --public-key PEM");
  }
  const database = openReadonlyDatabase(dbPath);
  try {
    const workspaces = database.query("SELECT id FROM workspaces ORDER BY id").all() as Array<{ id: string }>;
    const workspaceId = arg("--target-workspace-id") ?? (workspaces.length === 1 ? workspaces[0]!.id : undefined);
    if (!workspaceId) throw new Error("--target-workspace-id is required unless the database has exactly one workspace");
    const report = validateImportPlan({
      bundle_dir: bundle,
      artifact_id: arg("--artifact-id") ?? path.basename(path.resolve(bundle)),
      target_workspace_id: workspaceId,
      trust_store: { [keyId(publicKeyPath)]: publicKeyPath },
      database,
    });
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.valid) process.exitCode = 2;
  } finally {
    database.close();
  }
}

if (import.meta.main) runImportCli();
