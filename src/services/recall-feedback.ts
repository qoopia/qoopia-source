import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { QoopiaError } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { getNote } from "./notes.ts";
import { confirmMemory, queueAccessReinforcement, setMemoryPin } from "./memory-lifecycle.ts";
import { assertWriteScope, isAdmin } from "../auth/principal.ts";

export const RECALL_FEEDBACK_TYPES = [
  "helpful",
  "not_helpful",
  "stale",
  "incorrect",
  "confirm",
  "pin",
  "unpin",
] as const;
export type RecallFeedbackType = (typeof RECALL_FEEDBACK_TYPES)[number];

const PIN_TYPES = new Set(["owner", "steward"]);

function featureDisabled(name: string): never {
  const error = new QoopiaError("INVALID_INPUT", name);
  (error as { code: string }).code = "FEATURE_DISABLED";
  throw error;
}



interface FeedbackRow {
  id: string;
  note_id: string;
  trace_id: string | null;
  feedback: RecallFeedbackType;
  reason_code: string | null;
  reason_text: string | null;
}

export function recordRecallFeedback(input: {
  auth: AuthContext;
  note_id: string;
  feedback: RecallFeedbackType;
  trace_id?: string;
  reason_code?: string;
  reason_text?: string;
  idempotency_key: string;
}) {
  if (process.env.QOOPIA_V4_FEEDBACK !== "true") {
    featureDisabled("QOOPIA_V4_FEEDBACK");
  }
  assertWriteScope(input.auth);
  if (!(RECALL_FEEDBACK_TYPES as readonly string[]).includes(input.feedback)) {
    throw new QoopiaError("INVALID_INPUT", "unsupported recall feedback");
  }
  if (input.idempotency_key.length < 8 || input.idempotency_key.length > 200) {
    throw new QoopiaError("INVALID_INPUT", "idempotency_key must contain 8..200 characters");
  }
  if (input.reason_code && input.reason_code.length > 100) {
    throw new QoopiaError("SIZE_LIMIT", "reason_code exceeds 100 characters");
  }
  if (input.reason_text && input.reason_text.length > 500) {
    throw new QoopiaError("SIZE_LIMIT", "reason_text exceeds 500 characters");
  }
  if (input.reason_code) assertNoSecrets(input.reason_code, "recall_feedback.reason_code");
  if (input.reason_text) assertNoSecrets(input.reason_text, "recall_feedback.reason_text");
  if ((input.feedback === "pin" || input.feedback === "unpin") && !PIN_TYPES.has(input.auth.type)) {
    throw new QoopiaError("FORBIDDEN", "pin and unpin require owner or steward capability");
  }
  getNote(input.auth.workspace_id, input.note_id, input.auth.agent_id, isAdmin(input.auth));

  const result = db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, note_id, trace_id, feedback, reason_code, reason_text
         FROM recall_feedback
        WHERE workspace_id = ? AND actor_agent_id = ? AND idempotency_key = ?`,
    ).get(input.auth.workspace_id, input.auth.agent_id, input.idempotency_key) as FeedbackRow | undefined;
    if (existing) {
      if (
        existing.note_id !== input.note_id ||
        existing.trace_id !== (input.trace_id ?? null) ||
        existing.feedback !== input.feedback ||
        existing.reason_code !== (input.reason_code ?? null) ||
        existing.reason_text !== (input.reason_text ?? null)
      ) {
        throw new QoopiaError("CONFLICT", "idempotency_key was reused with different feedback");
      }
      return { id: existing.id, created: false };
    }

    getNote(input.auth.workspace_id, input.note_id, input.auth.agent_id, isAdmin(input.auth));
    if (input.trace_id) {
      const trace = db.prepare(
        `SELECT 1
           FROM recall_traces t JOIN recall_trace_items i
             ON i.workspace_id = t.workspace_id AND i.trace_id = t.id
          WHERE t.workspace_id = ? AND t.id = ? AND t.caller_agent_id = ?
            AND t.expires_at > ? AND i.result_kind = 'note' AND i.note_id = ?`,
      ).get(
        input.auth.workspace_id,
        input.trace_id,
        input.auth.agent_id,
        new Date().toISOString(),
        input.note_id,
      );
      if (!trace) throw new QoopiaError("NOT_FOUND", "recall trace item not found");
    }

    const id = ulid();
    db.prepare(
      `INSERT INTO recall_feedback
         (id, workspace_id, note_id, trace_id, actor_agent_id, feedback,
          reason_code, reason_text, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.auth.workspace_id,
      input.note_id,
      input.trace_id ?? null,
      input.auth.agent_id,
      input.feedback,
      input.reason_code ?? null,
      input.reason_text ?? null,
      input.idempotency_key,
    );
    if (input.feedback === "confirm") {
      confirmMemory({ auth: input.auth, note_id: input.note_id });
    } else if (input.feedback === "pin" || input.feedback === "unpin") {
      setMemoryPin({
        auth: input.auth,
        note_id: input.note_id,
        pinned: input.feedback === "pin",
      });
    }
    return { id, created: true };
  })();

  const deferred = input.feedback === "helpful" && result.created;
  if (deferred) {
    void queueAccessReinforcement({
      workspace_id: input.auth.workspace_id,
      note_id: input.note_id,
    });
  }
  return {
    feedback_id: result.id,
    note_id: input.note_id,
    feedback: input.feedback,
    trace_attached: !!input.trace_id,
    lifecycle_update_deferred: deferred,
  };
}
