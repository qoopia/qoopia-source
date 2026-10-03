import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { p1Database } from "./helpers/p1-fixtures.ts";
import { splitSqlStatements } from "../src/db/migration-033-exec.ts";
import { backfill036 } from "../src/db/migration-036-backfill.ts";

const sql036 = readFileSync(new URL("../migrations/036-unified-authority.sql", import.meta.url), "utf8");
// Mirrors src/db/migrate.ts: the 036 statements and the backfill share one transaction.
const migrate036 = (db: Database) => db.transaction(() => {
  for (const statement of splitSqlStatements(sql036)) db.run(statement);
  return backfill036(db);
})();
const UPDATED_AT = "2026-01-02T03:04:05.000Z";
// Same legacy runbook as tests/migration-036-drift.test.ts, in its pre-036 entity_pages shape.
const runbook = {
  title: "Legacy backup runbook", summary: "Recover a failed nightly backup",
  metadata: { trigger_conditions: ["when the nightly backup fails"], exact_steps: ["check the journal", "restore from backup"],
    verification_gates: ["integrity check passes"], failure_modes: ["disk full"], rollback: "restore the previous snapshot",
    prerequisites: ["sqlite3 available"] } as Record<string, unknown>,
};
function legacy(skills: Record<string, typeof runbook>) {
  const db = p1Database(35);
  db.run("INSERT INTO workspaces(id,name,slug) VALUES ('ws','Legacy','legacy')");
  db.run("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,tool_profile) VALUES ('writer','ws','Writer','standard','hash','full')");
  for (const [id, s] of Object.entries(skills)) db.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title,summary,metadata,updated_at) VALUES (?,'ws','skill',?,?,?,?,?)")
    .run(id, id, s.title, s.summary, JSON.stringify(s.metadata), UPDATED_AT);
  return db;
}

test("legacy skill gets immutable draft revision", () => {
  const db = legacy({ "legacy-skill": runbook });
  const report = migrate036(db);
  expect(report.skills).toBe(1);
  expect(report.principals).toEqual([expect.objectContaining({ id: "writer", legacy_skill_access: 1, profile_allows_skill_write: true, owner_mapping: "none" })]);
  expect(db.query("SELECT legacy_skill_access FROM agents WHERE id='writer'").get()).toEqual({ legacy_skill_access: 1 });
  const actor = db.query("SELECT id,active,tool_profile FROM agents WHERE name='legacy-skill-provenance'").all() as Array<{ id: string; active: number; tool_profile: string }>;
  expect(actor).toEqual([{ id: expect.any(String), active: 0, tool_profile: "read-only" }]);
  const draft = db.query("SELECT * FROM skill_drafts WHERE skill_id='legacy-skill'").get() as Record<string, unknown>;
  expect(draft).toMatchObject({ actor_id: actor[0]!.id, revision: 1, updated_at_ms: Date.parse(UPDATED_AT) });
  const revision = db.query("SELECT * FROM skill_draft_revisions WHERE id=?").get(draft.head_revision_id as string) as Record<string, unknown>;
  expect(revision).toMatchObject({ draft_id: draft.id, revision_no: 1, compiler_version: "qoopia-structured/1", missing_requirements: "[]",
    content_digest: "20aceaab1fc95d1b97ecd7adfb8d47f0d018a9de74e3be05064843e3234d9083" });
  expect(JSON.parse(revision.legacy_runbook_json as string)).toMatchObject({ id: "legacy-skill", title: runbook.title, metadata: runbook.metadata });
});

const oversized: Array<[string, typeof runbook]> = [
  ["title", { ...runbook, title: "t".repeat(301) }],
  ["summary", { ...runbook, summary: "s".repeat(100_001) }],
  ["rollback", { ...runbook, metadata: { ...runbook.metadata, rollback: "r".repeat(100_001) } }],
];
for (const [field, skill] of oversized) test(`an oversized legacy ${field} aborts 036 naming the skill`, () => {
  const db = legacy({ "fits-skill": runbook, "oversized-skill": skill });
  expect(() => migrate036(db)).toThrow(/oversized-skill.*restore pre-migrate backup/s);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='skill_drafts'").get()).toBeNull();
});
