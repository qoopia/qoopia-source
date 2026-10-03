import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSafeDir, ensureSafeFile } from "../src/utils/fs-perms.ts";

// chmod never fails for root, so a failing chmod is stubbed instead of using a foreign-owned directory.
function withTemp(run: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-fs-perms-"));
  try { run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function withFailingChmod(run: () => void) {
  const chmod = spyOn(fs, "chmodSync").mockImplementation(() => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); });
  try { run(); } finally { chmod.mockRestore(); }
}
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test("ensureSafeDir tightens a loose directory it owns", () => withTemp((dir) => {
  const child = path.join(dir, "data");
  fs.mkdirSync(child, { mode: 0o755 }); fs.chmodSync(child, 0o755);
  ensureSafeDir(child);
  expect(mode(child)).toBe(0o700);
}));

test("ensureSafeDir refuses when mode cannot be tightened", () => withTemp((dir) => {
  fs.chmodSync(dir, 0o755);
  withFailingChmod(() => expect(() => ensureSafeDir(dir)).toThrow(/0755/));
}));

test("ensureSafeDir accepts an already private directory it cannot chmod", () => withTemp((dir) => {
  fs.chmodSync(dir, 0o700);
  withFailingChmod(() => expect(() => ensureSafeDir(dir)).not.toThrow());
}));

test("ensureSafeFile refuses a file that stays group or world readable", () => withTemp((dir) => {
  const file = path.join(dir, "export.json");
  fs.writeFileSync(file, "{}", { mode: 0o644 }); fs.chmodSync(file, 0o644);
  withFailingChmod(() => expect(() => ensureSafeFile(file)).toThrow(/0644/));
  ensureSafeFile(file);
  expect(mode(file)).toBe(0o600);
}));
