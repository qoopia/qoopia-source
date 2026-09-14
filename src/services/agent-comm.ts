import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { logActivity } from "./activity.ts";
import { markDeliveredOnRead, scheduleAgentWakeDrain } from "./agent-wake.ts";

export type AgentCommKind = "request" | "ack" | "reply" | "status" | "system";

type AgentRow = { id: string; name: string; type: string; active: number; last_seen: string | null; tool_profile: string; workspace_id: string };
type SessionRow = { id: string; workspace_id: string; topic: string; status: string; created_by_agent_id: string; metadata: string; idempotency_key: string | null; created_at: string; updated_at: string; closed_at: string | null };
type MessageRow = { id: string; workspace_id: string; session_id: string; sender_agent_id: string; recipient_agent_id: string; kind: string; body: string; metadata: string; delivered_at: string | null; parent_message_id: string | null; idempotency_key: string | null; created_at: string; sender_name?: string; recipient_name?: string; topic?: string; session_status?: string; wake_id?: string | null; wake_status?: string | null };

export interface AgentSendInput {
  workspace_id: string;
  agent_id: string;
  to_agent: string;
  body: string;
  session_id?: string;
  topic?: string;
  metadata?: Record<string, unknown>;
  kind?: AgentCommKind;
  parent_message_id?: string;
  idempotency_key?: string;
  /** Internal: agentReply uses this to commit reply + close atomically. */
  close_after_send?: boolean;
}

function parse(s: string): unknown {
  return safeJsonParse(s, {});
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "idempotency_key must be 1-128 characters: letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  return key;
}

const AGENT_COLUMNS = "id, name, type, active, last_seen, tool_profile, workspace_id";

function normalizeTargetName(nameOrId: string): string {
  const target = String(nameOrId || "").trim();
  if (!target) throw new QoopiaError("INVALID_INPUT", "target agent is required");
  return target.toLowerCase() === "leo-agentcomm" ? "Leo" : target;
}

function resolveAgent(workspace_id: string, nameOrId: string): AgentRow {
  const target = normalizeTargetName(nameOrId);
  const row = db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents
     WHERE workspace_id = ? AND active = 1 AND (id = ? OR lower(name) = lower(?))
     LIMIT 1`,
  ).get(workspace_id, target, target) as AgentRow | undefined;
  if (!row) throw new QoopiaError("NOT_FOUND", `active agent not found: ${target}`);
  return row;
}

function assertOwnerBoundary(workspaceId: string, targetWorkspaceId: string): void {
  if (workspaceId === targetWorkspaceId) return;
  const owners = db.prepare(
    `SELECT workspace_id, actor_id FROM workspace_owners WHERE workspace_id IN (?, ?)`,
  ).all(workspaceId, targetWorkspaceId) as Array<{ workspace_id: string; actor_id: string }>;
  const sourceOwner = owners.find((owner) => owner.workspace_id === workspaceId);
  const targetOwner = owners.find((owner) => owner.workspace_id === targetWorkspaceId);
  if (!sourceOwner || !targetOwner || sourceOwner.actor_id !== targetOwner.actor_id) {
    throw new QoopiaError("FORBIDDEN", "AgentComm between independent owners is not federated");
  }
}

/**
 * Resolve the other end of a conversation, across workspaces if necessary.
 *
 * A workspace is a *memory* boundary: notes, recall, entities, sessions, files
 * and activity are scoped to one and stay that way. Agents that were given
 * their own workspace so their recall stays private remain reachable under the
 * legacy same-installation behavior only when both workspaces record the same
 * explicit owner. AgentComm does not invent federation or infer ownership.
 * Recipient lookup still starts in the caller's own workspace and widens only
 * when the owner boundary permits it.
 *
 * The widened search must be unambiguous. Two active agents sharing a name in
 * different workspaces is a routing question the server has no business
 * guessing at, so it is a CONFLICT and the caller must address by agent id.
 * Own-workspace names always win, so adding a foreign agent can never silently
 * re-point an existing local conversation.
 */
function resolveCounterparty(workspace_id: string, nameOrId: string): AgentRow {
  const target = normalizeTargetName(nameOrId);
  const local = db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents
     WHERE workspace_id = ? AND active = 1 AND (id = ? OR lower(name) = lower(?))
     LIMIT 1`,
  ).get(workspace_id, target, target) as AgentRow | undefined;
  if (local) return local;

  const foreign = db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents
     WHERE workspace_id != ? AND active = 1 AND (id = ? OR lower(name) = lower(?))
     ORDER BY name, id
     LIMIT 2`,
  ).all(workspace_id, target, target) as AgentRow[];
  if (!foreign.length) throw new QoopiaError("NOT_FOUND", `active agent not found: ${target}`);
  if (foreign.length > 1) {
    throw new QoopiaError(
      "CONFLICT",
      `agent name is ambiguous across workspaces: ${target} — address by agent id`,
    );
  }
  assertOwnerBoundary(workspace_id, foreign[0]!.workspace_id);
  return foreign[0]!;
}

function resolveAgentById(workspaceId: string, agentId: string): AgentRow {
  const row = db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ? AND active = 1`,
  ).get(agentId) as AgentRow | undefined;
  if (!row) throw new QoopiaError("NOT_FOUND", `active agent not found: ${agentId}`);
  assertOwnerBoundary(workspaceId, row.workspace_id);
  return row;
}

