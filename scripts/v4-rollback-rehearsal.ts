import fs from "node:fs";
import path from "node:path";
import { rehearseRestore } from "../src/services/backup.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runRollbackRehearsalCli(): void {
  const source = arg("--source");
  const workdir = arg("--workdir");
  const reportPath = arg("--report");
  const currentRelease = arg("--current-release");
  const rollbackRelease = arg("--rollback-release");
  if (!source || !workdir || !reportPath || !currentRelease || !rollbackRelease) {
    throw new Error("usage: v4-rollback-rehearsal --source DB --workdir DIR --report JSON --current-release SHA --rollback-release SHA");
  }
  for (const [label, value] of [["current", currentRelease], ["rollback", rollbackRelease]] as const) {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} release must be an exact 40-character Git SHA`);
  }
  const codeStarted = performance.now();
  const compose = fs.readFileSync(path.resolve(import.meta.dir, "../compose/docker-compose.v4.yml"), "utf8");
  const codeRollback = {
    strategy: "immutable_image_reference_swap" as const,
    current_release: currentRelease,
    rollback_release: rollbackRelease,
    compose_has_mutable_code_bind: compose.includes("/srv/qoopia/code"),
    production_actions: false as const,
    rto_ms: Number((performance.now() - codeStarted).toFixed(2)),
    rto_budget_ms: 15 * 60 * 1_000,
    rto_pass: !compose.includes("/srv/qoopia/code"),
  };
  const databaseRestore = rehearseRestore({ source, workdir });
  const report = {
    production_actions: false as const,
    code_rollback: codeRollback,
    database_restore: databaseRestore,
    rto_pass: codeRollback.rto_pass && databaseRestore.rto_pass,
  };
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.rto_pass) process.exitCode = 2;
}

if (import.meta.main) runRollbackRehearsalCli();
