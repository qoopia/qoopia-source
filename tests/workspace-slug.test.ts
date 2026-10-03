// Ops scripts (backlog sweep, wake SLO probe/alert) resolve their workspace by
// slug at runtime instead of hard-coding a production workspace ID in source.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace, workspaceIdBySlug } from "../src/admin/workspaces.ts";

beforeAll(() => runMigrations());
afterEach(() => { delete process.env.QOOPIA_WORKSPACE_SLUG; });

test("resolves the workspace named by QOOPIA_WORKSPACE_SLUG and refuses an unknown slug", () => {
  const slug = "ops-slug-" + randomUUID();
  const ws = createWorkspace({ name: "Ops slug", slug });
  expect(workspaceIdBySlug(slug)).toBe(ws.id);
  process.env.QOOPIA_WORKSPACE_SLUG = slug;
  expect(workspaceIdBySlug()).toBe(ws.id);
  process.env.QOOPIA_WORKSPACE_SLUG = "missing-" + randomUUID();
  expect(() => workspaceIdBySlug()).toThrow(/QOOPIA_WORKSPACE_SLUG/);
});
