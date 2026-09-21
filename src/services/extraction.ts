import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { createNote, getNote, NOTE_TYPES, type NoteVisibility } from "./notes.ts";
import { createNoteProvenance, hashProvenanceFragment } from "./provenance.ts";
import { logActivity } from "./activity.ts";
import { recordConflict, recordExtractionOutcome } from "../utils/observability.ts";
import { assertWriteScope, isAdmin } from "../auth/principal.ts";
import { assertAutomaticMemoryAllowed } from "./memory-policy.ts";

const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_TEXT = 16_384;
const REVIEWER_TYPES = new Set(["owner", "steward"]);
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?/i,
  /reveal\s+(?:the\s+)?(?:system|developer)\s+prompt/i,
  /(?:act|behave)\s+as\s+(?:an?\s+)?(?:admin|owner|system)/i,
  /bypass\s+(?:the\s+)?(?:review|authorization|safety)/i,
  /do\s+not\s+(?:show|tell)\s+(?:this\s+)?to\s+(?:the\s+)?(?:user|reviewer)/i,
] as const;

export interface ExtractionProposal {
  text: string;
  type?: string;
  tags?: string[];
  entities?: string[];
  source_message_ids: number[];
  confidence: number;
  conflict_note_ids?: string[];
  risk_flags?: string[];
}

interface RunRow {
  id: string;
  workspace_id: string;
  session_id: string;
  source_start_id: number;
  source_end_id: number;
  source_range_hash: string;
  extractor_version: string;
  prompt_hash: string;
  status: string;
  initiated_by_agent_id: string;
  candidate_count: number;
  accepted_count: number;
  rejected_count: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  run_id: string;
  proposed_text: string;
  proposed_type: string;
  proposed_tags: string;
  proposed_entities: string;
  source_message_ids: string;
  confidence: number;
  dedup_note_id: string | null;
  conflict_note_ids: string;
  risk_flags: string;
  status: string;
  accepted_note_id: string | null;
  reviewed_by_agent_id: string | null;
  reviewed_at: string | null;
  review_reason_code: string | null;
  review_version: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  session_id: string;
  agent_id: string | null;
  role: string;
  content: string;
  created_at: string;
}

function metricRiskClass(row: Pick<CandidateRow, "risk_flags" | "conflict_note_ids">): string {
  const risks = safeJsonParse(row.risk_flags, [] as string[]);
  if (risks.includes("prompt_injection")) return "prompt_injection";
  if (safeJsonParse(row.conflict_note_ids, [] as string[]).length > 0) return "conflict";
  return "normal";
}



function normalizeText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/g, " ");
}

function tokenize(text: string): Set<string> {
  return new Set(normalizeText(text).split(/[^\p{L}\p{N}_]+/u).filter((v) => v.length >= 2));
}

function jaccard(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function injectionFlags(text: string): string[] {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))
    ? ["prompt_injection"]
    : [];
}

function canonicalStringList(value: string[] | undefined, max = 100): string[] {
  const result = [...new Set((value ?? []).map(String).map((item) => item.trim()).filter(Boolean))]
    .sort();
  if (result.length > max) throw new QoopiaError("SIZE_LIMIT", `list exceeds ${max} items`);
  return result;
}

function canonicalEntityList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new QoopiaError("INVALID_INPUT", "candidate entities must contain only string IDs");
  }
  const normalized = value.map((item) => item.trim());
  if (normalized.some((item) => item.length === 0)) {
    throw new QoopiaError("INVALID_INPUT", "candidate entity IDs must not be empty");
  }
  if (normalized.some((item) => item.length > 512)) {
    throw new QoopiaError("SIZE_LIMIT", "candidate entity ID exceeds 512 characters");
  }
  const result = [...new Set(normalized)].sort();
  if (result.length > 100) {
    throw new QoopiaError("SIZE_LIMIT", "candidate entities exceed 100 items");
  }
  return result;
}

function runOut(row: RunRow) {
  return { ...row };
}

