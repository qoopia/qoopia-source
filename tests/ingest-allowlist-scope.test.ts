/**
 * F-040: getAllowlist is always workspace-scoped. An empty workspace id must
 * not fall through to the cross-workspace list.
 */
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { getAllowlist, registerClaudeAgent } from "../src/admin/claude-agents.ts";

let WS_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Allowlist Scope", slug: "allowlist-scope" });
  WS_ID = ws.id;
  createAgent({ name: "allowlist-scope-agent", workspaceSlug: ws.slug });
  registerClaudeAgent({
    workspaceSlug: ws.slug,
    agentName: "allowlist-scope-agent",
    cwdPrefix: "/tmp/allowlist-scope",
  });
});

test("returns only the requested workspace's entries", () => {
  const rows = getAllowlist(WS_ID);
  expect(rows.map((r) => r.cwd_prefix)).toEqual(["/tmp/allowlist-scope"]);
  expect(rows.every((r) => r.workspace_id === WS_ID)).toBe(true);
});

test("empty workspace id does not leak other workspaces' entries", () => {
  expect(getAllowlist("")).toEqual([]);
});
