import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const commitSha = valueAfter("--sha")?.trim() || "";
const outputPath = valueAfter("--output")?.trim() || "";

if (!COMMIT_SHA_RE.test(commitSha)) {
  throw new Error("--sha must be a lowercase 40-character git commit SHA");
}
if (!outputPath) {
  throw new Error("--output is required");
}

writeFileSync(
  resolve(outputPath),
  `${JSON.stringify({ commit_sha: commitSha, dirty: false }, null, 2)}\n`,
  { mode: 0o444 },
);