function candidateOut(row: CandidateRow, includeText = true) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    ...(includeText ? { proposed_text: row.proposed_text } : {}),
    proposed_type: row.proposed_type,
    proposed_tags: safeJsonParse(row.proposed_tags, [] as string[]),
    proposed_entities: safeJsonParse(row.proposed_entities, [] as string[]),
    source_message_ids: safeJsonParse(row.source_message_ids, [] as number[]),
    confidence: row.confidence,
    dedup_note_id: row.dedup_note_id,
    conflict_note_ids: safeJsonParse(row.conflict_note_ids, [] as string[]),
    risk_flags: safeJsonParse(row.risk_flags, [] as string[]),
    status: row.status,
    accepted_note_id: row.accepted_note_id,
    reviewed_by_agent_id: row.reviewed_by_agent_id,
    reviewed_at: row.reviewed_at,
    review_reason_code: row.review_reason_code,
    review_version: row.review_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sessionMessages(input: {
  auth: AuthContext;
  session_id: string;
  source_start_id: number;
  source_end_id: number;
}): MessageRow[] {
  if (
    !Number.isInteger(input.source_start_id) ||
    !Number.isInteger(input.source_end_id) ||
    input.source_start_id <= 0 ||
    input.source_end_id < input.source_start_id
  ) {
    throw new QoopiaError("INVALID_INPUT", "invalid source message range");
  }
  const session = db.prepare(
    `SELECT id, agent_id FROM sessions WHERE workspace_id = ? AND id = ?`,
  ).get(input.auth.workspace_id, input.session_id) as
    | { id: string; agent_id: string | null }
    | undefined;
  if (!session || (session.agent_id !== input.auth.agent_id && !isAdmin(input.auth))) {
    throw new QoopiaError("NOT_FOUND", "session not found");
  }
  const rows = db.prepare(
    `SELECT id, session_id, agent_id, role, content, created_at
       FROM session_messages
      WHERE workspace_id = ? AND session_id = ? AND id BETWEEN ? AND ?
      ORDER BY id ASC`,
  ).all(
    input.auth.workspace_id,
    input.session_id,
    input.source_start_id,
    input.source_end_id,
  ) as MessageRow[];
  if (
    rows.length === 0 ||
    rows[0]!.id !== input.source_start_id ||
    rows.at(-1)!.id !== input.source_end_id
  ) {
    throw new QoopiaError("NOT_FOUND", "source message range not found");
  }
  return rows;
}

function sourceRangeHash(messages: MessageRow[]): string {
  const h = createHash("sha256");
  for (const message of messages) {
    h.update(`${message.id}\0${message.role}\0${message.content.replace(/\r\n?/g, "\n")}\0`);
  }
  return h.digest("hex");
}

function visibleNotes(auth: AuthContext): Array<{ id: string; text: string }> {
  return db.prepare(
    `SELECT id, text FROM notes
      WHERE workspace_id = ? AND deleted_at IS NULL
        AND (visibility = 'workspace' OR agent_id = ? OR ? = 1)
      ORDER BY id ASC`,
  ).all(auth.workspace_id, auth.agent_id, isAdmin(auth) ? 1 : 0) as Array<{
    id: string;
    text: string;
  }>;
}

function dedupAndConflicts(
  auth: AuthContext,
  text: string,
  requestedConflictIds: string[] | undefined,
) {
  const notes = visibleNotes(auth);
  const normalized = normalizeText(text);
  let dedupNoteId: string | null = null;
  let bestSemantic: { id: string; score: number } | null = null;
  const conflicts = new Set<string>();
  for (const note of notes) {
    if (normalizeText(note.text) === normalized) {
      dedupNoteId = note.id;
      break;
    }
    const score = jaccard(text, note.text);
    if (score >= 0.82 && (!bestSemantic || score > bestSemantic.score)) {
      bestSemantic = { id: note.id, score };
    } else if (score >= 0.55) {
      conflicts.add(note.id);
    }
  }
  if (!dedupNoteId && bestSemantic) dedupNoteId = bestSemantic.id;
  for (const id of canonicalStringList(requestedConflictIds, 100)) {
    // getNote masks both cross-workspace and inaccessible private rows.
    getNote(auth.workspace_id, id, auth.agent_id, isAdmin(auth));
    conflicts.add(id);
  }
  if (dedupNoteId) conflicts.delete(dedupNoteId);
  return {
    dedup_note_id: dedupNoteId,
    conflict_note_ids: [...conflicts].sort(),
    semantic_duplicate: !!bestSemantic && !notes.some(
      (note) => note.id === dedupNoteId && normalizeText(note.text) === normalized,
    ),
  };
}

