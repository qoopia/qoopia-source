import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";

// The probe script runs `await probe(DIR)` at top level, so it cannot be
// imported. Read its error_class union from source instead, so a new member
// that the wake_slo_probes CHECK rejects fails here, not in production.
function probeErrorClasses(): string[] {
  const src = fs.readFileSync(path.join(import.meta.dir, "../scripts/wake_slo_probe.ts"), "utf8");
  const union = /let error_class:([\s\S]*?)\| null =/.exec(src);
  if (!union) throw new Error("error_class union not found in scripts/wake_slo_probe.ts");
  return [...union[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("wake_slo_probe error_class", () => {
  test("every class the probe can emit is accepted by the wake_slo_probes CHECK", () => {
    runMigrations();
    const classes = probeErrorClasses();
    expect(classes.length).toBeGreaterThan(0);
    const insert = db.prepare(
      `INSERT INTO wake_slo_probes (direction, status, error_class) VALUES ('C2L', 'failed', ?)`,
    );
    for (const errorClass of classes) {
      expect(() => insert.run(errorClass)).not.toThrow();
    }
    db.prepare("DELETE FROM wake_slo_probes").run();
  });
});
