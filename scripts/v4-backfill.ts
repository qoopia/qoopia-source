#!/usr/bin/env bun
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  executeRelationBackfill,
  planRelationBackfill,
  type BackfillExecutionResult,
} from "../src/db/v4-backfill.ts";
import {
  computeLogicalDatabaseHash,
  readSchemaVersion,
} from "../src/db/v4-migrations.ts";
import {
  openReadonlyDatabase,
  openWritableDatabase,
} from "../src/db/sqlite.ts";

type Mode = "plan" | "dry-run" | "apply";

interface CliOptions {
  mode: Mode;
  dbPath: string;
  reportPath?: string;
  checkpointPath?: string;
  resumeAfter?: string;
  batchSize: number;
  stopAfter?: number;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a non-empty value`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} requires an integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new Error(`${option} requires a positive integer`);
  return parsed;
}

export function parseBackfillArgs(args: string[]): CliOptions {
  const selected: Mode[] = [];
  let dbPath: string | undefined;
  let reportPath: string | undefined;
  let checkpointPath: string | undefined;
  let resumeAfter: string | undefined;
  let batchSize = 250;
  let stopAfter: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--plan") selected.push("plan");
    else if (argument === "--dry-run") selected.push("dry-run");
    else if (argument === "--apply") selected.push("apply");
    else if (argument === "--db") dbPath = requireValue(args, index++, argument);
    else if (argument === "--json-report" || argument === "--report") {
      reportPath = requireValue(args, index++, argument);
    } else if (argument === "--checkpoint") {
      checkpointPath = requireValue(args, index++, argument);
    } else if (argument === "--resume-after") {
      resumeAfter = requireValue(args, index++, argument);
    } else if (argument === "--batch-size") {
      batchSize = positiveInteger(requireValue(args, index++, argument), argument);
    } else if (argument === "--stop-after") {
      stopAfter = positiveInteger(requireValue(args, index++, argument), argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (selected.length > 1) {
    throw new Error(`Choose exactly one of --plan, --dry-run, or --apply`);
  }
  if (!dbPath) throw new Error(`--db is required`);
  const mode = selected[0] ?? "plan";
  if (mode !== "apply" && (checkpointPath || resumeAfter || stopAfter)) {
    throw new Error(`Checkpoint/resume/stop options require --apply`);
  }
  if (batchSize > 1_000) throw new Error(`--batch-size cannot exceed 1000`);
  return {
    mode,
    dbPath,
    reportPath,
    checkpointPath,
    resumeAfter,
    batchSize,
    stopAfter,
  };
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function writeJsonAtomic(filename: string, value: unknown): void {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filename);
}

function resolveResumeAfter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!fs.existsSync(value)) return value;
  const checkpoint = JSON.parse(fs.readFileSync(value, "utf8")) as unknown;
  if (!checkpoint || typeof checkpoint !== "object" ||
    !("last_processed_note_id" in checkpoint) ||
    typeof checkpoint.last_processed_note_id !== "string") {
    throw new Error(`Resume checkpoint lacks last_processed_note_id`);
  }
  return checkpoint.last_processed_note_id;
}

export function runBackfillCli(options: CliOptions): {
  report: Record<string, unknown>;
  exitCode: number;
} {
  const dbPath = fs.realpathSync(options.dbPath);
  const beforeFileHash = sha256File(dbPath);
  const generatedAt = new Date().toISOString();
  let execution: BackfillExecutionResult | null = null;
  let plan;
  let beforeLogicalHash: string;

  if (options.mode === "plan") {
    const db = openReadonlyDatabase(dbPath);
    try {
      plan = planRelationBackfill(db);
      beforeLogicalHash = computeLogicalDatabaseHash(db);
    } finally {
      db.close();
    }
  } else {
    const db = openWritableDatabase(dbPath);
    try {
      plan = planRelationBackfill(db);
      beforeLogicalHash = computeLogicalDatabaseHash(db);
      const resumeAfter = resolveResumeAfter(options.resumeAfter);
      execution = executeRelationBackfill(db, plan, {
        dryRun: options.mode === "dry-run",
        resumeAfter,
        batchSize: options.batchSize,
        stopAfter: options.stopAfter,
        onCheckpoint: options.checkpointPath
          ? (checkpoint) =>
            writeJsonAtomic(options.checkpointPath!, {
              schema_version: readSchemaVersion(db),
              mode: "apply",
              database_path: dbPath,
              updated_at: new Date().toISOString(),
              ...checkpoint,
            })
          : undefined,
      });
    } finally {
      db.close();
    }
  }

  const afterFileHash = sha256File(dbPath);
  if ((options.mode === "plan" || options.mode === "dry-run") &&
    beforeFileHash !== afterFileHash) {
    throw new Error(`${options.mode} mutated the database file`);
  }
  const report: Record<string, unknown> = {
    report_version: 1,
    generated_at: generatedAt,
    mode: options.mode,
    database_path: dbPath,
    schema_version: 32,
    database_sha256_before: beforeFileHash,
    database_sha256_after: afterFileHash,
    database_logical_sha256_before: beforeLogicalHash!,
    plan,
    execution,
    contains_note_bodies: false,
    production_actions: false,
  };
  if (options.reportPath) writeJsonAtomic(options.reportPath, report);
  return {
    report,
    exitCode: execution?.interrupted ? 75 : 0,
  };
}

if (import.meta.main) {
  try {
    const options = parseBackfillArgs(process.argv.slice(2));
    const result = runBackfillCli(options);
    console.log(JSON.stringify({
      ok: result.exitCode === 0,
      mode: options.mode,
      eligible: (result.report.plan as { counts: { eligible: number } }).counts.eligible,
      inserted: (result.report.execution as BackfillExecutionResult | null)?.inserted ?? 0,
      interrupted: result.exitCode === 75,
      report: options.reportPath ?? null,
    }));
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`v4-backfill failed: ${error}`);
    process.exit(1);
  }
}
