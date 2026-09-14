import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dir, "..");
const OUTPUT = path.join(ROOT, "artifacts/v4/evidence/P01/architecture-freeze.json");
const BASE_SHA = "b6c169b9c72a2f983933610072b4909ef61261c3";

function filesUnder(relativeDir: string): string[] {
  const absoluteDir = path.join(ROOT, relativeDir);
  const out: string[] = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(relative));
    else out.push(relative);
  }
  return out;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const adrPaths = [
  "docs/decisions/ADR-V4-0001-migration-coordinate-rebase.md",
  ...Array.from({ length: 10 }, (_, index) =>
    `docs/decisions/ADR-V4-${String(index + 1).padStart(3, "0")}.md`,
  ),
];
const evidencePaths = [
  "artifacts/v4/evidence/P01/amendment-consumption.json",
  "artifacts/v4/evidence/P01/architecture-consistency-self-review.md",
  "artifacts/v4/evidence/P01/baseline-inventory.json",
  "artifacts/v4/evidence/P01/commands.log",
  "artifacts/v4/evidence/P01/fable-review-prompt.md",
  "artifacts/v4/evidence/P01/review-findings-closure.md",
  "artifacts/v4/evidence/P01/tests.json",
  "artifacts/v4/evidence/P01/validation-tooling.md",
];
const paths = [
  ...filesUnder("docs/v4"),
  ...adrPaths,
  "artifacts/v4/inputs/ADR-V4-0001-migration-coordinate-rebase.md",
  "artifacts/v4/inputs/QOOPIA_V4_PROFESSIONAL_TZ.md",
  ...evidencePaths,
  "scripts/v4-contract-snapshot.ts",
  "scripts/v4-freeze-manifest.ts",
  "scripts/v4-traceability-check.ts",
].sort(compareUtf8);

if (new Set(paths).size !== paths.length) throw new Error("freeze path set contains duplicates");
const entries = paths.map((relative) => {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`freeze input missing: ${relative}`);
  }
  return { path: relative, sha256: sha256(fs.readFileSync(absolute)) };
});
const aggregatePreimage = entries
  .map((entry) => `${entry.sha256}  ${entry.path}\n`)
  .join("");
const manifest = {
  schema_version: 2,
  phase: "P01",
  base_sha: BASE_SHA,
  schema_target: 32,
  migration_range: "027-032",
  algorithm: "sha256",
  scope: "P01 frozen source inputs, architecture, ADRs, machine contracts, freeze validators, and pre-manifest evidence; excludes this manifest and self-referential checkpoint commits",
  aggregate_encoding: {
    path_normalization: "repository-relative POSIX UTF-8 paths without leading ./",
    entry_order: "unsigned UTF-8 bytewise path ascending",
    file_digest: "lowercase SHA-256 of exact file bytes",
    entry_record: "<64 lowercase hex><two ASCII spaces><path><LF>",
    final_newline: true,
    aggregate_digest: "lowercase SHA-256 of the UTF-8 concatenation of every entry record",
  },
  entry_count: entries.length,
  freeze_hash: sha256(Buffer.from(aggregatePreimage, "utf8")),
  entries,
};
const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--write")) {
  fs.writeFileSync(OUTPUT, rendered);
  console.log(JSON.stringify({ status: "written", entries: entries.length, freeze_hash: manifest.freeze_hash }));
} else {
  if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, "utf8") !== rendered) {
    throw new Error("architecture freeze manifest drift; run v4-freeze-manifest.ts --write and review the diff");
  }
  console.log(JSON.stringify({ status: "pass", entries: entries.length, freeze_hash: manifest.freeze_hash }));
}
