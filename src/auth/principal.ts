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
import type { AuthContext } from "./middleware.ts";
import { grantedScopeAllowsRisk } from "./oauth.ts";
import { QoopiaError } from "../utils/errors.ts";

/** Agent types that may read and act across their whole workspace. */
export const ADMIN_TYPES = new Set(["owner", "steward", "claude-privileged"]);

export function isAdmin(auth: AuthContext): boolean {
  return ADMIN_TYPES.has(auth.type);
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
