import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "../auth/middleware.ts";
import type { OAuthScope } from "../auth/oauth.ts";
import { grantedScopeAllowsRisk } from "../auth/oauth.ts";
import { QoopiaError } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { recordStorageWriteFailure } from "../utils/storage-degradation.ts";
import { NOTE_TYPES } from "../services/notes.ts";
import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
} from "../services/notes.ts";
import { recall } from "../services/recall.ts";
import { brief } from "../services/brief.ts";
import {
  saveMessage,
  sessionRecent,
  sessionSearch,
  sessionSummarize,
  sessionExpand,
} from "../services/sessions.ts";
import { listActivity } from "../services/activity.ts";
import {
  agentSend,
  agentInbox,
  agentReply,
  agentStatus,
  agentSessionCreate,
  agentSessionClose,
} from "../services/agent-comm.ts";
import { registerCompatTools } from "./compat.ts";
import { adminTools } from "./admin-tools.ts";
import { entityTools } from "./entity_tools.ts";
import { skillTools } from "./skill_tools.ts";
import { fileList, fileGet } from "../services/files.ts";
import { assertInstanceWriteAllowed } from "../utils/instance-role.ts";
import { enabledV4Tools } from "./v4-tools.ts";
import { bitemporalEnabled } from "../utils/temporal.ts";
import { db } from "../db/connection.ts";
import { bootstrapToolAllowed, currentToolAuth } from "../auth/policy.ts";
import { isAdmin } from "../auth/principal.ts";

export type ToolProfile = "memory" | "full";

const MEMORY_TOOLS = new Set([
  "recall",
  "brief",
  "session_save",
  "session_recent",
  "session_search",
]);

// QSA-F / ADR-016: tool-level risk classification.
//   read              — no DB writes, no external side effects
//   write-low         — additive writes recoverable via activity log
//   write-destructive — hard or impossible to recover (note_delete)
//   admin             — identity / permission changes (agent_*)
export type RiskClass =
  | "read"
  | "write-low"
  | "write-destructive"
  | "admin";

// QSA-F / ADR-016: per-agent MCP profile. The DB CHECK constraint in
// migration 010 is the source of truth; runtime treats anything else
// as 'read-only' (fail-closed).
export type AgentToolProfile = "read-only" | "no-destructive" | "full";

const KNOWN_AGENT_PROFILES: ReadonlySet<AgentToolProfile> = new Set([
  "read-only",
  "no-destructive",
  "full",
]);

/**
 * Coerce an arbitrary string from the DB (or undefined / null) into a
 * known AgentToolProfile. Unknown / missing values fail-closed to
 * 'read-only' with a single WARN line per request, matching the
 * documented behavior in ADR-016 "Fail-closed on null / unknown
 * profile". Exported so tests can exercise the fallback.
 */
export function normalizeAgentProfile(
  raw: unknown,
  agentName: string,
): AgentToolProfile {
  if (
    typeof raw === "string" &&
    KNOWN_AGENT_PROFILES.has(raw as AgentToolProfile)
  ) {
    return raw as AgentToolProfile;
  }
  logger.warn(
    `agent=${agentName} tool_profile=${JSON.stringify(raw)} unknown — degraded to read-only (fail-closed)`,
  );
  return "read-only";
}

/**
 * Decide whether a tool of the given risk class is exposed under the
 * agent's profile. Stricter wins: a `read-only` agent only sees `read`
 * tools regardless of the server-level `ToolProfile` argument.
 */
export function isToolAllowedForProfile(
  risk: RiskClass,
  profile: AgentToolProfile,
): boolean {
  switch (profile) {
    case "read-only":
      return risk === "read";
    case "no-destructive":
      return risk === "read" || risk === "write-low";
    case "full":
      return true;
  }
}

