import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { getNote } from "./notes.ts";
import { logActivity } from "./activity.ts";
import { recordConflict } from "../utils/observability.ts";
import { assertWriteScope, isAdmin } from "../auth/principal.ts";

export const NOTE_RELATION_TYPES = [
  "supersedes",
  "conflicts_with",
  "supports",
  "derived_from",
] as const;

export type NoteRelationType = (typeof NOTE_RELATION_TYPES)[number];

interface RelationRow {
  id: string;
  workspace_id: string;
  source_note_id: string;
  target_note_id: string;
  relation_type: NoteRelationType;
  created_by_agent_id: string;
  metadata: string;
  created_at: string;
}




function relationOut(row: RelationRow) {
  return {
    ...row,
    metadata: safeJsonParse(row.metadata, {} as Record<string, unknown>),
  };
}

function normalizedEndpoints(
  sourceNoteId: string,
  targetNoteId: string,
  relationType: NoteRelationType,
): [string, string] {
  if (sourceNoteId === targetNoteId) {
    throw new QoopiaError("INVALID_INPUT", "a note cannot relate to itself");
  }
  if (relationType !== "conflicts_with") return [sourceNoteId, targetNoteId];
  return sourceNoteId < targetNoteId
    ? [sourceNoteId, targetNoteId]
    : [targetNoteId, sourceNoteId];
}

function assertRelationType(value: string): asserts value is NoteRelationType {
  if (!(NOTE_RELATION_TYPES as readonly string[]).includes(value)) {
    throw new QoopiaError("INVALID_INPUT", `unsupported relation_type: ${value}`);
  }
}

/**
 * Существует ли направленный supersedes-путь `fromNoteId -> … -> toNoteId`.
 * Экспортируется, чтобы V4.1 write-path (`note-temporal.ts`) применял ТУ ЖЕ
 * защиту от цикла, что и legacy-путь, а не собственную копию.
 */
export function supersedePathExists(
  workspaceId: string,
  fromNoteId: string,
  toNoteId: string,
): boolean {
  const row = db.prepare(
    `WITH RECURSIVE walk(id) AS (
       SELECT target_note_id
         FROM note_relations
        WHERE workspace_id = ? AND source_note_id = ? AND relation_type = 'supersedes'
       UNION
       SELECT r.target_note_id
         FROM note_relations r
         JOIN walk w ON r.source_note_id = w.id
        WHERE r.workspace_id = ? AND r.relation_type = 'supersedes'
     )
     SELECT 1 AS found FROM walk WHERE id = ? LIMIT 1`,
  ).get(workspaceId, fromNoteId, workspaceId, toNoteId) as
    | { found: number }
    | undefined;
  return !!row;
}