/**
 * A participant reaches a thread through its participation, not through
 * workspace membership. This is the only door AgentComm opens across the
 * boundary, and it opens onto one session the agent is already in.
 */
function isSessionParticipant(session: SessionRow, agentId: string): boolean {
  if (session.created_by_agent_id === agentId) return true;
  const row = db.prepare(
    `SELECT 1 FROM agent_comm_messages
      WHERE session_id = ? AND (sender_agent_id = ? OR recipient_agent_id = ?)
      LIMIT 1`,
  ).get(session.id, agentId, agentId);
  return !!row;
}

/**
 * A session's home workspace is the workspace of the agent that opened it, and
 * the whole thread — messages, wake events, dashboard view — lives there. A
 * caller from that workspace sees it as before; a caller from elsewhere sees it
 * only if it is a participant, and sees nothing else in that workspace.
 */
function getSession(workspace_id: string, session_id: string, agent_id?: string): SessionRow {
  const session = db.prepare(
    `SELECT * FROM agent_comm_sessions WHERE id = ?`,
  ).get(session_id) as SessionRow | undefined;
  if (!session) throw new QoopiaError("NOT_FOUND", "agent session not found");
  if (session.workspace_id === workspace_id) return session;
  if (agent_id && isSessionParticipant(session, agent_id)) return session;
  throw new QoopiaError("NOT_FOUND", "agent session not found");
}

function messageOut(row: MessageRow) {
  return {
    id: row.id,
    session_id: row.session_id,
    topic: row.topic,
    session_status: row.session_status,
    kind: row.kind,
    from: row.sender_name,
    to: row.recipient_name,
    body: row.body,
    metadata: parse(row.metadata),
    delivered_at: row.delivered_at ?? null,
    parent_message_id: row.parent_message_id,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
  };
}

function createWake(
  workspace_id: string,
  target_agent_id: string,
  session_id: string,
  message_id: string,
): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO agent_wake_events
       (id, workspace_id, target_agent_id, session_id, message_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspace_id,
    target_agent_id,
    session_id,
    message_id,
    JSON.stringify({ reason: "agent_message" }),
    nowIso(),
  );
  return id;
}

function loadMessageResult(messageId: string, deduplicated = false) {
  const row = db.prepare(
    `SELECT m.*, recipient.name AS recipient_name, sender.name AS sender_name,
            s.topic, s.status AS session_status,
            w.id AS wake_id, w.status AS wake_status
       FROM agent_comm_messages m
       JOIN agents recipient ON recipient.id = m.recipient_agent_id
       JOIN agents sender ON sender.id = m.sender_agent_id
       JOIN agent_comm_sessions s ON s.id = m.session_id
       LEFT JOIN agent_wake_events w ON w.message_id = m.id
      WHERE m.id = ?
      ORDER BY w.created_at DESC
      LIMIT 1`,
  ).get(messageId) as MessageRow | undefined;
  if (!row) throw new QoopiaError("INTERNAL", "persisted AgentComm message not found");
  return {
    id: row.id,
    session_id: row.session_id,
    to: row.recipient_name,
    kind: row.kind,
    created_at: row.created_at,
    wake: row.wake_id
      ? { event_id: row.wake_id, status: row.wake_status ?? "queued" }
      : null,
    ...(deduplicated ? { deduplicated: true } : {}),
  };
}

