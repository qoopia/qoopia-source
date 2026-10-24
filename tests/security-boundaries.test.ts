/**
 * docs/security-boundaries.md is a claim → code → test matrix. Every file it names must exist and every test
 * title it quotes must be in the named test file, so a claim cannot keep a row after its evidence is gone.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";

// The matrix is a canonical document; the public source repository is exported without it (its allowlist names
// published documents one by one), so there is nothing to check there.
test.skipIf(!fs.existsSync("docs/security-boundaries.md"))("every row of the security matrix points at existing code and at tests that exist", () => {
  const rows = fs.readFileSync("docs/security-boundaries.md", "utf8").split("\n").filter((line) => /^\| \d+ \|/.test(line));
  expect(rows.length).toBeGreaterThanOrEqual(18);
  for (const row of rows) {
    const [, claim, code, evidence] = row.replace(/ \|$/, "").split(" | ").map((cell) => cell.trim());
    expect(claim!.length, row).toBeGreaterThan(20);
    const files = [...`${code} ${evidence}`.matchAll(/`((?:src|tests|docs|benchmarks|\.github)\/[^`\s]+?)`/g)].map((m) => m[1]!);
    expect(files.length, row).toBeGreaterThan(0);
    // The release image is built without .github; the checkout and CI have it.
    for (const file of files) if (!file.startsWith(".github/") || fs.existsSync(".github")) expect(fs.existsSync(file), `${file} in row ${row.slice(0, 6)}`).toBe(true);
    // «`tests/x.test.ts` — "title"; "title"»: each quoted title is a substring of a test name in that file.
    for (const part of evidence!.split(/;\s*(?=`tests\/)/)) {
      const file = /`(tests\/[^`]+)`/.exec(part)?.[1];
      if (!file) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const title of [...part.matchAll(/"([^"]+)"/g)].map((m) => m[1]!))
        expect(source.includes(title), `${file}: "${title}"`).toBe(true);
    }
  }
});
