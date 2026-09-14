import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { recordLifecycleChange } from "../utils/observability.ts";
import { getNote } from "./notes.ts";
import { resolveNoteProvenance } from "./provenance.ts";

interface LifecycleRow {
  workspace_id: string;
  note_id: string;
  last_recalled_at: string | null;
  recall_count: number;
  last_confirmed_at: string | null;
  confirmation_count: number;
  owner_pinned: number;
  updated_at: string;
}
const ADMIN_TYPES = new Set(["owner", "steward", "claude-privileged"]);
const PIN_TYPES = new Set(["owner", "steward"]);

function isAdmin(auth: AuthContext): boolean {
  return ADMIN_TYPES.has(auth.type);
}

function assertWriteScope(auth: AuthContext): void {
  if (auth.source === "oauth" && !auth.granted_scope?.includes("mcp:write")) {
    throw new QoopiaError("FORBIDDEN", "mcp:write scope is required");
  }
}

function rowOrDefault(workspaceId: string, noteId: string): LifecycleRow {
  const row = db.prepare(
    `SELECT * FROM memory_lifecycle WHERE workspace_id = ? AND note_id = ?`,
  ).get(workspaceId, noteId) as LifecycleRow | undefined;
  return row ?? {
    workspace_id: workspaceId,
    note_id: noteId,
    last_recalled_at: null,
    recall_count: 0,
    last_confirmed_at: null,
    confirmation_count: 0,
    owner_pinned: 0,
    updated_at: nowIso(),
  };
}

function verifiedOwnerApproval(workspaceId: string, metadata: Record<string, unknown>): boolean {
  const reference =
    typeof metadata.owner_approval_note_id === "string"
      ? metadata.owner_approval_note_id
      : typeof metadata.owner_approval_id === "string"
        ? metadata.owner_approval_id
        : null;
  if (!reference) return false;
  return !!db.prepare(
    `SELECT 1
       FROM notes n JOIN agents a ON a.id = n.agent_id AND a.workspace_id = n.workspace_id
      WHERE n.workspace_id = ? AND n.id = ? AND n.type = 'decision'
        AND n.deleted_at IS NULL AND a.type = 'owner' AND a.active = 1`,
  ).get(workspaceId, reference);
}