function assertProposal(
  proposal: ExtractionProposal,
  allowedMessageIds: Set<number>,
): void {
  if (!proposal.text || proposal.text.length > MAX_CANDIDATE_TEXT) {
    throw new QoopiaError("SIZE_LIMIT", `candidate text must contain 1..${MAX_CANDIDATE_TEXT} characters`);
  }
  assertNoSecrets(proposal.text, "extraction.candidate");
  const type = proposal.type ?? "note";
  if (!(NOTE_TYPES as readonly string[]).includes(type)) {
    throw new QoopiaError("INVALID_INPUT", `unsupported candidate type: ${type}`);
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    throw new QoopiaError("INVALID_INPUT", "candidate confidence must be between 0 and 1");
  }
  if (!Array.isArray(proposal.source_message_ids) || proposal.source_message_ids.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "candidate requires source_message_ids");
  }
  for (const id of proposal.source_message_ids) {
    if (!Number.isInteger(id) || !allowedMessageIds.has(id)) {
      throw new QoopiaError("INVALID_INPUT", "candidate source message is outside authorized range");
    }
  }
  const entities = canonicalEntityList(proposal.entities);
  assertNoSecrets(JSON.stringify(proposal.tags ?? []), "extraction.tags");
  assertNoSecrets(JSON.stringify(entities), "extraction.entities");
}

/**
 * Persist a proposal-only extraction run. This function has no code path that
 * writes notes, entities, relations or provenance.
 */