/**
 * Idempotency is a property of the sender, not of a workspace. A sender can now
 * write into a thread whose home workspace is not its own, so scoping the
 * lookup by workspace would let one key mean two different messages. Looking it
 * up by sender alone keeps a retry returning the original send wherever the
 * thread lives, and turns genuine key reuse into the CONFLICT it always was.
 */
function findIdempotentMessage(
  senderId: string,
  key: string | null,
): MessageRow | undefined {
  if (!key) return undefined;
  return db.prepare(
    `SELECT * FROM agent_comm_messages
      WHERE sender_agent_id = ? AND idempotency_key = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  ).get(senderId, key) as MessageRow | undefined;
}

function assertIdempotentMessageMatches(
  row: MessageRow,
  input: AgentSendInput,
  target: AgentRow,
  kind: AgentCommKind,
  body: string,
): void {
  if (
    row.recipient_agent_id !== target.id ||
    row.kind !== kind ||
    row.body !== body ||
    row.metadata !== JSON.stringify(input.metadata || {}) ||
    row.parent_message_id !== (input.parent_message_id ?? null) ||
    (input.session_id !== undefined && row.session_id !== input.session_id)
  ) {
    throw new QoopiaError("CONFLICT", "idempotency_key was already used for a different AgentComm message");
  }
}

function assertIdempotentSessionMatches(
  session: SessionRow,
  input: {
    metadata?: Record<string, unknown>;
  },
  topic: string,
  body: string | null,
  target: AgentRow | null,
  key: string,
): MessageRow | undefined {
  const initial = db.prepare(
    `SELECT * FROM agent_comm_messages
      WHERE session_id = ? AND idempotency_key = ?
      LIMIT 1`,
  ).get(session.id, key) as MessageRow | undefined;
  const expectedMetadata = JSON.stringify(input.metadata || {});
  const initialMatches = body && target
    ? !!initial &&
      initial.kind === "request" &&
      initial.recipient_agent_id === target.id &&
      initial.body === body &&
      initial.metadata === expectedMetadata
    : !initial;
  if (
    session.topic !== topic ||
    session.metadata !== expectedMetadata ||
    !initialMatches
  ) {
    throw new QoopiaError(
      "CONFLICT",
      "idempotency_key was already used for a different AgentComm session",
    );
  }
  return initial;
}

function resolveReplyTarget(
  workspaceId: string,
  sessionId: string,
  parentMessageId: string,
  sender: AgentRow,
  requestedTarget: AgentRow,
): { target: AgentRow; reroutedFrom: string | null } {
  const parent = db.prepare(
    `SELECT sender_agent_id FROM agent_comm_messages
      WHERE workspace_id = ? AND session_id = ? AND id = ?`,
  ).get(workspaceId, sessionId, parentMessageId) as
    | { sender_agent_id: string }
    | undefined;
  if (!parent) {
    throw new QoopiaError("NOT_FOUND", "reply parent message not found in session");
  }
  if (
    parent.sender_agent_id !== sender.id &&
    parent.sender_agent_id !== requestedTarget.id
  ) {
    return {
      // Resolved by id: the original requester may live in another workspace,
      // and it is already a participant of this thread either way.
      target: resolveAgentById(sender.workspace_id, parent.sender_agent_id),
      reroutedFrom: requestedTarget.name,
    };
  }
  return { target: requestedTarget, reroutedFrom: null };
}

function logSessionCreate(
  workspaceId: string,
  agentId: string,
  sessionId: string,
  topic: string,
): void {
  logActivity({
    workspace_id: workspaceId,
    agent_id: agentId,
    action: "agent_session_create",
    entity_type: "agent_comm_session",
    entity_id: sessionId,
    project_id: null,
    summary: `Created agent session: ${topic}`,
    details: { session_id: sessionId },
  });
}

function logSend(
  input: AgentSendInput,
  messageId: string,
  sessionId: string,
  targetName: string,
  kind: AgentCommKind,
  reroutedFrom: string | null,
): void {
  logActivity({
    workspace_id: input.workspace_id,
    agent_id: input.agent_id,
    action: "agent_send",
    entity_type: "agent_comm_message",
    entity_id: messageId,
    project_id: null,
    summary: `Agent message ${kind} to ${targetName}`,
    details: {
      session_id: sessionId,
      to: targetName,
      kind,
      ...(reroutedFrom ? { rerouted_from: reroutedFrom } : {}),
    },
  });
}

export function agentSessionCreate(input: {
  workspace_id: string;
  agent_id: string;
  to_agent?: string;
  topic: string;
  message?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}) {
  const topic = String(input.topic || "").trim();
  if (!topic) throw new QoopiaError("INVALID_INPUT", "topic is required");
  assertNoSecrets(topic, "agent_comm.topic");
  if ((input.to_agent && !input.message) || (!input.to_agent && input.message)) {
    throw new QoopiaError("INVALID_INPUT", "to_agent and message must be provided together");
  }
  const body = input.message ? String(input.message).trim() : null;
  if (input.message && !body) throw new QoopiaError("INVALID_INPUT", "message body is required");
  if (body) assertNoSecrets(body, "agent_comm.message");
  assertNoSecrets(JSON.stringify(input.metadata ?? {}), "agent_comm.metadata");

  const key = normalizeIdempotencyKey(input.idempotency_key);
  const sender = resolveAgent(input.workspace_id, input.agent_id);
  const target = input.to_agent ? resolveCounterparty(input.workspace_id, input.to_agent) : null;
  const existing = key
    ? db.prepare(
        `SELECT * FROM agent_comm_sessions
          WHERE workspace_id = ? AND created_by_agent_id = ? AND idempotency_key = ?`,
      ).get(input.workspace_id, sender.id, key) as SessionRow | undefined
    : undefined;
  if (existing) {
    const first = assertIdempotentSessionMatches(
      existing,
      input,
      topic,
      body,
      target,
      key!,
    );
    return {
      id: existing.id,
      topic: existing.topic,
      status: existing.status,
      initial_message: first ? loadMessageResult(first.id, true) : null,
      deduplicated: true,
    };
  }

  const sessionId = ulid();
  const messageId = body && target ? ulid() : null;
  const ts = nowIso();
  let wakeId: string | null = null;
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO agent_comm_sessions
           (id, workspace_id, topic, status, created_by_agent_id, metadata,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        input.workspace_id,
        topic,
        sender.id,
        JSON.stringify(input.metadata || {}),
        key,
        ts,
        ts,
      );
      logSessionCreate(input.workspace_id, sender.id, sessionId, topic);
      if (messageId && body && target) {
        db.prepare(
          `INSERT INTO agent_comm_messages
             (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
              kind, body, metadata, parent_message_id,
              idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, 'request', ?, ?, NULL, ?, ?)`,
        ).run(
          messageId,
          input.workspace_id,
          sessionId,
          sender.id,
          target.id,
          body,
          JSON.stringify(input.metadata || {}),
          key,
          ts,
        );
        db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).run(ts, sender.id);
        wakeId = createWake(input.workspace_id, target.id, sessionId, messageId);
        logSend(
          {
            workspace_id: input.workspace_id,
            agent_id: sender.id,
            to_agent: target.name,
            body,
          },
          messageId,
          sessionId,
          target.name,
          "request",
          null,
        );
      }
    })();
  } catch (error) {
    const raced = key
      ? db.prepare(
          `SELECT * FROM agent_comm_sessions
            WHERE workspace_id = ? AND created_by_agent_id = ? AND idempotency_key = ?`,
        ).get(input.workspace_id, sender.id, key) as SessionRow | undefined
      : undefined;
    if (!raced) throw error;
    const first = assertIdempotentSessionMatches(
      raced,
      input,
      topic,
      body,
      target,
      key!,
    );
    return {
      id: raced.id,
      topic: raced.topic,
      status: raced.status,
      initial_message: first ? loadMessageResult(first.id, true) : null,
      deduplicated: true,
    };
  }
  if (wakeId) scheduleAgentWakeDrain(wakeId);
  return {
    id: sessionId,
    topic,
    status: "open",
    initial_message: messageId ? loadMessageResult(messageId) : null,
  };
}

export function agentSend(input: AgentSendInput) {
  const body = String(input.body || "").trim();
  if (!body) throw new QoopiaError("INVALID_INPUT", "message body is required");
  assertNoSecrets(body, "agent_comm.body");
  assertNoSecrets(JSON.stringify(input.metadata ?? {}), "agent_comm.metadata");
  const key = normalizeIdempotencyKey(input.idempotency_key);
  const sender = resolveAgent(input.workspace_id, input.agent_id);
  let target = resolveCounterparty(input.workspace_id, input.to_agent);
  const kind: AgentCommKind = input.kind || "request";
  // The thread's home workspace, not the sender's: replying into a session
  // opened elsewhere must file the reply alongside the message it answers, or
  // the wake worker's own consistency checks would reject its delivery.
  const homeWorkspaceId = input.session_id
    ? getSession(input.workspace_id, input.session_id, sender.id).workspace_id
    : input.workspace_id;
  let reroutedFrom: string | null = null;
  if (kind === "reply" && input.parent_message_id && input.session_id) {
    const resolved = resolveReplyTarget(
      homeWorkspaceId,
      input.session_id,
      input.parent_message_id,
      sender,
      target,
    );
    target = resolved.target;
    reroutedFrom = resolved.reroutedFrom;
  }

  const existing = findIdempotentMessage(sender.id, key);
  if (existing) {
    assertIdempotentMessageMatches(existing, input, target, kind, body);
    return loadMessageResult(existing.id, true);
  }

  const sessionId = input.session_id ?? ulid();
  const messageId = ulid();
  const ts = nowIso();
  let wakeId = "";
  try {
    db.transaction(() => {
      const raced = findIdempotentMessage(sender.id, key);
      if (raced) {
        assertIdempotentMessageMatches(raced, input, target, kind, body);
        throw new QoopiaError("CONFLICT", `IDEMPOTENT_RACE:${raced.id}`);
      }

      if (input.session_id) {
        const session = getSession(input.workspace_id, input.session_id, sender.id);
        if (session.status !== "open") {
          throw new QoopiaError("CONFLICT", "agent session is closed");
        }
      } else {
        const topic = String(input.topic || `Message to ${target.name}`).trim();
        if (!topic) throw new QoopiaError("INVALID_INPUT", "topic is required");
        assertNoSecrets(topic, "agent_comm.topic");
        db.prepare(
          `INSERT INTO agent_comm_sessions
             (id, workspace_id, topic, status, created_by_agent_id, metadata,
              created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
        ).run(
          sessionId,
          input.workspace_id,
          topic,
          sender.id,
          JSON.stringify(input.metadata || {}),
          ts,
          ts,
        );
        logSessionCreate(input.workspace_id, sender.id, sessionId, topic);
      }

      if (kind === "reply" && input.parent_message_id) {
        const resolved = resolveReplyTarget(
          homeWorkspaceId,
          sessionId,
          input.parent_message_id,
          sender,
          target,
        );
        target = resolved.target;
        reroutedFrom ??= resolved.reroutedFrom;
      }

      db.prepare(
        `INSERT INTO agent_comm_messages
           (id, workspace_id, session_id, sender_agent_id, recipient_agent_id,
            kind, body, metadata, parent_message_id,
            idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        messageId,
        homeWorkspaceId,
        sessionId,
        sender.id,
        target.id,
        kind,
        body,
        JSON.stringify(input.metadata || {}),
        input.parent_message_id || null,
        key,
        ts,
      );
      const sessionUpdate = input.close_after_send
        ? db.prepare(
            `UPDATE agent_comm_sessions
                SET status = 'closed', closed_at = ?, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND status = 'open'`,
          ).run(ts, ts, homeWorkspaceId, sessionId)
        : db.prepare(
            `UPDATE agent_comm_sessions SET updated_at = ?
              WHERE workspace_id = ? AND id = ? AND status = 'open'`,
          ).run(ts, homeWorkspaceId, sessionId);
      if (sessionUpdate.changes !== 1) {
        throw new QoopiaError("CONFLICT", "agent session is closed");
      }
      db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).run(ts, sender.id);
      wakeId = createWake(homeWorkspaceId, target.id, sessionId, messageId);
      logSend(input, messageId, sessionId, target.name, kind, reroutedFrom);
      if (input.close_after_send) {
        logActivity({
          workspace_id: input.workspace_id,
          agent_id: sender.id,
          action: "agent_session_close",
          entity_type: "agent_comm_session",
          entity_id: sessionId,
          project_id: null,
          summary: "Closed agent session",
          details: { reason: "closed with reply" },
        });
      }
    })();
  } catch (error) {
    if (
      error instanceof QoopiaError &&
      error.message.startsWith("IDEMPOTENT_RACE:")
    ) {
      return loadMessageResult(error.message.slice("IDEMPOTENT_RACE:".length), true);
    }
    const raced = findIdempotentMessage(sender.id, key);
    if (!raced) throw error;
    assertIdempotentMessageMatches(raced, input, target, kind, body);
    return loadMessageResult(raced.id, true);
  }

  scheduleAgentWakeDrain(wakeId);
  return loadMessageResult(messageId);
}

export function agentInbox(input: {
  workspace_id: string;
  agent_id: string;
  status?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  // Addressed-to-me, not filed-in-my-workspace. agent ids are globally unique,
  // so recipient_agent_id alone is both the necessary and the sufficient
  // filter: it returns every message someone sent this agent and nothing else,
  // including the ones whose thread is homed in another workspace.
  const where = ["m.recipient_agent_id = ?"];
  const params: any[] = [input.agent_id];
  // Delivery is a transport fact, not a state the recipient closes: reading a
  // message here records it, and nothing is left for anyone to tick off.
  // 'undelivered' is therefore a diagnostic view of what has not reached its
  // recipient by any route yet, which this very call is about to change for
  // whatever it returns.
  if (input.status === "delivered") where.push("m.delivered_at IS NOT NULL");
  if (input.status === "undelivered") where.push("m.delivered_at IS NULL");
  const rows = db.prepare(
    `SELECT m.*, sa.name AS sender_name, ra.name AS recipient_name,
            s.topic, s.status AS session_status
       FROM agent_comm_messages m
       JOIN agents sa ON sa.id = m.sender_agent_id
       JOIN agents ra ON ra.id = m.recipient_agent_id
       JOIN agent_comm_sessions s ON s.id = m.session_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
  ).all(...params, limit) as MessageRow[];
  // Pull-side delivery. A push confirms delivery when the recipient's runtime
  // accepts the payload; for an agent that has no runtime to push to — a
  // connector the owner opens, an ephemeral CLI session — this is the moment
  // the message actually reaches it, and so this is where it is stamped. Same
  // stamp, same helper as the push path, written at most once.
  const deliveredAt = markDeliveredOnRead(rows.map((row) => row.id));
  const items = rows.map((row) =>
    messageOut(
      deliveredAt && !row.delivered_at ? { ...row, delivered_at: deliveredAt } : row,
    ),
  );
  return { items, limit };
}

