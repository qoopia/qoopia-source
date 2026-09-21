import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso, safeJsonParse } from "../utils/errors.ts";
import { sanitizeFtsQuery } from "./recall.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { assertAutomaticMemoryAllowed, type MemoryOrigin } from "./memory-policy.ts";

const MAX_CONTENT = 100_000;
const MAX_SUMMARY = 50_000;

export interface SessionSaveInput {
  workspace_id: string;
  agent_id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata?: Record<string, unknown>;
  token_count?: number;
  /** Claude Code JSONL entry uuid — used for server-side dedup in ingest path */
  ingest_uuid?: string;
  /** Defaults to "automatic": anything not proven to be a confirmed owner action obeys
   * the agent memory policy. Set by the server at the call site, never from a request body. */
  origin?: MemoryOrigin;
}

export function saveMessage(input: SessionSaveInput) {
  if (!input.content || input.content.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "content is required");
  }
  if (input.content.length > MAX_CONTENT) {
    throw new QoopiaError("SIZE_LIMIT", `content exceeds ${MAX_CONTENT} chars`);
  }
  assertNoSecrets(input.content, "session_message.content");
  // C3 fix: check metadata for secrets before persisting
  assertNoSecrets(JSON.stringify(input.metadata ?? {}), "session_message.metadata");

  const now = nowIso();

  // Wrap all operations in a transaction so partial failure is impossible.
  return db.transaction(() => {
    // Every path that records session content passes through here, so the memory
    // policy is enforced once, inside the write transaction. A switch to manual that
    // commits mid-flight therefore stops the very next message instead of a later one.
    assertAutomaticMemoryAllowed(input.workspace_id, input.agent_id, input.origin ?? "automatic");

    // H5 fix: check ownership BEFORE touching last_active.
    // If the session already exists, verify it belongs to this agent.
    const existing = db
      .prepare(`SELECT agent_id FROM sessions WHERE id = ? AND workspace_id = ?`)
      .get(input.session_id, input.workspace_id) as { agent_id: string } | undefined;
    if (existing && existing.agent_id !== input.agent_id) {
      throw new QoopiaError("FORBIDDEN", `session ${input.session_id} belongs to another agent`);
    }

    // Upsert session — on conflict only update last_active,
    // preserve original agent_id (prevents cross-agent session hijack)
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, agent_id, created_at, last_active)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_active = excluded.last_active
         WHERE workspace_id = excluded.workspace_id`,
    ).run(input.session_id, input.workspace_id, input.agent_id, now, now);

    // CRITICAL: Defensive cross-workspace check.
    // If session_id exists in the DB but belongs to a different workspace (ON CONFLICT DO NOTHING
    // silently skipped the insert), session_messages would still insert via FK on sessions.id only.
    // This check catches that and prevents cross-workspace corruption.
    const ownerRow = db
      .prepare(`SELECT workspace_id FROM sessions WHERE id = ?`)
      .get(input.session_id) as { workspace_id: string } | undefined;
    if (!ownerRow) {
      throw new QoopiaError("INTERNAL", "session upsert failed unexpectedly");
    }
    if (ownerRow.workspace_id !== input.workspace_id) {
      throw new QoopiaError(
        "FORBIDDEN",
        `session_id collision: owned by another workspace`,
      );
    }

    // When ingest_uuid is provided (ingest-daemon path), use INSERT OR IGNORE for
    // server-side dedup. The UNIQUE index idx_session_messages_ingest_uuid on
    // (session_id, ingest_uuid) WHERE ingest_uuid IS NOT NULL makes this safe.
    const insertSql = input.ingest_uuid
      ? `INSERT OR IGNORE INTO session_messages
          (workspace_id, session_id, agent_id, role, content, metadata, token_count, ingest_uuid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO session_messages
          (workspace_id, session_id, agent_id, role, content, metadata, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    const insertParams = input.ingest_uuid
      ? [
          input.workspace_id,
          input.session_id,
          input.agent_id,
          input.role,
          input.content,
          JSON.stringify(input.metadata || {}),
          input.token_count ?? null,
          input.ingest_uuid,
          now,
        ]
      : [
          input.workspace_id,
          input.session_id,
          input.agent_id,
          input.role,
          input.content,
          JSON.stringify(input.metadata || {}),
          input.token_count ?? null,
          now,
        ];

    const info = db.prepare(insertSql).run(...insertParams);

    // OR IGNORE means changes=0 on duplicate — return dedup signal
    if (input.ingest_uuid && info.changes === 0) {
      return { saved: false, duplicate: true, session_id: input.session_id };
    }

    const id = Number(info.lastInsertRowid);
    db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_enabled',1) WHERE id=?").run(input.session_id);

    const seqRow = db
      .prepare(
        `SELECT COUNT(*) as c FROM session_messages WHERE session_id = ? AND workspace_id = ?`,
      )
      .get(input.session_id, input.workspace_id) as { c: number };

    return { saved: true, id, session_id: input.session_id, seq: seqRow.c };
  })();
}

