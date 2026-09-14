import type { Database } from "bun:sqlite";
import type { AuthContext } from "./middleware.ts";
import { grantedScopeAllowsRisk } from "./oauth.ts";
import { QoopiaError } from "../utils/errors.ts";
import { assertInstanceWriteAllowed } from "../utils/instance-role.ts";
import type { RiskClass } from "../mcp/tools.ts";

export type AuthorityAction = "read" | "draft" | "review" | "seal" | "owner" | "report" | "legacy-skill" | "feedback";
export interface Principal {
  id: string; workspace_id: string; name: string; type: string; active: number;
  principal_kind: "human" | "agent" | "reporter";
  authority_profile: string; tool_profile: string; policy_epoch: number; session_version: number;
  legacy_skill_access: number;
}
const permissions: Record<string, readonly AuthorityAction[]> = {
  "memory-reader": ["read"], "memory-worker": ["read", "feedback"],
  "skill-author": ["read", "draft", "feedback"], "skill-reviewer": ["read", "review"],
  "runtime-reporter": ["report"], "owner": ["read", "draft", "review", "seal", "owner", "feedback"],
};

/** Re-resolve DB authority even on an already authenticated connection/replay. */
export function authorize(database: Database, auth: AuthContext, action: AuthorityAction): Principal {
  const p = database.query("SELECT * FROM agents WHERE id=? AND workspace_id=? AND active=1")
    .get(auth.agent_id, auth.workspace_id) as Principal | null;
  if (!p) throw new QoopiaError("UNAUTHENTICATED", "Principal is inactive or absent");
  if ((auth.policy_epoch !== undefined && auth.policy_epoch !== p.policy_epoch) ||
      (auth.session_version !== undefined && auth.session_version !== p.session_version)) {
    throw new QoopiaError("REVOKED", "Authentication generation changed; authenticate again");
  }
  if (action === "legacy-skill") {
    if (p.legacy_skill_access === 1) {
      // Preserve schema35's exact write-low intersection, including ADR-017 NULL scope.
      // This internal action never grants canonical draft/compile/review/owner authority.
      currentToolAuth(database, auth, "write-low");
      return p;
    }
    action = "draft";
  }
  const risk = action === "read" ? "read" : action === "owner" || action === "seal" ? "admin" : "write-low";
  assertInstanceWriteAllowed(risk, action);
  if (auth.source === "oauth" && !grantedScopeAllowsRisk(auth.granted_scope ?? [], risk)) {
    throw new QoopiaError("FORBIDDEN", "OAuth scope does not permit this operation");
  }
  if (p.tool_profile !== "full" && (p.tool_profile !== "no-destructive" || risk === "admin") && risk !== "read") {
    throw new QoopiaError("FORBIDDEN", "Current tool profile forbids mutation");
  }
  if (!permissions[p.authority_profile]?.includes(action)) {
    throw new QoopiaError("FORBIDDEN", "Current principal profile does not permit this operation");
  }
  if (p.principal_kind === "reporter" && action !== "report") {
    throw new QoopiaError("FORBIDDEN", "Reporter has no memory or command authority");
  }
  if (p.principal_kind === "reporter" && !database.query(`SELECT 1 FROM runtime_registrations r JOIN agents target
    ON target.id=r.target_agent_id AND target.workspace_id=r.workspace_id WHERE r.reporter_id=? AND r.workspace_id=? AND target.active=1`)
    .get(p.id, p.workspace_id)) throw new QoopiaError("REVOKED", "Reporter target registration is inactive");
  if (action === "owner") requireHumanOwner(database, p);
  return p;
}

export function requireHumanOwner(database: Database, p: Principal): void {
  if (p.principal_kind !== "human" || !database.query(
    "SELECT 1 FROM workspace_owners WHERE workspace_id=? AND actor_id=?",
  ).get(p.workspace_id, p.id)) throw new QoopiaError("FORBIDDEN", "A current human owner decision is required");
}

export function requireAgent(database: Database, workspace: string, id: string): Principal {
  const p = database.query("SELECT * FROM agents WHERE workspace_id=? AND id=? AND active=1")
    .get(workspace, id) as Principal | null;
  if (!p) throw new QoopiaError("NOT_FOUND", "Target does not exist in the authorized scope");
  return p;
}

/** Data ownership is independent of role names and discovery. */
export function mayEdit(p: Principal, author: string): void {
  if (p.id !== author && p.authority_profile !== "owner") {
    throw new QoopiaError("FORBIDDEN", "Only the author or an explicit owner delegate may edit this draft");
  }
}

/** Common legacy transport boundary. It keeps old memory rights but never reporter/owner impersonation. */
export function currentToolAuth(database: Database, auth: AuthContext, risk: RiskClass): AuthContext {
  const p = requireAgent(database, auth.workspace_id, auth.agent_id);
  if ((auth.policy_epoch !== undefined && p.policy_epoch !== auth.policy_epoch) ||
      (auth.session_version !== undefined && p.session_version !== auth.session_version)) throw new QoopiaError("REVOKED", "Authentication generation changed");
  if (p.principal_kind === "reporter") throw new QoopiaError("FORBIDDEN", "Reporter cannot use general memory or administration tools");
  assertInstanceWriteAllowed(risk, "legacy tool");
  // ADR-017 legacy NULL/empty stored scope falls back to the current tool profile.
  // Preserve undefined here; explicit [] still denies. Canonical P1 authorize() above
  // requires explicit OAuth grants, so this fallback cannot confer new authority.
  if ((auth.source === "oauth" && !grantedScopeAllowsRisk(auth.granted_scope, risk)) ||
      (risk !== "read" && p.tool_profile !== "full" && (p.tool_profile !== "no-destructive" || risk !== "write-low"))) {
    throw new QoopiaError("FORBIDDEN", "Current scope or tool profile forbids this operation");
  }
  return { ...auth, type: p.type, tool_profile: p.tool_profile };
}
export function bootstrapToolAllowed(name: string, profile?: string): boolean {
  if (!profile) return true; // named legacy full connection, during compatibility window
  if (profile === "runtime-reporter") return false;
  if (["recall", "note_get", "skill_search", "skill_get", "operation_get"].includes(name)) return true;
  if (profile === "memory-worker" && ["note_create", "note_update", "session_save"].includes(name)) return true;
  if (profile === "skill-author" && ["skill_upsert", "entity_upsert", "skill_mark_tested"].includes(name)) return true;
  return profile === "owner" && ["agent_list", "agent_onboard", "agent_deactivate", "skill_upsert", "skill_mark_tested"].includes(name);
}
