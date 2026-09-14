import { db } from "../db/connection.ts";
import { safeJsonParse, nowIso, QoopiaError } from "../utils/errors.ts";

export interface BriefParams {
  workspace_id: string;
  /** QRERUN-003 / ADR-014: agent_id of the caller — needed to surface
   *  their own private notes alongside workspace-visibility ones. */
  caller_agent_id: string;
  /** QRERUN-003 / ADR-014: true for steward/claude-privileged; bypasses
   *  the private-note filter. */
  is_admin: boolean;
  project?: string;
  agent?: string;
  limit_per_section?: number;
}

interface NoteRowLite {
  id: string;
  text: string;
  metadata: string;
  agent_id: string | null;
  created_at: string;
  type: string;
}

export function brief(p: BriefParams) {
  const limit = Math.min(Math.max(p.limit_per_section || 10, 1), 50);

  // Resolve project: accept ULID or exact name
  let projectId: string | null = null;
  let projectName: string | null = null;
  if (p.project) {
    const byId = db
      .prepare(
        `SELECT id, text FROM notes WHERE id = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL`,
      )
      .get(p.project, p.workspace_id) as
      | { id: string; text: string }
      | undefined;
    if (byId) {
      projectId = byId.id;
      projectName = byId.text.split("\n")[0]!;
    } else {
      const byName = db
        .prepare(
          `SELECT id, text FROM notes WHERE text = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL LIMIT 1`,
        )
        .get(p.project, p.workspace_id) as
        | { id: string; text: string }
        | undefined;
      if (byName) {
        projectId = byName.id;
        projectName = byName.text.split("\n")[0]!;
      }
    }
    // If caller passed a project filter but it could not be resolved, fail fast.
    // Silently returning the whole workspace is misleading for agents.
    if (!projectId) {
      throw new QoopiaError("NOT_FOUND", `project '${p.project}' not found in workspace`);
    }
  }

  const extra: string[] = [];
  const extraParams: any[] = [];
  // QRERUN-003 / ADR-014: hide private notes from non-owners (admins exempt).
  // Always present so every note query in this function inherits the filter.
  extra.push(`(visibility = 'workspace' OR agent_id = ? OR ? = 1)`);
  extraParams.push(p.caller_agent_id, p.is_admin ? 1 : 0);
  if (projectId) {
    extra.push(`project_id = ?`);
    extraParams.push(projectId);
  }
  if (p.agent) {
    extra.push(
      `agent_id IN (SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1)`,
    );
    extraParams.push(p.agent, p.workspace_id);
  }
  const extraSql = extra.length ? " AND " + extra.join(" AND ") : "";

  // Open tasks
  const openTasks = db
    .prepare(
      `SELECT id, text, metadata, agent_id, created_at, type
       FROM notes
       WHERE workspace_id = ?
         AND type = 'task'
         AND deleted_at IS NULL
         AND (json_extract(metadata, '$.status') IS NULL OR json_extract(metadata, '$.status') NOT IN ('done', 'cancelled', 'archived'))
         ${extraSql}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(p.workspace_id, ...extraParams, limit) as NoteRowLite[];

  const openTasksTotalRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM notes
       WHERE workspace_id = ? AND type = 'task' AND deleted_at IS NULL
         AND (json_extract(metadata, '$.status') IS NULL OR json_extract(metadata, '$.status') NOT IN ('done', 'cancelled', 'archived'))
         ${extraSql}`,
    )
    .get(p.workspace_id, ...extraParams) as { c: number };

  const now = nowIso();
  const overdueRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM notes
       WHERE workspace_id = ? AND type = 'task' AND deleted_at IS NULL
         AND json_extract(metadata, '$.due_date') IS NOT NULL
         AND json_extract(metadata, '$.due_date') < ?
         AND (json_extract(metadata, '$.status') IS NULL OR json_extract(metadata, '$.status') NOT IN ('done', 'cancelled', 'archived'))
         ${extraSql}`,
    )
    .get(p.workspace_id, now, ...extraParams) as { c: number };

  // Recent notes
  const recentNotes = db
    .prepare(
      `SELECT id, text, metadata, agent_id, created_at, type
       FROM notes
       WHERE workspace_id = ?
         AND type IN ('note', 'memory', 'decision', 'knowledge', 'context')
         AND deleted_at IS NULL
         ${extraSql}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(p.workspace_id, ...extraParams, limit) as NoteRowLite[];

  const recentNotesTotal = db
    .prepare(
      `SELECT COUNT(*) as c FROM notes
       WHERE workspace_id = ? AND deleted_at IS NULL
         AND type IN ('note', 'memory', 'decision', 'knowledge', 'context')
         ${extraSql}`,
    )
    .get(p.workspace_id, ...extraParams) as { c: number };

  // Active deals
  const activeDeals = db
    .prepare(
      `SELECT id, text, metadata, agent_id, created_at, type
       FROM notes
       WHERE workspace_id = ? AND type = 'deal' AND deleted_at IS NULL
         AND (json_extract(metadata, '$.status') IS NULL OR json_extract(metadata, '$.status') = 'active')
         ${extraSql}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(p.workspace_id, ...extraParams, limit) as NoteRowLite[];

  const activeDealsTotal = db
    .prepare(
      `SELECT COUNT(*) as c FROM notes
       WHERE workspace_id = ? AND type = 'deal' AND deleted_at IS NULL
         AND (json_extract(metadata, '$.status') IS NULL OR json_extract(metadata, '$.status') = 'active')
         ${extraSql}`,
    )
    .get(p.workspace_id, ...extraParams) as { c: number };

  // Agent activity — M3 fix: apply agent filter consistently when specified
  // When project filter is active, notes_today is scoped to that project for consistency.
  //
  // QSA-B / Codex QSA-001 (2026-04-28): non-admin callers must only see their
  // own activity row. The prior version surfaced every active agent's name,
  // last_seen, and notes_today, and notes_today did not apply the private-note
  // visibility filter — leaking sibling identities and a count-based signal of
  // their private activity. p.agent is silently ignored for non-admins because
  // a non-admin filtering by another agent's name would just return an empty
  // set anyway.
  const agentActivityWhere: string[] = [`a.workspace_id = ?`, `a.active = 1`];
  const agentActivityParams: any[] = [p.workspace_id];
  if (!p.is_admin) {
    agentActivityWhere.push(`a.id = ?`);
    agentActivityParams.push(p.caller_agent_id);
  } else if (p.agent) {
    agentActivityWhere.push(`a.name = ?`);
    agentActivityParams.push(p.agent);
  }
  const notesTodayProjectFilter = projectId
    ? `AND n.project_id = '${projectId.replace(/'/g, "''")}'`
    : "";
  const agents = db
    .prepare(
      `SELECT a.id, a.name, a.last_seen,
         (SELECT COUNT(*) FROM notes n WHERE n.agent_id = a.id AND n.workspace_id = a.workspace_id
           AND n.deleted_at IS NULL AND datetime(n.created_at) >= datetime('now', '-1 day')
           ${notesTodayProjectFilter}) as notes_today
       FROM agents a WHERE ${agentActivityWhere.join(" AND ")}
       ORDER BY a.last_seen DESC`,
    )
    .all(...agentActivityParams) as Array<{
    id: string;
    name: string;
    last_seen: string | null;
    notes_today: number;
  }>;

  const preview = (r: NoteRowLite) => ({
    id: r.id,
    text: r.text.length > 500 ? r.text.slice(0, 500) : r.text,
    text_preview_only: r.text.length > 500,
    metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    agent_id: r.agent_id,
    created_at: r.created_at,
  });

  const agentActivity: Record<string, unknown> = {};
  for (const a of agents) {
    agentActivity[a.name] = {
      last_active: a.last_seen,
      notes_today: a.notes_today,
    };
  }

  const totalBytes = JSON.stringify({
    openTasks,
    recentNotes,
    activeDeals,
  }).length;
  const tokensReturned = Math.ceil(totalBytes / 4);

  return {
    workspace_id: p.workspace_id,
    project: projectName,
    project_resolved: p.project ? projectId !== null : undefined,
    open_tasks: {
      total: openTasksTotalRow.c,
      overdue: overdueRow.c,
      items: openTasks.map(preview),
    },
    recent_notes: {
      total: recentNotesTotal.c,
      items: recentNotes.map(preview),
    },
    active_deals: {
      total: activeDealsTotal.c,
      items: activeDeals.map(preview),
    },
    agent_activity: agentActivity,
    cost: { tokens_returned: tokensReturned },
  };
}
