import { createHmac } from "node:crypto";
import { DB_READ_ONLY, db } from "../db/connection.ts";
import { nowIso } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { logActivity } from "./activity.ts";

const DELIVERY_TIMEOUT_MS = 5_000;
const WORKER_INTERVAL_MS = 1_000;
export const AGENT_WAKE_MAX_ATTEMPTS = 5;
const STALE_AFTER_MS = 10 * 60_000;
const BATCH_SIZE = 25;

type WakeStatus = "queued" | "delivered" | "failed" | "ignored";

type WakeEventRow = {
  id: string;
  workspace_id: string;
  target_agent_id: string;
  session_id: string;
  message_id: string;
  status: WakeStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  sender_agent_id: string;
  sender_name: string;
  target_name: string;
  target_active: number;
  target_workspace_id: string;
  sender_workspace_id: string;
  session_workspace_id: string;
  message_workspace_id: string;
  message_recipient_agent_id: string;
  topic: string;
  body: string;
  kind: string;
  message_created_at: string;
};

type WebhookConfig = {
  url: string;
  token: string;
  auth: "bearer" | "hmac";
};

type WebhookResolution =
  | { config: WebhookConfig }
  | { ignored: "no_webhook_config" | "invalid_webhook_url" | "stale_direct_callback_disabled" };

export type WakeDeliveryResult = {
  event_id: string;
  status: Exclude<WakeStatus, "queued">;
  attempted: boolean;
  http_status?: number;
  error?: string;
  /** Wake events whose messages rode along in this payload and are now delivered. */
  batched_event_ids?: string[];
};

/** How many still-undelivered messages ride along with a single wake. */
const MAX_BATCHED_MESSAGES = 20;
/**
 * How far back a wake will re-carry an undelivered message. This rescues a
 * recipient whose runtime was down for a while, but it is deliberately not
 * unbounded: replaying month-old traffic into an agent's turn is noise, not
 * delivery, and the message stays readable in agent_inbox either way.
 */
const BATCH_LOOKBACK_MS = 24 * 60 * 60_000;

type PendingMessageRow = {
  event_id: string;
  message_id: string;
  session_id: string;
  topic: string;
  body: string;
  kind: string;
  sender_name: string;
  message_created_at: string;
};

/**
 * Every message this recipient has not been confirmed to have received yet,
 * oldest first, including the one that triggered this wake.
 *
 * This is what turns the wake from a doorbell into the delivery itself. A
 * message is only dropped from this set once the recipient's runtime has
 * confirmed it accepted it into a turn, so a runtime that was down, or a
 * message whose own wake exhausted its attempts, is picked up again by the
 * next wake instead of being stranded.
 */
function pendingMessagesFor(row: WakeEventRow): PendingMessageRow[] {
  return db.prepare(
    `SELECT w.id AS event_id, m.id AS message_id, m.session_id, s.topic, m.body, m.kind,
            sender.name AS sender_name, m.created_at AS message_created_at
       FROM agent_wake_events w
       JOIN agent_comm_messages m ON m.id = w.message_id
       JOIN agent_comm_sessions s ON s.id = w.session_id
       JOIN agents sender ON sender.id = m.sender_agent_id
      WHERE w.workspace_id = ?
        AND w.target_agent_id = ?
        AND w.delivered_at IS NULL
        AND m.workspace_id = w.workspace_id
        AND (w.id = ? OR (w.created_at <= ? AND w.created_at >= ?))
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ?`,
  ).all(
    row.workspace_id,
    row.target_agent_id,
    row.id,
    row.created_at,
    new Date(Date.now() - BATCH_LOOKBACK_MS).toISOString(),
    MAX_BATCHED_MESSAGES,
  ) as PendingMessageRow[];
}

/**
 * Record delivery on the message and on its wake event at once, so the two can
 * never disagree, and record it once: a row that already carries delivered_at
 * keeps the timestamp it got the first time.
 *
 * Both delivery paths land here, which is the point — there is one definition
 * of "delivered", not two. The push path stamps when the recipient's runtime
 * has confirmed it accepted the payload; the pull path stamps when the
 * recipient takes the message out of its own inbox.
 *
 * Closing the wake event is what keeps a message that arrived by pull from
 * being retried later against a runtime that was never there, and failing
 * loudly for a message that was in fact read.
 */