export function createExtractionRun(input: {
  auth: AuthContext;
  session_id: string;
  source_start_id: number;
  source_end_id: number;
  extractor_version: string;
  prompt_hash: string;
  expected_source_range_hash?: string;
  candidates: ExtractionProposal[];
}) {
  assertWriteScope(input.auth);
  // Candidates are derived from session content and persist until reviewed: a derived record.
  assertAutomaticMemoryAllowed(input.auth.workspace_id, input.auth.agent_id);
  if (!input.extractor_version || input.extractor_version.length > 100) {
    throw new QoopiaError("INVALID_INPUT", "invalid extractor_version");
  }
  if (!/^[0-9a-f]{64}$/.test(input.prompt_hash)) {
    throw new QoopiaError("INVALID_INPUT", "prompt_hash must be lowercase SHA-256");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    throw new QoopiaError("SIZE_LIMIT", `at most ${MAX_CANDIDATES} candidates are allowed`);
  }
  const messages = sessionMessages(input);
  const rangeHash = sourceRangeHash(messages);
  if (input.expected_source_range_hash && input.expected_source_range_hash !== rangeHash) {
    throw new QoopiaError("CONFLICT", "source message range changed");
  }
  const allowedMessageIds = new Set(messages.map((message) => message.id));
  // Screen every candidate before starting the transaction; a secret in any
  // candidate makes the entire run non-persistent.
  for (const candidate of input.candidates) assertProposal(candidate, allowedMessageIds);

  return db.transaction(() => {
    // Re-read and hash in the transaction to close the range-change race.
    const currentMessages = sessionMessages(input);
    if (sourceRangeHash(currentMessages) !== rangeHash) {
      throw new QoopiaError("CONFLICT", "source message range changed");
    }
    const existing = db.prepare(
      `SELECT * FROM extraction_runs
        WHERE workspace_id = ? AND session_id = ? AND extractor_version = ?
          AND source_range_hash = ?`,
    ).get(
      input.auth.workspace_id,
      input.session_id,
      input.extractor_version,
      rangeHash,
    ) as RunRow | undefined;
    if (existing) {
      if (existing.prompt_hash !== input.prompt_hash) {
        throw new QoopiaError("CONFLICT", "idempotent extraction run has different prompt_hash");
      }
      const existingCandidates = db.prepare(
        `SELECT * FROM extraction_candidates WHERE workspace_id = ? AND run_id = ?
          ORDER BY created_at ASC, id ASC`,
      ).all(input.auth.workspace_id, existing.id) as CandidateRow[];
      return {
        created: false,
        run: runOut(existing),
        candidates: existingCandidates.map((row) => candidateOut(row)),
      };
    }

    const runId = ulid();
    const timestamp = nowIso();
    const initialStatus = input.candidates.length === 0 ? "completed" : "review";
    db.prepare(
      `INSERT INTO extraction_runs
         (id, workspace_id, session_id, source_start_id, source_end_id,
          source_range_hash, extractor_version, prompt_hash, status,
          initiated_by_agent_id, candidate_count, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      input.auth.workspace_id,
      input.session_id,
      input.source_start_id,
      input.source_end_id,
      rangeHash,
      input.extractor_version,
      input.prompt_hash,
      initialStatus,
      input.auth.agent_id,
      input.candidates.length,
      timestamp,
      timestamp,
      input.candidates.length === 0 ? timestamp : null,
    );

    const inserted: CandidateRow[] = [];
    for (const proposal of input.candidates) {
      const analysis = dedupAndConflicts(input.auth, proposal.text, proposal.conflict_note_ids);
      const flags = new Set([
        ...canonicalStringList(proposal.risk_flags, 50),
        ...injectionFlags(proposal.text),
      ]);
      if (analysis.dedup_note_id) {
        flags.add(analysis.semantic_duplicate ? "semantic_duplicate" : "exact_duplicate");
      }
      if (analysis.conflict_note_ids.length) {
        flags.add("possible_conflict");
        recordConflict("extraction");
      }
      const candidateId = ulid();
      db.prepare(
        `INSERT INTO extraction_candidates
           (id, workspace_id, run_id, proposed_text, proposed_type, proposed_tags,
            proposed_entities, source_message_ids, confidence, dedup_note_id,
            conflict_note_ids, risk_flags, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        candidateId,
        input.auth.workspace_id,
        runId,
        proposal.text,
        proposal.type ?? "note",
        JSON.stringify(canonicalStringList(proposal.tags, 100)),
        JSON.stringify(canonicalEntityList(proposal.entities)),
        JSON.stringify([...new Set(proposal.source_message_ids)].sort((a, b) => a - b)),
        proposal.confidence,
        analysis.dedup_note_id,
        JSON.stringify(analysis.conflict_note_ids),
        JSON.stringify([...flags].sort()),
        timestamp,
        timestamp,
      );
      inserted.push(
        db.prepare(`SELECT * FROM extraction_candidates WHERE id = ?`).get(candidateId) as CandidateRow,
      );
    }
    const run = db.prepare(`SELECT * FROM extraction_runs WHERE id = ?`).get(runId) as RunRow;
    return {
      created: true,
      run: runOut(run),
      candidates: inserted.map((row) => candidateOut(row)),
    };
  })();
}

function authorizedRun(auth: AuthContext, runId: string): RunRow {
  const row = db.prepare(
    `SELECT * FROM extraction_runs WHERE workspace_id = ? AND id = ?`,
  ).get(auth.workspace_id, runId) as RunRow | undefined;
  if (!row || (row.initiated_by_agent_id !== auth.agent_id && !REVIEWER_TYPES.has(auth.type))) {
    throw new QoopiaError("NOT_FOUND", "extraction run not found");
  }
  return row;
}

export function getExtractionRun(input: { auth: AuthContext; run_id: string }) {
  const run = authorizedRun(input.auth, input.run_id);
  const candidates = db.prepare(
    `SELECT * FROM extraction_candidates WHERE workspace_id = ? AND run_id = ?
      ORDER BY created_at ASC, id ASC`,
  ).all(input.auth.workspace_id, input.run_id) as CandidateRow[];
  return { run: runOut(run), candidates: candidates.map((row) => candidateOut(row)) };
}