function protectedReason(
  workspaceId: string,
  note: ReturnType<typeof getNote>,
  lifecycle: LifecycleRow,
): string | null {
  if (note.type === "rule" || note.type === "finance") return `type:${note.type}`;
  if (lifecycle.owner_pinned === 1) return "owner_pinned";
  const metadata = note.metadata as Record<string, unknown>;
  if (note.type === "decision") {
    const author = note.agent_id
      ? db.prepare(
          `SELECT type FROM agents WHERE workspace_id = ? AND id = ? AND active = 1`,
        ).get(workspaceId, note.agent_id) as { type: string } | undefined
      : undefined;
    if (author?.type === "owner") return "owner_authored_decision";
    if (verifiedOwnerApproval(workspaceId, metadata)) return "verified_owner_approval";
  }
  if (metadata.record_class === "legal") return "record_class:legal";
  if (
    (metadata.record_class === "incident" || metadata.record_class === "runbook") &&
    (metadata.status === "active" || metadata.status === "open")
  ) {
    return `record_class:${String(metadata.record_class)}:${String(metadata.status)}`;
  }
  return null;
}

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeLifecycleFactor(input: {
  auth: AuthContext;
  note_id: string;
  now?: Date | string | number;
}) {
  const note = getNote(
    input.auth.workspace_id,
    input.note_id,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  const lifecycle = rowOrDefault(input.auth.workspace_id, input.note_id);
  const reason = protectedReason(input.auth.workspace_id, note, lifecycle);
  const nowMs = input.now instanceof Date
    ? input.now.getTime()
    : typeof input.now === "string"
      ? Date.parse(input.now)
      : typeof input.now === "number"
        ? input.now
        : Date.now();
  if (!Number.isFinite(nowMs)) throw new QoopiaError("INVALID_INPUT", "invalid lifecycle time");
  const anchors = [
    validTime(lifecycle.last_confirmed_at),
    validTime(lifecycle.last_recalled_at),
    validTime(note.updated_at),
  ].filter((value): value is number => value !== null);
  const anchorMs = anchors.length ? Math.max(...anchors) : nowMs;
  const ageDays = Math.max(0, (nowMs - anchorMs) / 86_400_000);
  const decay = reason ? 1 : 0.85 + 0.15 * 2 ** (-ageDays / 180);
  const reinforcement = Math.min(
    0.1,
    0.01 * Math.log2(1 + lifecycle.recall_count) +
      0.03 * lifecycle.confirmation_count,
  );
  const provenance = resolveNoteProvenance({ auth: input.auth, note_id: input.note_id });
  const callerConfidence = provenance.max_confidence;
  const confidenceAdjustment = callerConfidence === null
    ? 0
    : clamp((callerConfidence - 0.5) * 0.1, -0.05, 0.05);
  const factor = lifecycle.owner_pinned === 1
    ? 1.15
    : clamp(decay + reinforcement + confidenceAdjustment, 0.85, 1.15);
  return {
    factor,
    explain: {
      age_days: Number(ageDays.toFixed(6)),
      protected: reason !== null,
      protected_reason: reason,
      decay: Number(decay.toFixed(6)),
      reinforcement: Number(reinforcement.toFixed(6)),
      caller_confidence: callerConfidence,
      confidence_adjustment: Number(confidenceAdjustment.toFixed(6)),
      visible_provenance_ids: provenance.items.map((item) => item.id),
      owner_pinned: lifecycle.owner_pinned === 1,
    },
    state: lifecycle,
  };
}

export function confirmMemory(input: { auth: AuthContext; note_id: string }) {
  assertWriteScope(input.auth);
  getNote(input.auth.workspace_id, input.note_id, input.auth.agent_id, isAdmin(input.auth));
  const result = db.transaction(() => {
    getNote(input.auth.workspace_id, input.note_id, input.auth.agent_id, isAdmin(input.auth));
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO memory_lifecycle
         (workspace_id, note_id, last_confirmed_at, confirmation_count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(workspace_id, note_id) DO UPDATE SET
         last_confirmed_at = excluded.last_confirmed_at,
         confirmation_count = memory_lifecycle.confirmation_count + 1,
         updated_at = excluded.updated_at`,
    ).run(input.auth.workspace_id, input.note_id, timestamp, timestamp);
    return rowOrDefault(input.auth.workspace_id, input.note_id);
  })();
  recordLifecycleChange("confirm", "success");
  return result;
}

export function setMemoryPin(input: {
  auth: AuthContext;
  note_id: string;
  pinned: boolean;
}) {
  assertWriteScope(input.auth);
  if (!PIN_TYPES.has(input.auth.type)) {
    throw new QoopiaError("FORBIDDEN", "pin and unpin require owner or steward capability");
  }
  getNote(input.auth.workspace_id, input.note_id, input.auth.agent_id, isAdmin(input.auth));
  const result = db.transaction(() => {
    // Recheck live authorization and note visibility inside the transaction.
    const actor = db.prepare(
      `SELECT type, active FROM agents WHERE workspace_id = ? AND id = ?`,
    ).get(input.auth.workspace_id, input.auth.agent_id) as
      | { type: string; active: number }
      | undefined;
    if (!actor || actor.active !== 1 || !PIN_TYPES.has(actor.type)) {
      throw new QoopiaError("FORBIDDEN", "pin authorization changed");
    }
    getNote(input.auth.workspace_id, input.note_id, input.auth.agent_id, isAdmin(input.auth));
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO memory_lifecycle (workspace_id, note_id, owner_pinned, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, note_id) DO UPDATE SET
         owner_pinned = excluded.owner_pinned,
         updated_at = excluded.updated_at`,
    ).run(input.auth.workspace_id, input.note_id, input.pinned ? 1 : 0, timestamp);
    return rowOrDefault(input.auth.workspace_id, input.note_id);
  })();
  recordLifecycleChange(input.pinned ? "pin" : "unpin", "success");
  return result;
}

/** Synchronous primitive used by the bounded write-behind worker. */
export function recordAccessReinforcement(input: {
  workspace_id: string;
  note_id: string;
  recalled_at?: string;
}) {
  const timestamp = input.recalled_at ?? nowIso();
  db.prepare(
    `INSERT INTO memory_lifecycle
       (workspace_id, note_id, last_recalled_at, recall_count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(workspace_id, note_id) DO UPDATE SET
       last_recalled_at = CASE
         WHEN memory_lifecycle.last_recalled_at IS NULL OR excluded.last_recalled_at > memory_lifecycle.last_recalled_at
           THEN excluded.last_recalled_at ELSE memory_lifecycle.last_recalled_at END,
       recall_count = memory_lifecycle.recall_count + 1,
       updated_at = excluded.updated_at`,
  ).run(input.workspace_id, input.note_id, timestamp, timestamp);
  recordLifecycleChange("reinforce", "success");
}

/**
 * Schedule reinforcement after response formation. Failure is deliberately
 * swallowed so a write-behind issue cannot fail or reorder the current recall.
 */
export function queueAccessReinforcement(input: {
  workspace_id: string;
  note_id: string;
  recalled_at?: string;
}): Promise<{ recorded: boolean }> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      try {
        recordAccessReinforcement(input);
        resolve({ recorded: true });
      } catch {
        recordLifecycleChange("reinforce", "failed");
        resolve({ recorded: false });
      }
    });
  });
}

export function getMemoryLifecycle(input: { auth: AuthContext; note_id: string }) {
  const note = getNote(
    input.auth.workspace_id,
    input.note_id,
    input.auth.agent_id,
    isAdmin(input.auth),
  );
  const state = rowOrDefault(input.auth.workspace_id, input.note_id);
  return {
    ...state,
    protected_reason: protectedReason(input.auth.workspace_id, note, state),
    note_metadata: safeJsonParse(JSON.stringify(note.metadata), {} as Record<string, unknown>),
  };
}