function stampDelivered(messageIds: string[], deliveredAt: string): void {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE agent_comm_messages
        SET delivered_at = ?
      WHERE delivered_at IS NULL
        AND id IN (${placeholders})`,
  ).run(deliveredAt, ...ids);
  db.prepare(
    `UPDATE agent_wake_events
        SET status = 'delivered',
            delivered_at = ?,
            next_attempt_at = NULL,
            last_error = NULL
      WHERE delivered_at IS NULL
        AND message_id IN (${placeholders})`,
  ).run(deliveredAt, ...ids);
}

function messageIdsForEvents(eventIds: string[]): string[] {
  if (!eventIds.length) return [];
  const placeholders = eventIds.map(() => "?").join(", ");
  return (
    db.prepare(
      `SELECT message_id FROM agent_wake_events WHERE id IN (${placeholders})`,
    ).all(...eventIds) as { message_id: string }[]
  ).map((row) => row.message_id);
}

/**
 * Delivery recorded because the recipient pulled the message, not because a
 * runtime accepted a push.
 *
 * Some agents are client-initiated identities rather than processes: a
 * connector the owner opens, an ephemeral CLI session. There is no address to
 * push to and never will be, and giving them a webhook that answers
 * accepted:true on their behalf would be a lie. The honest moment is this one
 * — the message is in the result the agent is reading, so it is in its
 * context. Nothing is asked of the model, and nothing is left open.
 *
 * Returns the timestamp written, or null when this instance cannot write.
 */
export function markDeliveredOnRead(messageIds: string[]): string | null {
  if (DB_READ_ONLY) return null;
  if (!messageIds.length) return null;
  const deliveredAt = nowIso();
  db.transaction(() => stampDelivered(messageIds, deliveredAt))();
  return deliveredAt;
}

function envPrefixForAgent(targetName: string): string {
  const normalized = targetName.trim().toLowerCase();
  if (normalized === "leo-agentcomm" || normalized === "leo") {
    return "AGENTCOMM_LEO_WEBHOOK";
  }
  return `AGENTCOMM_${normalized
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}_WEBHOOK`;
}

function isStaleLeoDirectCallback(targetName: string, url: URL): boolean {
  const normalized = targetName.trim().toLowerCase();
  return (
    (normalized === "leo" || normalized === "leo-agentcomm") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") &&
    url.port === "8645"
  );
}

function resolveWebhookConfig(targetName: string): WebhookResolution {
  const prefix = envPrefixForAgent(targetName);
  const rawUrl = process.env[`${prefix}_URL`];
  const token = process.env[`${prefix}_SECRET`] || process.env[`${prefix}_TOKEN`];
  if (!rawUrl || !token) return { ignored: "no_webhook_config" };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ignored: "invalid_webhook_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ignored: "invalid_webhook_url" };
  }
  // The audited Leo callback is a dead reverse-SSH-era assumption. Durable
  // inbox polling remains authoritative; this optional acceleration target is
  // ignored until an operator configures a verified listener on a new path.
  if (isStaleLeoDirectCallback(targetName, url)) {
    return { ignored: "stale_direct_callback_disabled" };
  }

  const rawAuth = (process.env[`${prefix}_AUTH`] || "hmac").trim().toLowerCase();
  return {
    config: {
      url: url.toString(),
      token,
      auth: rawAuth === "bearer" ? "bearer" : "hmac",
    },
  };
}

function dueRows(eventId?: string, limit = BATCH_SIZE): WakeEventRow[] {
  const now = nowIso();
  // A process can exit after a POST completes but before recordOutcome runs.
  // Once the claim lease expires, retire a fifth such claim instead of
  // allowing a still-queued row to escape the global attempt ceiling.
  const exhaustedFilter = eventId ? "AND id = ?" : "";
  db.prepare(
    `UPDATE agent_wake_events
        SET status = 'failed',
            next_attempt_at = NULL,
            last_error = COALESCE(last_error, 'attempt_ceiling_exhausted')
      WHERE status = 'queued'
        AND attempt_count >= ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ${exhaustedFilter}`,
  ).run(AGENT_WAKE_MAX_ATTEMPTS, now, ...(eventId ? [eventId] : []));

  const eventFilter = eventId ? "AND w.id = ?" : "";
  const params = eventId ? [now, eventId, limit] : [now, limit];
  return db.prepare(
    `SELECT w.id, w.workspace_id, w.target_agent_id, w.session_id, w.message_id,
            w.status, w.attempt_count, w.last_attempt_at, w.next_attempt_at, w.created_at,
            m.sender_agent_id, sender.name AS sender_name, target.name AS target_name,
            target.active AS target_active, target.workspace_id AS target_workspace_id,
            sender.workspace_id AS sender_workspace_id,
            s.workspace_id AS session_workspace_id, m.workspace_id AS message_workspace_id,
            m.recipient_agent_id AS message_recipient_agent_id,
            s.topic, m.body, m.kind,
            m.created_at AS message_created_at
       FROM agent_wake_events w
       JOIN workspaces ws ON ws.id = w.workspace_id
       JOIN agent_comm_sessions s ON s.id = w.session_id
       JOIN agent_comm_messages m ON m.id = w.message_id
       JOIN agents sender ON sender.id = m.sender_agent_id
       JOIN agents target ON target.id = w.target_agent_id
      WHERE (
              (w.status = 'queued' AND w.attempt_count < ?)
              OR (w.status = 'failed' AND w.attempt_count < ?)
            )
        AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= ?)
        ${eventFilter}
      ORDER BY w.created_at ASC, w.id ASC
      LIMIT ?`,
  ).all(AGENT_WAKE_MAX_ATTEMPTS, AGENT_WAKE_MAX_ATTEMPTS, ...params) as WakeEventRow[];
}

function claim(row: WakeEventRow): number | null {
  const attemptedAt = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + DELIVERY_TIMEOUT_MS * 2).toISOString();
  const info = db.prepare(
    `UPDATE agent_wake_events
        SET attempt_count = attempt_count + 1,
            last_attempt_at = ?,
            next_attempt_at = ?
      WHERE id = ?
        AND status = ?
        AND attempt_count = ?
        AND attempt_count < ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
  ).run(
    attemptedAt,
    leaseUntil,
    row.id,
    row.status,
    row.attempt_count,
    AGENT_WAKE_MAX_ATTEMPTS,
    attemptedAt,
  );
  return info.changes === 1 ? row.attempt_count + 1 : null;
}

