// F-106: deleteNote already removes a soft-deleted note from notes_fts. When the
// task purge later hard-deletes it (notes_ad) or tombstones it (notes_au), the
// trigger sent a second FTS 'delete', so the stored row total drifted down for
// good; at the floor every later FTS delete fails with SQLITE_CORRUPT_VTAB.
import { expect, test } from "bun:test";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { createNote, deleteNote, updateNote } from "../src/services/notes.ts";
import { runMaintenance } from "../src/services/retention.ts";
import { reviseDraft } from "../src/skills/authority.ts";
import { digest } from "../src/skills/commands.ts";
import { completeContent, principalAuth } from "./helpers/p1-fixtures.ts";

/** nRow is the first SQLite varint of the FTS5 averages record (notes_fts_data id=1). */
function ftsStoredRowCount(): number {
  const block = (db.query("SELECT block FROM notes_fts_data WHERE id=1").get() as { block: Uint8Array }).block;
  let value = 0;
  for (const byte of block) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return value;
}

const indexedRows = () => (db.query("SELECT count(*) AS n FROM notes_fts_docsize").get() as { n: number }).n;

test("purging soft-deleted task-bound notes keeps notes_fts row totals exact", () => {
  runMigrations();
  db.query("INSERT INTO workspaces(id,name,slug) VALUES ('fts-drift-ws','FTS drift','fts-drift')").run();
  const owner = bootstrapOwner(db, "FTS drift owner", undefined, "fts-drift-ws");
  const ws = owner.workspace_id, agent = owner.agent_id;
  const live = [createNote({ workspace_id: ws, agent_id: agent, text: "driftlive one" }).id,
    createNote({ workspace_id: ws, agent_id: agent, text: "driftlive two" }).id];
  const task = createNote({ workspace_id: ws, agent_id: agent, type: "task", text: "drift task", metadata: { status: "open" } }).id;
  const bound = [0, 1, 2, 3].map((i) => createNote({ workspace_id: ws, agent_id: agent, text: `driftbound ${i}`, task_bound_id: task }).id);
  // A skill draft holds one bound note, so the purge tombstones it (notes_au) instead of deleting it (notes_ad).
  reviseDraft(principalAuth(db, agent), { slug: "fts-drift-skill", expected_revision: 0, content: completeContent,
    source_refs: [{ kind: "note", id: bound[0]!, digest: digest("driftbound 0") }], idempotency_key: "fts-drift-draft" }, db);
  for (const id of bound) deleteNote(ws, agent, id, false);
  db.query("UPDATE notes SET metadata=json_set(metadata,'$.status','done'), updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(task);
  expect(ftsStoredRowCount()).toBe(indexedRows());

  const result = runMaintenance();
  expect(result.report).toMatchObject({ notes_purged: 3, notes_tombstoned: 1 });
  expect(ftsStoredRowCount()).toBe(indexedRows());
  // FTS deletes keep working for every workspace after the purge.
  expect(deleteNote(ws, agent, live[0]!, false).deleted).toBe(true);
  updateNote({ workspace_id: ws, agent_id: agent, is_admin: false, id: live[1]!, text: "driftlive edited" });
  expect(ftsStoredRowCount()).toBe(indexedRows());
});
