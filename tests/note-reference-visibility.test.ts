// A project_id / task_bound_id names a note the caller may read: another agent's private
// note answers exactly like a missing one, so a reference cannot probe that it exists.
import { beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, updateNote } from "../src/services/notes.ts";

let ws = "", alice = "", bob = "", steward = "", privateTask = "", sharedTask = "", own = "";
const errorOf = (f: () => unknown) => { try { f(); } catch (error) { return error as { code: string; message: string }; } throw new Error("expected a refusal"); };

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Reference visibility", slug: "note-reference-visibility" });
  ws = w.id;
  alice = createAgent({ name: "ref-alice", workspaceSlug: w.slug }).id;
  bob = createAgent({ name: "ref-bob", workspaceSlug: w.slug }).id;
  steward = createAgent({ name: "ref-steward", workspaceSlug: w.slug, type: "steward" }).id;
  privateTask = (createNote({ workspace_id: ws, agent_id: alice, type: "task", text: "alice private task", visibility: "private" }) as { id: string }).id;
  sharedTask = (createNote({ workspace_id: ws, agent_id: alice, type: "task", text: "alice shared task" }) as { id: string }).id;
  own = (createNote({ workspace_id: ws, agent_id: bob, text: "bob note" }) as { id: string }).id;
});

test("another agent's private task is answered like a missing one, on create and update", () => {
  const missing = errorOf(() => createNote({ workspace_id: ws, agent_id: bob, text: "x", task_bound_id: "01NOSUCHNOTE00000000000000" }));
  expect(errorOf(() => createNote({ workspace_id: ws, agent_id: bob, text: "x", task_bound_id: privateTask }))).toEqual(missing);
  expect(errorOf(() => updateNote({ workspace_id: ws, agent_id: bob, is_admin: false, id: own, task_bound_id: privateTask }))).toMatchObject({ code: "NOT_FOUND" });
  expect(errorOf(() => createNote({ workspace_id: ws, agent_id: bob, text: "x", project_id: privateTask }))).toMatchObject({ code: "NOT_FOUND" });
});

test("readable tasks stay referable: shared, own private, and anything for the steward", () => {
  expect(createNote({ workspace_id: ws, agent_id: bob, text: "on shared", task_bound_id: sharedTask })).toHaveProperty("id");
  expect(createNote({ workspace_id: ws, agent_id: alice, text: "on own", task_bound_id: privateTask })).toHaveProperty("id");
  expect(createNote({ workspace_id: ws, agent_id: steward, text: "steward", task_bound_id: privateTask })).toHaveProperty("id");
  expect(errorOf(() => createNote({ workspace_id: ws, agent_id: bob, text: "x", task_bound_id: own }))).toMatchObject({ code: "INVALID_INPUT" });
});