export interface ToolDef {
  name: string;
  description: string;
  // QSA-F / ADR-016: required so the per-agent filter can decide
  // visibility. New tools without an explicit risk class won't compile.
  risk: RiskClass;
  rawSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, auth: AuthContext) => unknown | Promise<unknown>;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
  let msg: string;
  if (recordStorageWriteFailure(err)) {
    msg = "STORAGE_FULL: SQLite storage capacity exhausted; writes are disabled. Free storage capacity, then restart Qoopia and verify /ready before resuming writes.";
  } else
  if (err instanceof QoopiaError) {
    msg = `${err.code}: ${err.message}`;
  } else if (err instanceof Error) {
    // M4 fix: log internal errors server-side, return stable generic message
    const raw = err.message;
    // Translate SQLite busy/lock errors into retryable domain error
    if (raw.includes("SQLITE_BUSY") || raw.includes("database is locked")) {
      msg = "BUSY: Database busy, please retry";
    } else if (raw.includes("UNIQUE constraint failed") && raw.includes("steward")) {
      msg = "CONFLICT: active steward already exists";
    } else if (raw.includes("UNIQUE constraint failed")) {
      msg = "CONFLICT: a record with the same identifier already exists";
    } else {
      logger.error("MCP tool internal error", { error: raw, stack: err.stack });
      msg = "INTERNAL: unexpected error — check server logs";
    }
  } else {
    logger.error("MCP tool unknown error", { error: String(err) });
    msg = "INTERNAL: unexpected error — check server logs";
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

const noteTypeEnum = z.enum(NOTE_TYPES);

// QRERUN-003 / ADR-014: agent types that bypass the per-note `private`
// visibility filter on MCP read paths (recall, brief, note_get, note_list).
// Mirrors the admin set used by dashboard-api.ts.

// -------- Tool definitions --------

const tools: ToolDef[] = [

  {
    name: "recall",
    risk: "read",
    description:
      "Search notes, activity log, and session messages. Note retrieval combines keywords and multilingual semantic similarity, with permission checks before ranking. A connected workspace subscription adds bounded query expansion, related-note retrieval and relevance judging automatically; judging metadata reports whether it ran. Without a usable model, keyword/vector retrieval remains available. Default notes fit a conservative 4k serialized-byte envelope with explicit completeness; use each excerpt's note_get request for its full body. The deep/deep_llm switches additionally select configured legacy rerank services.",
    rawSchema: {
      query: z.string().min(1).max(1000).describe("Describe what you need, or provide specific keywords."),
      limit: z.number().int().min(1).max(50).optional(),
      scope: z
        .enum(["notes", "activity", "sessions", "all"])
        .optional()
        .describe(
          "notes (default) | activity (audit log) | sessions (conversation messages) | all (union of the three).",
        ),
      type: noteTypeEnum.optional(),
      project_id: z.string().optional(),
      cross_workspace: z
        .boolean()
        .optional()
        .describe("Honored only for privileged agents (Claude)."),
      include_archived: z
        .boolean()
        .optional()
        .describe(
          "Include notes whose metadata.status='archived'. Default false — archived rows hidden to keep results focused.",
        ),
      deep: z
        .boolean()
        .optional()
        .describe(
          "Request the configured legacy cross-encoder reranker. Overrides its server default; does not disable automatic judging by a connected workspace subscription.",
        ),
      deep_llm: z
        .boolean()
        .optional()
        .describe(
          "Request the configured legacy LLM reranker instead of the legacy cross-encoder. Workspace subscription judging is automatic when connected.",
        ),
      latest_only: z.boolean().optional().describe(
        "Return active supersede heads only. Effective default remains false until QOOPIA_V4_LATEST_ONLY is enabled. include_history=true forces false when omitted and rejects explicit true.",
      ),
      include_history: z.boolean().optional().default(false).describe(
        "Relation audit mode. true requires include_archived=true, forces effective latest_only=false when omitted, and is incompatible with explicit latest_only=true.",
      ),
      explain: z.boolean().optional().default(false).describe(
        "Return bounded score components and reason codes for visible results only. Requires QOOPIA_V4_RECALL_EXPLAIN.",
      ),
      trace: z.boolean().optional().default(false).describe(
        "Persist a privacy-safe bounded trace and return its opaque ID. Requires QOOPIA_V4_RECALL_EXPLAIN.",
      ),
      lifecycle: z.boolean().optional().describe(
        "Per-call lifecycle override. true requires QOOPIA_V4_LIFECYCLE; false disables lifecycle for this call.",
      ),
    },
    handler: (args, auth) => {
      const privileged = auth.type === "claude-privileged" || auth.type === "owner";
      return recall({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        query: String(args.query),
        limit: args.limit as number | undefined,
        scope: args.scope as
          | "notes"
          | "activity"
          | "sessions"
          | "all"
          | undefined,
        type: args.type as string | undefined,
        project_id: args.project_id as string | undefined,
        cross_workspace: args.cross_workspace as boolean | undefined,
        privileged,
        include_archived: args.include_archived as boolean | undefined,
        deep: args.deep as boolean | undefined,
        deep_llm: args.deep_llm as boolean | undefined,
        // V4.1: поля присутствуют в схеме только при включённом флаге; при
        // выключенном прямой вызов всё равно отсеивается FEATURE_DISABLED.
        valid_as_of: args.valid_as_of as string | undefined,
        known_as_of: args.known_as_of as string | undefined,
        latest_only: args.latest_only as boolean | undefined,
        include_history: args.include_history as boolean | undefined,
        explain: args.explain as boolean | undefined,
        trace: args.trace as boolean | undefined,
        lifecycle: args.lifecycle as boolean | undefined,
      });
    },
  },
  {
    name: "brief",
    risk: "read",
    description:
      "Workspace snapshot: open tasks, recent notes, active deals, agent activity. Call at session start to restore context.",
    rawSchema: {
      project: z
        .string()
        .optional()
        .describe("Project ULID or exact project note text"),
      agent: z.string().optional(),
      limit_per_section: z.number().int().min(1).max(50).optional(),
    },
    handler: (args, auth) =>
      brief({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        project: args.project as string | undefined,
        agent: args.agent as string | undefined,
        limit_per_section: args.limit_per_section as number | undefined,
      }),
  },
  {
    name: "note_create",
    risk: "write-low",
    description:
      "Create a note in the universal notes table. Use type to distinguish task/deal/contact/finance/project/memory/decision/etc.",
    rawSchema: {
      text: z.string().min(1).max(100_000),
      type: noteTypeEnum.optional(),
      metadata: z.record(z.unknown()).optional(),
      project_id: z.string().optional(),
      task_bound_id: z
        .string()
        .optional()
        .describe("Bind this note to a task; auto-purged when task closes."),
      session_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
      visibility: z
        .enum(["workspace", "private"])
        .optional()
        .describe(
          "ADR-014: 'workspace' (default) shares note with all agents in this workspace. 'private' restricts reads to this agent and admin types.",
        ),
    },
    handler: (args, auth) =>
      createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: String(args.text),
        type: args.type as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        project_id: args.project_id as string | undefined,
        task_bound_id: args.task_bound_id as string | undefined,
        session_id: args.session_id as string | undefined,
        tags: args.tags as string[] | undefined,
        visibility: args.visibility as "workspace" | "private" | undefined,
        // V4.1 §6.1 — присутствуют в схеме только при включённом флаге.
        supersedes_id: args.supersedes_id as string | undefined,
        expected_superseded_updated_at_ms:
          args.expected_superseded_updated_at_ms as number | undefined,
        subject_key: args.subject_key as string | undefined,
        valid_from: args.valid_from as string | undefined,
        valid_until: args.valid_until as string | undefined,
        idempotency_key: args.idempotency_key as string | undefined,
        connection_id: auth.connection_id,
        is_admin: isAdmin(auth),
      }),
  },
  {
    name: "note_get",
    risk: "read",
    description: "Fetch a single note by ULID.",
    rawSchema: {
      id: z.string().min(1),
    },
    handler: (args, auth) =>
      getNote(auth.workspace_id, String(args.id), auth.agent_id, isAdmin(auth)),
  },
  {
    name: "note_list",
    risk: "read",
    description:
      "List notes with filters: type, project_id, agent, status (from metadata), tags, date range, session.",
    rawSchema: {
      type: noteTypeEnum.optional(),
      project_id: z.string().optional(),
      agent: z.string().optional(),
      status: z.string().optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      session_id: z.string().optional(),
      task_bound_id: z.string().optional(),
      include_deleted: z.boolean().optional(),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["created_desc", "created_asc", "updated_desc"]).optional(),
    },
    handler: (args, auth) =>
      listNotes({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        type: args.type as string | undefined,
        project_id: args.project_id as string | undefined,
        agent: args.agent as string | undefined,
        status: args.status as string | undefined,
        tags: args.tags as string[] | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        session_id: args.session_id as string | undefined,
        task_bound_id: args.task_bound_id as string | undefined,
        include_deleted: args.include_deleted as boolean | undefined,
        include_archived: args.include_archived as boolean | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        order: args.order as
          | "created_desc"
          | "created_asc"
          | "updated_desc"
          | undefined,
      }),
  },
  {
    name: "note_update",
    // QSA-F / Codex review #2 (2026-04-28): note_update can fully replace
    // text and (with metadata_replace=true) wipe metadata; the activity
    // log records field NAMES, not prior values, so the change is not
    // recoverable from audit alone. Treat as write-destructive so a
    // 'no-destructive' profile cannot silently overwrite content.
    risk: "write-destructive",
    description:
      "Update a note. Metadata merges shallowly by default; use metadata_replace to fully replace.",
    rawSchema: {
      id: z.string().min(1),
      text: z.string().max(100_000).optional(),
      metadata: z.record(z.unknown()).optional(),
      metadata_replace: z.record(z.unknown()).optional(),
      project_id: z.string().nullable().optional(),
      task_bound_id: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    handler: (args, auth) =>
      updateNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        id: String(args.id),
        text: args.text as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        metadata_replace: args.metadata_replace as
          | Record<string, unknown>
          | undefined,
        project_id: args.project_id as string | null | undefined,
        task_bound_id: args.task_bound_id as string | null | undefined,
        tags: args.tags as string[] | undefined,
      }),
  },
  {
    name: "note_delete",
    risk: "write-destructive",
    description: "Soft-delete a note (sets deleted_at).",
    rawSchema: {
      id: z.string().min(1),
    },
    handler: (args, auth) =>
      deleteNote(
        auth.workspace_id,
        auth.agent_id,
        String(args.id),
        isAdmin(auth),
      ),
  },
  {
    name: "session_save",
    risk: "write-low",
    description:
      "Append one message to a session. Call after every user message AND every assistant response.",
    rawSchema: {
      session_id: z.string().min(1).max(100),
      role: z.enum(["user", "assistant", "system", "tool"]),
      content: z.string().min(1).max(100_000),
      metadata: z.record(z.unknown()).optional(),
      token_count: z.number().int().positive().optional(),
    },
    handler: (args, auth) =>
      saveMessage({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        role: args.role as "user" | "assistant" | "system" | "tool",
        content: String(args.content),
        metadata: args.metadata as Record<string, unknown> | undefined,
        token_count: args.token_count as number | undefined,
      }),
  },
  {
    name: "session_recent",
    risk: "read",
    description:
      "Load recent messages from a session. Pass session_id='latest' to get the most recent session of this agent.",
    rawSchema: {
      session_id: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      include_summaries: z.boolean().optional(),
    },
    handler: (args, auth) =>
      sessionRecent({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        limit: args.limit as number | undefined,
        include_summaries: args.include_summaries as boolean | undefined,
      }),
  },
  {
    name: "session_search",
    risk: "read",
    description: "FTS5 search across saved session messages.",
    rawSchema: {
      query: z.string().min(1).max(1000),
      session_id: z.string().optional(),
      scope: z.enum(["own_agent", "workspace", "all"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    },
    handler: (args, auth) => {
      const privileged = auth.type === "claude-privileged" || auth.type === "owner";
      return sessionSearch({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        query: String(args.query),
        session_id: args.session_id as string | undefined,
        scope: args.scope as "own_agent" | "workspace" | "all" | undefined,
        limit: args.limit as number | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        privileged,
      });
    },
  },
  {
    name: "session_summarize",
    risk: "write-low",
    description:
      "Save your own summary of a message range. Qoopia does not generate summaries — you write the text.",
    rawSchema: {
      session_id: z.string().min(1),
      content: z.string().min(1).max(50_000),
      msg_start_id: z.number().int().positive(),
      msg_end_id: z.number().int().positive(),
      level: z.number().int().min(1).max(10).optional(),
      token_count: z.number().int().positive().optional(),
    },
    handler: (args, auth) =>
      sessionSummarize({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        content: String(args.content),
        msg_start_id: Number(args.msg_start_id),
        msg_end_id: Number(args.msg_end_id),
        level: args.level as number | undefined,
        token_count: args.token_count as number | undefined,
      }),
  },
  {
    name: "session_expand",
    risk: "read",
    description: "Fetch raw messages by ID range (expand a prior summary).",
    rawSchema: {
      start_id: z.number().int().positive(),
      end_id: z.number().int().positive(),
      session_id: z.string().optional(),
    },
    handler: (args, auth) =>
      sessionExpand({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        start_id: Number(args.start_id),
        end_id: Number(args.end_id),
        session_id: args.session_id as string | undefined,
      }),
  },

  {
    name: "activity_list",
    risk: "read",
    description: "Read the activity audit log with filters.",
    rawSchema: {
      entity_type: z.string().optional(),
      entity_id: z.string().optional(),
      project_id: z.string().optional(),
      agent: z.string().optional(),
      action: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: (args, auth) =>
      listActivity({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: isAdmin(auth),
        entity_type: args.entity_type as string | undefined,
        entity_id: args.entity_id as string | undefined,
        project_id: args.project_id as string | undefined,
        agent: args.agent as string | undefined,
        action: args.action as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  // ---- AgentComm: Phase 1 item 1 (MCP wrappers over src/services/agent-comm.ts) ----
  {
    name: "agent_send",
    risk: "write-low",
    description:
      "Send a message to another agent. It is delivered into the recipient's turn automatically; nothing has to be acknowledged. Agents in your own workspace are matched first; a name that is unique instance-wide also reaches an agent in another workspace (memory, notes and recall stay private to each). Creates a new session if session_id is omitted. Supply idempotency_key to make retries return the original send.",
    rawSchema: {
      to_agent: z.string().min(1).describe("Recipient agent name or id."),
      body: z.string().min(1).max(50_000),
      session_id: z.string().optional(),
      topic: z.string().optional().describe("Used only when creating a new session."),
      metadata: z.record(z.unknown()).optional(),
      kind: z.enum(["request", "ack", "reply", "status", "system"]).optional(),
      parent_message_id: z.string().optional(),
      idempotency_key: z.string().min(1).max(128).optional(),
    },
    handler: (args, auth) =>
      agentSend({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        to_agent: String(args.to_agent),
        body: String(args.body),
        session_id: args.session_id as string | undefined,
        topic: args.topic as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        kind: args.kind as
          | "request"
          | "ack"
          | "reply"
          | "status"
          | "system"
          | undefined,
        parent_message_id: args.parent_message_id as string | undefined,
        idempotency_key: args.idempotency_key as string | undefined,
      }),
  },
  {
    name: "agent_inbox",
    risk: "read",
    description:
      "List messages addressed to the calling agent. Messages are pushed into your turn automatically as they arrive, so this is a history view rather than something you must poll; if your client has no runtime to push to, listing them here is what delivers them. Whatever this returns is recorded as delivered. status filters by transport delivery state.",
    rawSchema: {
      status: z.enum(["delivered", "undelivered"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: (args, auth) =>
      agentInbox({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        status: args.status as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "agent_reply",
    risk: "write-low",
    description:
      "Reply within an existing session. If to_agent is omitted the most recent other party is used. Set close=true to close the session after sending.",
    rawSchema: {
      session_id: z.string().min(1),
      body: z.string().min(1).max(50_000),
      to_agent: z.string().optional(),
      reply_to_message_id: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      close: z.boolean().optional(),
      idempotency_key: z.string().min(1).max(128).optional(),
    },
    handler: (args, auth) =>
      agentReply({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        body: String(args.body),
        to_agent: args.to_agent as string | undefined,
        reply_to_message_id: args.reply_to_message_id as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        close: args.close as boolean | undefined,
        idempotency_key: args.idempotency_key as string | undefined,
      }),
  },
  {
    name: "agent_status",
    risk: "read",
    description:
      "List active agents in the workspace. Pass 'agent' to look up a single name; that lookup also finds an agent in another workspace when the name is unique instance-wide, flagged with external_workspace.",
    rawSchema: {
      agent: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: (args, auth) =>
      agentStatus({
        workspace_id: auth.workspace_id,
        agent: args.agent as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "agent_session_create",
    risk: "write-low",
    description:
      "Open a new agent-to-agent session with a topic. Optionally seed it atomically with an initial message by passing to_agent + message. Supply idempotency_key to make retries return the original session.",
    rawSchema: {
      topic: z.string().min(1).max(500),
      to_agent: z.string().optional(),
      message: z.string().max(50_000).optional(),
      metadata: z.record(z.unknown()).optional(),
      idempotency_key: z.string().min(1).max(128).optional(),
    },
    handler: (args, auth) =>
      agentSessionCreate({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        topic: String(args.topic),
        to_agent: args.to_agent as string | undefined,
        message: args.message as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
        idempotency_key: args.idempotency_key as string | undefined,
      }),
  },
  {
    name: "agent_session_close",
    risk: "write-low",
    description:
      "Close an open agent session. Status flips to 'closed' and timestamps are stamped; the close action is logged in the activity audit.",
    rawSchema: {
      session_id: z.string().min(1),
      reason: z.string().max(1000).optional(),
    },
    handler: (args, auth) =>
      agentSessionClose({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        session_id: String(args.session_id),
        reason: args.reason as string | undefined,
      }),
  },
  {
    name: "file_list",
    risk: "read",
    description:
      "List files the owner uploaded via the dashboard into named folders. Optional folder / owner filters. Workspace-scoped. Returns metadata (id, folder, filename, mime, size, readable).",
    rawSchema: {
      folder: z.string().max(200).optional().describe("Filter to one folder."),
      owner: z.string().max(64).optional().describe("Uploader/owner agent name."),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: (args, auth) =>
      fileList({
        workspace_id: auth.workspace_id,
        folder: args.folder as string | undefined,
        owner: args.owner as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "file_get",
    risk: "read",
    description:
      "Read one uploaded file by id, or by folder + filename. Returns inline text for text/markdown/docx/pdf; for other binary returns metadata + a dashboard download_path. Workspace-scoped.",
    rawSchema: {
      id: z.string().optional().describe("File id."),
      folder: z.string().optional().describe("Folder (use with filename)."),
      filename: z.string().optional().describe("Filename (use with folder)."),
    },
    handler: (args, auth) =>
      fileGet({
        workspace_id: auth.workspace_id,
        id: args.id as string | undefined,
        folder: args.folder as string | undefined,
        filename: args.filename as string | undefined,
      }),
  },
];

// Phase 2 Item C — entity page surface (5 tools). Gated behind
// QOOPIA_ENTITY_PAGES=true (default OFF until the explicit owner sign-off
// in docs/operations/entity-pages-production-enable.md). The check
// runs at module load: flipping the env mid-process does NOT toggle
// visibility — operators restart the container after enabling. This
// matches how QOOPIA_RECALL_MODE flips behaviour but not the tool
// surface itself.
//
// When OFF the surface is identical to pre-Item-C: `entity_*` tools
// are absent from `tools` and from MCP descriptors, the recall entity
// channel short-circuits (src/services/recall.ts checks the same env),
// and any caller asking for `entity_upsert` gets the standard "Unknown
// tool" response.
if (process.env.QOOPIA_ENTITY_PAGES === "true") {
  tools.push(...entityTools);
}

// Phase 2 Item E — fat skills surface (5 tools). Gated behind
// QOOPIA_SKILLS=true (default OFF until Leo final PASS + Asхат GO).
// Mirrors the QOOPIA_ENTITY_PAGES rollout pattern from Item C R2.
// The skills layer is built on entity_pages (type='skill') so it
// implicitly requires QOOPIA_ENTITY_PAGES at the service layer — but
// the MCP surface is a separate flag so an operator can enable the
// entity catalogue without exposing the skill helpers until the seed
// content has landed.
if (process.env.QOOPIA_SKILLS === "true") {
  tools.push(...skillTools);
}

// V4 tools are canonical and additive, but each bounded context stays absent
// until its explicit feature flag is enabled. Export/import bindings are owned
// by P08 and intentionally do not appear here yet.
tools.push(...enabledV4Tools());

/**
 * V4.1 §7.5 — MCP-поверхность расширяется только при включённом
 * QOOPIA_V4_BITEMPORAL. Флаг читается в момент регистрации, поэтому
 * caталог, снимаемый живым probe, всегда совпадает с фактическим сервером,
 * а при выключенном флаге inputSchema `recall`/`note_create` байт-в-байт
 * прежние.
 */
export function bitemporalToolFields(name: string): z.ZodRawShape {
  if (!bitemporalEnabled()) return {};
  if (name === "recall") {
    return {
      valid_as_of: z.string().min(1).max(40).optional().describe(
        "Bi-temporal: what was true in the world at T (UTC ISO). Incompatible with include_history=true.",
      ),
      known_as_of: z.string().min(1).max(40).optional().describe(
        "Bi-temporal: what the system knew at T (UTC ISO). Incompatible with include_history=true.",
      ),
    };
  }
  if (name === "note_create") {
    return {
      supersedes_id: z.string().min(1).optional().describe(
        "Explicitly supersede this note. Requires expected_superseded_updated_at_ms.",
      ),
      expected_superseded_updated_at_ms: z.number().int().min(1).optional().describe(
        "Optimistic version of the superseded note. Mandatory together with supersedes_id.",
      ),
      subject_key: z.string().min(1).max(128).optional(),
      valid_from: z.string().min(1).max(40).optional(),
      valid_until: z.string().min(1).max(40).optional(),
      // §6.3 — идемпотентный replay обязан быть достижим ИМЕННО отсюда.
      // Реестр на уровне сервиса без поля в MCP-схеме и без проброса в
      // хендлере недоступен клиенту, то есть требование не выполнено.
      idempotency_key: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          "Idempotent replay key. An identical repeat returns the same note without a second " +
            "insert or a second supersession; the same key with a different payload is " +
            "CONFLICT / IDEMPOTENCY_MISMATCH.",
        ),
    };
  }
  return {};
}

/**
 * Найти зарегистрированный инструмент по имени. Нужен тестам MCP-границы:
 * без него проверить, что хендлер ДЕЙСТВИТЕЛЬНО пробрасывает поле, можно
 * было бы только через живой сервер.
 */
export function findTool(name: string): ToolDef | undefined {
  return tools.find((tool) => tool.name === name);
}

/** Схема инструмента с учётом V4.1-расширений на момент регистрации. */
export function effectiveToolSchema(tool: ToolDef): z.ZodRawShape {
  const extra = bitemporalToolFields(tool.name);
  return Object.keys(extra).length === 0 ? tool.rawSchema : { ...tool.rawSchema, ...extra };
}

export function registerTools(
  server: McpServer,
  authProvider: () => AuthContext | null,
  profile: ToolProfile = "full",
  opts?: {
    isSteward?: boolean;
    agentToolProfile?: AgentToolProfile;
    grantedScope?: OAuthScope[];
    bootstrapProfile?: string;
  },
) {
  // QSA-F / ADR-016: per-agent profile filter. Defaults to 'full' to
  // preserve current behavior for callers that don't pass it (tests,
  // bootstrap CLI, future code paths). Production handleMcp always
  // computes this from auth.tool_profile via normalizeAgentProfile.
  const agentProfile: AgentToolProfile = opts?.agentToolProfile ?? "full";
  const grantedScope = opts?.grantedScope;

  for (const tool of tools) {
    if (!bootstrapToolAllowed(tool.name, opts?.bootstrapProfile)) continue;
    if (profile === "memory" && !MEMORY_TOOLS.has(tool.name)) continue;
    if (!isToolAllowedForProfile(tool.risk, agentProfile)) continue;
    if (!grantedScopeAllowsRisk(grantedScope, tool.risk)) continue;
    server.registerTool(
      tool.name,
      { description: tool.description,
        // These describe effects; the profile and OAuth checks below still enforce access.
        annotations: {
          readOnlyHint: tool.risk === 'read',
          destructiveHint: tool.risk === 'write-destructive' || tool.risk === 'admin',
          ...(tool.name === 'note_get' || tool.name === 'note_create' ? {openWorldHint:false} : {}),
          ...(tool.name === 'note_create' && authProvider()?.connection_id ? {idempotentHint:true} : {}),
        },
        inputSchema: z.object({...effectiveToolSchema(tool),
        ...(tool.name==='note_create'&&authProvider()?.connection_id?{idempotency_key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).describe('Use a stable unique key for this write. Reuse it only to retry the exact same note after an interrupted request.')}:{})}).strict() },
      async (args: unknown) => {
        try {
          const auth = authProvider();
          if (!auth) {
            return fail(new QoopiaError("UNAUTHORIZED", "No auth context"));
          }
          assertInstanceWriteAllowed(tool.risk, tool.name);
          if (!grantedScopeAllowsRisk(auth.granted_scope, tool.risk)) {
            return fail(
              new QoopiaError(
                "FORBIDDEN",
                `OAuth token scope forbids MCP tool '${tool.name}'`,
              ),
            );
          }
          const result = await tool.handler(
            (args as Record<string, unknown>) || {},
            currentToolAuth(db, auth, tool.risk),
          );
          return ok(result);
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // Admin tools: only registered for steward agents
  if (opts?.isSteward) {
    for (const tool of adminTools) {
      if (!bootstrapToolAllowed(tool.name, opts?.bootstrapProfile)) continue;
      // Per-agent profile filter applies even to steward — a steward
      // demoted to 'read-only' should still see only `risk='read'`
      // admin tools (i.e. agent_list).
      if (!isToolAllowedForProfile(tool.risk, agentProfile)) continue;
      if (!grantedScopeAllowsRisk(grantedScope, tool.risk)) continue;
      server.tool(
        tool.name,
        tool.description,
        tool.rawSchema,
        async (args: unknown) => {
          try {
            const auth = authProvider();
            if (!auth) {
              return fail(new QoopiaError("UNAUTHORIZED", "No auth context"));
            }
            assertInstanceWriteAllowed(tool.risk, tool.name);
            if (!grantedScopeAllowsRisk(auth.granted_scope, tool.risk)) {
              return fail(
                new QoopiaError(
                  "FORBIDDEN",
                  `OAuth token scope forbids MCP tool '${tool.name}'`,
                ),
              );
            }
            const result = await tool.handler(
              (args as Record<string, unknown>) || {},
              currentToolAuth(db, auth, tool.risk),
            );
            return ok(result);
          } catch (err) {
            return fail(err);
          }
        },
      );
    }
  }

  // V2 backward-compatibility aliases are disabled by default so agents only
  // see/use canonical V3 Qoopia tools. Keep an explicit rollback switch for
  // legacy clients during migration.
  if (profile !== "memory" && process.env.QOOPIA_ENABLE_V2_COMPAT === "true") {
    registerCompatTools(server, authProvider, agentProfile, grantedScope);
  }
}

/**
 * QSA-F / ADR-016: lookup a tool's risk class by name. Used by the
 * access log in src/http.ts to surface which risk class each MCP call
 * exercised. Returns null for unknown tool names (V2 compat aliases
 * fall through to canonical-name handlers, so their risk is implicit).
 */
const TOOL_RISK_INDEX: ReadonlyMap<string, RiskClass> = (() => {
  const m = new Map<string, RiskClass>();
  for (const t of tools) m.set(t.name, t.risk);
  for (const t of adminTools) m.set(t.name, t.risk);
  // V2 compat aliases — pinned here to keep src/http.ts logging
  // self-contained without importing compat.ts.
  m.set("create", "write-low");
  // QSA-F / Codex review #2: V2 'update' wraps note_update (write-destructive
  // because text/metadata replace is not recoverable from audit). Mirror it.
  m.set("update", "write-destructive");
  m.set("delete", "write-destructive");
  m.set("list", "read");
  m.set("get", "read");
  m.set("note", "write-low");
  return m;
})();

export function riskOf(toolName: string): RiskClass | null {
  return TOOL_RISK_INDEX.get(toolName) ?? null;
}

export function toolNames(profile: ToolProfile = "full"): string[] {
  return tools
    .filter((t) => profile === "full" || MEMORY_TOOLS.has(t.name))
    .map((t) => t.name);
}
