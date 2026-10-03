// F-102: the "created" activity row must not copy note text. Otherwise a deleted
// note, or text edited away, stays readable by every workspace agent through
// recall(scope=activity|all) and activity_list.
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, deleteNote, updateNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import { listActivity } from "../src/services/activity.ts";

let ws = "", author = "", reader = "";

beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Activity note preview", slug: "activity-note-preview" });
  ws = w.id;
  author = createAgent({ name: "preview-author", workspaceSlug: w.slug }).id;
  reader = createAgent({ name: "preview-reader", workspaceSlug: w.slug }).id;
});

async function readerSees(word: string): Promise<string> {
  const seen: string[] = [];
  for (const scope of ["activity", "all"] as const) {
    const r = await recall({ workspace_id: ws, caller_agent_id: reader, is_admin: false, query: word, mode: "fts5", scope });
    seen.push(...r.results.map((row) => row.text));
  }
  seen.push(...listActivity({ workspace_id: ws, caller_agent_id: reader, is_admin: false }).items.map((row: { summary: string }) => row.summary));
  return seen.join("\n");
}

describe("activity rows carry no note body", () => {
  test("a deleted note's text is not recallable by another agent", async () => {
    const id = createNote({ workspace_id: ws, agent_id: author, text: "kumquatpassphrase vault code 7781" }).id;
    deleteNote(ws, author, id, false);
    expect(await readerSees("kumquatpassphrase")).not.toContain("kumquatpassphrase");
  });

  test("text edited away is not recallable by another agent", async () => {
    const id = createNote({ workspace_id: ws, agent_id: author, text: "plumtreecipher wrong fact" }).id;
    updateNote({ workspace_id: ws, agent_id: author, is_admin: false, id, text: "corrected fact" });
    expect(await readerSees("plumtreecipher")).not.toContain("plumtreecipher");
  });
});
