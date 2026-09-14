/**
 * src/admin/claude-agents.ts — Phase 7a
 *
 * Admin functions for the claude_code_agents allowlist:
 * - registerClaudeAgent  (CLI: register-claude-agent)
 * - enableAutosession    (CLI: enable-autosession)
 * - disableAutosession   (CLI: disable-autosession)
 * - listClaudeAgents
 */

import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";

export interface ClaudeAgentRecord {
  id: string;
  workspace_id: string;
  agent_id: string;
  cwd_prefix: string;
  autosession_enabled: number;
  created_at: string;
}

/**
 * Register a cwd_prefix → agent mapping in the allowlist.
 * Throws CONFLICT if (workspace_id, cwd_prefix) already exists.
 */
export function registerClaudeAgent(opts: {
  workspaceSlug: string;
  agentName: string;
  cwdPrefix: string;
  autosessionEnabled?: boolean;
}): ClaudeAgentRecord {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(opts.workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace '${opts.workspaceSlug}' not found`);

  const agent = db
    .prepare(`SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1`)
    .get(opts.agentName, ws.id) as { id: string } | undefined;
  if (!agent)
    throw new QoopiaError("NOT_FOUND", `active agent '${opts.agentName}' not found in workspace '${opts.workspaceSlug}'`);

  const id = ulid();
  const enabled = opts.autosessionEnabled !== false ? 1 : 0;
  try {
    db.prepare(
      `INSERT INTO claude_code_agents (id, workspace_id, agent_id, cwd_prefix, autosession_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, ws.id, agent.id, opts.cwdPrefix, enabled, nowIso());
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("UNIQUE constraint failed")) {
      throw new QoopiaError(
        "CONFLICT",
        `cwd_prefix '${opts.cwdPrefix}' already registered in workspace '${opts.workspaceSlug}'`,
      );
    }
    throw err;
  }

  return db
    .prepare(`SELECT * FROM claude_code_agents WHERE id = ?`)
    .get(id) as ClaudeAgentRecord;
}

/**
 * Enable autosession ingestion for a registered cwd_prefix.
 */
export function enableAutosession(opts: {
  workspaceSlug: string;
  cwdPrefix: string;
}): { cwd_prefix: string; autosession_enabled: true } {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(opts.workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace '${opts.workspaceSlug}' not found`);

  const info = db
    .prepare(
      `UPDATE claude_code_agents SET autosession_enabled = 1
       WHERE workspace_id = ? AND cwd_prefix = ?`,
    )
    .run(ws.id, opts.cwdPrefix);
  if (info.changes === 0)
    throw new QoopiaError("NOT_FOUND", `cwd_prefix '${opts.cwdPrefix}' not registered`);
  return { cwd_prefix: opts.cwdPrefix, autosession_enabled: true };
}

/**
 * Disable autosession ingestion (pause without deleting the mapping).
 */
export function disableAutosession(opts: {
  workspaceSlug: string;
  cwdPrefix: string;
}): { cwd_prefix: string; autosession_enabled: false } {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(opts.workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace '${opts.workspaceSlug}' not found`);

  const info = db
    .prepare(
      `UPDATE claude_code_agents SET autosession_enabled = 0
       WHERE workspace_id = ? AND cwd_prefix = ?`,
    )
    .run(ws.id, opts.cwdPrefix);
  if (info.changes === 0)
    throw new QoopiaError("NOT_FOUND", `cwd_prefix '${opts.cwdPrefix}' not registered`);
  return { cwd_prefix: opts.cwdPrefix, autosession_enabled: false };
}

/**
 * List all registered Claude Code agents in a workspace.
 */
export function listClaudeAgents(workspaceSlug: string): Array<{
  id: string;
  agent_name: string;
  cwd_prefix: string;
  autosession_enabled: number;
  created_at: string;
}> {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace '${workspaceSlug}' not found`);

  return db
    .prepare(
      `SELECT c.id, a.name as agent_name, c.cwd_prefix, c.autosession_enabled, c.created_at
       FROM claude_code_agents c
       JOIN agents a ON a.id = c.agent_id
       WHERE c.workspace_id = ?
       ORDER BY c.cwd_prefix`,
    )
    .all(ws.id) as Array<{
      id: string;
      agent_name: string;
      cwd_prefix: string;
      autosession_enabled: number;
      created_at: string;
    }>;
}

/**
 * Get the allowlist for the tailer daemon.
 * Only returns entries where autosession_enabled = 1.
 *
 * If workspace_id is provided, returns only entries for that workspace
 * (hard isolation — tailer видит только агентов своего workspace).
 * Если workspace_id не передан — возвращает глобальный список (для
 * admin/migration-сценариев, НЕ для обслуживания ingest-daemon запросов).
 */
export function getAllowlist(workspace_id?: string): Array<{
  cwd_prefix: string;
  agent_id: string;
  workspace_id: string;
  autosession_enabled: number;
}> {
  if (workspace_id) {
    return db
      .prepare(
        `SELECT cwd_prefix, agent_id, workspace_id, autosession_enabled
         FROM claude_code_agents
         WHERE autosession_enabled = 1 AND workspace_id = ?`,
      )
      .all(workspace_id) as Array<{
        cwd_prefix: string;
        agent_id: string;
        workspace_id: string;
        autosession_enabled: number;
      }>;
  }
  return db
    .prepare(
      `SELECT cwd_prefix, agent_id, workspace_id, autosession_enabled
       FROM claude_code_agents
       WHERE autosession_enabled = 1`,
    )
    .all() as Array<{
      cwd_prefix: string;
      agent_id: string;
      workspace_id: string;
      autosession_enabled: number;
    }>;
}
