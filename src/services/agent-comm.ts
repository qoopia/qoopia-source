import { sameAgentName } from "../utils/agent-name.ts";
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { logActivity } from "./activity.ts";
import { markDeliveredOnRead, scheduleAgentWakeDrain } from "./agent-wake.ts";
import { bootstrapToolAllowed } from "../auth/policy.ts";

type AgentCommKind = "request" | "ack" | "reply" | "status" | "system";

type AgentRow = { id: string; name: string; type: string; active: number; last_seen: string | null; tool_profile: string; workspace_id: string };
type SessionRow = { id: string; workspace_id: string; topic: string; status: string; created_by_agent_id: string; metadata: string; idempotency_key: string | null; created_at: string; updated_at: string; closed_at: string | null };
type MessageRow = { id: string; workspace_id: string; session_id: string; sender_agent_id: string; recipient_agent_id: string; kind: string; body: string; metadata: string; delivered_at: string | null; parent_message_id: string | null; idempotency_key: string | null; created_at: string; sender_name?: string; recipient_name?: string; topic?: string; session_status?: string; wake_id?: string | null; wake_status?: string | null };

interface AgentSendInput {
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

const TOPIC_MAX_CHARS = 500;

/**
 * A topic is rendered into single-line headers (the wake's "Topic:" line,
 * activity summaries), where a raw line break could forge further header
 * lines. Store it as one bounded line. Secrets are checked on the raw input.
 */
function normalizeTopic(value: string): string {
  assertNoSecrets(value, "agent_comm.topic");
  const topic = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/ {2,}/g, " ").trim();
  if (!topic) throw new QoopiaError("INVALID_INPUT", "topic is required");
  if (topic.length > TOPIC_MAX_CHARS) {
    throw new QoopiaError("INVALID_INPUT", `topic exceeds ${TOPIC_MAX_CHARS} characters`);
  }
  return topic;
}

const AGENT_COLUMNS = "id, name, type, active, last_seen, tool_profile, workspace_id";

function normalizeTargetName(nameOrId: string): string {
  const target = String(nameOrId || "").trim();
  if (!target) throw new QoopiaError("INVALID_INPUT", "target agent is required");
  return target.toLowerCase() === "leo-agentcomm" ? "Leo" : target;
}

/**
 * Exact id, then exact name, then a case-insensitive name only when it names
 * exactly one agent. Names differing only by case can already coexist, and
 * picking one of them would silently deliver to the wrong agent.
 */
function findLocalAgent(workspace_id: string, target: string): AgentRow | undefined {
  // Names are compared in JS: SQLite lower() folds ASCII only, so 'Ассистент' would miss 'ассистент'.
  const rows = (db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE workspace_id = ? AND active = 1`,
  ).all(workspace_id) as AgentRow[]).filter((row) => row.id === target || sameAgentName(row.name, target));
  const exact = rows.find((row) => row.id === target) ?? rows.find((row) => row.name === target);
  if (exact) return exact;
  if (rows.length > 1) {
    throw new QoopiaError("CONFLICT", `agent name is ambiguous: ${target} — address by agent id`);
  }
  return rows[0];
}

function resolveAgent(workspace_id: string, nameOrId: string): AgentRow {
  const target = normalizeTargetName(nameOrId);
  const row = findLocalAgent(workspace_id, target);
  if (!row) throw new QoopiaError("NOT_FOUND", `active agent not found: ${target}`);
  return row;
}

/**
 * Agent `a` lives in a workspace that records the same explicit owner as the
 * caller's (bound parameter). F-191: this filters inside the lookup, so a name
 * held only by an independent tenant reads exactly like a missing one and can
 * never make a same-owner name ambiguous.
 */
const SAME_OWNER = `EXISTS (SELECT 1 FROM workspace_owners t
  JOIN workspace_owners s ON s.actor_id = t.actor_id
  WHERE t.workspace_id = a.workspace_id AND s.workspace_id = ?)`;

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
 * different same-owner workspaces is a routing question the server has no
 * business guessing at, so it is a CONFLICT and the caller must address by id.
 * Own-workspace names always win, so adding a foreign agent can never silently
 * re-point an existing local conversation.
 */
function resolveCounterparty(workspace_id: string, nameOrId: string): AgentRow {
  const target = normalizeTargetName(nameOrId);
  const local = findLocalAgent(workspace_id, target);
  if (local) return local;

  const foreign = (db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents a
     WHERE workspace_id != ? AND active = 1 AND ${SAME_OWNER}
     ORDER BY name, id`,
  ).all(workspace_id, workspace_id) as AgentRow[])
    .filter((row) => row.id === target || sameAgentName(row.name, target)).slice(0, 2);
  if (!foreign.length) throw new QoopiaError("NOT_FOUND", `active agent not found: ${target}`);
  if (foreign.length > 1) {
    throw new QoopiaError(
      "CONFLICT",
      `agent name is ambiguous across workspaces: ${target} — address by agent id`,
    );
  }
  return foreign[0]!;
}

