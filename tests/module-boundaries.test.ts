import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeSpecifiers, checkBoundaries } from "../scripts/check-module-boundaries.ts";

test("runtime parser retains values, aliases, re-exports, side effects and literal dynamic imports", () => {
  for (const source of [
    'export { x } from "./value";', 'export * from "./value";',
    'import value, { type T } from "./value";', 'import { x as y } from "./value";',
    'import "./value";', 'const x = import("./value");', 'const x = require("./value");',
    'import x = require("./value");',
  ]) expect(runtimeSpecifiers(source)).toEqual(["./value"]);
});
test("parser ignores only type edges and comments", () => {
  for (const source of ['export type { T } from "./type";', 'export { type T } from "./type";',
    'import type T from "./type";', 'import { type T } from "./type";', '// import x from "./type";']) {
    expect(runtimeSpecifiers(source)).toEqual([]);
  }
});
test("guard rejects forbidden re-exports and new two-file cycles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-edges-"));
  try {
    fs.mkdirSync(path.join(root, "utils")); fs.mkdirSync(path.join(root, "services"));
    fs.writeFileSync(path.join(root, "utils/a.ts"), 'export { x } from "../services/b";');
    fs.writeFileSync(path.join(root, "services/b.ts"), 'import a, { type T } from "../utils/a";');
    const result = checkBoundaries(root);
    expect(result.problems.some(p => p.startsWith("layer:"))).toBe(true);
    expect(result.problems.some(p => p.startsWith("new or enlarged"))).toBe(true);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});