export function listExtractionRuns(input: {
  auth: AuthContext;
  session_id?: string;
  status?: string;
  limit?: number;
}) {
  const where = ["workspace_id = ?"];
  const params: any[] = [input.auth.workspace_id];
  if (!REVIEWER_TYPES.has(input.auth.type)) {
    where.push("initiated_by_agent_id = ?");
    params.push(input.auth.agent_id);
  }
  if (input.session_id) {
    where.push("session_id = ?");
    params.push(input.session_id);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = db.prepare(
    `SELECT * FROM extraction_runs WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, limit) as RunRow[];
  return { items: rows.map(runOut), count: rows.length, limit };
}

function protectedAcceptance(
  auth: AuthContext,
  type: string,
  metadata: Record<string, unknown>,
): boolean {
  if (type === "rule" || type === "finance") return true;
  if (metadata.record_class === "legal") return true;
  if (type !== "decision") return false;
  const approvalId = typeof metadata.owner_approval_note_id === "string"
    ? metadata.owner_approval_note_id
    : typeof metadata.owner_approval_id === "string"
      ? metadata.owner_approval_id
      : null;
  if (!approvalId) return false;
  const row = db.prepare(
    `SELECT n.id
       FROM notes n JOIN agents a ON a.id = n.agent_id AND a.workspace_id = n.workspace_id
      WHERE n.workspace_id = ? AND n.id = ? AND n.type = 'decision'
        AND n.deleted_at IS NULL AND a.type = 'owner' AND a.active = 1`,
  ).get(auth.workspace_id, approvalId) as { id: string } | undefined;
  return !!row;
}

function recalculateRun(runId: string, workspaceId: string, timestamp: string): void {
  const counts = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('accepted','edited') THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM extraction_candidates WHERE workspace_id = ? AND run_id = ?`,
  ).get(workspaceId, runId) as {
    total: number;
    accepted: number | null;
    rejected: number | null;
    pending: number | null;
  };
  const completed = (counts.pending ?? 0) === 0;
  db.prepare(
    `UPDATE extraction_runs
        SET candidate_count = ?, accepted_count = ?, rejected_count = ?,
            status = ?, completed_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`,
  ).run(
    counts.total,
    counts.accepted ?? 0,
    counts.rejected ?? 0,
    completed ? "completed" : "review",
    completed ? timestamp : null,
    timestamp,
    workspaceId,
    runId,
  );
}

export type ExtractionReviewAction = "accept" | "edit" | "reject";

/** The sole canonical-write boundary for extraction. */
export function reviewExtractionCandidate(input: {
  auth: AuthContext;
  candidate_id: string;
  action: ExtractionReviewAction;
  expected_version: number;
  edited_text?: string;
  type?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  visibility?: NoteVisibility;
  reason_code?: string;
  /** MCP adapter replay binding, recorded only in the existing audit JSON. */
  idempotency_key?: string;
  request_hash?: string;
}) {
  assertWriteScope(input.auth);
  if (!["accept", "edit", "reject"].includes(input.action)) {
    throw new QoopiaError("INVALID_INPUT", "unsupported extraction review action");
  }
  if (input.action !== "edit" && input.edited_text !== undefined) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "edited_text is valid only for edit",
    );
  }
  if (!Number.isInteger(input.expected_version) || input.expected_version < 0) {
    throw new QoopiaError("INVALID_INPUT", "expected_version must be a non-negative integer");
  }
  if (input.reason_code && input.reason_code.length > 100) {
    throw new QoopiaError("SIZE_LIMIT", "review reason_code exceeds 100 characters");
  }
  const initial = db.prepare(
    `SELECT c.*, r.initiated_by_agent_id
       FROM extraction_candidates c JOIN extraction_runs r
         ON r.id = c.run_id AND r.workspace_id = c.workspace_id
      WHERE c.workspace_id = ? AND c.id = ?`,
  ).get(input.auth.workspace_id, input.candidate_id) as
    | (CandidateRow & { initiated_by_agent_id: string })
    | undefined;
  if (
    !initial ||
    (initial.initiated_by_agent_id !== input.auth.agent_id && !REVIEWER_TYPES.has(input.auth.type))
  ) {
    throw new QoopiaError("NOT_FOUND", "extraction candidate not found");
  }

  if (initial.status !== "pending") {
    const matches =
      (input.action === "reject" && initial.status === "rejected") ||
      (input.action === "accept" && initial.status === "accepted") ||
      (input.action === "edit" && initial.status === "edited");
    if (matches && initial.review_version === input.expected_version + 1) {
      if (input.reason_code !== undefined && input.reason_code !== initial.review_reason_code) {
        throw new QoopiaError("CONFLICT", "duplicate review has a different reason_code");
      }
      if (input.action !== "reject") {
        const accepted = getNote(
          input.auth.workspace_id,
          initial.accepted_note_id!,
          input.auth.agent_id,
          isAdmin(input.auth),
        );
        const expectedText = input.action === "edit" ? input.edited_text : initial.proposed_text;
        if (!expectedText || accepted.text !== expectedText) {
          throw new QoopiaError("CONFLICT", "duplicate review has different note text");
        }
        if (input.type !== undefined && accepted.type !== input.type) {
          throw new QoopiaError("CONFLICT", "duplicate review has a different note type");
        }
        if (
          input.tags !== undefined &&
          JSON.stringify([...input.tags].sort()) !== JSON.stringify([...accepted.tags].sort())
        ) {
          throw new QoopiaError("CONFLICT", "duplicate review has different note tags");
        }
        if (input.visibility !== undefined && accepted.visibility !== input.visibility) {
          throw new QoopiaError("CONFLICT", "duplicate review has different visibility");
        }
      }
      recordExtractionOutcome("idempotent", metricRiskClass(initial));
      return { idempotent: true, candidate: candidateOut(initial) };
    }
    throw new QoopiaError("CONFLICT", "candidate was already reviewed");
  }
  if (initial.review_version !== input.expected_version) {
    recordConflict("optimistic_concurrency");
    throw new QoopiaError("CONFLICT", "stale candidate review version");
  }

  const finalText = input.action === "edit" ? input.edited_text : initial.proposed_text;
  if (input.action === "edit" && !finalText) {
    throw new QoopiaError("INVALID_INPUT", "edited_text is required for edit action");
  }
  if (input.action !== "reject") {
    if (!finalText || finalText.length > MAX_CANDIDATE_TEXT) {
      throw new QoopiaError("SIZE_LIMIT", "review text is empty or too large");
    }
    assertNoSecrets(finalText, "extraction.review_text");
  }
  if (input.metadata) assertNoSecrets(JSON.stringify(input.metadata), "extraction.note_metadata");
  const finalType = input.type ?? initial.proposed_type;
  if (!(NOTE_TYPES as readonly string[]).includes(finalType)) {
    throw new QoopiaError("INVALID_INPUT", `unsupported note type: ${finalType}`);
  }
  if (
    input.action !== "reject" &&
    (protectedAcceptance(input.auth, initial.proposed_type, input.metadata ?? {}) ||
      protectedAcceptance(input.auth, finalType, input.metadata ?? {})) &&
    !REVIEWER_TYPES.has(input.auth.type)
  ) {
    throw new QoopiaError("FORBIDDEN", "protected candidate acceptance requires owner or steward");
  }

  return db.transaction(() => {
    const current = db.prepare(
      `SELECT c.*, r.initiated_by_agent_id
         FROM extraction_candidates c JOIN extraction_runs r
           ON r.id = c.run_id AND r.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND c.id = ?`,
    ).get(input.auth.workspace_id, input.candidate_id) as
      | (CandidateRow & { initiated_by_agent_id: string })
      | undefined;
    if (!current) throw new QoopiaError("NOT_FOUND", "extraction candidate not found");
    if (current.status !== "pending" || current.review_version !== input.expected_version) {
      throw new QoopiaError("CONFLICT", "candidate review lost optimistic concurrency race");
    }
    const actor = db.prepare(
      `SELECT type, active FROM agents WHERE workspace_id = ? AND id = ?`,
    ).get(input.auth.workspace_id, input.auth.agent_id) as
      | { type: string; active: number }
      | undefined;
    if (
      !actor ||
      actor.active !== 1 ||
      (current.initiated_by_agent_id !== input.auth.agent_id && !REVIEWER_TYPES.has(actor.type))
    ) {
      throw new QoopiaError("FORBIDDEN", "review authorization changed");
    }
    if (
      input.action !== "reject" &&
      (protectedAcceptance(input.auth, current.proposed_type, input.metadata ?? {}) ||
        protectedAcceptance(input.auth, finalType, input.metadata ?? {})) &&
      !REVIEWER_TYPES.has(actor.type)
    ) {
      throw new QoopiaError("FORBIDDEN", "protected candidate acceptance requires owner or steward");
    }

    const timestamp = nowIso();
    let acceptedNoteId: string | null = null;
    let status: "accepted" | "edited" | "rejected";
    if (input.action === "reject") {
      status = "rejected";
    } else {
      status = input.action === "edit" ? "edited" : "accepted";
      const note = createNote({
        workspace_id: input.auth.workspace_id,
        agent_id: input.auth.agent_id,
        text: finalText!,
        type: finalType,
        metadata: {
          ...(input.metadata ?? {}),
          extraction_run_id: current.run_id,
          extraction_candidate_id: current.id,
        },
        tags: input.tags ?? safeJsonParse(current.proposed_tags, [] as string[]),
        source: "extraction_review",
        visibility: input.visibility,
      });
      acceptedNoteId = note.id;

      const messageIds = safeJsonParse(current.source_message_ids, [] as number[]);
      for (const messageId of messageIds) {
        const message = db.prepare(
          `SELECT content FROM session_messages WHERE workspace_id = ? AND id = ?`,
        ).get(input.auth.workspace_id, messageId) as { content: string } | undefined;
        if (!message) throw new QoopiaError("CONFLICT", "source message disappeared");
        createNoteProvenance({
          auth: input.auth,
          note_id: acceptedNoteId,
          source_kind: "session_message",
          source_id: String(messageId),
          source_hash: hashProvenanceFragment(message.content),
          confidence: current.confidence,
          metadata: { extraction_candidate_id: current.id },
        });
      }
    }

    const updated = db.prepare(
      `UPDATE extraction_candidates
          SET status = ?, accepted_note_id = ?, reviewed_by_agent_id = ?,
              reviewed_at = ?, review_reason_code = ?,
              review_version = review_version + 1, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND status = 'pending' AND review_version = ?`,
    ).run(
      status,
      acceptedNoteId,
      input.auth.agent_id,
      timestamp,
      input.reason_code ?? null,
      timestamp,
      input.auth.workspace_id,
      input.candidate_id,
      input.expected_version,
    );
    if (updated.changes !== 1) {
      throw new QoopiaError("CONFLICT", "candidate review lost optimistic concurrency race");
    }
    recalculateRun(current.run_id, input.auth.workspace_id, timestamp);
    logActivity({
      workspace_id: input.auth.workspace_id,
      agent_id: input.auth.agent_id,
      action: "extraction_reviewed",
      entity_type: "extraction_candidate",
      entity_id: current.id,
      project_id: null,
      summary: `Extraction candidate ${status}`,
      details: {
        candidate_id: current.id,
        run_id: current.run_id,
        action: input.action,
        accepted_note_id: acceptedNoteId,
        ...(input.idempotency_key ? {
          mcp_idempotency_key: input.idempotency_key,
          mcp_request_hash: input.request_hash,
        } : {}),
      },
      visibility: input.visibility === "private" ? "private" : "workspace",
    });

    const row = db.prepare(
      `SELECT * FROM extraction_candidates WHERE workspace_id = ? AND id = ?`,
    ).get(input.auth.workspace_id, input.candidate_id) as CandidateRow;
    recordExtractionOutcome(status, metricRiskClass(row));
    return { idempotent: false, candidate: candidateOut(row) };
  })();
}
