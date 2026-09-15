/**
 * Drift guard for migration 036.
 *
 * backfill036 builds skill draft revisions by calling the live skills modules:
 * contentSchema, contentDigest, missingRequirements, COMPILER and canonical.
 * An applied migration that calls today's domain code does not reproduce what
 * it did when it was written, so a later change to the skill format silently
 * changes what a fresh database gets from a migration that older databases
 * already ran with different rules.
 *
 * Freezing a copy of the compiler inside db/ would duplicate a zod schema and
 * a digest routine, and a subtle copy error there corrupts skill drafts. This
 * test takes the cheaper guarantee instead: it pins the exact output for one
 * fixed legacy skill. If the skill format changes, this fails and the change
 * has to be argued about rather than shipped by accident.
 *
 * If you are here because this test failed: decide whether migration 036 must
 * keep its original output, and if so freeze the compiler it uses.
 */
import { describe, expect, test } from "bun:test";
import { contentSchema, COMPILER, contentDigest, missingRequirements } from "../src/skills/format.ts";
import { canonical } from "../src/skills/commands.ts";

// Mirrors the field mapping in src/db/migration-036-backfill.ts.
const LEGACY_SKILL = {
  title: "Legacy backup runbook",
  purpose: "Recover a failed nightly backup",
  trigger: ["when the nightly backup fails"],
  procedure: ["check the journal", "restore from backup"],
  verification: ["integrity check passes"],
  failure_modes: ["disk full"],
  rollback: "restore the previous snapshot",
  compatibility: ["sqlite3 available"],
};

describe("migration 036 output is pinned to the skill format it was written against", () => {
  const content = contentSchema.parse(LEGACY_SKILL);

  test("compiler version is unchanged", () => {
    expect(COMPILER).toBe("qoopia-structured/1");
  });

  test("content digest is unchanged", () => {
    expect(contentDigest(content)).toBe(
      "20aceaab1fc95d1b97ecd7adfb8d47f0d018a9de74e3be05064843e3234d9083",
    );
  });

  test("a complete legacy skill still reports no missing requirements", () => {
    expect(canonical(missingRequirements(content))).toBe("[]");
  });

  test("canonical content, including schema defaults, is unchanged", () => {
    expect(canonical(content)).toBe(
      '{"compatibility":["sqlite3 available"],"failure_modes":["disk full"],"inputs_schema":{},"outputs_schema":{},"procedure":["check the journal","restore from backup"],"purpose":"Recover a failed nightly backup","redaction_report":[],"requested_capabilities":[],"rollback":"restore the previous snapshot","secret_refs":[],"title":"Legacy backup runbook","trigger":["when the nightly backup fails"],"verification":["integrity check passes"]}',
    );
  });
});
