/**
 * archive-stale: metadata.previous_status preservation (reversibility).
 *
 * Blocker for the 2026-05-13 batch archive of 22 task notes — the user
 * needs un-archive to recover the original business status ('done',
 * 'cancelled', etc.) not just the archived-vs-not bit. This suite locks
 * the invariant:
 *
 *   - non-null prior $.status → copied into $.previous_status,
 *     $.status is set to 'archived'
 *   - null prior $.status     → $.previous_status remains ABSENT
 *                               (no JSON-null pollution)
 *   - re-archive is a no-op   → previous_status preserved across reruns
 *   - round-trip restore via SQL undoes the archive cleanly
 *
 * The recall.ts include_archived filter still keys off
 * `metadata.status != 'archived'`, so it is intentionally NOT touched.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { sweep, type SweepRule } from "../scripts/archive-stale.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "Archive Previous Status",
    slug: "archive-previous-status",
  });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "aps-agent", workspaceSlug: ws.slug });
  AGENT_ID = a.id;
});

/**
 * Build a SweepRule that targets exactly one note by id. Decouples tests
 * from the time-based cutoffs baked into archive-stale's default rules
 * (those use module-load `NOW`, which is the run time of `bun test`).
 */
function ruleForId(id: string, label = "test-rule"): SweepRule {
  return {
    label,
    candidateSql: `id = ?`,
    candidateParams: [id],
  };
}

function getMetadata(id: string): Record<string, unknown> {
  const row = db
    .prepare(`SELECT metadata FROM notes WHERE id = ?`)
    .get(id) as { metadata: string | null } | undefined;
  if (!row || !row.metadata) return {};
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

describe("archive-stale: previous_status preservation", () => {
  test("done task → previous_status='done', status='archived', archived_at set", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "preserve-done task body",
      type: "task",
      metadata: { status: "done" },
    });

    const r = sweep(ruleForId(n.id), false);
    expect(r.matched).toBe(1);
    expect(r.archived).toBe(1);

    const md = getMetadata(n.id);
    expect(md.status).toBe("archived");
    expect(md.previous_status).toBe("done");
    expect(typeof md.archived_at).toBe("string");
    expect(md.archived_by).toBe("archive-stale.ts");
  });

  test("note with no $.status → previous_status absent (no JSON-null pollution)", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "no-status memory body",
      type: "memory",
      // metadata omitted on purpose — note has no $.status key
    });

    const r = sweep(ruleForId(n.id), false);
    expect(r.archived).toBe(1);

    const md = getMetadata(n.id);
    expect(md.status).toBe("archived");
    expect(Object.prototype.hasOwnProperty.call(md, "previous_status")).toBe(
      false,
    );
    expect(typeof md.archived_at).toBe("string");
  });

  test("round-trip: restore original 'done' status by reversing the two metadata keys", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "round-trip task body",
      type: "task",
      metadata: { status: "done" },
    });

    sweep(ruleForId(n.id), false);
    expect(getMetadata(n.id).status).toBe("archived");
    expect(getMetadata(n.id).previous_status).toBe("done");

    // Simulate the un-archive SQL the operator would run.
    db.prepare(
      `UPDATE notes
         SET metadata = json_remove(
               json_set(metadata, '$.status', json_extract(metadata, '$.previous_status')),
               '$.previous_status'
             )
       WHERE id = ?`,
    ).run(n.id);

    const md = getMetadata(n.id);
    expect(md.status).toBe("done");
    expect(Object.prototype.hasOwnProperty.call(md, "previous_status")).toBe(
      false,
    );
  });

  test("idempotent: re-archiving an already-archived note is a no-op and preserves original previous_status", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "idempotent cancelled task",
      type: "task",
      metadata: { status: "cancelled" },
    });

    const first = sweep(ruleForId(n.id), false);
    expect(first.archived).toBe(1);
    expect(getMetadata(n.id).previous_status).toBe("cancelled");

    // Second run — guard predicate (status='archived') must exclude it.
    const second = sweep(ruleForId(n.id), false);
    expect(second.matched).toBe(0);
    expect(second.archived).toBe(0);

    // Original preserved business status survived the rerun untouched.
    const md = getMetadata(n.id);
    expect(md.previous_status).toBe("cancelled");
    expect(md.status).toBe("archived");
  });

  test("type=memory note with no status archives cleanly (no previous_status key)", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "stale memory anchor body",
      type: "memory",
    });

    const r = sweep(ruleForId(n.id), false);
    expect(r.archived).toBe(1);

    const md = getMetadata(n.id);
    expect(md.status).toBe("archived");
    expect(Object.prototype.hasOwnProperty.call(md, "previous_status")).toBe(
      false,
    );
  });

  test("type=context note with status='in_progress' preserves it", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "context note with workflow status",
      type: "context",
      metadata: { status: "in_progress" },
    });

    const r = sweep(ruleForId(n.id), false);
    expect(r.archived).toBe(1);

    const md = getMetadata(n.id);
    expect(md.status).toBe("archived");
    expect(md.previous_status).toBe("in_progress");
  });

  test("dry-run does not modify the row", () => {
    const n = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "dry-run task body",
      type: "task",
      metadata: { status: "done" },
    });

    const r = sweep(ruleForId(n.id), true);
    expect(r.matched).toBe(1);
    expect(r.archived).toBe(0);

    const md = getMetadata(n.id);
    expect(md.status).toBe("done");
    expect(md.previous_status).toBeUndefined();
    expect(md.archived_at).toBeUndefined();
  });
});