export interface SessionRecentParams {
  workspace_id: string;
  agent_id: string;
  session_id: string;
  limit?: number;
  include_summaries?: boolean;
}

export function sessionRecent(p: SessionRecentParams) {
  const limit = Math.min(Math.max(p.limit || 50, 1), 500);

  let sessionId = p.session_id;
  if (sessionId === "latest") {
    const row = db
      .prepare(
        `SELECT id FROM sessions
         WHERE workspace_id = ? AND (agent_id = ? OR ? IS NULL)
         ORDER BY last_active DESC LIMIT 1`,
      )
      .get(p.workspace_id, p.agent_id, p.agent_id) as
      | { id: string }
      | undefined;
    if (!row) {
      return {
        session_id: null,
        messages: [],
        summaries: [],
        message_count: 0,
        has_more_before: false,
        cost: { tokens_returned: 0 },
      };
    }
    sessionId = row.id;
  }

  const sess = db
    .prepare(
      `SELECT id, agent_id, created_at, last_active FROM sessions WHERE id = ? AND workspace_id = ?`,
    )
    .get(sessionId, p.workspace_id) as
    | { id: string; agent_id: string; created_at: string; last_active: string }
    | undefined;
  if (!sess) {
    throw new QoopiaError("NOT_FOUND", `session ${sessionId} not found`);
  }
  // C3 fix: enforce agent ownership — agents cannot read each other's transcripts
  if (sess.agent_id !== p.agent_id) {
    throw new QoopiaError("FORBIDDEN", `session ${sessionId} belongs to another agent`);
  }

  const rows = db
    .prepare(
      `SELECT id, role, content, metadata, token_count, created_at
       FROM session_messages
       WHERE session_id = ? AND workspace_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(sessionId, p.workspace_id, limit) as Array<{
    id: number;
    role: string;
    content: string;
    metadata: string;
    token_count: number | null;
    created_at: string;
  }>;

  rows.reverse();

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM session_messages WHERE session_id = ? AND workspace_id = ?`,
    )
    .get(sessionId, p.workspace_id) as { c: number };

  let summaries: Array<{
    id: string;
    content: string;
    msg_start_id: number;
    msg_end_id: number;
    level: number;
    created_at: string;
  }> = [];
  if (p.include_summaries !== false) {
    summaries = db
      .prepare(
        `SELECT id, content, msg_start_id, msg_end_id, level, created_at
         FROM summaries WHERE session_id = ? AND workspace_id = ?
         ORDER BY msg_start_id ASC`,
      )
      .all(sessionId, p.workspace_id) as typeof summaries;
  }

  const tokens = rows.reduce(
    (sum, r) => sum + Math.ceil(r.content.length / 4),
    0,
  );

  return {
    session_id: sessionId,
    session_created_at: sess.created_at,
    session_last_active: sess.last_active,
    messages: rows.map((r) => ({
      ...r,
      metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    })),
    summaries,
    message_count: totalRow.c,
    has_more_before: totalRow.c > rows.length,
    cost: { tokens_returned: tokens },
  };
}

export interface SessionSearchParams {
  workspace_id: string;
  agent_id: string;
  query: string;
  session_id?: string;
  scope?: "own_agent" | "workspace" | "all";
  privileged?: boolean;
  limit?: number;
  since?: string;
  until?: string;
}

