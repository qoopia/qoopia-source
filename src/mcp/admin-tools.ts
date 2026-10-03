/**
 * Admin MCP tools — available only to agents with type="steward".
 *
 * Three tools:
 *   agent_onboard  — create agent + bootstrap notes in one transaction
 *   agent_list     — list all agents in workspace
 *   agent_deactivate — soft-delete an agent (with self-guard)
 *
 * Design decisions (ADR-012):
 *   - Bootstrap notes are created with agent_id = new agent (owner),
 *     NOT steward's agent_id. This ensures the new agent sees them
 *     via brief() which filters by agent_id.
 *   - Activity log uses steward's agent_id (actor) for audit trail.
 *   - Plaintext API key is returned in tool response only, never logged.
 *   - Self-guard: steward cannot deactivate itself.
 *   - UNIQUE partial index prevents creating a second active steward.
 */
import { z } from "zod";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError } from "../utils/errors.ts";
import { createAgent, AGENT_NAME_RE, setSharedContext } from "../admin/agents.ts";
import { currentToolAuth } from "../auth/policy.ts";
import { seesWholeWorkspace, sharesContext } from "../auth/principal.ts";
import { surfaces, connectionId, connectionResource } from "../services/connection-identity.ts";
import { env } from "../utils/env.ts";
import { logActivity } from "../services/activity.ts";
import { getRolePreset, ROLE_PRESET_NAMES } from "../admin/templates.ts";
import { createNote } from "../services/notes.ts";
import type { RiskClass } from "./tools.ts";
import {
  listMemoryPolicies,
  memoryPolicy,
  resolveAgentByName,
  setMemoryPolicy,
  type MemoryMode,
} from "../services/memory-policy.ts";
import { decideSaveRequest, listSaveRequests } from "../services/memory-save-requests.ts";

interface AdminToolDef {
  name: string;
  description: string;
  // QSA-F / ADR-016: every admin tool is at least 'admin' risk; the field
  // is required so the per-agent profile filter has a value to read.
  risk: RiskClass;
  /** Only the workspace owner (canManagePolicy) can use it: not offered to a steward. */
  ownerOnly?: true;
  rawSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, auth: AuthContext) => unknown;
}

function assertSteward(auth: AuthContext) {
  // OWNER is the absolute top tier — it satisfies every steward gate.
  if (auth.type !== "steward" && auth.type !== "owner") {
    throw new QoopiaError("FORBIDDEN", "This tool requires steward or owner privileges.");
  }
}

const connectionPreparationSchema=z.object({
  agent_name: z.string().trim().regex(AGENT_NAME_RE),
  surface: z.enum(surfaces),
  access_mode: z.enum(['read','read_write']).default('read'),
  connection_id: connectionId.optional().describe('Existing connection to label or resume; never rebinds its identity'),
}).strict();