function retryAt(attempt: number): string | null {
  if (attempt >= AGENT_WAKE_MAX_ATTEMPTS) return null;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delayMs).toISOString();
}

function recordOutcome(
  row: WakeEventRow,
  attempt: number,
  result: WakeDeliveryResult,
): void {
  const completedAt = new Date().toISOString();
  db.transaction(() => {
    const update = db.prepare(
      `UPDATE agent_wake_events
          SET status = ?,
              delivered_at = ?,
              next_attempt_at = ?,
              last_error = ?
        WHERE id = ? AND attempt_count = ? AND delivered_at IS NULL`,
    ).run(
      result.status,
      result.status === "delivered" ? completedAt : null,
      result.status === "failed" ? retryAt(attempt) : null,
      result.error ?? null,
      row.id,
      attempt,
    );
    if (update.changes !== 1) return;
    if (result.status === "delivered") {
      stampDelivered(
        messageIdsForEvents([row.id, ...(result.batched_event_ids ?? [])]),
        completedAt,
      );
    }
    logActivity({
      workspace_id: row.workspace_id,
      agent_id: row.sender_agent_id,
      action: `agent_wake_${result.status}`,
      entity_type: "agent_wake_event",
      entity_id: row.id,
      project_id: null,
      summary: `AgentComm wake ${result.status} for ${row.target_name}`,
      details: {
        to: row.target_name,
        session_id: row.session_id,
        message_id: row.message_id,
        attempt,
        attempted: result.attempted,
        ...(result.batched_event_ids?.length
          ? { batched_messages: result.batched_event_ids.length }
          : {}),
        ...(result.http_status === undefined ? {} : { http_status: result.http_status }),
        ...(result.error ? { error: result.error } : {}),
      },
    });
  })();
}

/**
 * The recipient runtime confirms acceptance with {"accepted": true}. Anything
 * else — an empty body, a proxy's HTML, {"accepted": false} — is treated as a
 * non-delivery and retried, so a message is never written off as delivered on
 * the strength of a status code alone.
 */
async function runtimeAcceptedPayload(response: Response): Promise<boolean> {
  try {
    const parsed = await response.json();
    return !!parsed && typeof parsed === "object" && (parsed as { accepted?: unknown }).accepted === true;
  } catch {
    return false;
  }
}

