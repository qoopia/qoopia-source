import fs from "node:fs";
import path from "node:path";
import { createVerifiedBackup } from "../src/services/backup.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runBackupCli(): void {
  const source = arg("--source");
  const output = arg("--output");
  const reportPath = arg("--report");
  if (!source || !output || !reportPath || !process.argv.includes("--verify")) {
    throw new Error("usage: v4-backup --source DB --output DB --verify --report JSON [--latest-report JSON]");
  }
  const report = createVerifiedBackup({ source, output });
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const latest = arg("--latest-report");
  if (latest) {
    const tmp = `${latest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, latest);
    fs.chmodSync(latest, 0o600);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) runBackupCli();
