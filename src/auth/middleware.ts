import {resourceConnection} from "../services/client-connections.ts";
import { db } from "../db/connection.ts";
import { verifyApiKey, type AgentRecord } from "./api-keys.ts";
import type { OAuthScope } from "./oauth.ts";
import { findActiveToken, parseGrantedScope, oauthResource } from "./oauth.ts";
import { nowIso } from "../utils/errors.ts";
import { isReadOnlyInstance } from "../utils/instance-role.ts";

export interface AuthContext {
  agent_id: string;
  agent_name: string;
  workspace_id: string;
  type: "standard" | "claude-privileged" | string;
  source: "api-key" | "oauth";
  // QSA-F / ADR-016: per-agent MCP tool risk profile, propagated from
  // agents.tool_profile. Raw string here; src/mcp/tools.ts normalizes it
  // to a known enum and falls back to 'read-only' if it's unknown
  // (fail-closed). Optional in the type so legacy code that constructs
  // AuthContext in tests doesn't have to set it; runtime treats undefined
  // as 'read-only'.
  tool_profile?: string | null;
  granted_scope?: OAuthScope[];
  oauth_client_id?: string;
  connection_id?: string;
  policy_epoch?: number;
  session_version?: number;
  authority_profile?: string;
  legacy_skill_access?: number;
}

/**
 * Extracts bearer token from Authorization header and resolves to AuthContext.
 * Returns null for unauth / invalid.
 */
export function authenticate(request: Request): AuthContext | null {
  const header = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  if (!token) return null;

  // Agent API key path (static)
  const agent = verifyApiKey(token);
  if (agent) {
    return agentToContext(agent, "api-key");
  }

  // OAuth access token path — require active=1 so deactivated agents cannot auth
  const oauthRow = findActiveToken(token);
  const pathname=new URL(request.url).pathname;
  const mcp=pathname==='/mcp'||pathname==='/mcp/'||pathname.startsWith('/mcp/c/');
  const connection=oauthRow?.resource?resourceConnection(oauthRow.resource):undefined;
  const targetMatches=connection?pathname==='/mcp/c/'+connection:
    oauthRow?.resource?oauthRow.resource===new URL(pathname.replace(/\/$/,''),oauthResource()).href:pathname==='/mcp'||pathname==='/mcp/';
  if (oauthRow && oauthRow.token_type === "access" && (!mcp || targetMatches)) {
    const a = db
      .prepare(`SELECT * FROM agents WHERE id = ? AND active = 1`)
      .get(oauthRow.agent_id) as AgentRecord | undefined;
    if (a) {
      // Update last_seen on OAuth auth too (mirror verifyApiKey). Without this,
      // agents that reach Qoopia only via an OAuth access token (e.g. claude.ai
      // connector) never refresh last_seen and look dormant. Best effort.
      if (!isReadOnlyInstance()) {
        try {
          db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).run(nowIso(), a.id);
        } catch {}
      }
      const context=agentToContext(
        a,
        "oauth",
        parseGrantedScope(oauthRow.granted_scope),
        oauthRow.client_id,
      );
      if(oauthRow.resource)context.connection_id=resourceConnection(oauthRow.resource);
      return context;
    }
  }

  return null;
}

function agentToContext(
  a: AgentRecord,
  source: "api-key" | "oauth",
  grantedScope?: OAuthScope[],
  oauthClientId?: string,
): AuthContext {
  return {
    agent_id: a.id,
    agent_name: a.name,
    workspace_id: a.workspace_id,
    type: a.type,
    source,
    tool_profile: a.tool_profile ?? null,
    granted_scope: grantedScope,
    ...(oauthClientId ? {oauth_client_id: oauthClientId} : {}),
    policy_epoch: a.policy_epoch,
    session_version: a.session_version,
    authority_profile: a.authority_profile,
    legacy_skill_access: a.legacy_skill_access,
  };
}
