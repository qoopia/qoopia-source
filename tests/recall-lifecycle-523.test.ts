/**
 * 5.0.23 (Liam's additions, items 6 and 7): recall weighs memory by use and age softly and deletes nothing,
 * and recall quality has thresholds that CI enforces.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import { confirmMemory, queueAccessReinforcement } from "../src/services/memory-lifecycle.ts";

const previous = process.env.QOOPIA_V4_LIFECYCLE;
let ws = "", owner = "", agent = "", used = "", forgotten = "";
beforeAll(() => {
  runMigrations();
  process.env.QOOPIA_V4_LIFECYCLE = "true";
  const w = createWorkspace({ name: "Lifecycle 523", slug: "lifecycle-523" }); ws = w.id;
  owner = createAgent({ name: "lifecycle-owner", workspaceSlug: w.slug, type: "owner" }).id;
  agent = createAgent({ name: "lifecycle-agent", workspaceSlug: w.slug }).id;
  forgotten = createNote({ workspace_id: ws, agent_id: agent, type: "memory", text: "Kiwi warehouse delivery window is Tuesday morning (first)." }).id;
  used = createNote({ workspace_id: ws, agent_id: agent, type: "memory", text: "Kiwi warehouse delivery window is Tuesday morning (second)." }).id;
  // Both a year old; only one has been recalled and confirmed since.
  const year = new Date(Date.now() - 365 * 86_400_000);
  db.query("UPDATE notes SET updated_at=?, updated_at_ms=? WHERE id IN (?,?)").run(year.toISOString(), year.getTime(), forgotten, used);
});
afterAll(() => { if (previous === undefined) delete process.env.QOOPIA_V4_LIFECYCLE; else process.env.QOOPIA_V4_LIFECYCLE = previous; });

const auth = (agent_id: string, type = "standard") => ({ workspace_id: ws, agent_id, agent_name: agent_id, type, source: "api-key" }) as any;

test("with lifecycle on, a recalled and confirmed note outranks an equally relevant forgotten one, and nothing is deleted", async () => {
  for (let i = 0; i < 6; i++) await queueAccessReinforcement({ workspace_id: ws, note_id: used });
  confirmMemory({ auth: auth(owner, "owner"), note_id: used });
  const ids = (await recall({ workspace_id: ws, caller_agent_id: agent, is_admin: false, query: "kiwi warehouse delivery window", lifecycle: true }))
    .results.map((row: { id: string }) => row.id);
  expect(ids.indexOf(used)).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(used)).toBeLessThan(ids.indexOf(forgotten));
  // Soft: the forgotten note is still found, only lower, and still in the database.
  expect(ids).toContain(forgotten);
  expect(db.query("SELECT COUNT(*) AS n FROM notes WHERE id IN (?,?) AND deleted_at IS NULL").get(used, forgotten)).toEqual({ n: 2 });
});

test("the recall quality gate has hit@5 and latency thresholds and CI runs it", () => {
  const budgets = JSON.parse(fs.readFileSync("docs/v4/performance-budgets.json", "utf8"));
  expect(budgets.quality.exact_lexical_recall_at_5_min).toBeGreaterThanOrEqual(0.95);
  expect(budgets.quality.semantic_paraphrase_recall_at_5_min).toBeGreaterThanOrEqual(0.85);
  expect(budgets.quality.mixed_ru_en_recall_at_5_min).toBeGreaterThanOrEqual(0.85);
  expect(budgets.latency_ms.default_recall_p95_max).toBeGreaterThan(0);
  // The release image is built without .github; the checkout and CI have it.
  if (fs.existsSync(".github/workflows/ci.yml"))
    expect(fs.readFileSync(".github/workflows/ci.yml", "utf8")).toContain("benchmarks/v4/gate.ts --budgets docs/v4/performance-budgets.json");
  // The gate reads the quality thresholds, so a drop below them fails the job.
  const gate = fs.readFileSync("benchmarks/v4/gate.ts", "utf8");
  for (const key of ["exact_lexical_recall_at_5_min", "semantic_paraphrase_recall_at_5_min", "mixed_ru_en_recall_at_5_min", "default_recall_p95_max"]) expect(gate).toContain(key);
});
