import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { nowIso } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { timeBoundSql } from "../utils/temporal.ts";
import { readLevel, visibleRowSql } from "../auth/principal.ts";

/**
 * A4-02: every event Qoopia records itself carries a stable code and its parameters in
 * details.event / details.params. Clients (the dashboard, activity_list) phrase the event from
 * them in the reader's language; `summary` stays an English sentence for older clients.
 */
export const ACTIVITY_EVENTS = [
  "note.created", "note.updated", "note.deleted", "note.superseded", "note.relation.created",
  "file.uploaded", "file.deleted",
  "agentcomm.session.created", "agentcomm.session.closed", "agentcomm.message.sent",
  "agentcomm.wake.woken", "agentcomm.wake.failed", "agentcomm.wake.ignored",
  "agent.onboarded", "agent.onboarded_with_role", "agent.deactivated", "agent.profile_changed",
  "agent.autosave.on", "agent.autosave.off", "agent.shared_context.on", "agent.shared_context.off",
  "agent.dreamer.on", "agent.dreamer.off",
  "canon.created", "canon.superseded", "canon.retired", "canon.imported",
  "extraction.candidate.accepted", "extraction.candidate.edited", "extraction.candidate.rejected",
] as const;
export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];
type ActivityParams = Record<string, string | number | boolean | null>;

// Rows written by notes.ts (and rows from before A4-02) name their event only by action.
const LEGACY_EVENTS: Record<string, ActivityEvent> = {
  "note:created": "note.created", "note:updated": "note.updated", "note:deleted": "note.deleted",
  "note:note_superseded": "note.superseded", "note_relation:relation_created": "note.relation.created",
  "agent_comm_session:agent_session_close": "agentcomm.session.closed",
};
const KNOWN = new Set<string>(ACTIVITY_EVENTS);

/** The event code and parameters of a stored row; null for an event Qoopia did not phrase (an agent's own summary). */
export function activityEvent(row: { action: string; entity_type: string; details: unknown }): { event: ActivityEvent | null; params: ActivityParams | null } {
  const d = row.details as { event?: unknown; params?: unknown } | null;
  if (d && typeof d.event === "string" && KNOWN.has(d.event))
    return { event: d.event as ActivityEvent, params: d.params && typeof d.params === "object" ? d.params as ActivityParams : {} };
  const legacy = LEGACY_EVENTS[row.entity_type + ":" + row.action];
  return legacy ? { event: legacy, params: {} } : { event: null, params: null };
}

interface ActivityInput {
  workspace_id: string;
  agent_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  summary: string;
  details?: Record<string, unknown>;
  event?: ActivityEvent;
  params?: ActivityParams;
  /**
   * QTHIRD-001: stamp the activity row with the visibility of the entity
   * it describes. listActivity / recall(scope='activity'|'all') filter on
   * this column so a private note's activity (and its 80-char preview)
   * never leaks to non-owner non-admin callers. Defaults to 'workspace'
   * to preserve historical behavior for non-private events.
   */
  visibility?: "workspace" | "private";
}

export function logActivity(input: ActivityInput): string {
  const details = input.event ? { ...input.details, event: input.event, params: input.params ?? {} } : input.details;
  // Secret guard: reject if summary or details contain an API key pattern
  assertNoSecrets(input.summary, "activity.summary");
  if (details) {
    assertNoSecrets(JSON.stringify(details), "activity.details");
  }

  const id = ulid();
  const visibility = input.visibility === "private" ? "private" : "workspace";
  db.prepare(
    `INSERT INTO activity (id, workspace_id, agent_id, action, entity_type, entity_id, project_id, summary, details, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.agent_id,
    input.action,
    input.entity_type,
    input.entity_id,
    input.project_id,
    input.summary,
    JSON.stringify(details || {}),
    visibility,
    nowIso(),
  );
  return id;
}

interface ActivityListParams {
  workspace_id: string;
  /** QTHIRD-001: caller agent_id — needed to surface their own private
   *  activity rows alongside workspace-visibility ones. */
  caller_agent_id: string;
  /** ADR-020: true for the steward and the owner — every row; otherwise the
   *  caller's shared-context toggle decides (visibleRowSql). */
  is_admin: boolean;
  entity_type?: string;
  entity_id?: string;
  project_id?: string;
  agent?: string; // by name — resolves via agents
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export function listActivity(p: ActivityListParams) {
  const where: string[] = [`a.workspace_id = ?`];
  const params: any[] = [p.workspace_id];

  // QTHIRD-001 / ADR-020: siblings' rows only with shared context, never their private notes' rows.
  where.push(visibleRowSql("a"));
  params.push(p.caller_agent_id, readLevel(p.caller_agent_id, p.is_admin));


  if (p.entity_type) {
    where.push(`a.entity_type = ?`);
    params.push(p.entity_type);
  }
  if (p.entity_id) {
    where.push(`a.entity_id = ?`);
    params.push(p.entity_id);
  }
  if (p.project_id) {
    where.push(`a.project_id = ?`);
    params.push(p.project_id);
  }
  if (p.action) {
    where.push(`a.action = ?`);
    params.push(p.action);
  }
  if (p.agent) {
    where.push(
      `a.agent_id IN (SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1)`,
    );
    params.push(p.agent, p.workspace_id);
  }
  // Stored timestamps mix second and ms precision, so compare moments, not text.
  for (const side of ["since", "until"] as const) {
    if (!p[side]) continue;
    const bound = timeBoundSql("a.created_at", side, p[side]);
    where.push(bound.sql);
    params.push(...bound.params);
  }

  const limit = Math.min(Math.max(p.limit || 50, 1), 500);
  const sql = `SELECT a.id, a.action, a.entity_type, a.entity_id, a.project_id, a.agent_id,
                      ag.name as agent_name,
                      a.summary, a.details, a.created_at
               FROM activity a
               LEFT JOIN agents ag ON ag.id = a.agent_id
               WHERE ${where.join(" AND ")}
               ORDER BY a.created_at DESC
               LIMIT ?`;
  const items = db.prepare(sql).all(...params, limit) as Array<{
    id: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    project_id: string | null;
    agent_id: string | null;
    agent_name: string | null;
    summary: string;
    details: string;
    created_at: string;
  }>;

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM activity a WHERE ${where.join(" AND ")}`,
    )
    .get(...params) as { c: number };

  return {
    items: items.map((r) => {
      const details = safeParse(r.details);
      return { ...r, details, ...activityEvent({ ...r, details }) };
    }),
    total: totalRow.c,
    limit,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
