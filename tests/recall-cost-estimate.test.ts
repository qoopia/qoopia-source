// F-100: the cosmetic full-scan cost estimate must not re-scan every note body on
// every recall. It is cached per workspace, so a second recall right after a write
// reports the same estimate instead of paying an O(corpus) aggregate again.
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recallBaseline } from "../src/services/recall.ts";

let ws = "", agent = "";

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Recall cost estimate", slug: "recall-cost-estimate" });
  ws = w.id;
  agent = createAgent({ name: "cost-estimate-agent", workspaceSlug: w.slug }).id;
  createNote({ workspace_id: ws, agent_id: agent, type: "memory", text: "costestimate seed note" });
});

test("the full-scan estimate is not recomputed on the next recall", async () => {
  const run = () => recallBaseline({ workspace_id: ws, caller_agent_id: agent, is_admin: false, query: "costestimate", mode: "fts5" });
  const first = await run();
  expect(first.cost.tokens_full_scan_estimate).toBeGreaterThan(0);
  createNote({ workspace_id: ws, agent_id: agent, type: "memory", text: "x".repeat(40_000) });
  const second = await run();
  expect(second.cost.tokens_full_scan_estimate).toBe(first.cost.tokens_full_scan_estimate);
});

test("the estimate covers only notes the caller may read (ADR-020)", async () => {
  const w = createWorkspace({ name: "Recall cost visibility", slug: "recall-cost-visibility" });
  const writer = createAgent({ name: "cost-writer", workspaceSlug: w.slug }).id;
  const loner = createAgent({ name: "cost-loner", workspaceSlug: w.slug }).id;
  createNote({ workspace_id: w.id, agent_id: loner, type: "memory", text: "costvisible own note" });
  createNote({ workspace_id: w.id, agent_id: writer, type: "memory", text: "y".repeat(40_000), visibility: "private" });
  const estimate = async (agent: string, isAdmin = false) =>
    (await recallBaseline({ workspace_id: w.id, caller_agent_id: agent, is_admin: isAdmin, query: "costvisible", mode: "fts5" }))
      .cost.tokens_full_scan_estimate;
  // A sibling's private note is not in a shared-context agent's corpus; the steward's includes it.
  expect(await estimate(loner)).toBeLessThan(100);
  expect(await estimate(loner, true)).toBeGreaterThan(10_000);
});