/**
 * A recipient whose connection profile has no agent_inbox (a client connection or memory-setup
 * agent: 'memory-worker' without the legacy surface) can never read a message, so queueing one
 * would answer "delivered automatically" for something nobody will see. Refuse it at send time.
 */
function assertCanReceive(target: AgentRow): void {
  const row = db.prepare(`SELECT authority_profile, legacy_skill_access FROM agents WHERE id = ?`)
    .get(target.id) as { authority_profile: string | null; legacy_skill_access: number | null } | undefined;
  const profile = row?.legacy_skill_access === 1 ? undefined : row?.authority_profile ?? undefined;
  if (bootstrapToolAllowed("agent_inbox", profile)) return;
  const nextAction = "Save it as a workspace note that agent can recall (note_create), or ask the owner to give that runtime a full agent identity.";
  throw new QoopiaError(
    "UNSUPPORTED",
    `${target.name} cannot read agent messages: its connection has no inbox, so nothing would reach it. ${nextAction}`,
    { recipient: target.name, next_action: nextAction },
  );
}

function resolveAgentById(workspaceId: string, agentId: string): AgentRow {
  const row = db.prepare(
    `SELECT ${AGENT_COLUMNS} FROM agents a
     WHERE id = ? AND active = 1 AND (workspace_id = ? OR ${SAME_OWNER})`,
  ).get(agentId, workspaceId, workspaceId) as AgentRow | undefined;
  if (!row) throw new QoopiaError("NOT_FOUND", `active agent not found: ${agentId}`);
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
 * the whole thread — messages, wake events, dashboard view — lives there. Every
 * caller is a writer (send, reply, close), and a writer reaches the thread only
 * through its own participation: sharing the home workspace is not enough, or
 * any colleague could post into, redirect, or close another pair's thread.
 * Non-participants get NOT_FOUND so they cannot probe which sessions exist.
 */
function getSession(session_id: string, agent_id: string): SessionRow {
  const session = db.prepare(
    `SELECT * FROM agent_comm_sessions WHERE id = ?`,
  ).get(session_id) as SessionRow | undefined;
  if (!session || !isSessionParticipant(session, agent_id)) {
    throw new QoopiaError("NOT_FOUND", "agent session not found");
  }
  return session;
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

/** Does `asked` (an id or a name) name this agent, active or not? A replay must not
 * depend on the recipient still being resolvable. */
function namesAgent(agentId: string, asked: string | undefined): boolean {
  if (!asked) return false;
  const row = db.prepare(`SELECT id, name FROM agents WHERE id = ?`).get(agentId) as
    | { id: string; name: string }
    | undefined;
  const target = normalizeTargetName(asked);
  return !!row && (target === row.id || target.toLowerCase() === row.name.toLowerCase());
}

/**
 * A replay is judged against what was stored, never against a fresh resolution
 * that can change after the send: the recipient may be deactivated by now, and a
 * reply is rerouted to its parent's sender whatever target was asked for.
 */
function assertIdempotentMessageMatches(
  row: MessageRow,
  input: AgentSendInput,
  kind: AgentCommKind,
  body: string,
): void {
  const session = db.prepare(`SELECT topic, status FROM agent_comm_sessions WHERE id = ?`)
    .get(row.session_id) as { topic: string; status: string } | undefined;
  const parent = kind === "reply" && input.parent_message_id
    ? db.prepare(`SELECT sender_agent_id FROM agent_comm_messages WHERE session_id = ? AND id = ?`)
        .get(row.session_id, input.parent_message_id) as { sender_agent_id: string } | undefined
    : undefined;
  const rerouted = parent?.sender_agent_id === row.recipient_agent_id &&
    parent.sender_agent_id !== row.sender_agent_id;
  if (
    !(namesAgent(row.recipient_agent_id, input.to_agent) || rerouted) ||
    row.kind !== kind ||
    row.body !== body ||
    row.metadata !== JSON.stringify(input.metadata || {}) ||
    row.parent_message_id !== (input.parent_message_id ?? null) ||
    (input.session_id !== undefined && row.session_id !== input.session_id) ||
    (input.session_id === undefined && input.topic !== undefined &&
      session?.topic !== normalizeTopic(String(input.topic))) ||
    (input.close_after_send === true && session?.status === "open")
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
  toAgent: string | undefined,
  key: string,
): MessageRow | undefined {
  const initial = db.prepare(
    `SELECT * FROM agent_comm_messages
      WHERE session_id = ? AND idempotency_key = ?
      LIMIT 1`,
  ).get(session.id, key) as MessageRow | undefined;
  const expectedMetadata = JSON.stringify(input.metadata || {});
  const initialMatches = body && toAgent
    ? !!initial &&
      initial.kind === "request" &&
      namesAgent(initial.recipient_agent_id, toAgent) &&
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
  const topic = normalizeTopic(String(input.topic || ""));
  if ((input.to_agent && !input.message) || (!input.to_agent && input.message)) {
    throw new QoopiaError("INVALID_INPUT", "to_agent and message must be provided together");
  }
  const body = input.message ? String(input.message).trim() : null;
  if (input.message && !body) throw new QoopiaError("INVALID_INPUT", "message body is required");
  if (body) assertNoSecrets(body, "agent_comm.message");
  assertNoSecrets(JSON.stringify(input.metadata ?? {}), "agent_comm.metadata");

  const key = normalizeIdempotencyKey(input.idempotency_key);
  const sender = resolveAgent(input.workspace_id, input.agent_id);
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
      input.to_agent,
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
  // One key is one operation of its sender: a message agent_send filed under it is another request.
  const usedBySend = () => {
    if (findIdempotentMessage(sender.id, key)) {
      throw new QoopiaError("CONFLICT", "idempotency_key was already used by agent_send");
    }
  };
  usedBySend();
  const target = input.to_agent ? resolveCounterparty(input.workspace_id, input.to_agent) : null;
  if (target) assertCanReceive(target);

  const sessionId = ulid();
  const messageId = body && target ? ulid() : null;
  const ts = nowIso();
  let wakeId: string | null = null;
  try {
    db.transaction(() => {
      usedBySend();
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
      input.to_agent,
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
  // The server never sends 'system'; a sender claiming it would only borrow
  // authority it does not have. Rows stored before this keep their kind.
  if (input.kind === "system") {
    throw new QoopiaError("INVALID_INPUT", "kind 'system' is reserved and cannot be sent");
  }
  const body = String(input.body || "").trim();
  if (!body) throw new QoopiaError("INVALID_INPUT", "message body is required");
  assertNoSecrets(body, "agent_comm.body");
  assertNoSecrets(JSON.stringify(input.metadata ?? {}), "agent_comm.metadata");
  const key = normalizeIdempotencyKey(input.idempotency_key);
  const sender = resolveAgent(input.workspace_id, input.agent_id);
  const kind: AgentCommKind = input.kind || "request";
  // Replay before any resolution that can change after the original send.
  const existing = findIdempotentMessage(sender.id, key);
  if (existing) {
    assertIdempotentMessageMatches(existing, input, kind, body);
    return loadMessageResult(existing.id, true);
  }
  let target = resolveCounterparty(input.workspace_id, input.to_agent);
  // The thread's home workspace, not the sender's: replying into a session
  // opened elsewhere must file the reply alongside the message it answers, or
  // the wake worker's own consistency checks would reject its delivery.
  const homeWorkspaceId = input.session_id
    ? getSession(input.session_id, sender.id).workspace_id
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
  assertCanReceive(target);

  const sessionId = input.session_id ?? ulid();
  const messageId = ulid();
  const ts = nowIso();
  let wakeId = "";
  try {
    db.transaction(() => {
      const raced = findIdempotentMessage(sender.id, key);
      if (raced) {
        assertIdempotentMessageMatches(raced, input, kind, body);
        throw new QoopiaError("CONFLICT", `IDEMPOTENT_RACE:${raced.id}`);
      }

      if (input.session_id) {
        const session = getSession(input.session_id, sender.id);
        if (session.status !== "open") {
          throw new QoopiaError("CONFLICT", "agent session is closed");
        }
      } else {
        const topic = normalizeTopic(String(input.topic || `Message to ${target.name}`));
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

      // A parent is a message of this thread, whatever the kind: an unknown id
      // would surface as a foreign-key failure, and one from another thread or
      // workspace would link rows that no view or export holds together.
      if (
        input.parent_message_id &&
        !db.prepare(
          `SELECT 1 FROM agent_comm_messages WHERE workspace_id = ? AND session_id = ? AND id = ?`,
        ).get(homeWorkspaceId, sessionId, input.parent_message_id)
      ) {
        throw new QoopiaError("NOT_FOUND", "parent message not found in session");
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
    assertIdempotentMessageMatches(raced, input, kind, body);
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
  // Undelivered first, oldest first, then history newest first. Reading is the
  // only delivery a pull-only agent has, so repeated calls must work through a
  // backlog larger than one page instead of returning the newest page again.
  // Two index-ordered reads (idx_agent_comm_messages_inbox) instead of one sort.
  const page = (extra: string | null, order: string, n: number) => db.prepare(
    `SELECT m.*, sa.name AS sender_name, ra.name AS recipient_name,
            s.topic, s.status AS session_status
       FROM agent_comm_messages m
       JOIN agents sa ON sa.id = m.sender_agent_id
       JOIN agents ra ON ra.id = m.recipient_agent_id
       JOIN agent_comm_sessions s ON s.id = m.session_id
      WHERE ${[...where, ...(extra ? [extra] : [])].join(" AND ")}
      ORDER BY ${order}
      LIMIT ?`,
  ).all(...params, n) as MessageRow[];
  const oldestFirst = "m.created_at ASC, m.id ASC", newestFirst = "m.created_at DESC, m.id DESC";
  let rows: MessageRow[];
  if (input.status === "delivered") rows = page(null, newestFirst, limit);
  else if (input.status === "undelivered") rows = page(null, oldestFirst, limit);
  else {
    rows = page("m.delivered_at IS NULL", oldestFirst, limit);
    if (rows.length < limit) rows = rows.concat(page("m.delivered_at IS NOT NULL", newestFirst, limit - rows.length));
  }
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
  const session = getSession(input.session_id, sender.id);
  if (session.status !== "open" && !input.idempotency_key) {
    throw new QoopiaError("CONFLICT", "agent session is closed");
  }
  // A retry takes its target from the stored message: the implicit one may be gone since.
  let to = input.to_agent ??
    findIdempotentMessage(sender.id, normalizeIdempotencyKey(input.idempotency_key))?.recipient_agent_id;
  if (!to) {
    // The other end of the latest message the caller is not alone in: its sender, or, for a
    // follow-up to a message nobody answered yet, its recipient. Never the caller itself.
    const last = db.prepare(
      `SELECT CASE WHEN sender_agent_id != ? THEN sender_agent_id ELSE recipient_agent_id END AS other
         FROM agent_comm_messages
        WHERE workspace_id = ? AND session_id = ?
          AND (sender_agent_id = ? OR recipient_agent_id = ?)
          AND (sender_agent_id != ? OR recipient_agent_id != ?)
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(input.agent_id, session.workspace_id, input.session_id, input.agent_id, input.agent_id, input.agent_id, input.agent_id) as
      | { other: string }
      | undefined;
    const targetId = last?.other ?? (session.created_by_agent_id !== input.agent_id ? session.created_by_agent_id : null);
    const agent = targetId
      ? db.prepare(`SELECT id FROM agents WHERE id = ? AND active = 1`).get(targetId) as { id: string } | undefined
      : undefined;
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
  const existing = getSession(input.session_id, closer.id);
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
      const current = getSession(input.session_id, closer.id);
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
  /** ADR-020: an agent whose shared context is off sees only itself — no sibling, no external lookup. */
  only_agent_id?: string;
}) {
  const where = ["workspace_id = ?", "active = 1"];
  const params: any[] = [input.workspace_id];
  if (input.only_agent_id) {
    where.push("id = ?");
    params.push(input.only_agent_id);
  }
  // By name or by id, as agent_send addresses it: a local agent asked by id is not external.
  // Filtered in JS before the limit: SQLite lower() folds ASCII only.
  const agents = (db.prepare(
    `SELECT id, name, type, tool_profile, last_seen FROM agents
      WHERE ${where.join(" AND ")} ORDER BY name`,
  ).all(...params) as AgentRow[])
    .filter((agent) => !input.agent || agent.id === input.agent || sameAgentName(agent.name, input.agent))
    .slice(0, Math.min(Math.max(input.limit || 50, 1), 100));
  // Asking after one agent by name is an addressing question, and addressing is
  // no longer confined to the workspace. Answer it the same way agent_send
  // resolves it, so "can I reach Diana?" and "did my message to Diana route?"
  // can never disagree. The unfiltered listing stays workspace-local — this is
  // a lookup, not a directory of every agent on the instance.
  if (input.agent && !agents.length && !input.only_agent_id) {
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
