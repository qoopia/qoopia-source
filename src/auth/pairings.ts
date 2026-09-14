import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { db } from "../db/connection.ts";
import type { AuthContext } from "./middleware.ts";
import { authorize, requireAgent } from "./policy.ts";
import { command, digest } from "../skills/commands.ts";
import { QoopiaError } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { assertInstanceWriteAllowed } from "../utils/instance-role.ts";

export const pairingSchema = z.object({
  name: z.string().min(1).max(120), runtime_id: z.string().min(1).max(200),
  profile: z.enum(["memory-reader", "memory-worker", "skill-author", "skill-reviewer", "runtime-reporter"]),
  target_agent_id: z.string().min(1).max(200).optional(), expected_revision: z.number().int().positive(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();
export const revokePrincipalSchema = z.object({
  agent_id: z.string().min(1).max(200), expected_revision: z.number().int().positive(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();

export function issuePairing(auth: AuthContext, input: unknown, database: Database = db) {
  const parsed = pairingSchema.safeParse(input);
  if (!parsed.success) throw new QoopiaError("INVALID_INPUT", parsed.error.message);
  const a = parsed.data;
  assertNoSecrets(a.name, "pairing.name"); assertNoSecrets(a.runtime_id, "pairing.runtime_id");
  let code: string | null = null;
  const response = command(database, auth, "owner", "agent_pairing_create", a.idempotency_key, a, a.name,
    (p) => {
      if (a.target_agent_id) {
        const target = requireAgent(database, p.workspace_id, a.target_agent_id);
        if (target.principal_kind !== "agent") throw new QoopiaError("FORBIDDEN", "Reporter target must be an agent");
      }
    }, ({ now, principal: p }) => {
      if (a.expected_revision !== p.policy_epoch) throw new QoopiaError("STALE_REVISION", "Owner policy epoch changed");
      if ((a.profile === "runtime-reporter") !== !!a.target_agent_id) {
        throw new QoopiaError("INVALID_INPUT", "Only a reporter pairing requires a target agent");
      }
      if (database.query("SELECT 1 FROM agents WHERE workspace_id=? AND name=?").get(p.workspace_id, a.name)) {
        throw new QoopiaError("CONFLICT", "Principal name already exists");
      }
      const pairingId = randomUUID();
      code = randomBytes(32).toString("base64url");
      database.query(`INSERT INTO agent_pairings
        (id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,code_digest,name,profile,principal_kind,target_agent_id,runtime_id,expires_at_ms,policy_epoch)
        VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?,?,?,?,?,?,?)`).run(pairingId, p.workspace_id, p.id, now, now, digest(code), a.name, a.profile,
        a.profile === "runtime-reporter" ? "reporter" : "agent", a.target_agent_id ?? null, a.runtime_id, now + 600_000, p.policy_epoch);
      return { data: { pairing_id: pairingId, expires_at_ms: now + 600_000, profile: a.profile }, revision: 1 };
    });
  return { ...response, one_time_code: code, next_action: code ? "Redeem this pairing within ten minutes" : "Code is never replayed; create a new pairing with a new idempotency key" };
}

/** Possession of the single-use code is the enrollment credential, never owner authority. */
export function redeemPairing(code: string, database: Database = db) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new QoopiaError("UNAUTHENTICATED", "Invalid pairing");
  return database.transaction(() => {
    const pair = database.query("SELECT * FROM agent_pairings WHERE code_digest=?").get(digest(code)) as {
      id: string; workspace_id: string; actor_id: string; name: string; profile: string; principal_kind: string;
      target_agent_id: string | null; runtime_id: string; policy_epoch: number; expires_at_ms: number;
      redeemed_agent_id: string | null; revoked_at_ms: number | null;
    } | null;
    if (!pair) throw new QoopiaError("UNAUTHENTICATED", "Invalid pairing");
    if (pair.redeemed_agent_id || pair.revoked_at_ms) throw new QoopiaError("REVOKED", "Pairing already used or revoked; ask the owner for a new pairing");
    if (pair.expires_at_ms <= Date.now()) throw new QoopiaError("EXPIRED", "Pairing expired");
    const owner = requireAgent(database, pair.workspace_id, pair.actor_id);
    const ownerAuth: AuthContext = { agent_id: owner.id, workspace_id: owner.workspace_id, agent_name: owner.name,
      type: owner.type, source: "api-key", policy_epoch: pair.policy_epoch, session_version: owner.session_version };
    authorize(database, ownerAuth, "owner");
    if (pair.target_agent_id) requireAgent(database, pair.workspace_id, pair.target_agent_id);
    if (database.query("SELECT 1 FROM agents WHERE workspace_id=? AND name=?").get(pair.workspace_id, pair.name)) {
      throw new QoopiaError("CONFLICT", "Name was claimed after the pairing was issued");
    }
    const agentId = randomUUID(), apiKey = `q_${randomBytes(32).toString("base64url")}`, now = Date.now();
    database.query(`INSERT INTO agents(id,workspace_id,name,type,api_key_hash,principal_kind,authority_profile,tool_profile)
      VALUES (?,?,?,'standard',?,?,?,?)`).run(agentId, pair.workspace_id, pair.name, digest(apiKey), pair.principal_kind, pair.profile,
      pair.profile === "memory-reader" ? "read-only" : "no-destructive");
    const result = command(database, ownerAuth, "owner", "agent_pairing_redeem", pair.id,
      { pairing_id: pair.id }, agentId, () => {}, () => {
        let registrationId: string;
        const updated = database.query("UPDATE agent_pairings SET redeemed_agent_id=?,revision=revision+1,updated_at_ms=? WHERE id=? AND redeemed_agent_id IS NULL")
          .run(agentId, now, pair.id);
        if (updated.changes !== 1) throw new QoopiaError("REVOKED", "Pairing already redeemed");
        if (pair.principal_kind === "reporter") {
          const existing = database.query("SELECT id,reporter_id FROM runtime_registrations WHERE workspace_id=? AND target_agent_id=? AND runtime_id=?")
            .get(pair.workspace_id, pair.target_agent_id, pair.runtime_id) as { id: string; reporter_id: string | null } | null;
          if (!existing) throw new QoopiaError("NOT_FOUND", "Target runtime must be enrolled before its reporter");
          if (existing.reporter_id) throw new QoopiaError("CONFLICT", "Runtime already has a reporter; revoke and explicitly replace its registration");
          registrationId = existing.id;
          database.query("UPDATE runtime_registrations SET reporter_id=?,revision=revision+1,updated_at_ms=? WHERE id=?")
            .run(agentId, now, existing.id);
        } else {
          registrationId = randomUUID();
          database.query(`INSERT INTO runtime_registrations
            (id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,target_agent_id,runtime_id)
            VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?,?,?,?)`).run(registrationId, pair.workspace_id, pair.actor_id, now, now, agentId, pair.runtime_id);
        }
        return { data: { agent_id: agentId, profile: pair.profile, runtime_id: pair.runtime_id, runtime_registration_id: registrationId }, revision: 1 };
      });
    return { ...result, api_key: apiKey };
  }).immediate();
}

export function revokePrincipal(auth: AuthContext, input: unknown, database: Database = db) {
  const parsed = revokePrincipalSchema.safeParse(input);
  if (!parsed.success) throw new QoopiaError("INVALID_INPUT", parsed.error.message);
  const a = parsed.data;
  return command(database, auth, "owner", "principal_revoke", a.idempotency_key, a, a.agent_id,
    (p) => {
      if (!database.query("SELECT 1 FROM agents WHERE workspace_id=? AND id=?").get(p.workspace_id, a.agent_id)) throw new QoopiaError("NOT_FOUND", "Principal not found");
      if (a.agent_id === p.id) throw new QoopiaError("FORBIDDEN", "Owner recovery is required before self-revocation");
    }, ({ principal: p }) => {
      const changed = database.query("UPDATE agents SET active=0,policy_epoch=policy_epoch+1,session_version=session_version+1 WHERE workspace_id=? AND id=? AND policy_epoch=?")
        .run(p.workspace_id, a.agent_id, a.expected_revision);
      if (changed.changes !== 1) throw new QoopiaError("STALE_REVISION", "Principal epoch changed");
      return { data: { agent_id: a.agent_id, state: "revoked" }, revision: a.expected_revision + 1 };
    });
}

/** Explicit local OS bootstrap only; never exposed by HTTP/MCP and never infers a human from an old role. */
export function bootstrapOwner(database: Database, name: string, workspaceName?: string, workspaceId?: string) {
  assertInstanceWriteAllowed("admin", "local owner bootstrap");
  if (!name.trim() || name.length > 120 || (!!workspaceName === !!workspaceId) || (workspaceName !== undefined && !workspaceName.trim())) {
    throw new QoopiaError("INVALID_INPUT", "Owner name and exactly one workspace name (fresh instance) or existing workspace ID required");
  }
  return database.transaction(() => {
    if (workspaceId) {
      if (!database.query("SELECT 1 FROM workspaces WHERE id=?").get(workspaceId)) throw new QoopiaError("NOT_FOUND", "Workspace not found");
      if (database.query("SELECT 1 FROM workspace_owners WHERE workspace_id=?").get(workspaceId)) throw new QoopiaError("CONFLICT", "Workspace already has an owner; bootstrap cannot replace or recover ownership");
    } else if (database.query("SELECT 1 FROM workspaces LIMIT 1").get()) {
      throw new QoopiaError("CONFLICT", "Existing instance requires an explicit --workspace-id local owner decision");
    }
    const workspace = workspaceId ?? randomUUID(), agent = randomUUID(), now = Date.now(), apiKey = `q_${randomBytes(32).toString("base64url")}`;
    if (database.query("SELECT 1 FROM agents WHERE workspace_id=? AND name=?").get(workspace, name)) throw new QoopiaError("CONFLICT", "Principal name already exists; use a new human owner name");
    if (!workspaceId) database.query("INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)").run(workspace, workspaceName!, `local-${workspace}`);
    database.query(`INSERT INTO agents(id,workspace_id,name,type,api_key_hash,principal_kind,authority_profile,tool_profile)
      VALUES (?,?,?,'owner',?,'human','owner','full')`).run(agent, workspace, name, digest(apiKey));
    database.query("INSERT INTO workspace_owners(id,workspace_id,actor_id,origin_instance_id,created_at_ms) VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?)")
      .run(randomUUID(), workspace, agent, now);
    return { workspace_id: workspace, agent_id: agent, api_key: apiKey };
  }).immediate();
}
