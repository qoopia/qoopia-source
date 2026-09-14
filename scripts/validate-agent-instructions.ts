#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFleetToolsContract,
  validateAgentInstructionPaths,
  validateFleetToolLayout,
} from "../src/utils/agent-instruction-validator.ts";

function valuesAfter(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]!);
    }
  }
  return values;
}

const workspaces = valuesAfter("--workspace");
const instructions = valuesAfter("--instruction");
const canonicalTools = valuesAfter("--canonical-tools")[0];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const contractPath = valuesAfter("--contract")[0] ||
  path.resolve(scriptDir, "../deploy/fleet-tools-contract.json");

if (workspaces.length === 0) {
  console.error(
    "usage: bun run scripts/validate-agent-instructions.ts --workspace <path> " +
      "[--workspace <path> ...] [--instruction <relative-path>] " +
      "[--canonical-tools <path>] [--contract <path>] [--check-absolute]",
  );
  process.exit(2);
}

const contract = readFleetToolsContract(contractPath);
const errors: string[] = [];
let referenceCount = 0;
for (const workspace of workspaces) {
  const result = validateAgentInstructionPaths({
    workspaceRoot: workspace,
    instructionFiles: instructions.length ? instructions : undefined,
    checkAbsolute: process.argv.includes("--check-absolute"),
  });
  errors.push(...result.errors);
  referenceCount += result.checkedReferences.length;
  if (canonicalTools) {
    errors.push(...validateFleetToolLayout({
      workspaceRoot: workspace,
      canonicalToolsRoot: canonicalTools,
      contract,
    }));
  }
}

console.log(JSON.stringify({
  ok: errors.length === 0,
  workspaces: workspaces.length,
  references_checked: referenceCount,
  fleet_tool_release: canonicalTools ? contract.tool_release : null,
  errors,
}, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