export function agentReply(input: {
  workspace_id: string;
  agent_id: string;
  session_id: string;
  body: string;
  to_agent?: string;
  reply_to_message_id?: string;
  metadata?: Record<string, unknown>;
  close?: boolean;
  idempotency_key?: string;
}) {
  const sender = resolveAgent(input.workspace_id, input.agent_id);
  const session = getSession(input.workspace_id, input.session_id, sender.id);
  if (session.status !== "open" && !input.idempotency_key) {
    throw new QoopiaError("CONFLICT", "agent session is closed");
  }
  let to = input.to_agent;
  if (!to) {
    const last = db.prepare(
      `SELECT sender_agent_id FROM agent_comm_messages
        WHERE workspace_id = ? AND session_id = ? AND sender_agent_id != ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(session.workspace_id, input.session_id, input.agent_id) as
      | { sender_agent_id: string }
      | undefined;
    const targetId = last?.sender_agent_id || session.created_by_agent_id;
    const agent = db.prepare(`SELECT id FROM agents WHERE id = ? AND active = 1`).get(targetId) as
      | { id: string }
      | undefined;
    if (!agent) throw new QoopiaError("NOT_FOUND", "reply target not found");
    // By id, not by name: the other party may live in another workspace, where
    // a name lookup would have to guess.
    to = agent.id;
  }
  return agentSend({
    workspace_id: input.workspace_id,
    agent_id: input.agent_id,
    to_agent: to,
    session_id: input.session_id,
    body: input.body,
    metadata: input.metadata,
    kind: "reply",
    parent_message_id: input.reply_to_message_id,
    idempotency_key: input.idempotency_key,
    close_after_send: input.close,
  });
}

export function agentSessionClose(input: {
  workspace_id: string;
  agent_id: string;
  session_id: string;
  reason?: string;
}) {
  if (input.reason) assertNoSecrets(input.reason, "agent_comm.close_reason");
  const closer = resolveAgent(input.workspace_id, input.agent_id);
  const existing = getSession(input.workspace_id, input.session_id, closer.id);
  if (existing.status === "closed") {
    return {
      session_id: input.session_id,
      status: "closed",
      closed_at: existing.closed_at,
      noop: true,
    };
  }
  const ts = nowIso();
  return db.transaction(() => {
    const updated = db.prepare(
      `UPDATE agent_comm_sessions
          SET status = 'closed', closed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND status = 'open'`,
    ).run(ts, ts, existing.workspace_id, input.session_id);
    if (updated.changes !== 1) {
      const current = getSession(input.workspace_id, input.session_id, closer.id);
      return {
        session_id: input.session_id,
        status: current.status,
        closed_at: current.closed_at,
        noop: true,
      };
    }
    logActivity({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      action: "agent_session_close",
      entity_type: "agent_comm_session",
      entity_id: input.session_id,
      project_id: null,
      summary: "Closed agent session",
      details: { reason: input.reason || "done" },
    });
    return { session_id: input.session_id, status: "closed", closed_at: ts };
  })();
}

export function agentStatus(input: {
  workspace_id: string;
  agent?: string;
  limit?: number;
}) {
  const where = ["workspace_id = ?", "active = 1"];
  const params: any[] = [input.workspace_id];
  if (input.agent) {
    where.push("lower(name) = lower(?)");
    params.push(input.agent);
  }
  const agents = db.prepare(
    `SELECT id, name, type, tool_profile, last_seen FROM agents
      WHERE ${where.join(" AND ")} ORDER BY name LIMIT ?`,
  ).all(...params, Math.min(Math.max(input.limit || 50, 1), 100)) as AgentRow[];
  // Asking after one agent by name is an addressing question, and addressing is
  // no longer confined to the workspace. Answer it the same way agent_send
  // resolves it, so "can I reach Diana?" and "did my message to Diana route?"
  // can never disagree. The unfiltered listing stays workspace-local — this is
  // a lookup, not a directory of every agent on the instance.
  if (input.agent && !agents.length) {
    try {
      const reachable = resolveCounterparty(input.workspace_id, input.agent);
      return {
        agents: [{
          name: reachable.name,
          type: reachable.type,
          tool_profile: reachable.tool_profile,
          last_seen: reachable.last_seen,
          external_workspace: true,
        }],
      };
    } catch {
      return { agents: [] };
    }
  }
  return {
    agents: agents.map((agent) => ({
      name: agent.name,
      type: agent.type,
      tool_profile: agent.tool_profile,
      last_seen: agent.last_seen,
    })),
  };
}
