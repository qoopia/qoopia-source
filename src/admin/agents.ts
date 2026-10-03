import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { generateApiKey, sha256Hex } from "../auth/api-keys.ts";
import { revokeAllAgentTokens } from "../auth/oauth.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";
import { seesWholeWorkspace, sharesContext } from "../auth/principal.ts";
import { canManagePolicy } from "../services/memory-policy.ts";
import { logActivity } from "../services/activity.ts";

export type AgentType = "standard" | "steward" | "owner" | "ingest-daemon";

/**
 * ADR-020: there is no privileged agent type. An existing 'claude-privileged' row stays as it is
 * and acts as an ordinary agent; new agents get their reach from the shared-context toggle.
 */
function refuseLegacyType(type: string | undefined): void {
  if (type === "claude-privileged")
    throw new QoopiaError("INVALID_INPUT",
      "Type 'claude-privileged' is retired (ADR-020). Create a standard agent: its shared context is on by default and the owner switches it on the agent card or through the steward. Management stays with the steward and the owner.");
}

export const AGENT_NAME_RE = /^[a-zA-Z0-9_\-\s]{1,64}$/;

export function createAgent(opts: {
  name: string;
  workspaceSlug: string;
  type?: AgentType;
}): { id: string; name: string; api_key: string; workspace_id: string } {
  refuseLegacyType(opts.type);
  if (!AGENT_NAME_RE.test(opts.name)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "Agent name contains invalid characters (allowed: letters, digits, underscore, hyphen, space; max 64)",
    );
  }

  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(opts.workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${opts.workspaceSlug} not found`);

  // Case-insensitive: AgentComm addresses agents by name, and a case-only
  // variant would make that address ambiguous.
  const existing = db
    .prepare(`SELECT id FROM agents WHERE lower(name) = lower(?) AND workspace_id = ? AND active = 1`)
    .get(opts.name, ws.id);
  if (existing)
    throw new QoopiaError(
      "CONFLICT",
      `agent '${opts.name}' already exists in workspace ${opts.workspaceSlug}`,
    );

  const id = ulid();
  const apiKey = generateApiKey();
  // This is the legacy onboarding entry point, also used before migration036.
  // Preserve its old skill API rights without granting new P1 author capabilities.
  const legacySkills = !!db.query("SELECT 1 FROM pragma_table_info('agents') WHERE name='legacy_skill_access'").get();
  try {
    db.prepare(
      `INSERT INTO agents (id, workspace_id, name, type, api_key_hash, active, created_at${legacySkills ? ", legacy_skill_access" : ""})
       VALUES (?, ?, ?, ?, ?, 1, ?${legacySkills ? ", 1" : ""})`,
    ).run(id, ws.id, opts.name, opts.type || "standard", sha256Hex(apiKey), nowIso());
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("UNIQUE constraint failed")) {
      throw new QoopiaError("CONFLICT", "Agent with this name already exists in the workspace");
    }
    throw err;
  }
  return { id, name: opts.name, api_key: apiKey, workspace_id: ws.id };
}

export function listAgents() {
  return db
    .prepare(
      `SELECT a.id, a.name, a.type, a.active, a.last_seen, a.created_at, w.slug as workspace_slug
       FROM agents a JOIN workspaces w ON w.id = a.workspace_id
       ORDER BY w.slug, a.name`,
    )
    .all();
}

export function rotateAgentKey(name: string, workspaceSlug: string): string {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${workspaceSlug} not found`);
  const a = db
    .prepare(`SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1`)
    .get(name, ws.id) as { id: string } | undefined;
  if (!a) throw new QoopiaError("NOT_FOUND", `agent ${name} not found`);
  const newKey = generateApiKey();
  // QDASHCOOKIE-002: bump session_version so any outstanding dashboard
  // cookie minted under the previous api_key fails its sv check on the
  // next request (see authFromSessionCookie). ADR-015 §Consequences.
  db.prepare(
    `UPDATE agents
        SET api_key_hash    = ?,
            session_version = session_version + 1
      WHERE id = ?`,
  ).run(sha256Hex(newKey), a.id);
  return newKey;
}

