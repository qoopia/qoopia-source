/**
 * unpdf declares ZERO dependencies and vendors pdf.js into dist/pdfjs.mjs, so
 * no lockfile scanner (bun audit, osv-scanner, Dependabot) can see which pdf.js
 * we actually run. This is the only place that version is checked.
 *
 * Bump EXPECTED_PDFJS deliberately, after reading the pdf.js advisories for the
 * new version. A silent unpdf upgrade that drags in an older or vulnerable
 * pdf.js fails CI here instead of shipping.
 *
 * Why the pin is 1.4.0 and not the newest unpdf. GHSA-hq66-cqwq-w95j covers
 * pdfjs-dist >=5.6.83 <6.2.108. unpdf 1.5.0 through 1.7.0 vendor 5.6.205 and
 * 1.8.0/1.8.1 vendor 6.1.200 -- every one of them inside that range. 1.4.0
 * vendors 5.4.296, below the range, and is the NEWEST unpdf whose bundled
 * pdf.js is unaffected. Upgrading past it again requires an unpdf release that
 * vendors >=6.2.108; until then this check is what stops the regression.
 */
import fs from "node:fs";
import path from "node:path";

const EXPECTED_PDFJS = "5.4.296";
const EXPECTED_UNPDF = "1.4.0";
// GHSA-hq66-cqwq-w95j: pdfjs-dist >=5.6.83 <6.2.108.
const ADVISORY_RANGE = { atLeast: "5.6.83", below: "6.2.108" };

function fail(message: string): never {
  process.stderr.write(`check-vendored-pdfjs: ${message}\n`);
  process.exit(1);
}

const unpdfRoot = path.resolve(import.meta.dir, "../node_modules/unpdf");
const unpdfVersion = JSON.parse(
  fs.readFileSync(path.join(unpdfRoot, "package.json"), "utf8"),
).version as string;
if (unpdfVersion !== EXPECTED_UNPDF) {
  fail(`unpdf is ${unpdfVersion}, expected ${EXPECTED_UNPDF}. Re-verify the vendored pdf.js, then bump both constants.`);
}

const bundle = path.join(unpdfRoot, "dist/pdfjs.mjs");
if (!fs.existsSync(bundle)) fail(`vendored bundle missing at ${bundle}`);

// pdf.js stamps its own version into the bundle as a quoted literal.
const found = new Set(
  [...fs.readFileSync(bundle, "utf8").matchAll(/["'](\d+\.\d+\.\d+)["']/g)].map((m) => m[1]!),
);
if (!found.has(EXPECTED_PDFJS)) {
  fail(
    `expected pdf.js ${EXPECTED_PDFJS} in ${bundle}, found version literals: ` +
      `${[...found].slice(0, 10).join(", ") || "none"}`,
  );
}

// An equality pin alone only proves the bundle matches the constant. If someone
// later edits the constant to a vulnerable version to make the check pass, this
// is what refuses. Cheap semver compare -- no dependency for three integers.
const cmp = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};
if (cmp(EXPECTED_PDFJS, ADVISORY_RANGE.atLeast) >= 0 && cmp(EXPECTED_PDFJS, ADVISORY_RANGE.below) < 0) {
  fail(
    `pdf.js ${EXPECTED_PDFJS} is inside GHSA-hq66-cqwq-w95j ` +
      `(>=${ADVISORY_RANGE.atLeast} <${ADVISORY_RANGE.below}). Pin an unpdf whose bundle is outside it.`,
  );
}

process.stdout.write(
  `${JSON.stringify({ unpdf: unpdfVersion, vendored_pdfjs: EXPECTED_PDFJS, ok: true })}\n`,
);
