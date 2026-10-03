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