function supersedeComponent(workspaceId: string, noteId: string): string[] {
  const rows = db.prepare(
    `WITH RECURSIVE component(id) AS (
       SELECT ?
       UNION
       SELECT r.target_note_id
         FROM note_relations r JOIN component c ON r.source_note_id = c.id
        WHERE r.workspace_id = ? AND r.relation_type = 'supersedes'
       UNION
       SELECT r.source_note_id
         FROM note_relations r JOIN component c ON r.target_note_id = c.id
        WHERE r.workspace_id = ? AND r.relation_type = 'supersedes'
     )
     SELECT id FROM component ORDER BY id`,
  ).all(noteId, workspaceId, workspaceId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function componentState(workspaceId: string, noteId: string) {
  const noteIds = supersedeComponent(workspaceId, noteId);
  if (noteIds.length === 0) return { note_ids: [], active_heads: [], conflict: false };
  const placeholders = noteIds.map(() => "?").join(",");
  const targets = new Set(
    (
      db.prepare(
        `SELECT target_note_id
           FROM note_relations
          WHERE workspace_id = ? AND relation_type = 'supersedes'
            AND source_note_id IN (${placeholders})
            AND target_note_id IN (${placeholders})`,
      ).all(workspaceId, ...noteIds, ...noteIds) as Array<{ target_note_id: string }>
    ).map((row) => row.target_note_id),
  );
  const activeHeads = noteIds.filter((id) => !targets.has(id)).sort();
  return {
    note_ids: noteIds,
    active_heads: activeHeads,
    conflict: activeHeads.length > 1,
  };
}

function visibleComponentState(auth: AuthContext, noteId: string) {
  const rows = db.prepare(
    `SELECT source_note_id, target_note_id
       FROM note_relations
      WHERE workspace_id = ? AND relation_type = 'supersedes'
      ORDER BY source_note_id, target_note_id`,
  ).all(auth.workspace_id) as Array<{
    source_note_id: string;
    target_note_id: string;
  }>;
  const visibility = new Map<string, boolean>();
  const visible = (id: string): boolean => {
    const cached = visibility.get(id);
    if (cached !== undefined) return cached;
    try {
      getNote(auth.workspace_id, id, auth.agent_id, isAdmin(auth));
      visibility.set(id, true);
      return true;
    } catch {
      visibility.set(id, false);
      return false;
    }
  };
  const edges = rows.filter((row) => visible(row.source_note_id) && visible(row.target_note_id));
  const adjacency = new Map<string, Set<string>>();
  for (const row of edges) {
    if (!adjacency.has(row.source_note_id)) adjacency.set(row.source_note_id, new Set());
    if (!adjacency.has(row.target_note_id)) adjacency.set(row.target_note_id, new Set());
    adjacency.get(row.source_note_id)!.add(row.target_note_id);
    adjacency.get(row.target_note_id)!.add(row.source_note_id);
  }
  const component = new Set([noteId]);
  const queue = [noteId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (component.has(next)) continue;
      component.add(next);
      queue.push(next);
    }
  }
  const noteIds = [...component].sort();
  const targets = new Set(
    edges
      .filter((row) => component.has(row.source_note_id) && component.has(row.target_note_id))
      .map((row) => row.target_note_id),
  );
  const activeHeads = noteIds.filter((id) => !targets.has(id)).sort();
  return {
    note_ids: noteIds,
    active_heads: activeHeads,
    conflict: activeHeads.length > 1,
    incomplete: false,
  };
}

function nextNoteTimestamp(
  workspaceId: string,
  noteIds: string[],
): { iso: string; ms: number } {
  const placeholders = noteIds.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COALESCE(MAX(updated_at_ms), 0) AS max_ms
       FROM notes WHERE workspace_id = ? AND id IN (${placeholders})`,
  ).get(workspaceId, ...noteIds) as { max_ms: number };
  const global = db.prepare(
    `SELECT COALESCE(MAX(updated_at_ms), 0) AS max_ms
       FROM notes WHERE workspace_id = ?`,
  ).get(workspaceId) as { max_ms: number };
  const ms = Math.max(Date.now(), row.max_ms + 1, global.max_ms + 1);
  return { iso: new Date(ms).toISOString(), ms };
}

/**
 * Create an immutable relation. Supersede mirror metadata, archive state and
 * audit activity are committed atomically with the relation row.
 */
export function createNoteRelation(input: {
  auth: AuthContext;
  source_note_id: string;
  target_note_id: string;
  relation_type: NoteRelationType;
  metadata?: Record<string, unknown>;
}) {
  assertWriteScope(input.auth);
  assertRelationType(input.relation_type);
  const [sourceNoteId, targetNoteId] = normalizedEndpoints(
    input.source_note_id,
    input.target_note_id,
    input.relation_type,
  );
  if (input.metadata) {
    assertNoSecrets(JSON.stringify(input.metadata), "note_relation.metadata");
  }

  // Visibility checks deliberately happen before graph inspection so private
  // note existence cannot be inferred through cycle/head errors.
  const source = getNote(
    input.auth.workspace_id,
    sourceNoteId,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  const target = getNote(
    input.auth.workspace_id,
    targetNoteId,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  if (
    (source.visibility === "private" || target.visibility === "private") &&
    !(
      source.visibility === "private" &&
      target.visibility === "private" &&
      source.agent_id !== null &&
      source.agent_id === target.agent_id
    )
  ) {
    throw new QoopiaError("NOT_FOUND", "relation endpoint not found");
  }

  if (
    input.relation_type === "supersedes" &&
    supersedePathExists(input.auth.workspace_id, targetNoteId, sourceNoteId)
  ) {
    recordConflict("relation");
    throw new QoopiaError("CONFLICT", "supersede relation would create a cycle");
  }

  const id = ulid();
  const createdAt = nowIso();
  const result = db.transaction(() => {
    // Recheck both rows within the write transaction.
    const currentSource = getNote(
      input.auth.workspace_id,
      sourceNoteId,
      input.auth.agent_id,
      isAdmin(input.auth),
    );
    const currentTarget = getNote(
      input.auth.workspace_id,
      targetNoteId,
      input.auth.agent_id,
      isAdmin(input.auth),
    );
    if (
      (currentSource.visibility === "private" || currentTarget.visibility === "private") &&
      !(
        currentSource.visibility === "private" &&
        currentTarget.visibility === "private" &&
        currentSource.agent_id !== null &&
        currentSource.agent_id === currentTarget.agent_id
      )
    ) {
      throw new QoopiaError("NOT_FOUND", "relation endpoint not found");
    }
    if (
      input.relation_type === "supersedes" &&
      supersedePathExists(input.auth.workspace_id, targetNoteId, sourceNoteId)
    ) {
      throw new QoopiaError("CONFLICT", "supersede relation would create a cycle");
    }

    const existing = db.prepare(
      `SELECT * FROM note_relations
        WHERE workspace_id = ? AND source_note_id = ? AND target_note_id = ?
          AND relation_type = ?`,
    ).get(
      input.auth.workspace_id,
      sourceNoteId,
      targetNoteId,
      input.relation_type,
    ) as RelationRow | undefined;
    if (existing) {
      const state = input.relation_type === "supersedes"
        ? componentState(input.auth.workspace_id, sourceNoteId)
        : null;
      return { created: false, relation: relationOut(existing), chain: state };
    }

    db.prepare(
      `INSERT INTO note_relations
         (id, workspace_id, source_note_id, target_note_id, relation_type,
          created_by_agent_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.auth.workspace_id,
      sourceNoteId,
      targetNoteId,
      input.relation_type,
      input.auth.agent_id,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    );

    if (input.relation_type === "supersedes") {
      const sourceMetadata = {
        ...(currentSource.metadata as Record<string, unknown>),
        supersedes: targetNoteId,
      };
      const targetMetadata = {
        ...(currentTarget.metadata as Record<string, unknown>),
        superseded_by: sourceNoteId,
        status: "archived",
      };
      assertNoSecrets(JSON.stringify(sourceMetadata), "note.metadata");
      assertNoSecrets(JSON.stringify(targetMetadata), "note.metadata");
      const timestamp = nextNoteTimestamp(
        input.auth.workspace_id,
        [sourceNoteId, targetNoteId],
      );
      const targetMs = timestamp.ms + 1;
      db.prepare(
        `UPDATE notes SET metadata = ?, updated_at = ?, updated_at_ms = ?
          WHERE id = ? AND workspace_id = ?`,
      ).run(
        JSON.stringify(sourceMetadata),
        timestamp.iso,
        timestamp.ms,
        sourceNoteId,
        input.auth.workspace_id,
      );
      db.prepare(
        `UPDATE notes SET metadata = ?, updated_at = ?, updated_at_ms = ?
          WHERE id = ? AND workspace_id = ?`,
      ).run(
        JSON.stringify(targetMetadata),
        new Date(targetMs).toISOString(),
        targetMs,
        targetNoteId,
        input.auth.workspace_id,
      );
    }

    logActivity({
      workspace_id: input.auth.workspace_id,
      agent_id: input.auth.agent_id,
      action: "relation_created",
      entity_type: "note_relation",
      entity_id: id,
      project_id: null,
      summary: `Created ${input.relation_type} note relation`,
      details: {
        relation_id: id,
        source_note_id: sourceNoteId,
        target_note_id: targetNoteId,
        relation_type: input.relation_type,
      },
      visibility:
        source.visibility === "private" || target.visibility === "private"
          ? "private"
          : "workspace",
    });

    const row = db.prepare(`SELECT * FROM note_relations WHERE id = ?`).get(id) as RelationRow;
    const state = input.relation_type === "supersedes"
      ? componentState(input.auth.workspace_id, sourceNoteId)
      : null;
    return { created: true, relation: relationOut(row), chain: state };
  })();

  if (result.created && input.relation_type === "conflicts_with") recordConflict("relation");
  return result;
}

