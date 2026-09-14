import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { generateApiKey, sha256Hex } from "../auth/api-keys.ts";
import { revokeAllAgentTokens } from "../auth/oauth.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";

export type AgentType = "standard" | "claude-privileged" | "steward" | "owner" | "ingest-daemon";

const AGENT_NAME_RE = /^[a-zA-Z0-9_\-\s]{1,64}$/;

export function createAgent(opts: {
  name: string;
  workspaceSlug: string;
  type?: AgentType;
}): { id: string; name: string; api_key: string; workspace_id: string } {
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

  const existing = db
    .prepare(`SELECT id FROM agents WHERE name = ? AND workspace_id = ? AND active = 1`)
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
