import { beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { upsertEntity } from "../src/services/entities.ts";
import { skillMarkTested } from "../src/services/skills.ts";
import { principalAuth } from "./helpers/p1-fixtures.ts";

beforeAll(() => runMigrations());
test("T-22/T-05: generic skill writer uses one revision, replay is stable and self-report cannot impersonate", () => {
  const workspace = createWorkspace({ name: "P1 compat", slug: `compat-${randomUUID()}` });
  const agent = createAgent({ name: "Compatibility author", workspaceSlug: workspace.slug });
  const auth = principalAuth(db, agent.id);
  const input = { workspace_id: workspace.id, type: "skill" as const, slug: "compat-skill", title: "Compatibility draft", summary: "Fixture",
    metadata: {}, expected_revision: 0, idempotency_key: "legacy-create" };
  const created = upsertEntity(input, auth);
  expect(upsertEntity(input, auth)).toEqual(created);
  expect(db.query("SELECT count(*) AS n FROM skill_draft_revisions WHERE workspace_id=?").get(workspace.id)).toEqual({ n: 1 });
  expect(() => upsertEntity({ ...input, type: "person" }, auth)).toThrow("cannot be retyped");
  expect(() => upsertEntity({ ...input, metadata: { unknown: true }, idempotency_key: "unknown" }, auth)).toThrow("Unknown");
  expect(() => skillMarkTested({ workspace_id: workspace.id, id: created.id, expected_revision: 1, idempotency_key: "forged-test", tested_at: new Date().toISOString(), tester_agent: "other-agent" }, auth)).toThrow("authenticated reporter");
  const oauth = { ...auth, source: "oauth" as const, granted_scope: [] };
  expect(() => upsertEntity(input, oauth)).toThrow("scope");
  db.query("UPDATE agents SET active=0 WHERE id=?").run(agent.id);
  expect(() => upsertEntity(input, auth)).toThrow("inactive");
});
