import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { AuthContext } from "../auth/middleware.ts";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";
import { getNote } from "../services/notes.ts";
import {
  NOTE_RELATION_TYPES,
  createNoteRelation,
  listNoteRelations,
  type NoteRelationType,
} from "../services/note-relations.ts";
import {
  createExtractionRun,
  getExtractionRun,
  listExtractionRuns,
  reviewExtractionCandidate,
  type ExtractionReviewAction,
} from "../services/extraction.ts";
import { supersedeExistingNote } from "../services/note-temporal.ts";
import { bitemporalEnabled } from "../utils/temporal.ts";
import { getRecallTrace } from "../services/recall-traces.ts";
import {
  RECALL_FEEDBACK_TYPES,
  recordRecallFeedback,
  type RecallFeedbackType,
} from "../services/recall-feedback.ts";
import type { ToolDef } from "./tools.ts";
import { env } from "../utils/env.ts";
import {
  createExportPlan,
  materializeExportBundle,
  validateImportPlan,
} from "../services/export.ts";
import { ADMIN_TYPES } from "../auth/principal.ts";

const CURSOR_KEY = randomBytes(32);
const REVIEWER_TYPES = new Set(["owner", "steward"]);

function requireExportAdmin(auth: AuthContext): void {
  if (!REVIEWER_TYPES.has(auth.type) || auth.tool_profile !== "full") {
    throw new QoopiaError("FORBIDDEN", "export/import requires owner or steward with full profile");
  }
  if (auth.source === "oauth" && !auth.granted_scope?.includes("mcp:admin")) {
    throw new QoopiaError("FORBIDDEN", "export/import requires mcp:admin OAuth scope");
  }
  const current = db.query(
    `SELECT type, tool_profile, active FROM agents WHERE id = ? AND workspace_id = ?`,
  ).get(auth.agent_id, auth.workspace_id) as { type: string; tool_profile: string | null; active: number } | null;
  if (!current || current.active !== 1 || !REVIEWER_TYPES.has(current.type) || current.tool_profile !== "full") {
    throw new QoopiaError("FORBIDDEN", "export/import authorization changed before transaction");
  }
}

function exportSigner() {
  const filename = process.env.QOOPIA_V4_EXPORT_SIGNING_KEY_FILE;
  if (!filename) throw new QoopiaError("FORBIDDEN", "export signing key file is not configured");
  return { private_key: fs.readFileSync(filename) };
}

function exportRoot(): string {
  const root = process.env.QOOPIA_V4_EXPORT_ROOT;
  if (!root) throw new QoopiaError("FORBIDDEN", "sanctioned export root is not configured");
  return path.resolve(root);
}

function trustStore(): Record<string, string> {
  const filename = process.env.QOOPIA_V4_EXPORT_TRUST_STORE;
  if (!filename) throw new QoopiaError("FORBIDDEN", "export trust store is not configured");
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, string>;
  for (const [keyId, keyFile] of Object.entries(parsed)) {
    if (!/^[0-9a-f]{64}$/.test(keyId) || typeof keyFile !== "string" || !path.isAbsolute(keyFile)) {
      throw new QoopiaError("INVALID_INPUT", "export trust store contains an invalid entry");
    }
  }
  return parsed;
}

type CursorPayload = {
  v: 1;
  tool: string;
  workspace_id: string;
  agent_id: string;
  capability: string;
  scope_hash: string;
  offset: number;
};

function invalidCursor(): never {
  const error = new QoopiaError("INVALID_INPUT", "invalid or out-of-scope cursor");
  (error as { code: string }).code = "INVALID_ARGUMENT";
  throw error;
}

