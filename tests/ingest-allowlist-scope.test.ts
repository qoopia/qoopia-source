/**
 * F-040: getAllowlist is always workspace-scoped. An empty workspace id must
 * not fall through to the cross-workspace list.
 */
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent, deleteAgent } from "../src/admin/agents.ts";
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

test("F-520 a deactivated agent's mapping is not tailed; a padded name still registers", () => {
  const ws = createWorkspace({ name: "Allowlist Deactivated", slug: "allowlist-deactivated" });
  createAgent({ name: "allowlist-gone", workspaceSlug: ws.slug });
  createAgent({ name: "allowlist-kept", workspaceSlug: ws.slug });
  registerClaudeAgent({ workspaceSlug: ws.slug, agentName: "allowlist-gone", cwdPrefix: "/tmp/allowlist-gone" });
  registerClaudeAgent({ workspaceSlug: ws.slug, agentName: " allowlist-kept ", cwdPrefix: "/tmp/allowlist-kept" });
  deleteAgent("allowlist-gone", ws.slug);
  expect(getAllowlist(ws.id).map((r) => r.cwd_prefix)).toEqual(["/tmp/allowlist-kept"]);
});