export function listNoteRelations(input: {
  auth: AuthContext;
  note_id: string;
  relation_type?: NoteRelationType;
}) {
  getNote(
    input.auth.workspace_id,
    input.note_id,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  if (input.relation_type) assertRelationType(input.relation_type);
  const params: any[] = [
    input.auth.workspace_id,
    input.note_id,
    input.note_id,
  ];
  const typeSql = input.relation_type ? " AND relation_type = ?" : "";
  if (input.relation_type) params.push(input.relation_type);
  const rows = db.prepare(
    `SELECT * FROM note_relations
      WHERE workspace_id = ? AND (source_note_id = ? OR target_note_id = ?)${typeSql}
      ORDER BY created_at ASC, id ASC`,
  ).all(...params) as RelationRow[];

  // A row is returned only when both endpoints remain visible to this caller.
  const visible = rows.filter((row) => {
    try {
      getNote(input.auth.workspace_id, row.source_note_id, input.auth.agent_id, isAdmin(input.auth));
      getNote(input.auth.workspace_id, row.target_note_id, input.auth.agent_id, isAdmin(input.auth));
      return true;
    } catch {
      return false;
    }
  });
  return { items: visible.map(relationOut), count: visible.length };
}

export function getSupersedeChain(input: { auth: AuthContext; note_id: string }) {
  getNote(
    input.auth.workspace_id,
    input.note_id,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  // Build the connected component only from edges whose two endpoints are
  // already visible. Hidden rows cannot affect IDs, head counts or flags.
  return visibleComponentState(input.auth, input.note_id);
}
