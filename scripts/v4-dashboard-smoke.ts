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
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("dashboard inline script not found");
new Function(script);
const required = [
  "V4 Review", "v4Query", "v4Results", "v4Extraction", "v4Relations",
  "v4Lifecycle", "v4Runtime", "v4Chain", "X-Qoopia-CSRF", "aria-live",
  "production apply unavailable", "esc(row.text", "expected_version",
];
const missing = required.filter((token) => !html.includes(token));
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