function scopeHash(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function encodeCursor(
  auth: AuthContext,
  tool: string,
  scope: unknown,
  offset: number,
): string {
  const payload: CursorPayload = {
    v: 1,
    tool,
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    capability: auth.type,
    scope_hash: scopeHash(scope),
    offset,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", CURSOR_KEY).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function decodeCursor(
  cursor: unknown,
  auth: AuthContext,
  tool: string,
  scope: unknown,
): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || cursor.length > 512) invalidCursor();
  const [body, suppliedMac, extra] = cursor.split(".");
  if (!body || !suppliedMac || extra !== undefined) invalidCursor();
  const expectedMac = createHmac("sha256", CURSOR_KEY).update(body).digest();
  let actualMac: Buffer;
  try {
    actualMac = Buffer.from(suppliedMac, "base64url");
  } catch {
    invalidCursor();
  }
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
    invalidCursor();
  }
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    invalidCursor();
  }
  if (
    payload.v !== 1 ||
    payload.tool !== tool ||
    payload.workspace_id !== auth.workspace_id ||
    payload.agent_id !== auth.agent_id ||
    payload.capability !== auth.type ||
    payload.scope_hash !== scopeHash(scope) ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0
  ) {
    invalidCursor();
  }
  return payload.offset;
}

function serviceAuth(auth: AuthContext): AuthContext {
  if (auth.source !== "oauth" || !auth.granted_scope?.includes("mcp:admin")) return auth;
  return { ...auth, granted_scope: [...new Set([...auth.granted_scope, "mcp:write" as const])] };
}

function runOut(run: Record<string, unknown>) {
  return {
    run_id: run.id,
    session_id: run.session_id,
    source_start_id: run.source_start_id,
    source_end_id: run.source_end_id,
    source_range_hash: run.source_range_hash,
    extractor_version: run.extractor_version,
    status: run.status,
    candidate_count: run.candidate_count,
    accepted_count: run.accepted_count,
    rejected_count: run.rejected_count,
    error_code: run.error_code,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
  };
}

