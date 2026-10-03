/**
 * V2 backward-compatibility layer — rollback switch only.
 *
 * Off by default: src/mcp/tools.ts registers these aliases only when
 * QOOPIA_ENABLE_V2_COMPAT=true (and never on the memory profile). They are
 * not advertised in toolCatalog()/qoopia_capabilities; agents use the V3
 * names. The aliases translate V2 tool names and argument shapes into V3
 * service calls without changing data semantics.
 *
 * Tools registered here (6):
 *   create  — generic create with `entity` discriminator → V3 createNote / logActivity
 *   update  — generic update with `entity` discriminator → V3 updateNote
 *   delete  — generic delete with `entity` discriminator → V3 deleteNote
 *   list    — generic list with `entity` discriminator → V3 listNotes / listActivity
 *   get     — generic get with `entity` discriminator → V3 getNote
 *   note    — memory note (was V2 'note' with auto-magic; we drop the magic)
 *
 * recall and brief keep their V2 names in V3 and are not re-registered here.
 * Each alias is gated by the same risk class, agent profile and OAuth scope as
 * its V3 handler. tests/compat-aliases.test.ts exercises every alias.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "../auth/middleware.ts";
import type { OAuthScope } from "../auth/oauth.ts";
import { grantedScopeAllowsRisk } from "../auth/oauth.ts";
import { QoopiaError } from "../utils/errors.ts";
import { db } from "../db/connection.ts";
import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
} from "../services/notes.ts";
import { logActivity, listActivity } from "../services/activity.ts";
import {
  boundedMetadata,
  boundedTags,
  isToolAllowedForProfile,
  normalizeAgentProfile,
  type AgentToolProfile,
  type RiskClass,
} from "./profiles.ts";
import type { ToolDef, toolCallback } from "./tools.ts";
import { isAdmin, seesWholeWorkspace } from "../auth/principal.ts";

// V2 plural entity → V3 singular type
const ENTITY_TO_TYPE: Record<string, string> = {
  tasks: "task",
  deals: "deal",
  contacts: "contact",
  finances: "finance",
  projects: "project",
};

// ---- field composition helpers ----

function composeTaskText(title: unknown, description: unknown): string {
  const t = String(title || "").trim();
  const d = String(description || "").trim();
  if (!t) throw new QoopiaError("INVALID_INPUT", "title required");
  return d ? `${t}\n\n${d}` : t;
}

function buildTaskMetadata(args: Record<string, unknown>) {
  return {
    status: args.status ?? "todo",
    priority: args.priority ?? "medium",
    assignee: args.assignee ?? null,
    due_date: args.due_date ?? null,
    inline_notes: args.notes ?? null,
  };
}

function buildDealMetadata(args: Record<string, unknown>) {
  return {
    status: args.status ?? "active",
    address: args.address ?? null,
    asking_price: args.asking_price ?? null,
    target_price: args.target_price ?? null,
    monthly_rent: args.monthly_rent ?? null,
    inline_notes: args.notes ?? null,
    metadata: args.metadata ?? {},
    timeline: args.timeline ?? [],
  };
}

function buildContactMetadata(args: Record<string, unknown>) {
  return {
    role: args.role ?? null,
    company: args.company ?? null,
    email: args.email ?? null,
    phone: args.phone ?? null,
    telegram_id: args.telegram_id ?? null,
    language: args.language ?? "EN",
    timezone: args.timezone ?? null,
    category: args.category ?? null,
    inline_notes: args.notes ?? null,
  };
}

function buildFinanceMetadata(args: Record<string, unknown>) {
  return {
    finance_type: args.type ?? null,
    amount: args.amount ?? 0,
    currency: args.currency ?? "USD",
    recurring: args.recurring ?? "none",
    status: args.status ?? "active",
    inline_notes: args.notes ?? null,
  };
}

function buildProjectMetadata(args: Record<string, unknown>) {
  return {
    description: args.description ?? null,
    status: args.status ?? "active",
    color: args.color ?? null,
  };
}

// Build V2-style "create" → routes by entity discriminator
// QSA-C: exported for direct unit testing of the admin-only activity gate.
export function v2Create(args: Record<string, unknown>, auth: AuthContext) {
  const entity = String(args.entity || "");
  switch (entity) {
    case "tasks": {
      return createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: composeTaskText(args.title, args.description),
        type: "task",
        metadata: buildTaskMetadata(args),
        project_id: (args.project_id as string) || null,
        tags: (args.tags as string[]) || [],
      });
    }
    case "deals": {
      const name = String(args.name || "").trim();
      if (!name) throw new QoopiaError("INVALID_INPUT", "name required");
      return createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: name,
        type: "deal",
        metadata: buildDealMetadata(args),
        project_id: (args.project_id as string) || null,
        tags: (args.tags as string[]) || [],
      });
    }
    case "contacts": {
      const name = String(args.name || "").trim();
      if (!name) throw new QoopiaError("INVALID_INPUT", "name required");
      return createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: name,
        type: "contact",
        metadata: buildContactMetadata(args),
        tags: (args.tags as string[]) || [],
      });
    }
    case "finances": {
      const name = String(args.name || "").trim();
      if (!name) throw new QoopiaError("INVALID_INPUT", "name required");
      return createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: name,
        type: "finance",
        metadata: buildFinanceMetadata(args),
        project_id: (args.project_id as string) || null,
        tags: (args.tags as string[]) || [],
      });
    }
    case "projects": {
      const name = String(args.name || "").trim();
      if (!name) throw new QoopiaError("INVALID_INPUT", "name required");
      return createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: name,
        type: "project",
        metadata: buildProjectMetadata(args),
        tags: (args.tags as string[]) || [],
      });
    }
    case "activity": {
      // QSA-C / Codex QSA-002 (2026-04-28): activity is the audit log.
      // Allowing any full-profile agent to forge entries (arbitrary action,
      // entity_type, entity_id, summary, details) destroys integrity. The
      // V2 compat 'create activity' is therefore restricted to the steward
      // and the owner (ADR-020); every other agent must use the workspace
      // tools that emit activity through the service layer.
      if (!isAdmin(auth)) {
        throw new QoopiaError(
          "FORBIDDEN",
          "compat 'create activity' is admin-only — standard agents emit activity implicitly via note_create/update/delete",
        );
      }
      // QSA-F / Codex review #2 (2026-04-28): the 'create' alias is gated
      // as write-low at registerCompatTools, so a no-destructive admin
      // (steward on profile='no-destructive') still has
      // the alias registered. activity-forging is admin-class risk; only
      // 'full' profile may exercise it. Defence-in-depth alongside the
      // isAdmin check above.
      const activityProfile = normalizeAgentProfile(
        auth.tool_profile,
        auth.agent_name,
      );
      if (activityProfile !== "full") {
        throw new QoopiaError(
          "FORBIDDEN",
          `tool_profile=${activityProfile} cannot forge activity entries — only 'full' profile may write to the audit log`,
        );
      }
      const id = logActivity({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        action: String(args.action || "logged"),
        entity_type: String(args.entity_type || "note"),
        entity_id: (args.entity_id as string) || null,
        project_id: (args.project_id as string) || null,
        summary: String(args.summary || ""),
        details: (args.details as Record<string, unknown>) || {},
      });
      return { created: true, id };
    }
    default:
      throw new QoopiaError(
        "INVALID_INPUT",
        `unsupported entity for create: ${entity}`,
      );
  }
}

function v2Update(args: Record<string, unknown>, auth: AuthContext) {
  const entity = String(args.entity || "");
  const id = String(args.id || "");
  if (!id) throw new QoopiaError("INVALID_INPUT", "id required");

  // Entity type check: verify the note's type matches what caller expects
  const existingForCheck = getNote(auth.workspace_id, id, auth.agent_id, seesWholeWorkspace(auth));
  const expectedType = ENTITY_TO_TYPE[entity] || entity;
  if (existingForCheck.type !== expectedType) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `Entity type mismatch: note ${id} is '${existingForCheck.type}', not '${entity}'`,
    );
  }

  // Build a metadata patch from known typed fields. Anything that maps to
  // V2 metadata for the relevant entity is included; missing fields stay
  // untouched (V3 updateNote does a shallow merge).
  let textOverride: string | undefined;
  let metadata: Record<string, unknown> = {};

  switch (entity) {
    case "tasks": {
      // If title or description supplied, recompose text. To do this we need
      // existing description if title alone given (and vice versa). Read note.
      if (args.title !== undefined || args.description !== undefined) {
        const existing = getNote(auth.workspace_id, id, auth.agent_id, seesWholeWorkspace(auth));
        const oldText = existing.text || "";
        const split = oldText.split("\n\n");
        const oldTitle = split[0] || "";
        const oldDesc = split.slice(1).join("\n\n");
        const newTitle = args.title !== undefined ? String(args.title) : oldTitle;
        const newDesc =
          args.description !== undefined ? String(args.description) : oldDesc;
        textOverride = newDesc ? `${newTitle}\n\n${newDesc}` : newTitle;
      }
      for (const k of ["status", "priority", "assignee", "due_date"]) {
        if (args[k] !== undefined) metadata[k] = args[k];
      }
      if (args.notes !== undefined) metadata.inline_notes = args.notes;
      break;
    }
    case "deals": {
      if (args.name !== undefined) textOverride = String(args.name);
      for (const k of [
        "status",
        "address",
        "asking_price",
        "target_price",
        "monthly_rent",
      ]) {
        if (args[k] !== undefined) metadata[k] = args[k];
      }
      if (args.notes !== undefined) metadata.inline_notes = args.notes;
      if (args.metadata !== undefined) metadata.metadata = args.metadata;
      if (args.timeline !== undefined) metadata.timeline = args.timeline;
      break;
    }
    case "contacts": {
      if (args.name !== undefined) textOverride = String(args.name);
      for (const k of [
        "role",
        "company",
        "email",
        "phone",
        "telegram_id",
        "language",
        "timezone",
        "category",
      ]) {
        if (args[k] !== undefined) metadata[k] = args[k];
      }
      if (args.notes !== undefined) metadata.inline_notes = args.notes;
      break;
    }
    case "finances": {
      if (args.name !== undefined) textOverride = String(args.name);
      if (args.type !== undefined) metadata.finance_type = args.type;
      for (const k of ["amount", "currency", "recurring", "status"]) {
        if (args[k] !== undefined) metadata[k] = args[k];
      }
      if (args.notes !== undefined) metadata.inline_notes = args.notes;
      break;
    }
    case "projects": {
      // For projects: name → text, others → metadata
      if (args.name !== undefined) textOverride = String(args.name);
      for (const k of ["description", "status", "color"]) {
        if (args[k] !== undefined) metadata[k] = args[k];
      }
      break;
    }
    default:
      throw new QoopiaError(
        "INVALID_INPUT",
        `unsupported entity for update: ${entity}`,
      );
  }

  return updateNote({
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    is_admin: seesWholeWorkspace(auth),
    id,
    text: textOverride,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    tags: (args.tags as string[]) || undefined,
  });
}

function v2List(args: Record<string, unknown>, auth: AuthContext) {
  const entity = String(args.entity || "");
  const limit = (args.limit as number) || 50;

  if (entity === "activity") {
    return listActivity({
      workspace_id: auth.workspace_id,
      caller_agent_id: auth.agent_id,
      is_admin: seesWholeWorkspace(auth),
      entity_type: args.entity_type as string | undefined,
      project_id: args.project_id as string | undefined,
      limit,
    });
  }
  const type = ENTITY_TO_TYPE[entity];
  if (!type) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `unsupported entity for list: ${entity}`,
    );
  }
  return listNotes({
    workspace_id: auth.workspace_id,
    caller_agent_id: auth.agent_id,
    is_admin: seesWholeWorkspace(auth),
    type,
    project_id: args.project_id as string | undefined,
    status: args.status as string | undefined,
    include_archived: Boolean(args.include_archived),
    limit,
  });
}

function v2Get(args: Record<string, unknown>, auth: AuthContext) {
  const id = String(args.id || "");
  if (!id) throw new QoopiaError("INVALID_INPUT", "id required");
  const note = getNote(auth.workspace_id, id, auth.agent_id, seesWholeWorkspace(auth));
  // M11 fix: verify the fetched note type matches the requested entity discriminator
  const entity = String(args.entity || "");
  if (entity) {
    const expectedType = ENTITY_TO_TYPE[entity] || entity;
    if (note.type !== expectedType) {
      throw new QoopiaError(
        "NOT_FOUND",
        `Entity ${id} is type '${note.type}', not '${entity}'`,
      );
    }
  }
  return note;
}

function v2Delete(args: Record<string, unknown>, auth: AuthContext) {
  const id = String(args.id || "");
  if (!id) throw new QoopiaError("INVALID_INPUT", "id required");

  // Entity type check: verify the note's type matches what caller expects
  const entity = String(args.entity || "");
  if (entity) {
    const note = getNote(auth.workspace_id, id, auth.agent_id, seesWholeWorkspace(auth));
    const expectedType = ENTITY_TO_TYPE[entity] || entity;
    if (note.type !== expectedType) {
      throw new QoopiaError(
        "INVALID_INPUT",
        `Entity type mismatch: note ${id} is '${note.type}', not '${entity}'`,
      );
    }
  }

  return deleteNote(auth.workspace_id, auth.agent_id, id, seesWholeWorkspace(auth));
}

function v2Note(args: Record<string, unknown>, auth: AuthContext) {
  const text = String(args.text || "").trim();
  if (!text) throw new QoopiaError("INVALID_INPUT", "text required");
  const v2type = (args.type as string) || "memory";

  // Resolve project: accept ULID or exact name (mirrors brief() resolution)
  let projectId: string | null = null;
  if (args.project) {
    const projectVal = String(args.project);
    const byId = db
      .prepare(
        `SELECT id FROM notes WHERE id = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL`,
      )
      .get(projectVal, auth.workspace_id) as { id: string } | undefined;
    if (byId) {
      projectId = byId.id;
    } else {
      const byName = db
        .prepare(
          `SELECT id FROM notes WHERE text = ? AND workspace_id = ? AND type = 'project' AND deleted_at IS NULL LIMIT 1`,
        )
        .get(projectVal, auth.workspace_id) as { id: string } | undefined;
      if (byName) {
        projectId = byName.id;
      }
    }
  }

  // V2 valid types: rule, memory, knowledge, context. All map 1:1 in V3.
  return createNote({
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    text,
    type: v2type,
    metadata: {
      v2_compat: true,
      v2_session_id: args.session_id ?? null,
      v2_agent_name: args.agent_name ?? null,
      v2_entities_hint: args.entities_hint ?? [],
    },
    session_id: (args.session_id as string) || null,
    project_id: projectId,
  });
}

// ---- registration ----

export function registerCompatTools(
  server: McpServer,
  authProvider: () => AuthContext | null,
  // Passed in by tools.ts: importing it here would be a runtime import cycle.
  callback: typeof toolCallback,
  agentProfile: AgentToolProfile = "full",
  grantedScope?: OAuthScope[],
) {
  // The V2 aliases keep their own write-guard label, scope wording and log
  // prefix, return results unlabelled, and do not await the (sync) handlers.
  const wrap = (fn: ToolDef["handler"], risk: RiskClass) =>
    callback(authProvider, risk, fn, { writeLabel: "v2-compat", forbids: `risk='${risk}'`, await: false, log: "MCP compat tool" });

  // QSA-F / ADR-016: V2 alias risk classification. Each alias gates on
  // the same risk class as its V3 canonical handler — otherwise a
  // 'read-only' agent could bypass the profile by calling `create` /
  // `update` / `delete` instead of `note_*`.
  const allow = (risk: RiskClass) =>
    isToolAllowedForProfile(risk, agentProfile) &&
    grantedScopeAllowsRisk(grantedScope, risk);

  // Generic CRUD with `entity` discriminator
  if (allow("write-low")) server.tool(
    "create",
    "[V2 compat] Create entity by type. entity ∈ tasks|deals|contacts|finances|projects|activity. Use note_create for V3-native API.",
    {
      entity: z.enum(["tasks", "deals", "contacts", "finances", "projects", "activity"]),
      title: z.string().optional(),
      description: z.string().optional(),
      name: z.string().optional(),
      project_id: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      assignee: z.string().optional(),
      due_date: z.string().optional(),
      address: z.string().optional(),
      asking_price: z.number().optional(),
      target_price: z.number().optional(),
      monthly_rent: z.number().optional(),
      role: z.string().optional(),
      company: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      telegram_id: z.string().optional(),
      language: z.string().optional(),
      timezone: z.string().optional(),
      category: z.string().optional(),
      type: z.string().optional(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      recurring: z.string().optional(),
      entity_type: z.string().optional(),
      entity_id: z.string().optional(),
      action: z.string().optional(),
      summary: z.string().optional(),
      details: boundedMetadata().optional(),
      metadata: boundedMetadata().optional(),
      timeline: z.array(z.unknown()).optional(),
      notes: z.string().optional(),
      tags: boundedTags().optional(),
    },
    wrap(v2Create, "write-low"),
  );

  // QSA-F / Codex review #2: V2 'update' wraps note_update which can
  // overwrite text and (with metadata_replace) wipe metadata. Audit log
  // records field names but not prior values, so the change is not
  // recoverable from audit alone — promote to write-destructive.
  if (allow("write-destructive")) server.tool(
    "update",
    "[V2 compat] Update entity by id. Provide entity + id + fields to change.",
    {
      entity: z.enum(["tasks", "deals", "contacts", "finances", "projects"]),
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      name: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      assignee: z.string().optional(),
      due_date: z.string().optional(),
      address: z.string().optional(),
      asking_price: z.number().optional(),
      target_price: z.number().optional(),
      monthly_rent: z.number().optional(),
      metadata: boundedMetadata().optional(),
      timeline: z.array(z.unknown()).optional(),
      role: z.string().optional(),
      company: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      telegram_id: z.string().optional(),
      language: z.string().optional(),
      timezone: z.string().optional(),
      category: z.string().optional(),
      type: z.string().optional(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      recurring: z.string().optional(),
      color: z.string().optional(),
      notes: z.string().optional(),
      tags: boundedTags().optional(),
    },
    wrap(v2Update, "write-destructive"),
  );

  if (allow("write-destructive")) server.tool(
    "delete",
    "[V2 compat] Soft-delete an entity. entity ∈ tasks|deals|contacts|finances|projects.",
    {
      entity: z.enum(["tasks", "deals", "contacts", "finances", "projects"]),
      id: z.string(),
    },
    wrap(v2Delete, "write-destructive"),
  );

  if (allow("read")) server.tool(
    "list",
    "[V2 compat] List entities by type. Supported filters: project_id, status, entity_type (for activity), limit.",
    {
      entity: z.enum([
        "tasks",
        "deals",
        "contacts",
        "finances",
        "projects",
        "activity",
      ]),
      project_id: z.string().optional(),
      status: z.string().optional(),
      entity_type: z.string().optional(),
      limit: z.number().int().optional(),
    },
    wrap(v2List, "read"),
  );

  if (allow("read")) server.tool(
    "get",
    "[V2 compat] Get a single entity by id.",
    {
      entity: z.string(),
      id: z.string(),
    },
    wrap(v2Get, "read"),
  );

  if (allow("write-low")) server.tool(
    "note",
    "[V2 compat] Record a memory note. Maps to note_create with type=memory by default.",
    {
      text: z.string().min(1).max(100_000),
      project: z.string().optional(),
      agent_name: z.string().optional(),
      session_id: z.string().optional(),
      entities_hint: z.array(z.string()).optional(),
      type: z.enum(["rule", "memory", "knowledge", "context"]).optional(),
    },
    wrap(v2Note, "write-low"),
  );

  // recall and brief already exist in V3 with the same name. We DON'T re-register
  // them — the V3 versions already accept the V2 args (V2 'entities' is ignored,
  // V2 'agent_name' is ignored). Aidan's existing recall/brief calls work as-is.
  // If we want to be strict about V2 'entities' string, we could override here,
  // but it's not needed for current clients.
}
