/**
 * src/skills/legacy is vendored Skillonomia code (Apache-2.0), not dead legacy:
 * canonical(), skill format, signing and archive handling run on it. The files
 * listed in PROVENANCE.json must stay byte-identical to the pinned upstream
 * commit; fix behaviour around them, never inside them. outcome.ts is an
 * excerpt, not an unchanged copy, so it is deliberately not hashed.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(import.meta.dir, "../src/skills/legacy");

test("vendored Skillonomia files match their pinned sha256", () => {
  const { unchanged_sha256 } = JSON.parse(fs.readFileSync(path.join(DIR, "PROVENANCE.json"), "utf8"));
  const pinned = Object.entries(unchanged_sha256 as Record<string, string>);
  expect(pinned.length).toBe(5);
  for (const [file, sha] of pinned) {
    expect([file, createHash("sha256").update(fs.readFileSync(path.join(DIR, file))).digest("hex")]).toEqual([file, sha]);
  }
});