function candidateOut(candidate: Record<string, unknown>) {
  return {
    candidate_id: candidate.id,
    proposed_text: candidate.proposed_text,
    proposed_type: candidate.proposed_type,
    proposed_tags: candidate.proposed_tags,
    proposed_entities: candidate.proposed_entities,
    source_message_ids: candidate.source_message_ids,
    confidence: candidate.confidence,
    dedup_note_id: candidate.dedup_note_id,
    conflict_note_ids: candidate.conflict_note_ids,
    risk_flags: candidate.risk_flags,
    status: candidate.status,
    accepted_note_id: candidate.accepted_note_id,
    reviewed_by_agent_id: candidate.reviewed_by_agent_id,
    reviewed_at: candidate.reviewed_at,
    review_reason_code: candidate.review_reason_code,
    review_version: candidate.review_version,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

const relationTools: ToolDef[] = [
  {
    name: "note_relation_list",
    risk: "read",
    description: "List visible V4 relations for one note after workspace and private-note authorization.",
    rawSchema: {
      note_id: z.string().min(1),
      direction: z.enum(["any", "outgoing", "incoming"]).default("any"),
      relation_types: z.array(z.enum(NOTE_RELATION_TYPES)).max(4)
        .refine((items) => new Set(items).size === items.length, "relation_types must be unique")
        .optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().min(1).max(512).optional(),
    },
    handler: (args, auth) => {
      const direction = (args.direction as string | undefined) ?? "any";
      const relationTypes = (args.relation_types as NoteRelationType[] | undefined) ?? [];
      const limit = (args.limit as number | undefined) ?? 25;
      const scope = { note_id: args.note_id, direction, relation_types: [...relationTypes].sort() };
      const offset = decodeCursor(args.cursor, auth, "note_relation_list", scope);
      const all = listNoteRelations({ auth, note_id: String(args.note_id) }).items.filter((row) => {
        if (relationTypes.length && !relationTypes.includes(row.relation_type)) return false;
        if (direction === "outgoing" && row.source_note_id !== args.note_id) return false;
        if (direction === "incoming" && row.target_note_id !== args.note_id) return false;
        return true;
      });
      const relations = all.slice(offset, offset + limit).map(({ workspace_id: _workspace, ...row }) => row);
      const nextOffset = offset + relations.length;
      return {
        relations,
        next_cursor: nextOffset < all.length
          ? encodeCursor(auth, "note_relation_list", scope, nextOffset)
          : null,
      };
    },
  },
  {
    name: "note_supersede",
    risk: "write-destructive",
    description: "Atomically link a current note to the prior note, mirror legacy metadata, and archive the prior note without deleting it.",
    rawSchema: {
      source_note_id: z.string().min(1),
      target_note_id: z.string().min(1),
      expected_target_updated_at_ms: z.number().int().min(1),
      metadata: z.record(z.unknown()).optional(),
      idempotency_key: z.string().min(8).max(200),
    },
    handler: (args, auth) => {
      const requestHash = scopeHash({
        source_note_id: args.source_note_id,
        target_note_id: args.target_note_id,
        expected_target_updated_at_ms: args.expected_target_updated_at_ms,
        metadata: args.metadata ?? {},
      });
      const replay = db.prepare(
        `SELECT id, source_note_id, target_note_id, metadata
           FROM note_relations
          WHERE workspace_id = ? AND relation_type = 'supersedes'
            AND json_extract(metadata, '$.mcp_idempotency_key') = ?`,
      ).get(auth.workspace_id, String(args.idempotency_key)) as
        | { id: string; source_note_id: string; target_note_id: string; metadata: string }
        | undefined;
      if (replay) {
        const metadata = JSON.parse(replay.metadata) as Record<string, unknown>;
        if (metadata.mcp_request_hash !== requestHash) {
          throw new QoopiaError("CONFLICT", "idempotency_key was reused with different input");
        }
        const heads = createNoteRelation({
          auth: serviceAuth(auth),
          source_note_id: replay.source_note_id,
          target_note_id: replay.target_note_id,
          relation_type: "supersedes",
        }).chain?.active_heads ?? [replay.source_note_id];
        return {
          relation_id: replay.id,
          source_note_id: replay.source_note_id,
          target_note_id: replay.target_note_id,
          active_head_ids: heads,
          target_archived: true,
        };
      }
      const target = getNote(auth.workspace_id, String(args.target_note_id), auth.agent_id, ADMIN_TYPES.has(auth.type));
      if (target.updated_at_ms !== args.expected_target_updated_at_ms) {
        throw new QoopiaError("CONFLICT", "target note changed since it was read");
      }
      // V4.1 §6.4: при включённом флаге — тот же атомарный helper, что и у
      // note_create(supersedes_id). `notes.metadata` не трогается, поэтому
      // legacy-поле `target_archived` честно возвращается как false, а
      // закрытие убеждения отражено в `target_invalidated`.
      if (bitemporalEnabled()) {
        const temporal = supersedeExistingNote({
          workspace_id: auth.workspace_id,
          agent_id: auth.agent_id,
          is_admin: ADMIN_TYPES.has(auth.type),
          successor_id: String(args.source_note_id),
          predecessor_id: String(args.target_note_id),
          expected_updated_at_ms: Number(args.expected_target_updated_at_ms),
          relation_metadata: {
            ...(args.metadata as Record<string, unknown> | undefined),
            mcp_idempotency_key: String(args.idempotency_key),
            mcp_request_hash: requestHash,
          },
        });
        return {
          relation_id: temporal.relation_id,
          source_note_id: String(args.source_note_id),
          target_note_id: String(args.target_note_id),
          active_head_ids: [String(args.source_note_id)],
          target_archived: false,
          target_invalidated: true,
          target_invalidated_at_ms: temporal.invalidated_at_ms,
        };
      }
      const result = createNoteRelation({
        auth: serviceAuth(auth),
        source_note_id: String(args.source_note_id),
        target_note_id: String(args.target_note_id),
        relation_type: "supersedes",
        metadata: {
          ...(args.metadata as Record<string, unknown> | undefined),
          mcp_idempotency_key: String(args.idempotency_key),
          mcp_request_hash: requestHash,
        },
      });
      return {
        relation_id: result.relation.id,
        source_note_id: result.relation.source_note_id,
        target_note_id: result.relation.target_note_id,
        active_head_ids: result.chain?.active_heads ?? [String(args.source_note_id)],
        target_archived: true,
      };
    },
  },
];

const extractionTools: ToolDef[] = [
  {
    name: "extraction_preview",
    risk: "write-low",
    description: "Create or reuse an idempotent extraction proposal run. It never writes canonical notes or entities.",
    rawSchema: {
      session_id: z.string().min(1),
      source_start_id: z.number().int().min(1),
      source_end_id: z.number().int().min(1),
      extractor_version: z.string().min(1).max(100),
      idempotency_key: z.string().min(8).max(200),
    },
    handler: (args, auth) => {
      const promptHash = scopeHash({ tool: "extraction_preview", idempotency_key: args.idempotency_key });
      const result = createExtractionRun({
        auth: serviceAuth(auth),
        session_id: String(args.session_id),
        source_start_id: Number(args.source_start_id),
        source_end_id: Number(args.source_end_id),
        extractor_version: String(args.extractor_version),
        prompt_hash: promptHash,
        candidates: [],
      });
      return { run_id: result.run.id, status: result.run.status, reused: !result.created };
    },
  },
  {
    name: "extraction_run_get",
    risk: "read",
    description: "Read one authorized extraction run and its paginated candidate review state.",
    rawSchema: {
      run_id: z.string().min(1),
      candidate_limit: z.number().int().min(1).max(100).default(25),
      candidate_cursor: z.string().min(1).max(512).optional(),
    },
    handler: (args, auth) => {
      const limit = (args.candidate_limit as number | undefined) ?? 25;
      const scope = { run_id: args.run_id };
      const offset = decodeCursor(args.candidate_cursor, auth, "extraction_run_get", scope);
      const result = getExtractionRun({ auth, run_id: String(args.run_id) });
      const candidates = result.candidates.slice(offset, offset + limit).map((row) => candidateOut(row));
      const nextOffset = offset + candidates.length;
      return {
        run: runOut(result.run),
        candidates,
        next_cursor: nextOffset < result.candidates.length
          ? encodeCursor(auth, "extraction_run_get", scope, nextOffset)
          : null,
      };
    },
  },
  {
    name: "extraction_run_list",
    risk: "read",
    description: "List extraction runs visible to the caller in the current workspace.",
    rawSchema: {
      session_id: z.string().min(1).optional(),
      status: z.enum(["queued", "running", "review", "completed", "failed", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().min(1).max(512).optional(),
    },
    handler: (args, auth) => {
      const limit = (args.limit as number | undefined) ?? 25;
      const scope = { session_id: args.session_id ?? null, status: args.status ?? null };
      const offset = decodeCursor(args.cursor, auth, "extraction_run_list", scope);
      const result = listExtractionRuns({
        auth,
        session_id: args.session_id as string | undefined,
        status: args.status as string | undefined,
        limit: 200,
      });
      const runs = result.items.slice(offset, offset + limit).map((row) => runOut(row));
      const nextOffset = offset + runs.length;
      return {
        runs,
        next_cursor: nextOffset < result.items.length
          ? encodeCursor(auth, "extraction_run_list", scope, nextOffset)
          : null,
      };
    },
  },
  {
    name: "extraction_review",
    risk: "write-low",
    description: "Accept, edit, or reject one candidate with optimistic concurrency. Only accept/edit creates a canonical note.",
    rawSchema: {
      candidate_id: z.string().min(1),
      action: z.enum(["accept", "edit", "reject"]),
      edited_text: z.string().min(1).max(16_384).optional(),
      edited_type: z.enum(["note", "task", "deal", "contact", "finance", "project", "memory", "rule", "knowledge", "context", "decision"]).optional(),
      edited_tags: z.array(z.string().min(1).max(100)).max(50).optional(),
      reason_code: z.string().min(1).max(100).optional(),
      expected_review_version: z.number().int().min(0),
      idempotency_key: z.string().min(8).max(200),
    },
    handler: (args, auth) => {
      const action = args.action as ExtractionReviewAction;
      if (action === "edit" && args.edited_text === undefined) {
        throw new QoopiaError("INVALID_INPUT", "edited_text is required for edit");
      }
      if (action !== "edit" && (args.edited_text !== undefined || args.edited_type !== undefined || args.edited_tags !== undefined)) {
        throw new QoopiaError("INVALID_INPUT", "edited fields are valid only for edit");
      }
      const requestHash = scopeHash({
        candidate_id: args.candidate_id,
        action,
        edited_text: args.edited_text ?? null,
        edited_type: args.edited_type ?? null,
        edited_tags: args.edited_tags ?? null,
        reason_code: args.reason_code ?? null,
        expected_review_version: args.expected_review_version,
      });
      const keyReplay = db.prepare(
        `SELECT entity_id, details FROM activity
          WHERE workspace_id = ? AND action = 'extraction_reviewed'
            AND json_extract(details, '$.mcp_idempotency_key') = ?
          ORDER BY id DESC LIMIT 1`,
      ).get(auth.workspace_id, String(args.idempotency_key)) as
        | { entity_id: string; details: string }
        | undefined;
      if (keyReplay) {
        const details = JSON.parse(keyReplay.details) as Record<string, unknown>;
        if (keyReplay.entity_id !== args.candidate_id || details.mcp_request_hash !== requestHash) {
          throw new QoopiaError("CONFLICT", "idempotency_key was reused with different input");
        }
      }
      const result = reviewExtractionCandidate({
        auth: serviceAuth(auth),
        candidate_id: String(args.candidate_id),
        action,
        expected_version: Number(args.expected_review_version),
        edited_text: args.edited_text as string | undefined,
        type: args.edited_type as string | undefined,
        tags: args.edited_tags as string[] | undefined,
        reason_code: args.reason_code as string | undefined,
        idempotency_key: String(args.idempotency_key),
        request_hash: requestHash,
      });
      const candidate = result.candidate as Record<string, unknown>;
      return {
        candidate_id: candidate.id,
        status: candidate.status,
        review_version: candidate.review_version,
        accepted_note_id: candidate.accepted_note_id,
      };
    },
  },
];

const recallTools: ToolDef[] = [
  {
    name: "recall_trace_get",
    risk: "read",
    description: "Read one bounded privacy-safe recall trace scoped to its caller or an authorized admin.",
    rawSchema: {
      trace_id: z.string().min(1),
      include_items: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().min(1).max(512).optional(),
    },
    handler: (args, auth) => {
      const limit = (args.limit as number | undefined) ?? 25;
      const includeItems = (args.include_items as boolean | undefined) ?? true;
      const scope = { trace_id: args.trace_id, include_items: includeItems };
      const offset = decodeCursor(args.cursor, auth, "recall_trace_get", scope);
      const result = getRecallTrace({
        auth,
        trace_id: String(args.trace_id),
        limit: includeItems ? limit : 1,
        offset,
      });
      const items = includeItems ? result.items : [];
      const nextOffset = offset + (includeItems ? items.length : 0);
      return {
        trace: result.trace,
        items,
        next_cursor: includeItems && result.next_cursor
          ? encodeCursor(auth, "recall_trace_get", scope, nextOffset)
          : null,
      };
    },
  },
  {
    name: "recall_feedback",
    risk: "write-low",
    description: "Record bounded feedback for a visible note. pin and unpin require owner or steward capability.",
    rawSchema: {
      note_id: z.string().min(1),
      feedback: z.enum(RECALL_FEEDBACK_TYPES),
      trace_id: z.string().min(1).optional(),
      reason_code: z.string().min(1).max(100).optional(),
      reason_text: z.string().max(500).optional(),
      idempotency_key: z.string().min(8).max(200),
    },
    handler: (args, auth) => {
      if ((args.feedback === "pin" || args.feedback === "unpin") && !REVIEWER_TYPES.has(auth.type)) {
        throw new QoopiaError("FORBIDDEN", "pin and unpin require owner or steward capability");
      }
      return recordRecallFeedback({
        auth: serviceAuth(auth),
        note_id: String(args.note_id),
        feedback: args.feedback as RecallFeedbackType,
        trace_id: args.trace_id as string | undefined,
        reason_code: args.reason_code as string | undefined,
        reason_text: args.reason_text as string | undefined,
        idempotency_key: String(args.idempotency_key),
      });
    },
  },
];

const exportTools: ToolDef[] = [
  {
    name: "export_plan",
    risk: "admin",
    description: "Legacy schema 32 only: build a privileged read-only count and policy plan for the caller's workspace; no row body is returned.",
    rawSchema: { include_ephemeral: z.boolean().default(false) },
    handler: (args, auth) => {
      requireExportAdmin(auth);
      return createExportPlan({
        workspace_id: auth.workspace_id,
        actor_id: auth.agent_id,
        include_ephemeral: args.include_ephemeral === true,
        release_sha: process.env.QOOPIA_RELEASE_SHA ?? "unreleased-v4",
        signer: exportSigner(),
        database: db,
        authorize: () => requireExportAdmin(auth),
      });
    },
  },
  {
    name: "export_bundle",
    risk: "admin",
    description: "Legacy schema 32 only: generate a signed high-sensitivity export inside the sanctioned root and return only opaque identifiers and hashes.",
    rawSchema: {
      plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
      idempotency_key: z.string().min(8).max(200),
    },
    handler: (args, auth) => {
      requireExportAdmin(auth);
      const result = materializeExportBundle({
        plan_hash: String(args.plan_hash),
        idempotency_key: String(args.idempotency_key),
        workspace_id: auth.workspace_id,
        actor_id: auth.agent_id,
        release_sha: process.env.QOOPIA_RELEASE_SHA ?? "unreleased-v4",
        source_instance_id: env.INSTANCE_ID,
        signer: exportSigner(),
        export_root: exportRoot(),
        database: db,
        authorize: () => requireExportAdmin(auth),
      });
      const { output_dir: _output, archive_path: _archive, ...response } = result;
      return response;
    },
  },
  {
    name: "import_plan",
    risk: "admin",
    description: "Legacy schema 32 only: validate one sanctioned export artifact for this workspace. Import apply is never an MCP operation.",
    rawSchema: {
      artifact_id: z.string().min(1).max(200),
      target_workspace_id: z.string().min(1),
    },
    handler: (args, auth) => {
      requireExportAdmin(auth);
      if (args.target_workspace_id !== auth.workspace_id) {
        throw new QoopiaError("FORBIDDEN", "target_workspace_id must equal the authenticated workspace");
      }
      const artifactId = String(args.artifact_id);
      const root = exportRoot();
      const bundle = path.resolve(root, artifactId);
      if (!bundle.startsWith(`${root}${path.sep}`)) throw new QoopiaError("FORBIDDEN", "artifact escapes sanctioned root");
      return validateImportPlan({
        bundle_dir: bundle,
        artifact_id: artifactId,
        target_workspace_id: auth.workspace_id,
        trust_store: trustStore(),
        database: db,
        authorize: () => requireExportAdmin(auth),
      });
    },
  },
];

function currentSchemaVersion(): number | null {
  try {
    return (db.query("SELECT MAX(version) AS version FROM schema_versions").get() as { version: number | null }).version;
  } catch {
    return null;
  }
}

export function enabledV4Tools(schemaVersion: number | null = currentSchemaVersion()): ToolDef[] {
  const enabled: ToolDef[] = schemaVersion === 32 ? [...exportTools] : [];
  if (process.env.QOOPIA_V4_RELATIONS === "true") enabled.push(...relationTools);
  if (process.env.QOOPIA_V4_EXTRACTION === "true") enabled.push(...extractionTools);
  if (process.env.QOOPIA_V4_RECALL_EXPLAIN === "true") enabled.push(recallTools[0]!);
  if (process.env.QOOPIA_V4_FEEDBACK === "true") enabled.push(recallTools[1]!);
  return enabled;
}

export const V4_TOOL_NAMES = [
  ...relationTools,
  ...extractionTools,
  ...recallTools,
  ...exportTools,
].map((tool) => tool.name);
