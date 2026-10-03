import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SOURCE = /\.(ts|tsx|js|mjs|cjs|py|sh|swift|sql|json|md|html|css)$/;

// Raw control bytes make git and rg treat a source file as binary, so its
// diffs and searches silently disappear from review. Write escapes instead.
test("tracked source files contain no raw control bytes", () => {
  const files = execFileSync("git", ["ls-files", "-z", "src", "scripts", "tests", "sdk", "migrations"], { cwd: ROOT })
    .toString("utf8").split("\0").filter(f => SOURCE.test(f) && !f.startsWith("scripts/vendor/"));
  const offenders = files.filter(f => {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) return false;
    return fs.readFileSync(full).some(byte => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
  });
  expect(offenders).toEqual([]);
});

// 5.0.14 retired the verification prompt; the connection card's request and the
// first qoopia_protocol call confirm a connection (F-245, F-333).
test("user-facing setup text no longer asks for the retired verification prompt", () => {
  const files = ["src/delivery/desktop-auth.ts", "src/delivery/stdio-oauth.ts", "scripts/darwin-launcher.swift",
    "src/public/connections-guide-en.html", "src/public/connections-guide-ru.html"];
  const stale = /run the (wizard’s )?verification prompt|запрос проверки/i;
  expect(files.filter(f => stale.test(fs.readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
});
