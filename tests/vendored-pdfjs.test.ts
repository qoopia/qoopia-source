// The vendored pdf.js gate runs inside `bun test`, so CI and the Docker
// verify stage (the only gate of `bun run release:build`) both enforce it.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkVendoredPdfjs, EXPECTED_PDFJS, EXPECTED_UNPDF } from "../scripts/check-vendored-pdfjs.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fakeUnpdf(version: string, bundle: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-unpdf-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "dist/pdfjs.mjs"), bundle);
  return root;
}

test("installed unpdf vendors the pinned pdf.js", () => {
  expect(checkVendoredPdfjs()).toEqual({ unpdf: EXPECTED_UNPDF, vendored_pdfjs: EXPECTED_PDFJS });
});

test("an unpdf bump or a different vendored pdf.js fails the gate", () => {
  expect(() => checkVendoredPdfjs(fakeUnpdf("1.5.0", `const v="${EXPECTED_PDFJS}";`))).toThrow(/unpdf is 1\.5\.0/);
  expect(() => checkVendoredPdfjs(fakeUnpdf(EXPECTED_UNPDF, 'const v="5.6.205";'))).toThrow(/expected pdf\.js/);
});