async function deliver(row: WakeEventRow, attempt: number): Promise<WakeDeliveryResult> {
  if (Date.now() - new Date(row.created_at).getTime() > STALE_AFTER_MS) {
    return {
      event_id: row.id,
      status: "ignored",
      attempted: false,
      error: "stale_queued_event",
    };
  }
  // The thread — wake, session and message — must agree on one home workspace;
  // a disagreement there means a corrupt or forged row and is never delivered.
  //
  // The participants are deliberately not held to it. Addressing crosses the
  // workspace boundary (see resolveCounterparty in agent-comm.ts), so the
  // sender or the recipient legitimately lives elsewhere. What still has to
  // hold is that this wake carries the message it claims to: the recipient is
  // pinned to the message's own recipient, so a wake can never be pointed at an
  // agent the message was not addressed to.
  if (
    row.target_active !== 1 ||
    row.session_workspace_id !== row.workspace_id ||
    row.message_workspace_id !== row.workspace_id ||
    row.message_recipient_agent_id !== row.target_agent_id
  ) {
    return {
      event_id: row.id,
      status: "ignored",
      attempted: false,
      error: "inactive_or_workspace_mismatch",
    };
  }

  const resolved = resolveWebhookConfig(row.target_name);
  if ("ignored" in resolved) {
    return {
      event_id: row.id,
      status: "ignored",
      attempted: false,
      error: resolved.ignored,
    };
  }

  // The wake carries the messages themselves, not a notification to go and
  // fetch them. The recipient runtime renders these straight into the turn, so
  // the model sees them the way it sees a message from a user — there is no
  // "decide to read" step left to fail.
  const pending = pendingMessagesFor(row);
  const messages = pending.map((message) => ({
    message_id: message.message_id,
    session_id: message.session_id,
    from_agent: message.sender_name,
    topic: message.topic,
    kind: message.kind,
    body: message.body,
    created_at: message.message_created_at,
  }));
  const batchedEventIds = pending
    .map((message) => message.event_id)
    .filter((eventId) => eventId !== row.id);

  // Recipient runtimes render the wake into the turn through a flat
  // {{placeholder}} template that can only stringify a value, so the readable
  // form of the whole batch is built here rather than in nine separate
  // templates.
  const messagesText = messages
    .map((message, index) => {
      const header = messages.length > 1 ? `--- message ${index + 1} of ${messages.length} ---\n` : "";
      return `${header}From: ${message.from_agent}\nTopic: ${message.topic}\n` +
        `Kind: ${message.kind}\nSession ID: ${message.session_id}\n` +
        `Message ID: ${message.message_id}\nSent: ${message.created_at}\n\n${message.body}`;
    })
    .join("\n\n");

  const payload = JSON.stringify({
    event_type: "agentcomm_wake",
    // The triggering message stays at the top level so a runtime whose prompt
    // template still reads {{body}}/{{from_agent}} keeps working untouched
    // while templates are rolled forward to render {{messages}}.
    from_agent: row.sender_name,
    to_agent: row.target_name,
    session_id: row.session_id,
    message_id: row.message_id,
    topic: row.topic,
    body: row.body,
    created_at: row.message_created_at,
    kind: row.kind,
    message_count: messages.length,
    messages,
    messages_text: messagesText,
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolved.config.auth === "bearer") {
    headers.Authorization = `Bearer ${resolved.config.token}`;
  } else {
    headers["X-Webhook-Signature"] = createHmac("sha256", resolved.config.token)
      .update(payload)
      .digest("hex");
  }

  try {
    const response = await fetch(resolved.config.url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (response.ok) {
      // A 2xx alone is not proof of receipt — a proxy, a redirect target or a
      // generic health endpoint can produce one. Delivery is recorded only on
      // the recipient runtime's own acknowledgement that it authenticated the
      // call, matched an enabled hook and handed the messages to a turn.
      const accepted = await runtimeAcceptedPayload(response);
      if (!accepted) {
        return {
          event_id: row.id,
          status: "failed",
          attempted: true,
          http_status: response.status,
          error: "runtime_did_not_confirm_acceptance",
        };
      }
      return {
        event_id: row.id,
        status: "delivered",
        attempted: true,
        http_status: response.status,
        batched_event_ids: batchedEventIds,
      };
    }
    return {
      event_id: row.id,
      status: "failed",
      attempted: true,
      http_status: response.status,
      error: `http_${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.name : "transport_error";
    return {
      event_id: row.id,
      status: "failed",
      attempted: true,
      error: message.slice(0, 120),
    };
  }
}

export async function drainAgentWakeQueue(options: {
  eventId?: string;
  limit?: number;
} = {}): Promise<WakeDeliveryResult[]> {
  const rows = dueRows(options.eventId, Math.min(Math.max(options.limit ?? BATCH_SIZE, 1), 100));
  const results: WakeDeliveryResult[] = [];
  for (const row of rows) {
    const attempt = claim(row);
    if (attempt === null) continue;
    const result = await deliver(row, attempt);
    recordOutcome(row, attempt, result);
    results.push(result);
  }
  return results;
}

let scheduled = false;

/** Non-throwing post-commit nudge; durable queue state remains authoritative. */
export function scheduleAgentWakeDrain(eventId?: string): void {
  if (scheduled && !eventId) return;
  scheduled = true;
  queueMicrotask(() => {
    void drainAgentWakeQueue({ eventId })
      .catch((error) => logger.warn("AgentComm wake drain failed", { error: String(error) }))
      .finally(() => {
        scheduled = false;
      });
  });
}

let worker: ReturnType<typeof setInterval> | null = null;

export function startAgentWakeWorker(): void {
  if (worker) return;
  scheduleAgentWakeDrain();
  worker = setInterval(() => scheduleAgentWakeDrain(), WORKER_INTERVAL_MS);
  if (typeof worker.unref === "function") worker.unref();
}

export function stopAgentWakeWorker(): void {
  if (!worker) return;
  clearInterval(worker);
  worker = null;
}
