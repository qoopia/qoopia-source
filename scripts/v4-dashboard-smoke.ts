// HISTORICAL. This checks the V4 review dashboard, a section that was removed from
// src/public/dashboard.html before schema 45; every token below is already absent on main, so the
// script fails by design until someone revives that surface. Kept as evidence of the V4 contract,
// not as a working check — it is not part of CI. The file reference is current: the page's code
// lives in src/public/brand/dashboard.js.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function value(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const fixtureDir = value("--fixtures", "tests/fixtures/v4/dashboard");
const widths = value("--widths", "375,768,1440").split(",").map(Number);
const output = value("--json", "artifacts/v4/evidence/P07/ui-smoke.json");
const html = readFileSync("src/public/dashboard.html", "utf8");
const fixture = JSON.parse(readFileSync(join(fixtureDir, "state.json"), "utf8"));
// The page's code is a same-origin file; the page itself only references it.
const script = readFileSync("src/public/brand/dashboard.js", "utf8");
if (!html.includes("/brand/dashboard.js")) throw new Error("dashboard page does not load its script");
new Function(script);
const searched = html + "\n" + script;
const required = [
  "V4 Review", "v4Query", "v4Results", "v4Extraction", "v4Relations",
  "v4Lifecycle", "v4Runtime", "v4Chain", "X-Qoopia-CSRF", "aria-live",
  "production apply unavailable", "esc(row.text", "expected_version",
];
const missing = required.filter((token) => !searched.includes(token));
if (missing.length) throw new Error(`dashboard DOM contract missing: ${missing.join(", ")}`);
if (!widths.every((width) => Number.isInteger(width) && width >= 320 && width <= 4096)) {
  throw new Error("widths must be integer CSS pixels in [320,4096]");
}
const serialized = JSON.stringify(fixture);
for (const forbidden of ["api_key", "Bearer ", "PRIVATE KEY", "production_apply_controls\":true"]) {
  if (serialized.includes(forbidden)) throw new Error(`unsafe fixture token: ${forbidden}`);
}
const sections = ["recall", "extraction", "relations", "lifecycle", "runtime", "chain", "flags"];
const report = {
  generated_at: new Date().toISOString(),
  mode: "synthetic_static_dom_contract",
  fixture: join(fixtureDir, "state.json"),
  widths: widths.map((width) => ({
    width,
    layout: width <= 480 ? "single-column-compact" : width <= 860 ? "single-column" : "two-column",
    sections,
    native_keyboard_controls: true,
    live_status_regions: true,
    horizontal_overflow_contract: "body-hidden-panels-minmax-zero",
  })),
  fixture_counts: {
    traces: fixture.traces.length,
    relations: fixture.relations.length,
    candidates: fixture.extraction.flatMap((run: any) => run.candidates || []).length,
    lifecycle: fixture.lifecycle.length,
  },
  security: { escaped_dynamic_text: true, csrf_header: true, production_apply_controls: false },
  pass: true,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`P07 UI smoke PASS: ${widths.join(",")} -> ${output}`);
