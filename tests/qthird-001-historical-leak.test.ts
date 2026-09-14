/**
 * QFOURTH-001 regression: prove that historical (pre-QTHIRD-001) activity
 * rows that leaked the first 80 chars of a private note's text into the
 * shared audit log are scrubbed and hidden from sibling agents.
 *
 * The scrub is implemented in migrations/007_scrub_legacy_private_activity.sql.
 * Tests exercise the same SQL idempotently against a manually-injected
 * pre-fix-style row, since runMigrations() in setup.ts has already
 * applied 007 to the test DB.
 *
 * Before fix:
 *   activity.summary = 'Created note: SECRET PAYLOAD ATTACKER WANTS...'
 *   activity.visibility = 'workspace'  (default after migration 006)
 *   listActivity (sibling)         → row visible
 *   recall(scope='activity', sib)  → row visible
 *
 * After fix:
 *   activity.summary    = 'Created note (private) [scrubbed by migration 007]'
 *   activity.visibility = 'private'
 *   sibling reads       → row hidden
 *   owner / admin reads → row visible, but with neutral summary
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "ulid";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { listActivity } from "../src/services/activity.ts";
import { recall } from "../src/services/recall.ts";
import { db } from "../src/db/connection.ts";
import { nowIso } from "../src/utils/errors.ts";

let WORKSPACE_ID = "";
let AGENT_A = "";
let AGENT_B = "";
let ADMIN_AGENT = "";
let B_PRIVATE_NOTE_ID = "";

const SECRET_PAYLOAD =
  "qfourth-leaked-secret super sensitive content from agent b";

// Replays migrations/007's scrub SQL — kept in TS so the test can
// re-execute it against rows manually injected into the DB at runtime
// (the migration itself has already been applied at suite startup).
function scrubLegacyPrivateActivity(): void {
  db.prepare(
    `UPDATE activity
        SET visibility = 'private',
            summary = 'Created note (private) [scrubbed by migration 007]'
      WHERE entity_type = 'note'
        AND action = 'created'
        AND visibility = 'workspace'
        AND entity_id IN (SELECT id FROM notes WHERE visibility = 'private')`,
  ).run();
  db.prepare(
    `UPDATE activity
        SET visibility = 'private',
            summary = 'Updated note (private) [scrubbed by migration 007]'
      WHERE entity_type = 'note'
        AND action = 'updated'
        AND visibility = 'workspace'
        AND entity_id IN (SELECT id FROM notes WHERE visibility = 'private')`,
  ).run();
  db.prepare(
    `UPDATE activity
        SET visibility = 'private',
            summary = 'Deleted note (private) [scrubbed by migration 007]'
      WHERE entity_type = 'note'
        AND action = 'deleted'
        AND visibility = 'workspace'
        AND entity_id IN (SELECT id FROM notes WHERE visibility = 'private')`,
  ).run();
}

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "QFOURTH Test",
    slug: "qfourth-test",
  });
  WORKSPACE_ID = ws.id;
  AGENT_A = createAgent({ name: "qfourth-a", workspaceSlug: ws.slug }).id;
  AGENT_B = createAgent({ name: "qfourth-b", workspaceSlug: ws.slug }).id;
  ADMIN_AGENT = createAgent({
    name: "qfourth-steward",
    workspaceSlug: ws.slug,
    type: "steward",
  }).id;

  // Create the private note via the current code path. This produces a
  // properly-stamped (private) activity row — but we then INSERT a
  // SECOND, hand-crafted row that matches the pre-fix layout (workspace
  // visibility + leaked text in summary) to simulate a row that
  // survived from before QTHIRD-001 landed.
  B_PRIVATE_NOTE_ID = createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_B,
    text: SECRET_PAYLOAD,
    visibility: "private",
  }).id;

  // Inject a legacy-style row (this is what existed in production
  // databases before the fix). visibility defaulted to 'workspace' and
  // the summary embedded the first 80 chars of the note text.
  db.prepare(
    `INSERT INTO activity
       (id, workspace_id, agent_id, action, entity_type, entity_id,
        project_id, summary, details, visibility, created_at)
     VALUES (?, ?, ?, 'created', 'note', ?, NULL, ?, '{}', 'workspace', ?)`,
  ).run(
    ulid(),
    WORKSPACE_ID,
    AGENT_B,
    B_PRIVATE_NOTE_ID,
    `Created note: ${SECRET_PAYLOAD.slice(0, 80)}`,
    nowIso(),
  );

  // Also a legacy 'updated' row — same shape.
  db.prepare(
    `INSERT INTO activity
       (id, workspace_id, agent_id, action, entity_type, entity_id,
        project_id, summary, details, visibility, created_at)
     VALUES (?, ?, ?, 'updated', 'note', ?, NULL, ?, '{}', 'workspace', ?)`,
  ).run(
    ulid(),
    WORKSPACE_ID,
    AGENT_B,
    B_PRIVATE_NOTE_ID,
    `Updated note: text — ${SECRET_PAYLOAD.slice(0, 60)}`,
    nowIso(),
  );

  // Run the scrub. This is what migration 007 does to historical data.
  scrubLegacyPrivateActivity();
});

describe("QFOURTH-001: historical leaked activity is scrubbed", () => {
  test("sibling listActivity does not see legacy leaked row", async () => {
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      entity_type: "note",
      limit: 100,
    });
    // No row referencing B's private note should reach a sibling.
    const ids = result.items.map((r) => r.entity_id);
    expect(ids).not.toContain(B_PRIVATE_NOTE_ID);
    // And the secret text must not appear in any summary.
    for (const r of result.items) {
      expect(r.summary).not.toContain(SECRET_PAYLOAD.slice(0, 30));
    }
  });

  test("sibling recall(scope='activity') does not see legacy leaked row", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      query: "qfourth-leaked-secret",
      scope: "activity",
      limit: 100,
    });
    for (const r of result.results) {
      expect(r.text).not.toContain(SECRET_PAYLOAD);
      expect(r.id).not.toBe(B_PRIVATE_NOTE_ID);
    }
  });

  test("sibling recall(scope='all') does not see legacy leaked row", async () => {
    const result = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_A,
      is_admin: false,
      query: "qfourth-leaked-secret",
      scope: "all",
      limit: 100,
    });
    for (const r of result.results) {
      expect(r.text).not.toContain(SECRET_PAYLOAD);
    }
  });

  test("owner sees scrubbed neutral summary, not the original leaked text", async () => {
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_B,
      is_admin: false,
      entity_type: "note",
      limit: 100,
    });
    const ownerRows = result.items.filter(
      (r) => r.entity_id === B_PRIVATE_NOTE_ID,
    );
    expect(ownerRows.length).toBeGreaterThanOrEqual(2); // legacy created + legacy updated
    for (const r of ownerRows) {
      // No row may carry the original payload anymore.
      expect(r.summary).not.toContain(SECRET_PAYLOAD.slice(0, 30));
    }
    // At least one row must carry the scrub marker so we know the
    // migration ran (vs. e.g. test-ordering accidentally producing a
    // pass).
    const scrubbed = ownerRows.filter((r) =>
      r.summary.includes("[scrubbed by migration 007]"),
    );
    expect(scrubbed.length).toBeGreaterThanOrEqual(2);
  });

  test("admin sees the scrubbed rows with the neutral summary", async () => {
    const result = listActivity({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: ADMIN_AGENT,
      is_admin: true,
      entity_type: "note",
      limit: 100,
    });
    const rows = result.items.filter((r) => r.entity_id === B_PRIVATE_NOTE_ID);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.summary).not.toContain(SECRET_PAYLOAD.slice(0, 30));
    }
  });

  test("scrub is idempotent — second run is a no-op", async () => {
    // Snapshot summaries, run scrub again, verify nothing changed.
    const before = db
      .prepare(
        `SELECT id, summary, visibility FROM activity
          WHERE entity_id = ? ORDER BY created_at`,
      )
      .all(B_PRIVATE_NOTE_ID);
    scrubLegacyPrivateActivity();
    const after = db
      .prepare(
        `SELECT id, summary, visibility FROM activity
          WHERE entity_id = ? ORDER BY created_at`,
      )
      .all(B_PRIVATE_NOTE_ID);
    expect(after).toEqual(before);
  });
});
