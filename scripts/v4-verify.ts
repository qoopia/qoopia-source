#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { openReadonlyDatabase } from "../src/db/sqlite.ts";
import { verifyV4Database } from "../src/db/v4-verification.ts";

interface VerifyCliOptions {
  dbPath: string;
  expectSchema: number;
  legacySourcePath: string;
  legacyValueFreeManifestPath: string;
  reconciliationManifestPath: string;
  expectLegacyActive: number;
  reportPath: string;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${option} requires a non-empty value`);
  }
  return value;
}

function integer(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} requires an integer`);
  return Number.parseInt(value, 10);
}

export function parseVerifyArgs(args: string[]): VerifyCliOptions {
  let dbPath: string | undefined;
  let expectSchema: number | undefined;
  let legacySourcePath: string | undefined;
  let legacyValueFreeManifestPath: string | undefined;
  let reconciliationManifestPath: string | undefined;
  let expectLegacyActive: number | undefined;
  let reportPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--db") dbPath = requireValue(args, index++, argument);
    else if (argument === "--expect-schema") {
      expectSchema = integer(requireValue(args, index++, argument), argument);
    } else if (argument === "--legacy-source") {
      legacySourcePath = requireValue(args, index++, argument);
    } else if (argument === "--legacy-value-free-manifest") {
      legacyValueFreeManifestPath = requireValue(args, index++, argument);
    } else if (argument === "--reconciliation-manifest") {
      reconciliationManifestPath = requireValue(args, index++, argument);
    } else if (argument === "--expect-legacy-active") {
      expectLegacyActive = integer(requireValue(args, index++, argument), argument);
    } else if (argument === "--report" || argument === "--json-report") {
      reportPath = requireValue(args, index++, argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!dbPath || expectSchema === undefined || !legacySourcePath ||
    !legacyValueFreeManifestPath || !reconciliationManifestPath ||
    expectLegacyActive === undefined || !reportPath) {
    throw new Error(
      `--db, --expect-schema, --legacy-source, --legacy-value-free-manifest, ` +
        `--reconciliation-manifest, --expect-legacy-active, and --report are required`,
    );
  }
  return {
    dbPath,
    expectSchema,
    legacySourcePath,
    legacyValueFreeManifestPath,
    reconciliationManifestPath,
    expectLegacyActive,
    reportPath,
  };
}

function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filename);
}

export function runVerifyCli(options: VerifyCliOptions) {
  const resolved = {
    dbPath: fs.realpathSync(options.dbPath),
    legacySourcePath: fs.realpathSync(options.legacySourcePath),
    legacyValueFreeManifestPath: fs.realpathSync(
      options.legacyValueFreeManifestPath,
    ),
    reconciliationManifestPath: fs.realpathSync(
      options.reconciliationManifestPath,
    ),
  };
  const db = openReadonlyDatabase(resolved.dbPath);
  try {
    const report = verifyV4Database({
      db,
      dbPath: resolved.dbPath,
      expectSchema: options.expectSchema,
      legacySourcePath: resolved.legacySourcePath,
      legacyValueFreeManifestPath: resolved.legacyValueFreeManifestPath,
      reconciliationManifestPath: resolved.reconciliationManifestPath,
      expectLegacyActive: options.expectLegacyActive,
    });
    writeJsonAtomic(options.reportPath, {
      report_version: 1,
      generated_at: new Date().toISOString(),
      ...report,
      resolved_paths: resolved,
      contains_note_bodies: false,
      production_actions: false,
    });
    return report;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const options = parseVerifyArgs(process.argv.slice(2));
    const report = runVerifyCli(options);
    console.log(JSON.stringify({
      ok: report.ok,
      schema: report.schema.actual,
      legacy_coverage: `${report.legacy.covered}/${report.legacy.expected_active}`,
      missing: report.legacy.missing,
      report: options.reportPath,
    }));
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(`v4-verify failed: ${error}`);
    process.exit(1);
  }
}
