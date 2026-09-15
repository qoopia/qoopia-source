/**
 * Identity of a client connection: how its id maps to an origin, an MCP
 * resource URL and an OAuth issuer, and how a connection row is read back.
 *
 * These five functions were part of client-connections.ts, which also
 * provisions connections and therefore reaches into agent creation, owner
 * onboarding and policy. auth/oauth.ts and auth/middleware.ts need only the
 * identity half, and importing the whole module for it closed every runtime
 * import cycle in the codebase through a single edge. They depend on nothing
 * but the database, the origin validator and the error type, so they live
 * here as a leaf instead.
 */
import { z } from "zod";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";
import { resourceOrigin } from "../auth/resource-origin.ts";

export const surfaces = [
  "chatgpt_web",
  "chatgpt_desktop",
  "claude_web",
  "claude_desktop",
  "codex",
  "claude_code",
] as const;

export const connectionId = z.string().uuid();

export type ConnectionRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  agent_id: string;
  surface: (typeof surfaces)[number];
  access_mode: "read" | "read_write";
  request_key: string;
  origin: string;
  state: "awaiting_client" | "verified" | "revoked";
  challenge_hash: string;
  challenge_expires_at: string;
  oauth_client_id: string | null;
  verified_at: string | null;
};

export function connectionOrigin(id: string) {
  const row = db.query('SELECT origin FROM client_connections WHERE id=?').get(connectionId.parse(id)) as {origin:string}|null;
  if(!row)throw new QoopiaError('NOT_FOUND','Connection unavailable');return resourceOrigin(row.origin);
}
export function connectionResource(id: string) { return connectionOrigin(id)+'/mcp/c/'+id; }
export function connectionIssuer(id: string) { return connectionOrigin(id)+'/oauth/c/'+id; }
export function resourceConnection(resource: string): string|undefined {
  try{
    const match=/^\/mcp\/c\/([a-f0-9-]{36})$/.exec(new URL(resource).pathname);
    return match&&resource===connectionResource(match[1]!)?match[1]:undefined;
  }catch{return;}
}
export function publicConnection(id: string): ConnectionRow {
  const row=db.query(`SELECT c.* FROM client_connections c JOIN agents a ON a.id=c.agent_id AND a.workspace_id=c.workspace_id
    WHERE c.id=? AND c.state!='revoked' AND a.active=1`).get(connectionId.parse(id)) as ConnectionRow|null;
  if(!row)throw new QoopiaError('NOT_FOUND','Connection unavailable');return row;
}
