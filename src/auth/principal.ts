/**
 * Principal-level authorisation helpers.
 *
 * These three were previously copy-pasted across eleven modules. One copy
 * had drifted: recall-feedback also accepted `mcp:admin`, while four others
 * required `mcp:write` alone. The drifting copy was the correct one —
 * grantedScopeAllowsRisk, which the MCP dispatcher already applies before a
 * tool handler runs, treats `mcp:admin` as covering every lower risk class.
 * The four strict copies could therefore refuse a call the dispatcher had
 * just allowed. Scope evaluation now delegates to that single helper so the
 * two layers cannot disagree again.
 */
import type { Database } from "bun:sqlite";
import type { AuthContext } from "./middleware.ts";
import { grantedScopeAllowsRisk } from "./oauth.ts";
import { db } from "../db/connection.ts";
import { QoopiaError, safeJsonParse } from "../utils/errors.ts";

/**
 * ADR-020: workspace MANAGE rights (OAuth client registration and consent, audit rows through
 * the V2 compat alias, backup/ops health) belong to the steward and the human owner only. A
 * legacy 'claude-privileged' row keeps its type string but is an ordinary agent everywhere.
 */
export const ADMIN_TYPES = new Set(["owner", "steward"]);

export function isAdmin(auth: AuthContext): boolean {
  return ADMIN_TYPES.has(auth.type);
}

/** The caller's agent row as it is now, null once deactivated: re-read inside a write transaction. */
export function liveActor(auth: AuthContext): { type: string; tool_profile: string | null } | null {
  return db.query("SELECT type, tool_profile FROM agents WHERE workspace_id = ? AND id = ? AND active = 1")
    .get(auth.workspace_id, auth.agent_id) as { type: string; tool_profile: string | null } | null;
}

// ---- ADR-020: one visibility rule for notes, transcripts and activity ----

/** The steward and the human owner read the whole workspace, private notes included. */
export function seesWholeWorkspace(auth: { type: string }): boolean {
  return ADMIN_TYPES.has(auth.type);
}

/**
 * The agent's shared-context toggle, stored as agents.metadata.shared_context. Absent (every
 * agent at onboarding) means on; only an explicit false turns it off. It is read on every call,
 * so a switch takes effect at once and no auth cache can hold a stale value.
 */
export function sharesContext(agentId: string, database: Database = db): boolean {
  const row = database.query("SELECT metadata FROM agents WHERE id = ? AND active = 1").get(agentId) as { metadata: string } | null;
  return !!row && safeJsonParse<Record<string, unknown> | null>(row.metadata, {})?.shared_context !== false;
}

/** 0: own rows only. 1: also the sibling agents' shared rows. 2: every row of the workspace. */
type ReadLevel = 0 | 1 | 2;

/** `wholeWorkspace` is seesWholeWorkspace(auth), or true for a trusted server-side caller. */
export function readLevel(agentId: string, wholeWorkspace: boolean, database: Database = db): ReadLevel {
  return wholeWorkspace ? 2 : sharesContext(agentId, database) ? 1 : 0;
}

export const levelOf = (auth: { agent_id: string; type: string }): ReadLevel =>
  readLevel(auth.agent_id, seesWholeWorkspace(auth));

/**
 * ADR-020 open point: a note (and its activity row) marked visibility 'private' stays hidden
 * from shared-context siblings — only its author, the steward and the owner read it. Set this
 * to true if shared-context agents should read private notes too.
 */
const SHARED_CONTEXT_READS_PRIVATE: boolean = false;

/** A notes or activity row the caller may read. Binds (caller agent id, ReadLevel). */
export function visibleRowSql(alias?: string): string {
  const a = alias ? `${alias}.` : "";
  const shared = SHARED_CONTEXT_READS_PRIVATE ? "1" : `${a}visibility = 'workspace'`;
  return `(${a}agent_id = ? OR CASE ? WHEN 2 THEN 1 WHEN 1 THEN ${shared} ELSE 0 END)`;
}

/** A session transcript row the caller may read; transcripts have no private flag. Binds (caller agent id, ReadLevel). */
export function visibleTranscriptSql(alias?: string): string {
  return `(${alias ? `${alias}.` : ""}agent_id = ? OR ? > 0)`;
}

/** visibleRowSql for a row already in hand. */
export function canReadRow(row: { agent_id: string | null; visibility?: string | null }, agentId: string, level: ReadLevel): boolean {
  if (row.agent_id === agentId || level === 2) return true;
  return level === 1 && (SHARED_CONTEXT_READS_PRIVATE || (row.visibility ?? "workspace") === "workspace");
}

/**
 * OWNER DECISION 2026-10-04 (ADR-020, F-335): shared context is read-only. Only the note's
 * author, the steward and the owner change it (update, tags, supersede/archive) or delete it;
 * a sibling that reads it through shared context gets FORBIDDEN with the next action. Call it
 * after the read check, so a note the caller cannot see still answers NOT_FOUND.
 * `wholeWorkspace` is seesWholeWorkspace(auth), or true for a trusted server-side caller.
 */
export function assertCanModifyNote(
  row: { id: string; agent_id: string | null },
  agentId: string,
  wholeWorkspace: boolean,
  database: Database = db,
): void {
  if (wholeWorkspace || row.agent_id === agentId) return;
  const author = row.agent_id
    ? (database.query("SELECT name FROM agents WHERE id = ?").get(row.agent_id) as { name: string } | null)?.name
    : undefined;
  const who = author ?? "another agent";
  const next_action = `Ask ${who} or the steward to change it, or add your own note.`;
  throw new QoopiaError(
    "FORBIDDEN",
    `note ${row.id} belongs to ${who}; shared context is read-only. ${next_action}`,
    { next_action, author_agent_id: row.agent_id },
  );
}

/**
 * Reject an OAuth caller whose granted scope does not cover a write-low
 * operation. API-key callers carry no granted scope and are governed by
 * their tool profile instead, so they pass through untouched.
 */
export function assertWriteScope(auth: AuthContext): void {
  if (auth.source !== "oauth") return;
  if (grantedScopeAllowsRisk(auth.granted_scope, "write-low")) return;
  throw new QoopiaError("FORBIDDEN", "mcp:write scope is required");
}