export function setAgentType(
  name: string,
  workspaceSlug: string,
  type: AgentType,
): { name: string; type: string } {
  refuseLegacyType(type);
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${workspaceSlug} not found`);
  const info = db
    .prepare(
      `UPDATE agents SET type = ? WHERE name = ? AND workspace_id = ? AND active = 1`,
    )
    .run(type, name, ws.id);
  if (info.changes === 0)
    throw new QoopiaError("NOT_FOUND", `active agent '${name}' not found in workspace ${workspaceSlug}`);
  return { name, type };
}

/**
 * ADR-020: switch one agent's shared-context toggle. On (absent from agents.metadata, the
 * onboarding default) it reads its siblings' notes and transcripts; off, only its own. The
 * workspace owner or the workspace's steward may switch it, and every change is audited.
 */
export function setSharedContext(input: { workspace_id: string; agent_id: string; enabled: boolean; actor_id: string }) {
  if (typeof input.enabled !== "boolean") throw new QoopiaError("INVALID_INPUT", "enabled must be true or false");
  return db.transaction(() => {
    const actor = db.query("SELECT type FROM agents WHERE id = ? AND workspace_id = ? AND active = 1")
      .get(input.actor_id, input.workspace_id) as { type: string } | null;
    if (!actor || (actor.type !== "steward" && !canManagePolicy(input.workspace_id, input.actor_id)))
      throw new QoopiaError("FORBIDDEN", "Only the workspace owner or its steward can change an agent's shared context");
    const target = db.query("SELECT id, name, type FROM agents WHERE id = ? AND workspace_id = ? AND active = 1")
      .get(input.agent_id, input.workspace_id) as { id: string; name: string; type: string } | null;
    if (!target) throw new QoopiaError("NOT_FOUND", "Agent unavailable");
    if (seesWholeWorkspace(target))
      throw new QoopiaError("INVALID_INPUT", "The steward and the owner always read the whole workspace");
    const changed = sharesContext(target.id) !== input.enabled;
    if (changed) {
      db.query(input.enabled
        ? "UPDATE agents SET metadata = json_remove(metadata, '$.shared_context') WHERE id = ?"
        : "UPDATE agents SET metadata = json_set(metadata, '$.shared_context', json('false')) WHERE id = ?").run(target.id);
      logActivity({
        workspace_id: input.workspace_id,
        agent_id: input.actor_id,
        action: "agent_shared_context_changed",
        entity_type: "agent",
        entity_id: target.id,
        project_id: null,
        summary: `Shared context of '${target.name}' turned ${input.enabled ? "on" : "off"}`,
        details: { agent_name: target.name, shared_context: input.enabled },
      });
    }
    return { agent_id: target.id, name: target.name, shared_context: input.enabled, changed };
  }).immediate();
}

export function deleteAgent(name: string, workspaceSlug: string) {
  const ws = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(workspaceSlug) as { id: string } | undefined;
  if (!ws) throw new QoopiaError("NOT_FOUND", `workspace ${workspaceSlug} not found`);
  const agent = db
    .prepare(`SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1`)
    .get(name, ws.id) as { id: string } | undefined;
  if (!agent) throw new QoopiaError("NOT_FOUND", `agent ${name} not found`);

  // QDASHCOOKIE-002: bump session_version on deactivation as well, so the
  // sv check kills outstanding dashboard cookies even if the active=0 row
  // is somehow reactivated later — defense-in-depth, not a real exploit
  // surface today (cookie auth already rejects active=0 unconditionally).
  db.prepare(
    `UPDATE agents
        SET active          = 0,
            session_version = session_version + 1
      WHERE id = ?`,
  ).run(agent.id);

  // C2 fix: revoke all OAuth tokens on deactivation
  const revoked = revokeAllAgentTokens(agent.id);

  return { deactivated: true, tokens_revoked: revoked };
}