export function sessionSearch(p: SessionSearchParams) {
  const limit = Math.min(Math.max(p.limit || 20, 1), 100);
  const sanitized = sanitizeFtsQuery(p.query);
  const scope = p.scope || "own_agent";

  const where: string[] = [`session_messages_fts MATCH ?`];
  const params: any[] = [sanitized];

  if (scope === "all" && p.privileged) {
    // no workspace filter — steward cross-workspace search
  } else {
    where.push(`sm.workspace_id = ?`);
    params.push(p.workspace_id);
    if (scope === "own_agent" || (scope === "workspace" && !p.privileged)) {
      // H4 fix: standard agents can only search their own sessions.
      // scope="workspace" for non-privileged is silently treated as "own_agent"
      // to prevent cross-agent transcript exposure.
      where.push(`sm.agent_id = ?`);
      params.push(p.agent_id);
    }
  }

  if (p.session_id) {
    where.push(`sm.session_id = ?`);
    params.push(p.session_id);
  }
  if (p.since) {
    where.push(`sm.created_at >= ?`);
    params.push(p.since);
  }
  if (p.until) {
    where.push(`sm.created_at <= ?`);
    params.push(p.until);
  }

  const sql = `
    SELECT sm.id, sm.session_id, sm.role, sm.content, sm.created_at, rank
    FROM session_messages_fts f
    JOIN session_messages sm ON sm.id = f.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY rank
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as Array<{
    id: number;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
    rank: number;
  }>;

  const tokens = rows.reduce(
    (s, r) => s + Math.ceil(r.content.length / 4),
    0,
  );

  return {
    results: rows,
    total_found: rows.length,
    query: p.query,
    sanitized_query: sanitized,
    cost: { tokens_returned: tokens },
  };
}

export interface SessionSummarizeInput {
  workspace_id: string;
  agent_id: string;
  session_id: string;
  content: string;
  msg_start_id: number;
  msg_end_id: number;
  level?: number;
  token_count?: number;
}

export function sessionSummarize(input: SessionSummarizeInput) {
  if (!input.content || input.content.length === 0) {
    throw new QoopiaError("INVALID_INPUT", "content is required");
  }
  if (input.content.length > MAX_SUMMARY) {
    throw new QoopiaError("SIZE_LIMIT", `summary exceeds ${MAX_SUMMARY} chars`);
  }
  if (input.msg_start_id > input.msg_end_id) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "msg_start_id must be <= msg_end_id",
    );
  }
  const level = input.level ?? 1;
  if (level < 1 || level > 10) {
    throw new QoopiaError("INVALID_INPUT", "level must be between 1 and 10");
  }

  assertNoSecrets(input.content, "summary.content");
  // A summary is derived session content, so it follows the same policy as the messages.
  assertAutomaticMemoryAllowed(input.workspace_id, input.agent_id);

  const sess = db
    .prepare(
      `SELECT id, agent_id FROM sessions WHERE id = ? AND workspace_id = ?`,
    )
    .get(input.session_id, input.workspace_id) as { id: string; agent_id: string } | undefined;
  if (!sess) {
    throw new QoopiaError("NOT_FOUND", `session ${input.session_id} not found`);
  }
  // C3 fix: enforce agent ownership for summarize
  if (sess.agent_id !== input.agent_id) {
    throw new QoopiaError("FORBIDDEN", `session ${input.session_id} belongs to another agent`);
  }

  // H4 fix: validate that boundary messages belong to this session
  const startMsg = db
    .prepare(`SELECT id FROM session_messages WHERE id = ? AND session_id = ?`)
    .get(input.msg_start_id, input.session_id) as { id: number } | undefined;
  const endMsg = db
    .prepare(`SELECT id FROM session_messages WHERE id = ? AND session_id = ?`)
    .get(input.msg_end_id, input.session_id) as { id: number } | undefined;
  if (!startMsg) {
    throw new QoopiaError("INVALID_INPUT", `msg_start_id ${input.msg_start_id} not found in session`);
  }
  if (!endMsg) {
    throw new QoopiaError("INVALID_INPUT", `msg_end_id ${input.msg_end_id} not found in session`);
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO summaries
      (id, workspace_id, session_id, agent_id, content, msg_start_id, msg_end_id, level, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.session_id,
    input.agent_id,
    input.content,
    input.msg_start_id,
    input.msg_end_id,
    level,
    input.token_count ?? null,
    nowIso(),
  );
  return {
    saved: true,
    summary_id: id,
    range: `${input.msg_start_id}-${input.msg_end_id}`,
    level,
  };
}

export function sessionExpand(p: {
  workspace_id: string;
  agent_id: string;
  start_id: number;
  end_id: number;
  session_id?: string;
}) {
  if (p.start_id > p.end_id) {
    throw new QoopiaError("INVALID_INPUT", "start_id must be <= end_id");
  }
  const where: string[] = [`workspace_id = ?`, `id BETWEEN ? AND ?`];
  const params: any[] = [p.workspace_id, p.start_id, p.end_id];
  // H2 fix: filter by agent_id to prevent cross-agent transcript reads
  where.push(`agent_id = ?`);
  params.push(p.agent_id);
  if (p.session_id) {
    where.push(`session_id = ?`);
    params.push(p.session_id);
  }
  const rows = db
    .prepare(
      `SELECT id, session_id, agent_id, role, content, metadata, token_count, created_at
       FROM session_messages WHERE ${where.join(" AND ")} ORDER BY id ASC`,
    )
    .all(...params) as Array<{
    id: number;
    session_id: string;
    agent_id: string | null;
    role: string;
    content: string;
    metadata: string;
    token_count: number | null;
    created_at: string;
  }>;
  const tokens = rows.reduce(
    (s, r) => s + Math.ceil(r.content.length / 4),
    0,
  );
  return {
    messages: rows.map((r) => ({
      ...r,
      metadata: safeJsonParse(r.metadata, {} as Record<string, unknown>),
    })),
    count: rows.length,
    cost: { tokens_returned: tokens },
  };
}