export const adminTools: AdminToolDef[] = [
  {
    name: "connection_prepare",
    risk: "read",
    description: "Prepare a named client connection for the owner to review in the dashboard. Read-only: creates no agent, credential or grant. Reuse an existing connection instead of duplicating it. OAuth and verification must happen in the actual target client.",
    rawSchema: connectionPreparationSchema.shape,
    handler(args, auth) {
      assertSteward(currentToolAuth(db, auth, 'read'));
      const input=connectionPreparationSchema.parse(args);
      const agent=db.query('SELECT id FROM agents WHERE workspace_id=? AND name=? AND active=1').get(auth.workspace_id,input.agent_name) as {id:string}|null;
      const rows=db.query(`SELECT c.id,c.agent_id,c.surface,c.access_mode,c.state,c.verified_at FROM client_connections c
        JOIN agents a ON a.id=c.agent_id AND a.workspace_id=c.workspace_id AND a.active=1
        WHERE c.workspace_id=? AND c.state!='revoked' AND ${input.connection_id?'c.id=?':'a.name=?'}`)
        .all(auth.workspace_id,input.connection_id??input.agent_name) as {id:string;agent_id:string;surface:string;access_mode:string;state:string;verified_at:string|null}[];
      if(input.connection_id&&!rows.length)throw new QoopiaError('NOT_FOUND','Connection unavailable in this workspace');
      if(rows.length>1)throw new QoopiaError('CONFLICT','Select an exact connection_id');
      const existing=rows[0];
      if(agent&&(!existing||agent.id!==existing.agent_id))throw new QoopiaError('CONFLICT','This agent already has access; reuse its existing client or select its exact connection');
      if(existing&&(existing.access_mode!==input.access_mode||existing.surface!==input.surface&&![existing.surface,input.surface].every(s=>s==='muse_app'||s==='muse_code')))
        throw new QoopiaError('CONFLICT','This connection has a different application or access. Resume its actual settings; changing access requires a separate owner-reviewed connection.');
      const url=new URL('/dashboard',env.PUBLIC_URL);
      for(const [key,value] of Object.entries({connect:input.surface,agent:input.agent_name,access:input.access_mode,workspace:auth.workspace_id}))url.searchParams.set(key,value);
      if(existing)url.searchParams.set('connection',existing.id);
      url.hash='connections';
      return {format:'qoopia-connections/1',state:'requires_owner_action',workspace_id:auth.workspace_id,selection:input,
        connection:existing?{...existing,mcp_url:connectionResource(existing.id)}:null,
        owner_url:url.href,changes_applied:false,transcript_capture:false,
        next_action:existing?'Open the existing connection in the owner dashboard. Keep its URL, OAuth grant and verification; review its label only.':'Send the owner this review link. The owner reviews the application, name and access, then prepares the connection. Send its exact MCP URL to the target client; complete OAuth and verify there. Never request tokens or callback codes in chat.'};
    },
  },
  // --- agent_onboard ---
  {
    name: "agent_onboard",
    risk: "admin",
    description:
      "Create a new agent with optional bootstrap notes from a role preset. " +
      "Returns the API key ONCE — it is never stored or logged in plaintext. " +
      "If a role preset is specified, bootstrap notes are created and a thin " +
      "system prompt is returned ready for copy-paste.",
    rawSchema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe("Agent name (unique within workspace)"),
      role: z
        .string()
        .optional()
        .describe(
          `Optional role preset for bootstrap notes. Available: ${ROLE_PRESET_NAMES.join(", ")}`,
        ),
    },
    handler(args, auth) {
      assertSteward(auth);

      const name = args.name as string;
      const roleName = args.role as string | undefined;

      // Resolve workspace slug from steward's workspace_id
      const ws = db
        .prepare(`SELECT slug FROM workspaces WHERE id = ?`)
        .get(auth.workspace_id) as { slug: string } | undefined;
      if (!ws)
        throw new QoopiaError("NOT_FOUND", "workspace not found");

      // Run everything in a transaction — all or nothing
      const txn = db.transaction(() => {
        // 1. Create agent (type=standard, never steward via MCP)
        const created = createAgent({
          name,
          workspaceSlug: ws.slug,
          type: "standard",
        });

        // 2. Bootstrap notes from role preset (if specified)
        let bootstrapCount = 0;
        let systemPrompt: string | null = null;

        if (roleName) {
          const preset = getRolePreset(roleName);

          // Through createNote, so bootstrap notes get the same ms timestamps and
          // temporal columns as every other note (owner = new agent, NOT steward).
          for (const note of preset.bootstrapNotes) {
            createNote({
              workspace_id: created.workspace_id,
              agent_id: created.id,
              type: note.type,
              text: note.text,
              tags: note.tags,
              source: "steward",
            });
            bootstrapCount++;
          }

          systemPrompt = preset.systemPrompt;
        }

        // 3. Activity log (steward = actor, no key in details)
        logActivity({
          workspace_id: auth.workspace_id,
          agent_id: auth.agent_id, // steward is the actor
          action: "agent_onboarded",
          entity_type: "agent",
          entity_id: created.id,
          project_id: null,
          summary: `Steward onboarded agent '${name}'${roleName ? ` with role '${roleName}'` : ""}`,
          details: {
            agent_name: name,
            role: roleName || null,
            bootstrap_notes: bootstrapCount,
          },
        });

        return {
          agent_id: created.id,
          agent_name: name,
          api_key: created.api_key,
          workspace_id: created.workspace_id,
          bootstrap_notes_created: bootstrapCount,
          system_prompt: systemPrompt,
        };
      });

      return txn();
    },
  },

  // --- agent_list ---
  {
    name: "agent_list",
    risk: "read",
    description:
      "List all agents in your own workspace (steward or owner only; no agent reads another workspace). " +
      "Returns name, type, active status, and last_seen.",
    rawSchema: {},
    handler(_args, auth) {
      assertSteward(auth);
      // Scope to steward's workspace only
      const all = db
        .prepare(
          `SELECT a.id, a.name, a.type, a.active, a.last_seen, a.created_at, w.slug as workspace_slug
           FROM agents a JOIN workspaces w ON w.id = a.workspace_id
           WHERE a.workspace_id = ?
           ORDER BY a.name`,
        )
        .all(auth.workspace_id) as Array<{
        id: string;
        name: string;
        type: string;
        active: number;
        last_seen: string | null;
        created_at: string;
        workspace_slug: string;
      }>;
      return {
        agents: all.map((a) => ({
          name: a.name,
          type: a.type,
          active: !!a.active,
          last_seen: a.last_seen,
          created_at: a.created_at,
          workspace: a.workspace_slug,
          shared_context: seesWholeWorkspace(a) ? null : sharesContext(a.id),
        })),
        total: all.length,
      };
    },
  },

  // --- agent_deactivate ---
  {
    name: "agent_deactivate",
    risk: "admin",
    description:
      "Deactivate (soft-delete) an agent. All API keys and OAuth tokens " +
      "become immediately invalid. Self-guard: steward cannot deactivate itself.",
    rawSchema: {
      name: z.string().min(1).describe("Name of the agent to deactivate"),
    },
    handler(args, auth) {
      assertSteward(auth);

      const targetName = args.name as string;

      // Self-guard: steward cannot deactivate itself
      if (targetName === auth.agent_name) {
        throw new QoopiaError(
          "FORBIDDEN",
          "Steward cannot deactivate itself. Use CLI: qoopia admin delete-agent",
        );
      }

      const ws = db
        .prepare(`SELECT slug FROM workspaces WHERE id = ?`)
        .get(auth.workspace_id) as { slug: string } | undefined;
      if (!ws)
        throw new QoopiaError("NOT_FOUND", "workspace not found");

      // Deactivate agent + revoke all OAuth tokens in one transaction
      const txn = db.transaction(() => {
        const agent = db
          .prepare(
            `SELECT id, type FROM agents WHERE name = ? AND workspace_id = ? AND active = 1`,
          )
          .get(targetName, auth.workspace_id) as { id: string; type: string } | undefined;

        if (!agent) {
          throw new QoopiaError(
            "NOT_FOUND",
            `Active agent '${targetName}' not found in workspace`,
          );
        }

        // OWNER protection: only an owner may deactivate an owner.
        if (agent.type === "owner" && auth.type !== "owner") {
          throw new QoopiaError(
            "FORBIDDEN",
            "Only an owner may deactivate an owner.",
          );
        }

        db.prepare(`UPDATE agents SET active = 0 WHERE id = ?`).run(agent.id);

        // Revoke all OAuth tokens for this agent
        const revoked = db
          .prepare(
            `UPDATE oauth_tokens SET revoked = 1 WHERE agent_id = ? AND revoked = 0`,
          )
          .run(agent.id);

        return { agent_id: agent.id, tokens_revoked: revoked.changes };
      });
      const result = txn();

      logActivity({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        action: "agent_deactivated",
        entity_type: "agent",
        entity_id: result.agent_id,
        project_id: null,
        summary: `Steward deactivated agent '${targetName}' (${result.tokens_revoked} OAuth tokens revoked)`,
        details: { agent_name: targetName, tokens_revoked: result.tokens_revoked },
      });

      return { deactivated: true, agent_name: targetName, tokens_revoked: result.tokens_revoked };
    },
  },

  // --- agent_set_profile (QSA-F / ADR-016) ---
  {
    name: "agent_set_profile",
    risk: "admin",
    description:
      "Change an agent's MCP tool risk profile. Profiles: " +
      "'read-only' (only risk='read' tools), 'no-destructive' " +
      "(read + write-low), 'full' (every tool the agent's type qualifies for). " +
      "Steward-only. Refuses to demote the caller (self-lockout) or the last " +
      "active full-profile steward in the workspace (workspace lockout). " +
      "Activates on the next MCP request — current in-flight requests are " +
      "not interrupted.",
    rawSchema: {
      name: z
        .string()
        .min(1)
        .describe("Name of the agent whose profile is being changed"),
      tool_profile: z
        .enum(["read-only", "no-destructive", "full"])
        .describe("New profile to apply"),
    },
    handler(args, auth) {
      assertSteward(auth);

      const targetName = args.name as string;
      const newProfile = args.tool_profile as
        | "read-only"
        | "no-destructive"
        | "full";

      // Self-demote guard: a steward who locked itself into 'read-only'
      // could no longer call agent_set_profile to undo it. Block here
      // before doing any DB work.
      if (
        targetName === auth.agent_name &&
        (newProfile === "read-only" || newProfile === "no-destructive")
      ) {
        throw new QoopiaError(
          "FORBIDDEN",
          "Cannot demote self — use a different steward or DB-level escalation",
        );
      }

      // Resolve target row inside the transaction so the last-steward
      // check sees the same snapshot as the UPDATE.
      const txn = db.transaction(() => {
        const target = db
          .prepare(
            `SELECT id, type, tool_profile FROM agents
             WHERE name = ? AND workspace_id = ? AND active = 1`,
          )
          .get(targetName, auth.workspace_id) as
          | { id: string; type: string; tool_profile: string }
          | undefined;

        if (!target) {
          throw new QoopiaError(
            "NOT_FOUND",
            `Active agent '${targetName}' not found in workspace`,
          );
        }

        // OWNER protection: only an owner may change an owner's profile.
        if (target.type === "owner" && auth.type !== "owner") {
          throw new QoopiaError(
            "FORBIDDEN",
            "Only an owner may change an owner's profile.",
          );
        }

        // Last-active-steward guard: if the target is currently a
        // 'full'-profile steward and we're about to demote it, count
        // how many other full-profile stewards remain. Zero = refuse.
        if (
          target.type === "steward" &&
          target.tool_profile === "full" &&
          newProfile !== "full"
        ) {
          const others = db
            .prepare(
              `SELECT COUNT(*) AS n FROM agents
               WHERE workspace_id = ?
                 AND type = 'steward'
                 AND active = 1
                 AND tool_profile = 'full'
                 AND id != ?`,
            )
            .get(auth.workspace_id, target.id) as { n: number };
          if (others.n === 0) {
            throw new QoopiaError(
              "FORBIDDEN",
              `Cannot demote the last full-profile steward in workspace ${auth.workspace_id}`,
            );
          }
        }

        const previous = target.tool_profile;
        db.prepare(
          `UPDATE agents SET tool_profile = ? WHERE id = ?`,
        ).run(newProfile, target.id);

        return {
          agent_id: target.id,
          previous_profile: previous,
        };
      });
      const result = txn();

      logActivity({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        action: "agent_profile_changed",
        entity_type: "agent",
        entity_id: result.agent_id,
        project_id: null,
        summary: `Steward changed profile of '${targetName}' from ${result.previous_profile} → ${newProfile}`,
        details: {
          agent_name: targetName,
          previous_profile: result.previous_profile,
          new_profile: newProfile,
        },
      });

      return {
        changed: true,
        agent_name: targetName,
        previous_profile: result.previous_profile,
        new_profile: newProfile,
      };
    },
  },

  // --- agent_set_shared_context (ADR-020) ---
  {
    name: "agent_set_shared_context",
    risk: "admin",
    description:
      "Turn one agent's shared context on or off. On (the default for every new agent) it reads " +
      "the notes and conversation transcripts of every agent in this workspace; off it reads only its " +
      "own. Private notes stay with their author, the steward and the owner. The steward and the " +
      "owner always read the whole workspace; no agent reads another workspace. Audited; repeating " +
      "a command that already holds is not an error.",
    rawSchema: {
      agent: z
        .string()
        .min(1)
        .max(128)
        .describe("Agent id, or its exact name when that name is unique in the workspace"),
      enabled: z.boolean().describe("true = reads its siblings' context, false = only its own"),
    },
    handler: (args, auth) => {
      assertSteward(auth);
      const requested = args.agent as string;
      let target: string;
      try {
        target = memoryPolicy(auth.workspace_id, requested).agent_id;
      } catch {
        target = resolveAgentByName(auth.workspace_id, requested).agent_id;
      }
      return setSharedContext({
        workspace_id: auth.workspace_id,
        agent_id: target,
        enabled: args.enabled as boolean,
        actor_id: auth.agent_id,
      });
    },
  },

  // --- memory_policy_list ---
  {
    name: "memory_policy_list",
    // A pure read; assertSteward below still keeps it to stewards and the owner.
    risk: "read",
    description:
      "Show the memory policy of every active agent in this workspace: auto (session " +
      "content is captured automatically) or manual (captured only on an explicit request). " +
      "Answers questions like 'who has autosave running?'.",
    rawSchema: {},
    handler: (_args, auth) => {
      assertSteward(auth);
      const agents = listMemoryPolicies(auth.workspace_id);
      return {
        agents: agents.map((a) => ({
          agent_id: a.agent_id,
          name: a.name,
          mode: a.mode,
          revision: a.revision,
          changed_at_ms: a.updated_at_ms,
          changed_by: a.actor_id,
        })),
        auto: agents.filter((a) => a.mode === "auto").length,
        manual: agents.filter((a) => a.mode === "manual").length,
      };
    },
  },

  // --- memory_policy_set ---
  {
    name: "memory_policy_set",
    risk: "admin",
    ownerOnly: true,
    description:
      "Turn automatic memory on (auto) or off (manual) for one agent. Only the workspace " +
      "owner may change it; a steward may not. Existing memory is never deleted and stays " +
      "readable in either mode. Repeating a command that already holds is not an error.",
    rawSchema: {
      agent: z
        .string()
        .min(1)
        .max(128)
        .describe("Agent id, or its exact name when that name is unique in the workspace"),
      mode: z.enum(["auto", "manual"]).describe("auto = capture automatically, manual = only on request"),
      expected_revision: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Reject the change if the policy moved since it was read"),
    },
    handler: (args, auth) => {
      const requested = args.agent as string;
      const mode = args.mode as MemoryMode;
      // An id is accepted directly; a name must resolve to exactly one agent, so an
      // ambiguous name is reported instead of changing the wrong agent's setting.
      let target: ReturnType<typeof resolveAgentByName>;
      try {
        target = memoryPolicy(auth.workspace_id, requested);
      } catch {
        target = resolveAgentByName(auth.workspace_id, requested);
      }
      const before = target.mode;
      const result = setMemoryPolicy({
        workspace_id: auth.workspace_id,
        agent_id: target.agent_id,
        mode,
        actor_id: auth.agent_id,
        expected_revision: args.expected_revision as number | undefined,
      });

      if (before !== result.mode) {
        logActivity({
          workspace_id: auth.workspace_id,
          agent_id: auth.agent_id,
          action: "agent_memory_policy_changed",
          entity_type: "agent",
          entity_id: result.agent_id,
          project_id: null,
          summary: `Memory policy of '${result.name}' changed from ${before} → ${result.mode}`,
          details: { agent_name: result.name, previous_mode: before, new_mode: result.mode, revision: result.revision },
        });
      }

      return {
        changed: before !== result.mode,
        agent_id: result.agent_id,
        name: result.name,
        mode: result.mode,
        revision: result.revision,
        note:
          result.mode === "manual"
            ? "Automatic capture is off. Existing memory stays readable; new material is saved only when explicitly requested."
            : "Automatic capture is on from now. Material from the manual period is not backfilled.",
      };
    },
  },

  // --- memory_save_list ---
  {
    name: "memory_save_list",
    risk: "admin",
    ownerOnly: true,
    description:
      "Owner only. Notes that «only on request» agents prepared and that wait for the owner's " +
      "confirmation. They are not memory yet: recall does not see them and they expire after 24 hours.",
    rawSchema: {
      agent: z.string().min(1).max(128).optional().describe("Limit to one agent id"),
    },
    handler: (args, auth) => ({
      items: listSaveRequests(auth.workspace_id, auth.agent_id, args.agent as string | undefined),
    }),
  },

  // --- memory_save_decide ---
  {
    name: "memory_save_decide",
    risk: "admin",
    ownerOnly: true,
    description:
      "Owner only. Confirm (accept=true) or decline one prepared save. Confirming writes exactly " +
      "the prepared note once; repeating it returns the same note. An agent can never confirm its own request.",
    rawSchema: {
      id: z.string().min(1).max(64).describe("Request id from memory_save_list or from the agent's APPROVAL_REQUIRED reply"),
      accept: z.boolean(),
    },
    handler: (args, auth) =>
      decideSaveRequest({
        workspace_id: auth.workspace_id,
        actor_id: auth.agent_id,
        id: args.id as string,
        accept: args.accept as boolean,
      }),
  },
];
