import { opsSummary } from "./delivery/ops-state.ts";
import { inspectScheduledBackups } from "./delivery/doctor-checks.ts";
/**
 * Dashboard HTTP API: the read models the dashboard renders, plus the owner
 * writes it makes (login/logout, memory policy and save requests, V4 review).
 * The route table is handleDashboardApi below.
 *
 * Who the caller is (cookie format, HMAC, origin allowlist, the authorization
 * model) lives in dashboard-session.ts. In short: the steward and the owner
 * see the workspace, other agents follow their shared-context toggle (ADR-020),
 * and any other type, ingest-daemon included, gets 401.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "./db/connection.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { sha256Hex } from "./auth/api-keys.ts";
import { env } from "./utils/env.ts";
import { getV4FeatureFlags } from "./utils/health-metadata.ts";
import { fileListFolders, fileListByFolder, fileGetForDownload } from "./services/files.ts";
import { recall } from "./services/recall.ts";
import { analyzeFtsQuery, buildFtsMatch } from "./services/fts-query.ts";
import { logger } from "./utils/logger.ts";
import { getSupersedeChain } from "./services/note-relations.ts";
import { confirmMemory, getMemoryLifecycle, setMemoryPin } from "./services/memory-lifecycle.ts";
import { listExtractionRuns, getExtractionRun, reviewExtractionCandidate } from "./services/extraction.ts";
import { recordRecallFeedback } from "./services/recall-feedback.ts";
import { assertNoSecrets } from "./utils/secret-guard.ts";
import { assignmentReadiness, compatibility, type Assignment } from "./skills/loop.ts";
import { ADMIN_TYPES, levelOf, seesWholeWorkspace, sharesContext, visibleRowSql } from "./auth/principal.ts";
import { attachmentDisposition, json, readRequestBody, RequestBodyError } from "./utils/http-json.ts";
import { agentMemoryStatus, canManagePolicy, setMemoryPolicy, type MemoryMode } from "./services/memory-policy.ts";
import { setSharedContext } from "./admin/agents.ts";
import { decideSaveRequest, listSaveRequests } from "./services/memory-save-requests.ts";
import { agentContractFor } from "./api/agent-contract.ts";
import { authorityOperations } from "./api/authority.ts";
import { QoopiaError } from "./utils/errors.ts";
import {
  ALLOWED_TYPES,
  DashboardAuth,
  SESSION_TTL_SEC,
  authFromSessionCookie,
  buffersEqualConstantTime,
  buildClearCookie,
  buildSessionCookie,
  checkDashboardAuth,
  originAllowed,
  signSession,
} from "./dashboard-session.ts";
export {
  checkDashboardAuth,
  dashboardMutationAllowed,
  dashboardOriginDiagnostics,
  isHttps,
  localOwnerLoginHandler,
  originAllowed,
  ownerIdentityEnabled,
  ownerIdentityRequestAllowed,
  renewLocalOwnerSession,
} from "./dashboard-session.ts";
export type { DashboardAuth } from "./dashboard-session.ts";


function loginHandler(req: IncomingMessage, res: ServerResponse) {
  if (!originAllowed(req)) {
    json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed for /api/dashboard/login.",
    });
    return;
  }
  const header = (req.headers["authorization"] as string | undefined) || "";
  if (!header) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Login requires Authorization: Bearer <agent_api_key> of an owner, steward or agent.",
    });
    return;
  }

  // Resolve the Bearer directly so we can inspect `auth.source`.
  // checkDashboardAuth() collapses source down to a DashboardAuth, which
  // would let an OAuth access token mint a one-year cookie — explicitly
  // rejected here.
  const fetchReq = new Request("http://local/", {
    headers: { authorization: header },
  });
  const auth = authenticate(fetchReq);
  if (!auth) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Bearer token rejected (unknown, inactive, or wrong agent type).",
    });
    return;
  }
  if (auth.source !== "api-key") {
    // Do NOT issue Set-Cookie. Do NOT echo the source back in the body
    // either (don't help an attacker fingerprint the token type).
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Dashboard cookie can only be minted from a static agent api_key. OAuth access tokens are not accepted at this endpoint.",
    });
    return;
  }
  if (!ALLOWED_TYPES.has(auth.type)) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Bearer token rejected (unknown, inactive, or wrong agent type).",
    });
    return;
  }
  const dashAuth: DashboardAuth = {
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    type: auth.type,
    isAdmin: ADMIN_TYPES.has(auth.type),
    source: auth.source,
  };
  // QDASHCOOKIE-005: read api_key_hash AND session_version in one SELECT,
  // then constant-time-compare the row's hash to sha256(presented bearer).
  // This binds the cookie's `sv` snapshot to the *exact* api_key_hash the
  // client just proved possession of. If rotateAgentKey() commits between
  // authenticate() above and this read, the row will carry the new hash and
  // the new sv together — the hash compare fails and we 401, instead of
  // signing a cookie with the post-rotation sv from a pre-rotation auth.
  const bearer = header.trim().replace(/^Bearer\s+/i, "").trim();
  const presentedHashHex = sha256Hex(bearer);
  const presentedHashBuf = Buffer.from(presentedHashHex, "hex");
  const snapshotRow = db
    .prepare(
      `SELECT api_key_hash, session_version
         FROM agents
        WHERE id = ? AND active = 1`,
    )
    .get(dashAuth.agent_id) as
    | { api_key_hash: string; session_version: number }
    | undefined;
  if (!snapshotRow) {
    json(res, 401, {
      error: "unauthorized",
      error_description: "Agent record disappeared between auth and login.",
    });
    return;
  }
  const rowHashBuf = Buffer.from(snapshotRow.api_key_hash, "hex");
  if (
    presentedHashBuf.length !== 32 ||
    rowHashBuf.length !== 32 ||
    !buffersEqualConstantTime(presentedHashBuf, rowHashBuf)
  ) {
    // The api_key was rotated mid-flight (row.api_key_hash changed between
    // authenticate() and this re-check). Refuse to mint the cookie — the
    // client must re-login with the new key. The bumped session_version
    // would also kill any cookie we did mint, but we'd rather not mint
    // one at all than rely on the second-line defense.
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Bearer token rejected (unknown, inactive, or wrong agent type).",
    });
    return;
  }
  const cookie = buildSessionCookie(
    req,
    signSession(dashAuth.agent_id, snapshotRow.session_version),
  );
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "set-cookie": cookie,
  });
  res.end(
    JSON.stringify({
      ok: true,
      agent_id: dashAuth.agent_id,
      type: dashAuth.type,
      isAdmin: dashAuth.isAdmin,
      expires_in: SESSION_TTL_SEC,
    }),
  );
}

/**
 * POST /api/dashboard/logout — clears the session cookie AND, when the
 * caller presented a verifiable cookie, bumps that agent's
 * `session_version` so any pre-logout copy of the cookie fails the sv
 * check on its next request (server-side revocation).
 *
 * QSA-E / Codex QSA-005 (2026-04-28): the prior implementation only
 * cleared the browser's cookie copy. A copy of the cookie made before
 * logout (e.g. exfiltrated via XSS or a malicious extension) remained
 * valid until expiry / api_key rotation / agent deactivation /
 * session-secret rotation. With this change, a single logout call
 * revokes every outstanding cookie for that agent immediately.
 *
 * Behavior:
 *   - Origin guard still applies (cross-site form submission blocked).
 *   - If the request carries a cookie that we can verify
 *     (signature ok, agent active, sv matches), bump session_version.
 *     The bumped value invalidates the cookie we just verified, plus
 *     any other copy in flight.
 *   - If the cookie is missing, tampered, expired, or already revoked,
 *     we cannot identify the agent and skip the bump. The browser
 *     cookie is still cleared — logout remains idempotent and a 200.
 *   - Unauthenticated by design: an attacker who can replay a valid
 *     cookie to /logout can log the owner out, but that was already
 *     true and is the whole point of revocation.
 */
function logoutHandler(req: IncomingMessage, res: ServerResponse) {
  // Logout reads only the cookie, so it always needs the header a no-cors request cannot send.
  if (!originAllowed(req) || req.headers["x-qoopia-csrf"] !== "1") {
    json(res, 403, {
      error: "forbidden",
      error_description: "Same-origin dashboard request required for /api/dashboard/logout.",
    });
    return;
  }

  const auth = authFromSessionCookie(req);
  if (auth) {
    db.prepare(
      `UPDATE agents SET session_version = session_version + 1 WHERE id = ?`,
    ).run(auth.agent_id);
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "set-cookie": buildClearCookie(req),
  });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * ADR-020: another agent's dashboard data needs the steward/owner role or the
 * caller's shared-context toggle. Returns true if the request should be denied
 * (403 already written). Private notes are filtered per query (visibleRowSql).
 */
function denyIfNotOwn(
  res: ServerResponse,
  auth: DashboardAuth,
  requestedAgentId: string,
): boolean {
  if (requestedAgentId === auth.agent_id || levelOf(auth) > 0) return false;
  json(res, 403, {
    error: "forbidden",
    error_description:
      "This agent reads only its own dashboard data; the owner can turn its shared context on.",
  });
  return true;
}

// Re-export for any internal callers that imported the old AuthContext.
export type { AuthContext };

// ---- /api/dashboard/agents ----
function listAgents(res: ServerResponse, auth: DashboardAuth) {
  // ADR-020: without shared context an agent sees only itself.
  const all = levelOf(auth) > 0;
  const sql = all
    ? `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ?
       ORDER BY name ASC`
    : `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ? AND id = ?
       ORDER BY name ASC`;
  const args: string[] = all
    ? [auth.workspace_id]
    : [auth.workspace_id, auth.agent_id];
  const rows = db.prepare(sql).all(...args) as Array<{
    id: string;
    workspace_id: string;
    name: string;
    type: string;
    active: number;
    last_seen: string | null;
    created_at: string;
  }>;

  const countSessions = db.prepare(
    `SELECT COUNT(*) as c FROM sessions WHERE agent_id = ?`,
  );
  // Only the notes the viewer may read: a sibling's private note is not counted (ADR-020).
  const countNotes = db.prepare(
    `SELECT COUNT(*) as c FROM notes WHERE agent_id = ? AND deleted_at IS NULL AND ${visibleRowSql()}`,
  );
  const level = levelOf(auth);
  const countMessages = db.prepare(
    `SELECT COUNT(*) as c FROM session_messages WHERE agent_id = ?`,
  );
  const lastSession = db.prepare(
    `SELECT id, last_active FROM sessions
     WHERE agent_id = ?
     ORDER BY last_active DESC LIMIT 1`,
  );

  const owner = canManagePolicy(auth.workspace_id, auth.agent_id);
  const items = rows.map((a) => {
    const memory = agentMemoryStatus(auth.workspace_id, a.id);
    const sharedContext = seesWholeWorkspace(a) ? null : sharesContext(a.id);
    const s = countSessions.get(a.id) as { c: number };
    const n = countNotes.get(a.id, auth.agent_id, level) as { c: number };
    const m = countMessages.get(a.id) as { c: number };
    const last = lastSession.get(a.id) as
      | { id: string; last_active: string }
      | undefined;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      workspace_id: a.workspace_id,
      created_at: a.created_at,
      last_seen: a.last_seen,
      sessions_count: s.c,
      notes_count: n.c,
      messages_count: m.c,
      last_session_id: last?.id ?? null,
      last_session_active: last?.last_active ?? null,
      memory,
      // ADR-020: null for the steward and the owner, who always read the whole workspace.
      shared_context: sharedContext,
      can_switch_shared_context: owner && sharedContext !== null,
    };
  });

  return json(res, 200, { items, total: items.length });
}

// ---- /api/dashboard/agents/:agent_id/sessions ----
function listSessions(
  res: ServerResponse,
  auth: DashboardAuth,
  agentId: string,
  limit = 100,
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  const rows = db
    .prepare(
      `SELECT s.id, s.workspace_id, s.agent_id, s.title, s.metadata,
              s.created_at, s.last_active,
              (SELECT COUNT(*) FROM session_messages WHERE session_id = s.id) as message_count
       FROM sessions s
       WHERE s.agent_id = ? AND s.workspace_id = ?
       ORDER BY s.last_active DESC
       LIMIT ?`,
    )
    .all(agentId, workspaceId, Math.min(Math.max(limit, 1), 500)) as Array<{
    id: string;
    workspace_id: string;
    agent_id: string;
    title: string | null;
    metadata: string;
    created_at: string;
    last_active: string;
    message_count: number;
  }>;

  const items = rows.map((r) => ({
    id: r.id,
    title: r.title,
    metadata: safeJson(r.metadata),
    created_at: r.created_at,
    last_active: r.last_active,
    message_count: r.message_count,
  }));

  return json(res, 200, { items, total: items.length, agent_id: agentId });
}

// ---- /api/dashboard/sessions/:session_id/messages ----
function sessionMessages(
  res: ServerResponse,
  auth: DashboardAuth,
  sessionId: string,
  limit = 500,
) {
  const workspaceId = auth.workspace_id;
  const sess = db
    .prepare(
      `SELECT id, agent_id, workspace_id, title, created_at, last_active
       FROM sessions WHERE id = ? AND workspace_id = ?`,
    )
    .get(sessionId, workspaceId) as
    | {
        id: string;
        agent_id: string;
        workspace_id: string;
        title: string | null;
        created_at: string;
        last_active: string;
      }
    | undefined;
  if (!sess) return json(res, 404, { error: "session_not_found" });
  // Non-admin: session must belong to the authenticated agent.
  if (denyIfNotOwn(res, auth, sess.agent_id)) return;

  const rows = db
    .prepare(
      `SELECT id, role, content, metadata, token_count, created_at
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(sessionId, Math.min(Math.max(limit, 1), 2000)) as Array<{
    id: number;
    role: string;
    content: string;
    metadata: string;
    token_count: number | null;
    created_at: string;
  }>;

  const summaries = db
    .prepare(
      `SELECT id, content, msg_start_id, msg_end_id, level, created_at
       FROM summaries WHERE session_id = ?
       ORDER BY msg_start_id ASC`,
    )
    .all(sessionId);

  return json(res, 200, {
    session: sess,
    messages: rows.map((r) => ({
      ...r,
      metadata: safeJson(r.metadata),
    })),
    summaries,
    total: rows.length,
  });
}

// ---- /api/dashboard/agents/:agent_id/notes ----
function listNotesByAgent(
  res: ServerResponse,
  auth: DashboardAuth,
  agentId: string,
  type: string | null,
  limit = 200,
  before: string | null = null,
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  const visible = [auth.agent_id, levelOf(auth)];
  const where: string[] = [`agent_id = ?`, `workspace_id = ?`, `deleted_at IS NULL`, visibleRowSql()];
  const params: any[] = [agentId, workspaceId, ...visible];
  if (type) {
    where.push(`type = ?`);
    params.push(type);
  }
  // F-312: older pages follow `next_before`, so every note the badge counts is reachable.
  let cursor: ReturnType<typeof beforeCursor>;
  try {
    cursor = beforeCursor("notes", before);
  } catch {
    return json(res, 400, BAD_CURSOR);
  }
  if (cursor) {
    where.push(cursor.sql);
    params.push(...cursor.params);
  }
  const lim = Math.min(Math.max(limit, 1), 1000);
  const page = db
    .prepare(
      `SELECT id, workspace_id, agent_id, type, text, metadata, tags,
              project_id, task_bound_id, session_id, source,
              created_at, updated_at
       FROM notes
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, lim + 1) as Array<{
    id: string;
    workspace_id: string;
    agent_id: string;
    type: string;
    text: string;
    metadata: string;
    tags: string;
    project_id: string | null;
    task_bound_id: string | null;
    session_id: string | null;
    source: string;
    created_at: string;
    updated_at: string;
  }>;
  const rows = page.slice(0, lim);
  const last = page.length > lim ? rows[rows.length - 1] : undefined;

  // Breakdown by type (all types, not filtered by `type`)
  const typeBreakdown = db
    .prepare(
      `SELECT type, COUNT(*) as c
       FROM notes WHERE agent_id = ? AND workspace_id = ? AND deleted_at IS NULL AND ${visibleRowSql()}
       GROUP BY type ORDER BY c DESC`,
    )
    .all(agentId, workspaceId, ...visible) as Array<{ type: string; c: number }>;

  return json(res, 200, {
    items: rows.map((r) => ({
      ...r,
      metadata: safeJson(r.metadata),
      tags: safeJson(r.tags) ?? [],
    })),
    total: rows.length,
    next_before: last ? `${last.created_at}|${last.id}` : null,
    type_breakdown: typeBreakdown,
    agent_id: agentId,
    filter_type: type,
  });
}

// ---- /api/dashboard/agents/:agent_id/search?q=... ----
function searchMessages(
  res: ServerResponse,
  auth: DashboardAuth,
  agentId: string,
  query: string,
  limit = 50,
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  // Shared FTS5 builder (F-101): operators and unindexable tokens are dropped
  // instead of being required by the AND-join. All words must match, no prefix.
  const cleaned = buildFtsMatch(query, "AND", false);
  if (!cleaned) {
    return json(res, 200, { items: [], total: 0, query });
  }
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
                s.title as session_title
         FROM session_messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.rowid IN (
           SELECT rowid FROM session_messages_fts
           WHERE session_messages_fts MATCH ?
         )
         AND m.agent_id = ? AND m.workspace_id = ?
         ORDER BY m.id DESC
         LIMIT ?`,
      )
      .all(cleaned, agentId, workspaceId, Math.min(Math.max(limit, 1), 200)) as Array<{
      id: number;
      session_id: string;
      role: string;
      content: string;
      created_at: string;
      session_title: string | null;
    }>;
    return json(res, 200, {
      items: rows.map((r) => ({
        ...r,
        // Truncate content to keep response light
        content: r.content.length > 400 ? r.content.slice(0, 400) + "…" : r.content,
      })),
      total: rows.length,
      query,
    });
  } catch (e) {
    // The builder cannot produce FTS5 syntax errors, so this is a server fault; never echo SQLite text.
    logger.error("dashboard message search failed", { error: (e as Error).message });
    return json(res, 500, { error: "search_failed" });
  }
}

/** Up to 300 characters around the first query term, whitespace collapsed: the hit is visible without sending the row. */
function searchExcerpt(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 80) : 0;
  return (start ? "…" : "") + flat.slice(start, start + 300) + (start + 300 < flat.length ? "…" : "");
}

// ---- /api/dashboard/search?q=... — the dashboard's one Search request (F-304) ----
// Messages and notes of every agent the caller may open (the /agents list scope), newest first.
// Each source pages with its own keyset cursor, so a merged page never skips or repeats a row.
function dashboardSearch(
  res: ServerResponse,
  auth: DashboardAuth,
  query: string,
  limit: number,
  messagesBefore: string | null,
  notesBefore: string | null,
) {
  // Every word must match; prefixes, because Search runs while the owner types.
  const match = buildFtsMatch(query, "AND", true);
  if (!match) return json(res, 200, { items: [], next: null, query });
  const lim = clampLimit(limit, 50, 100);
  let mc: ReturnType<typeof beforeCursor>, nc: ReturnType<typeof beforeCursor>;
  try {
    mc = beforeCursor("m", messagesBefore);
    nc = beforeCursor("n", notesBefore);
  } catch {
    return json(res, 400, BAD_CURSOR);
  }
  const level = levelOf(auth);
  const own = level > 0 ? "" : " AND ag.id = ?";
  const ownParams = level > 0 ? [] : [auth.agent_id];
  try {
    const messages = db
      .prepare(
        `SELECT 'message' AS kind, m.id, m.agent_id, ag.name AS agent_name, m.session_id, m.role,
                m.content AS text, m.created_at
         FROM session_messages m
         JOIN agents ag ON ag.id = m.agent_id AND ag.workspace_id = m.workspace_id AND ag.active = 1
         WHERE m.rowid IN (SELECT rowid FROM session_messages_fts WHERE session_messages_fts MATCH ?)
           AND m.workspace_id = ?${own}${mc ? ` AND ${mc.sql}` : ""}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
      )
      .all(match, auth.workspace_id, ...ownParams, ...(mc?.params ?? []), lim + 1) as Array<Record<string, any>>;
    // ponytail: every match is sorted by time (~3 µs a row: 60 ms for 21k matching notes) and a note's
    // first 8,000 characters feed its excerpt (a later match shows the note's start). Rank or pre-limit
    // the FTS rowids if workspaces reach 10^5 matches per word.
    const notes = db
      .prepare(
        `SELECT 'note' AS kind, n.id, n.agent_id, ag.name AS agent_name, n.type,
                substr(n.text, 1, 8000) AS text, n.created_at
         FROM notes_fts f
         JOIN notes n ON n.rowid = f.rowid
         JOIN agents ag ON ag.id = n.agent_id AND ag.workspace_id = n.workspace_id AND ag.active = 1
         WHERE notes_fts MATCH ? AND n.workspace_id = ? AND n.deleted_at IS NULL
           AND ${visibleRowSql("n")}${own}${nc ? ` AND ${nc.sql}` : ""}
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT ?`,
      )
      .all(match, auth.workspace_id, auth.agent_id, level, ...ownParams, ...(nc?.params ?? []), lim + 1) as Array<Record<string, any>>;
    // A stable merge keeps each source in its SQL order, so the page holds a prefix of both.
    const page = [...messages, ...notes]
      .sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))
      .slice(0, lim);
    const cursor = (kind: string, previous: string | null) => {
      const last = page.findLast((r) => r.kind === kind);
      return last ? `${last.created_at}|${last.id}` : previous;
    };
    const terms = analyzeFtsQuery(query).terms;
    return json(res, 200, {
      items: page.map(({ text, ...row }) => ({ ...row, excerpt: searchExcerpt(text, terms) })),
      next: messages.length + notes.length > lim
        ? { messages_before: cursor("message", messagesBefore), notes_before: cursor("note", notesBefore) }
        : null,
      query,
    });
  } catch (e) {
    logger.error("dashboard search failed", { error: (e as Error).message });
    return json(res, 500, { error: "search_failed" });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ============================================================
// Command Center endpoints (CC-001) — additive, read-only, GET-only.
//
// All scoped to auth.workspace_id. The steward and the owner see the whole
// workspace; other agents see their siblings' per-agent tables
// (agents/sessions/messages/notes/activity) and comm traffic only while their
// shared-context toggle is on (ADR-020), otherwise their own slice. Workspace knowledge (entity_pages/skills) is shared, except
// private pages (VISIBLE_PAGE). Every sub-query is wrapped so a single
// failure degrades to null/[] instead of 500-ing the whole response.
// ============================================================

/**
 * Private entity pages (Skillonomia and native-draft imports) are visible only to
 * their authority owner and the workspace owner, as on /api/v1; stewards are not
 * exempt. Unqualified so it fits aliased and unaliased entity_pages queries alike.
 * Bind visiblePageParams(auth).
 */
const VISIBLE_PAGE =
  "(authority_private=0 OR authority_owner_id=? OR EXISTS(SELECT 1 FROM workspace_owners WHERE workspace_id=? AND actor_id=?))";
const visiblePageParams = (auth: DashboardAuth) => [auth.agent_id, auth.workspace_id, auth.agent_id];

/** Tiny try/catch wrapper: run fn, return its value, or the fallback on throw. */
function ccTry<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** COUNT(*) helper. */
function ccCount(table: string, where: string, params: any[]): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as
    | { c: number }
    | undefined;
  return row ? row.c : 0;
}

// ---- /api/dashboard/overview — the System Pulse ----
export function dashboardJourney(auth: DashboardAuth, database = db) {
  if (auth.type !== "owner") return null;
  const workspace = auth.workspace_id;
  const ownerBound = Boolean(database.prepare(
    `SELECT 1 FROM workspace_owners o JOIN agents a ON a.id=o.actor_id AND a.workspace_id=o.workspace_id
      WHERE o.workspace_id=? AND a.active=1 AND a.principal_kind='human' AND a.authority_profile='owner' LIMIT 1`,
  ).get(workspace));
  const connectedAgents = (database.prepare(
    `SELECT COUNT(*) AS count FROM agents WHERE workspace_id=? AND active=1 AND principal_kind='agent'`,
  ).get(workspace) as { count:number }).count;
  const registrations = database.prepare(
    `SELECT id,runtime_kind,runtime_version,platform,reporter_id,managed_root FROM runtime_registrations WHERE workspace_id=?`,
  ).all(workspace) as Array<{runtime_kind:string;runtime_version:string;platform:string;reporter_id:string|null;managed_root:string|null}>;
  const compatibleRuntimes = registrations.filter(runtime => compatibility(runtime.runtime_kind,runtime.runtime_version,runtime.platform).status === "supported").length;
  const runnableRuntimes = registrations.filter(runtime => compatibility(runtime.runtime_kind,runtime.runtime_version,runtime.platform).status === "supported" && runtime.reporter_id && runtime.managed_root).length;
  const assignments = database.prepare("SELECT * FROM skill_assignments WHERE workspace_id=?").all(workspace) as Assignment[];
  const activeAssignments = assignments.filter(assignment => assignmentReadiness(database,assignment).ready).length;
  const runs = (database.prepare("SELECT COUNT(*) AS count FROM skill_runs WHERE workspace_id=?").get(workspace) as {count:number}).count;
  const outcomes = (database.prepare("SELECT COUNT(*) AS count FROM skill_outcomes WHERE workspace_id=?").get(workspace) as {count:number}).count;
  return { owner_bound:ownerBound, connected_agents:connectedAgents, compatible_runtimes:compatibleRuntimes,
    runnable_runtimes:runnableRuntimes, active_assignments:activeAssignments, runs, outcomes };
}
function ccOverview(res: ServerResponse, auth: DashboardAuth) {
  const ws = auth.workspace_id;
  // ADR-020: counts cover the agents whose context the caller reads, AgentComm included.
  const level = levelOf(auth);
  const admin = level > 0;
  const aid = auth.agent_id;
  const now = Date.now();
  const since24 = new Date(now - 86400000).toISOString();
  const since10m = new Date(now - 600000).toISOString();
  const since90s = new Date(now - 90000).toISOString();

  const agents = ccTry(() => {
    const baseW = admin
      ? "active = 1 AND workspace_id = ?"
      : "active = 1 AND workspace_id = ? AND id = ?";
    const baseP: any[] = admin ? [ws] : [ws, aid];
    const g = (extra: string, ...ep: any[]) =>
      ccCount("agents", baseW + extra, [...baseP, ...ep]);
    return {
      total_active: g(""),
      live_now: g(" AND last_seen >= ?", since90s),
      recent: g(" AND last_seen >= ?", since10m),
      by_type: db
        .prepare(`SELECT type, COUNT(*) AS c FROM agents WHERE ${baseW} GROUP BY type ORDER BY c DESC`)
        .all(...baseP),
    };
  }, null as any);

  const af = admin ? "" : " AND agent_id = ?";
  const ap: any[] = admin ? [] : [aid];

  const sessions = ccTry(() => ({
    total: ccCount("sessions", `workspace_id = ?${af}`, [ws, ...ap]),
    last_24h: ccCount("sessions", `workspace_id = ?${af} AND created_at >= ?`, [ws, ...ap, since24]),
  }), null as any);

  const messages = ccTry(() => ({
    total: ccCount("session_messages", `workspace_id = ?${af}`, [ws, ...ap]),
    last_24h: ccCount("session_messages", `workspace_id = ?${af} AND created_at >= ?`, [ws, ...ap, since24]),
  }), null as any);

  // Notes the caller may read: a sibling's private note is not counted.
  const notes = ccTry(() => ({
    total: ccCount("notes", `workspace_id = ? AND deleted_at IS NULL AND ${visibleRowSql()}`, [ws, aid, level]),
    by_type: db
      .prepare(
        `SELECT type, COUNT(*) AS c FROM notes WHERE workspace_id = ? AND deleted_at IS NULL AND ${visibleRowSql()} GROUP BY type ORDER BY c DESC LIMIT 8`,
      )
      .all(ws, aid, level),
  }), null as any);

  const visible = visiblePageParams(auth);
  const entities = ccTry(() => ({
    total: ccCount("entity_pages", `workspace_id = ? AND ${VISIBLE_PAGE}`, [ws, ...visible]),
    by_type: db
      .prepare(`SELECT type, COUNT(*) AS c FROM entity_pages WHERE workspace_id = ? AND ${VISIBLE_PAGE} GROUP BY type ORDER BY c DESC`)
      .all(ws, ...visible),
  }), null as any);

  const skills = ccTry(() => {
    const total = ccCount("entity_pages", `workspace_id = ? AND type = 'skill' AND ${VISIBLE_PAGE}`, [ws, ...visible]);
    const rows = db
      .prepare(`SELECT metadata, status FROM entity_pages WHERE workspace_id = ? AND type = 'skill' AND ${VISIBLE_PAGE}`)
      .all(ws, ...visible) as Array<{ metadata: string; status: string }>;
    let tested = 0;
    for (const r of rows) {
      try {
        const m = JSON.parse(r.metadata || "{}");
        if (m && (m.tested === true || m.tested === "true")) tested++;
      } catch {
        /* ignore unparseable metadata */
      }
    }
    return { total, tested };
  }, null as any);

  const comm = ccTry(() => {
    const mf = admin ? "" : " AND (sender_agent_id = ? OR recipient_agent_id = ?)";
    const mp: any[] = admin ? [] : [aid, aid];
    const wf = admin ? "" : " AND target_agent_id = ?";
    const wp: any[] = admin ? [] : [aid];
    return {
      open_sessions: ccCount("agent_comm_sessions", "workspace_id = ? AND status = 'open'", [ws]),
      messages_24h: ccCount(
        "agent_comm_messages",
        `workspace_id = ?${mf} AND created_at >= ?`,
        [ws, ...mp, since24],
      ),
      undelivered: ccCount(
        "agent_wake_events",
        `workspace_id = ?${wf} AND delivered_at IS NULL`,
        [ws, ...wp],
      ),
      wakes_24h: ccCount(
        "agent_wake_events",
        `workspace_id = ?${wf} AND created_at >= ?`,
        [ws, ...wp, since24],
      ),
    };
  }, null as any);

  const activity = ccTry(() => ({
    last_24h: ccCount(
      "activity",
      `workspace_id = ? AND ${visibleRowSql()} AND created_at >= ?`,
      [ws, aid, level, since24],
    ),
  }), null as any);

  const health = (() => {
    let schema_version: number | null = null;
    try {
      const r = db.prepare(`SELECT MAX(version) AS v FROM schema_versions`).get() as
        | { v: number }
        | undefined;
      schema_version = r ? r.v : null;
    } catch {
      /* ignore */
    }
    const backup = auth.isAdmin ? ccTry(() => {
      const instance = db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string} | null;
      return instance ? inspectScheduledBackups(env.BACKUP_DIR, instance.instance_id) : { status: 'unknown' };
    }, {status:'unknown'}) : {status:'owner_only'};
    return {
      schema_version,
      recall_mode: process.env.QOOPIA_RECALL_MODE || "hybrid",
      uptime_seconds: Math.floor(process.uptime()),
      last_backup: null, // Legacy filename/mtime is not verification evidence.
      verified_backup: auth.isAdmin ? backup : { status: 'owner_only' },
      operations: auth.isAdmin ? opsSummary(env.OPS_STATE_DIR) : { status: 'owner_only' },
      embed_endpoint: process.env.QOOPIA_EMBED_ENDPOINT || null,
      now: new Date().toISOString(),
    };
  })();

  return json(res, 200, {
    agents,
    sessions,
    messages,
    notes,
    entities,
    skills,
    comm,
    activity,
    health,
    journey: dashboardJourney(auth),
    scope: admin ? "workspace" : "agent",
  });
}

/**
 * Keyset cursor `created_at|id` for pages ordered by (created_at DESC, id DESC):
 * created_at alone is per-second, so a page edge inside a busy second would skip
 * its siblings forever. A bare timestamp from an older dashboard tab still works
 * as a plain bound; a malformed composite cursor throws (the caller answers 400).
 */
function beforeCursor(alias: string, before: string | null): { sql: string; params: string[] } | null {
  const raw = before?.trim();
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length === 1) return { sql: `${alias}.created_at < ?`, params: [raw] };
  const [at, id] = parts;
  if (parts.length !== 2 || !at || !id) throw new Error("bad cursor");
  return { sql: `(${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`, params: [at, at, id] };
}

const BAD_CURSOR = { error: "bad_request", error_description: "`before` is not a cursor this endpoint returned." };

// ---- /api/dashboard/activity — live activity feed ----
function ccActivity(
  res: ServerResponse,
  auth: DashboardAuth,
  limit: number,
  before: string | null,
) {
  const ws = auth.workspace_id;
  const lim = Math.min(Math.max(limit || 100, 1), 500);
  // ADR-020: siblings' rows with shared context, never the rows of their private notes.
  const where: string[] = ["a.workspace_id = ?", visibleRowSql("a")];
  const params: any[] = [ws, auth.agent_id, levelOf(auth)];
  let cursor: ReturnType<typeof beforeCursor>;
  try {
    cursor = beforeCursor("a", before);
  } catch {
    return json(res, 400, BAD_CURSOR);
  }
  if (cursor) {
    where.push(cursor.sql);
    params.push(...cursor.params);
  }
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary,
                a.agent_id, ag.name AS agent_name, a.created_at, a.origin_host
         FROM activity a
         LEFT JOIN agents ag ON ag.id = a.agent_id
         WHERE ${where.join(" AND ")}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ?`,
      )
      .all(...params, lim) as any[];
    return json(res, 200, {
      items: rows,
      total: rows.length,
      next_before: rows.length ? `${rows[rows.length - 1].created_at}|${rows[rows.length - 1].id}` : null,
    });
  } catch (e) {
    logger.error("dashboard list failed", { error: (e as Error).message });
    return json(res, 200, { items: [], total: 0, next_before: null, error: "query_failed" });
  }
}

// ============================================================
// AgentComm reader (AC-READ-001) — additive, read-only, GET-only.
//
// Two levels, mirroring a messenger:
//   • /api/dashboard/agentcomm/threads — one row per agent PAIR,
//   • /api/dashboard/agentcomm/thread  — the full transcript of one pair.
//
// Scope (ADR-020): the steward, the owner and an agent whose shared-context
// toggle is on read every conversation of the workspace; an agent with the
// toggle off only those it is a party to. Sending stays with participants.
//
// Message bodies are returned VERBATIM — no truncation, no ellipsis. The
// owner requirement is to read messages in full; volume is bounded by
// date-cursor pagination instead.
// ============================================================

/** Stable, order-independent key for an agent pair. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function clampLimit(raw: number, fallback: number, max: number): number {
  const n = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.min(Math.max(n || fallback, 1), max);
}

/** One direction of a pair, newest first: an index probe on (workspace_id, recipient_agent_id). */
const acDirectionSql = (cols: string, extra: string) =>
  `SELECT ${cols} FROM agent_comm_messages m
   WHERE m.workspace_id = ? AND m.sender_agent_id = ? AND m.recipient_agent_id = ?${extra}
   ORDER BY m.created_at DESC, m.id DESC LIMIT ?`;

/**
 * F-272: newest messages of an agent pair as a UNION of the two directions.
 * An OR of both directions plans as a scan of the whole workspace plus a sort.
 * UNION (not ALL) keeps a self-addressed pair (a = b) free of duplicates.
 */
export const acPairSql = (cols: string, extra = "") =>
  `SELECT * FROM (${acDirectionSql(cols, extra)})
   UNION SELECT * FROM (${acDirectionSql(cols, extra)})
   ORDER BY created_at DESC, id DESC LIMIT ?`;

export const acPairParams = (ws: string, a: string, b: string, extra: string[], limit: number) =>
  [ws, a, b, ...extra, limit, ws, b, a, ...extra, limit, limit];

// ---- /api/dashboard/agentcomm/threads — one row per agent pair ----
function acThreads(res: ServerResponse, auth: DashboardAuth, limit: number) {
  const ws = auth.workspace_id;
  const admin = levelOf(auth) > 0;
  const aid = auth.agent_id;
  const lim = clampLimit(limit, 100, 300);

  const scope = admin ? "" : " AND (m.sender_agent_id = ? OR m.recipient_agent_id = ?)";
  const scopeParams: string[] = admin ? [] : [aid, aid];

  const rows = ccTry(
    () =>
      db
        .prepare(
          `SELECT
             CASE WHEN m.sender_agent_id < m.recipient_agent_id
                  THEN m.sender_agent_id ELSE m.recipient_agent_id END AS agent_a_id,
             CASE WHEN m.sender_agent_id < m.recipient_agent_id
                  THEN m.recipient_agent_id ELSE m.sender_agent_id END AS agent_b_id,
             COUNT(*) AS message_count,
             MAX(m.created_at) AS last_message_at,
             MIN(m.created_at) AS first_message_at
           FROM agent_comm_messages m
           WHERE m.workspace_id = ?${scope}
           GROUP BY agent_a_id, agent_b_id
           ORDER BY last_message_at DESC
           LIMIT ?`,
        )
        .all(ws, ...scopeParams, lim) as Array<{
        agent_a_id: string;
        agent_b_id: string;
        message_count: number;
        last_message_at: string;
        first_message_at: string;
      }>,
    [] as any[],
  );

  const nameOf = db.prepare(`SELECT name FROM agents WHERE id = ?`);
  const lastOf = db.prepare(acPairSql("m.id, m.sender_agent_id, m.recipient_agent_id, m.kind, m.body, m.created_at"));

  const items = rows.map((r) => {
    const an = ccTry(() => (nameOf.get(r.agent_a_id) as { name: string } | undefined)?.name, undefined);
    const bn = ccTry(() => (nameOf.get(r.agent_b_id) as { name: string } | undefined)?.name, undefined);
    const last = ccTry(
      () =>
        lastOf.get(...acPairParams(ws, r.agent_a_id, r.agent_b_id, [], 1)) as
          | {
              id: string;
              sender_agent_id: string;
              recipient_agent_id: string;
              kind: string;
              body: string;
              created_at: string;
            }
          | undefined,
      undefined,
    );
    return {
      pair_key: pairKey(r.agent_a_id, r.agent_b_id),
      agent_a: { id: r.agent_a_id, name: an ?? null },
      agent_b: { id: r.agent_b_id, name: bn ?? null },
      message_count: r.message_count,
      first_message_at: r.first_message_at,
      last_message_at: r.last_message_at,
      last_message: last
        ? {
            id: last.id,
            sender_agent_id: last.sender_agent_id,
            sender_name:
              last.sender_agent_id === r.agent_a_id ? (an ?? null) : (bn ?? null),
            kind: last.kind,
            // Preview only — the full body is served by /agentcomm/thread.
            preview:
              typeof last.body === "string" && last.body.length > 160
                ? last.body.slice(0, 160)
                : last.body,
            created_at: last.created_at,
          }
        : null,
    };
  });

  return json(res, 200, { items, total: items.length });
}

// ---- /api/dashboard/agentcomm/thread?a=&b= — full transcript of one pair ----
function acThread(
  res: ServerResponse,
  auth: DashboardAuth,
  agentA: string,
  agentB: string,
  limit: number,
  before: string | null,
) {
  if (!agentA || !agentB) {
    return json(res, 400, {
      error: "bad_request",
      error_description: "Both `a` and `b` agent ids are required.",
    });
  }
  // Without shared context an agent reads only threads it is a party to.
  if (auth.agent_id !== agentA && auth.agent_id !== agentB && levelOf(auth) === 0) {
    return json(res, 403, {
      error: "forbidden",
      error_description:
        "This agent reads only its own conversations; the owner can turn its shared context on.",
    });
  }

  const ws = auth.workspace_id;
  const lim = clampLimit(limit, 200, 500);
  let cursor: ReturnType<typeof beforeCursor>;
  try {
    cursor = beforeCursor("m", before);
  } catch {
    return json(res, 400, BAD_CURSOR);
  }

  // Newest-first window so `before` walks backwards through history; the
  // rows are flipped to chronological order for the transcript view.
  const rows = ccTry(
    () =>
      db
        .prepare(
          `SELECT m.id, m.session_id, m.sender_agent_id, m.recipient_agent_id,
                  s.name AS sender_name, r.name AS recipient_name,
                  m.kind, m.body, m.metadata, m.parent_message_id,
                  m.created_at, m.delivered_at,
                  cs.topic AS topic
           FROM (${acPairSql("m.*", cursor ? ` AND ${cursor.sql}` : "")}) m
           LEFT JOIN agents s ON s.id = m.sender_agent_id
           LEFT JOIN agents r ON r.id = m.recipient_agent_id
           LEFT JOIN agent_comm_sessions cs ON cs.id = m.session_id
           ORDER BY m.created_at DESC, m.id DESC`,
        )
        .all(...acPairParams(ws, agentA, agentB, cursor?.params ?? [], lim)) as Array<
        Record<string, any>
      >,
    [] as Array<Record<string, any>>,
  );

  // Bodies are returned in full — deliberately not truncated.
  const messages = rows
    .slice()
    .reverse()
    .map((m) => ({
      id: m.id,
      session_id: m.session_id,
      topic: m.topic ?? null,
      sender_agent_id: m.sender_agent_id,
      sender_name: m.sender_name ?? null,
      recipient_agent_id: m.recipient_agent_id,
      recipient_name: m.recipient_name ?? null,
      kind: m.kind,
      body: m.body,
      parent_message_id: m.parent_message_id ?? null,
      created_at: m.created_at,
      delivered_at: m.delivered_at ?? null,
    }));

  const countDir = db.prepare(
    `SELECT COUNT(*) AS c FROM agent_comm_messages
     WHERE workspace_id = ? AND sender_agent_id = ? AND recipient_agent_id = ?`,
  );
  const dir = (from: string, to: string) => (countDir.get(ws, from, to) as { c: number }).c;
  const total = ccTry(() => dir(agentA, agentB) + (agentA === agentB ? 0 : dir(agentB, agentA)), 0);
  // F-192: the ids come from the query string, so a name is resolved only for an agent of
  // this workspace, or for a federated pair whose thread is stored here.
  const nameOf = (id: string) =>
    ccTry(
      () =>
        (db.prepare(`SELECT name FROM agents WHERE id = ? AND (workspace_id = ? OR ? > 0)`).get(id, ws, total) as
          | { name: string }
          | undefined)?.name ?? null,
      null,
    );

  return json(res, 200, {
    pair_key: pairKey(agentA, agentB),
    agent_a: { id: agentA, name: nameOf(agentA) },
    agent_b: { id: agentB, name: nameOf(agentB) },
    total,
    messages,
    // Cursor for the previous (older) page; null when the head is reached.
    has_more: rows.length === lim,
    next_before: rows.length === lim ? `${messages[0]!.created_at}|${messages[0]!.id}` : null,
  });
}

// ---- /api/dashboard/entities — knowledge graph pages ----
function ccEntities(
  res: ServerResponse,
  auth: DashboardAuth,
  type: string | null,
  q: string | null,
  limit: number,
) {
  const ws = auth.workspace_id;
  const lim = Math.min(Math.max(limit || 100, 1), 500);
  const where: string[] = ["e.workspace_id = ?", "e.status != 'archived'", VISIBLE_PAGE];
  const params: any[] = [ws, ...visiblePageParams(auth)];
  if (type) {
    where.push("e.type = ?");
    params.push(type);
  }
  if (q) {
    where.push("(e.title LIKE ? OR e.slug LIKE ? OR e.summary LIKE ?)");
    const like = "%" + q + "%";
    params.push(like, like, like);
  }
  const items = ccTry(
    () =>
      db
        .prepare(
          `SELECT e.id, e.type, e.slug, e.title, e.summary, e.status, e.metadata, e.created_at, e.updated_at,
                  (SELECT COUNT(*) FROM entity_links l
                    WHERE l.source_entity_id = e.id OR l.target_entity_id = e.id) AS link_count
           FROM entity_pages e
           WHERE ${where.join(" AND ")}
           ORDER BY e.updated_at DESC
           LIMIT ?`,
        )
        .all(...params, lim)
        .map((r: any) => ({ ...r, metadata: safeJson(r.metadata) })),
    [] as any[],
  );
  const type_breakdown = ccTry(
    () =>
      db
        .prepare(
          `SELECT type, COUNT(*) AS c FROM entity_pages WHERE workspace_id = ? AND status != 'archived' AND ${VISIBLE_PAGE} GROUP BY type ORDER BY c DESC`,
        )
        .all(ws, ...visiblePageParams(auth)),
    [] as any[],
  );
  return json(res, 200, { items, total: items.length, type_breakdown });
}

// ---- /api/dashboard/skills — skill entity pages ----
function ccSkills(res: ServerResponse, auth: DashboardAuth, limit: number) {
  const ws = auth.workspace_id;
  const lim = Math.min(Math.max(limit || 100, 1), 500);
  try {
    const rows = db
      .prepare(
        `SELECT id, slug, title, summary, status, metadata, created_at, updated_at
         FROM entity_pages
         WHERE workspace_id = ? AND type = 'skill' AND ${VISIBLE_PAGE}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(ws, ...visiblePageParams(auth), lim) as any[];
    return json(res, 200, {
      items: rows.map((r) => ({ ...r, metadata: safeJson(r.metadata) })),
      total: rows.length,
    });
  } catch (e) {
    logger.error("dashboard list failed", { error: (e as Error).message });
    return json(res, 200, { items: [], total: 0, error: "query_failed" });
  }
}

/**
 * Route dispatcher — called from http.ts before the generic 404.
 * Returns true if the request was handled (response sent).
 */
function downloadFileHandler(res: ServerResponse, auth: DashboardAuth, id: string) {
  const f = fileGetForDownload({ workspace_id: auth.workspace_id, id });
  if (!f) {
    json(res, 404, { error: "not_found" });
    return;
  }
  // The stored type is whatever the uploader claimed (text/html included); on the dashboard origin the
  // bytes are served inert, as /api/dashboard/my-agent/file does.
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(f.size),
    "content-disposition": attachmentDisposition(f.filename),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "no-store",
  });
  res.end(f.content);
}

function v4Auth(auth: DashboardAuth): AuthContext {
  const row = db.prepare("SELECT name, tool_profile FROM agents WHERE workspace_id = ? AND id = ?")
    .get(auth.workspace_id, auth.agent_id) as { name: string; tool_profile: string } | undefined;
  if (!row) throw new Error("dashboard agent disappeared");
  return {
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    agent_name: row.name,
    type: auth.type,
    source: auth.source === "oauth" ? "oauth" : "api-key",
    tool_profile: row.tool_profile,
    granted_scope: auth.source === "oauth" ? auth.granted_scope ?? [] : undefined,
  };
}

function requireV4Admin(res: ServerResponse, auth: DashboardAuth): boolean {
  // F-169: owner/steward only, as the P07 route matrix and trace contract say.
  if (auth.type === "owner" || auth.type === "steward") return true;
  json(res, 403, { error: "forbidden", error_description: "V4 review dashboard requires owner/steward capability" });
  return false;
}

function requireV4Feature(name: string): void {
  if (process.env[name] === "true") return;
  const error = new Error(`${name} is disabled`) as Error & { code: string };
  error.code = "FEATURE_DISABLED";
  throw error;
}

async function readDashboardJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req, 64 * 1024);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new QoopiaError("INVALID_INPUT", "invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new QoopiaError("INVALID_INPUT", "invalid_json_object");
  return parsed as Record<string, unknown>;
}

function dashboardV4State(res: ServerResponse, auth: DashboardAuth) {
  const serviceAuth = v4Auth(auth);
  const runs = listExtractionRuns({ auth: serviceAuth, limit: 50 });
  const extraction = runs.items.map((run: any) => getExtractionRun({ auth: serviceAuth, run_id: run.id }));
  const traces = db.prepare(
    `SELECT id, query_hash, mode, options, pipeline_version, duration_ms,
            result_count, created_at, expires_at
       FROM recall_traces WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).all(auth.workspace_id);
  const relations = db.prepare(
    `SELECT id, source_note_id, target_note_id, relation_type, created_at
       FROM note_relations WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`,
  ).all(auth.workspace_id);
  const lifecycleRows = db.prepare(
    `SELECT l.note_id, l.last_recalled_at, l.recall_count, l.last_confirmed_at,
            l.confirmation_count, l.owner_pinned, l.updated_at,
            n.type, n.tags
       FROM memory_lifecycle l JOIN notes n
         ON n.id = l.note_id AND n.workspace_id = l.workspace_id
      WHERE l.workspace_id = ? AND n.deleted_at IS NULL
      ORDER BY l.updated_at DESC, l.note_id ASC LIMIT 100`,
  ).all(auth.workspace_id) as Array<Record<string, unknown> & { note_id: string }>;
  const lifecycle = lifecycleRows.map((row) => {
    const detail = getMemoryLifecycle({ auth: serviceAuth, note_id: row.note_id });
    return { ...row, protected_reason: detail.protected_reason };
  });
  const feedback = db.prepare(
    `SELECT id, note_id, trace_id, feedback, reason_code, created_at
       FROM recall_feedback WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`,
  ).all(auth.workspace_id);
  const schema = db.prepare("SELECT MAX(version) AS version FROM schema_versions").get() as { version: number };
  json(res, 200, {
    feature_flags: getV4FeatureFlags(),
    traces,
    relations,
    conflicts: (relations as any[]).filter((row) => row.relation_type === "conflicts_with"),
    extraction,
    lifecycle,
    feedback,
    runtime_acceptance: { status: "deferred_to_p10", evidence: [] },
    operations: {
      schema_version: schema.version,
      transfer: {
        label: "Complete V1 installation backup and new-machine restore (local OS owner only)",
        backup: "qoopia backup --out ABSOLUTE_DIRECTORY --commit",
        restore_new_machine: "qoopia restore --new-machine --backup ABSOLUTE_DIRECTORY --commit",
        approval: "Both operations preview without --commit; the local OS owner must explicitly add --commit to apply.",
      },
      legacy_schema_32_workspace_export: schema.version === 32 ? "available_via_mcp_admin_tools" : "unsupported_and_omitted",
      production_apply_controls: false,
    }
  });
}

/** The same owner-only change the MCP command makes; the dashboard is just another way in. */
/** Owner writes about an agent's memory: same-origin, CSRF header, and a real owner session. */
async function memoryOwnerPost(req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, act: (body: Record<string, unknown>) => unknown) {
  if (!originAllowed(req) || req.headers["x-qoopia-csrf"] !== "1")
    return json(res, 403, { error: "forbidden", error_description: "Origin and X-Qoopia-CSRF are required" });
  if (auth.source === "oauth")
    return json(res, 403, { error: "forbidden", error_description: "Changing a memory policy requires an owner dashboard session" });
  try {
    return json(res, 200, act(await readDashboardJson(req)));
  } catch (error) {
    if (error instanceof RequestBodyError) return json(res, error.status, { error: error.message });
    const code = error instanceof QoopiaError ? error.code : "INTERNAL";
    const status = { FORBIDDEN: 403, NOT_FOUND: 404, STALE_REVISION: 409, CONFLICT: 409, EXPIRED: 410, INVALID_INPUT: 400 }[code as string] ?? 500;
    return json(res, status, { error: code.toLowerCase(), error_description: status === 500 ? "Could not complete the memory change" : (error as Error).message });
  }
}

const memoryPolicyPost = (req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, agentId: string) =>
  memoryOwnerPost(req, res, auth, (body) => {
    const policy = setMemoryPolicy({
      workspace_id: auth.workspace_id,
      agent_id: agentId,
      mode: body.mode as MemoryMode,
      actor_id: auth.agent_id,
      expected_revision: typeof body.expected_revision === "number" ? body.expected_revision : undefined,
    });
    return { agent_id: policy.agent_id, name: policy.name, mode: policy.mode, revision: policy.revision };
  });

/** ADR-020: the owner's shared-context toggle next to an agent. The steward switches it over MCP. */
const sharedContextPost = (req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, agentId: string) =>
  memoryOwnerPost(req, res, auth, (body) => {
    if (!canManagePolicy(auth.workspace_id, auth.agent_id))
      throw new QoopiaError("FORBIDDEN", "Only the workspace owner can change shared context in the dashboard");
    return setSharedContext({ workspace_id: auth.workspace_id, agent_id: agentId, enabled: body.enabled as boolean, actor_id: auth.agent_id });
  });

const memorySavePost = (req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, requestId: string) =>
  memoryOwnerPost(req, res, auth, (body) => {
    if (typeof body.accept !== "boolean") throw new QoopiaError("INVALID_INPUT", "accept must be true or false");
    return decideSaveRequest({ workspace_id: auth.workspace_id, actor_id: auth.agent_id, id: requestId, accept: body.accept });
  });

async function dashboardV4Post(req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, path: string) {
  if (!originAllowed(req) || req.headers["x-qoopia-csrf"] !== "1") {
    json(res, 403, { error: "forbidden", error_description: "Origin and X-Qoopia-CSRF are required" });
    return;
  }
  if (auth.source === "oauth") {
    json(res, 403, { error: "forbidden", error_description: "V4 dashboard writes require an API-key-backed cookie" });
    return;
  }
  try {
    const body = await readDashboardJson(req);
    const serviceAuth = v4Auth(auth);
    if (path === "/api/dashboard/v4/recall") {
      const query = String(body.query ?? "").trim();
      if (!query || query.length > 500) throw new Error("query must contain 1..500 characters");
      assertNoSecrets(query, "dashboard.v4.recall.query");
      const result = await recall({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: seesWholeWorkspace(auth),
        query,
        limit: Math.min(Math.max(Number(body.limit ?? 10), 1), 50),
        scope: (body.scope ?? "notes") as any,
        include_archived: body.include_history === true,
        latest_only: body.include_history === true ? false : body.latest_only !== false,
        include_history: body.include_history === true,
        explain: body.explain !== false,
        trace: body.trace === true,
        lifecycle: body.lifecycle === true,
        deep: false,
        deep_llm: false,
      });
      json(res, 200, result);
      return;
    }
    if (path === "/api/dashboard/v4/extraction-review") {
      requireV4Feature("QOOPIA_V4_EXTRACTION");
      const result = reviewExtractionCandidate({
        auth: serviceAuth,
        candidate_id: String(body.candidate_id ?? ""),
        action: String(body.action ?? "") as any,
        expected_version: Number(body.expected_version),
        edited_text: typeof body.edited_text === "string" ? body.edited_text : undefined,
        reason_code: typeof body.reason_code === "string" ? body.reason_code : undefined,
      });
      json(res, 200, result);
      return;
    }
    if (path === "/api/dashboard/v4/feedback") {
      requireV4Feature("QOOPIA_V4_FEEDBACK");
      const result = recordRecallFeedback({
        auth: serviceAuth,
        note_id: String(body.note_id ?? ""),
        trace_id: typeof body.trace_id === "string" ? body.trace_id : undefined,
        feedback: String(body.feedback ?? "") as any,
        reason_code: typeof body.reason_code === "string" ? body.reason_code : undefined,
        idempotency_key: String(body.idempotency_key ?? ""),
      });
      json(res, 200, result);
      return;
    }
    if (path === "/api/dashboard/v4/lifecycle-confirm") {
      requireV4Feature("QOOPIA_V4_LIFECYCLE");
      json(res, 200, confirmMemory({ auth: serviceAuth, note_id: String(body.note_id ?? "") }));
      return;
    }
    if (path === "/api/dashboard/v4/lifecycle-pin") {
      requireV4Feature("QOOPIA_V4_LIFECYCLE");
      if (typeof body.pinned !== "boolean") throw new Error("pinned must be a boolean");
      json(res, 200, setMemoryPin({ auth: serviceAuth, note_id: String(body.note_id ?? ""), pinned: body.pinned }));
      return;
    }
    json(res, 404, { error: "not_found", path });
  } catch (error) {
    if (error instanceof RequestBodyError) return json(res, error.status, { error: error.message });
    const code = typeof error === "object" && error && "code" in error ? String((error as any).code) : "INVALID_INPUT";
    const status = code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    json(res, status, { error: code.toLowerCase(), error_description: error instanceof Error ? error.message : "request failed" });
  }
}

export function handleDashboardApi(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = req.url || "/";
  if (!url.startsWith("/api/dashboard")) return false;
  // Every GET here is a read, so HEAD routes like GET; the runtime drops the body.
  const requested = (req.method || "GET").toUpperCase();
  const method = requested === "HEAD" ? "GET" : requested;
  const u = new URL(url, "http://local");
  // A non-numeric query value falls back to the route default instead of binding NaN into SQL.
  const intParam = (name: string, fallback: number) => {
    const n = Number.parseInt(u.searchParams.get(name) ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const path = u.pathname;

  if (path.startsWith("/api/dashboard/v4/") && process.env.QOOPIA_V4_DASHBOARD !== "true") {
    json(res, 404, { error: "not_found", path });
    return true;
  }

  // Auth POST endpoints — handled before the GET-only gate. They must NOT
  // require a valid session (login is what produces one; logout is idempotent
  // and unauthenticated by design). Origin checks live inside each handler.
  if (path === "/api/dashboard/login") {
    if (method !== "POST") {
      res.setHeader("allow", "POST");
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    loginHandler(req, res);
    return true;
  }
  if (path === "/api/dashboard/logout") {
    if (method !== "POST") {
      res.setHeader("allow", "POST");
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    logoutHandler(req, res);
    return true;
  }

  if (method === "POST" && path.startsWith("/api/dashboard/v4/")) {
    const auth = checkDashboardAuth(req);
    if (!auth) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!requireV4Admin(res, auth)) return true;
    void dashboardV4Post(req, res, auth, path);
    return true;
  }

  // The contract is one agent's answer and costs a pass over the tool registry, so it is read
  // on demand rather than for every row of the agent list.
  const contractRoute = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/contract$/);
  if (method === "GET" && contractRoute) {
    const auth = checkDashboardAuth(req);
    if (!auth) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    const id = decodeURIComponent(contractRoute[1]!);
    if (id !== auth.agent_id && levelOf(auth) === 0) {

      json(res, 403, { error: "forbidden" });
      return true;
    }
    const contract = agentContractFor(db, auth.workspace_id, id, authorityOperations);
    json(res, contract ? 200 : 404, contract ?? { error: "not_found" });
    return true;
  }

  const policyRoute = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/memory-policy$/);
  if (method === "POST" && policyRoute) {
    const auth = checkDashboardAuth(req);
    if (!auth) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    void memoryPolicyPost(req, res, auth, decodeURIComponent(policyRoute[1]!));
    return true;
  }

  const sharedRoute = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/shared-context$/);
  if (method === "POST" && sharedRoute) {
    const auth = checkDashboardAuth(req);
    if (!auth) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    void sharedContextPost(req, res, auth, decodeURIComponent(sharedRoute[1]!));
    return true;
  }

  const saveRoute = path.match(
/^\/api\/dashboard\/memory-saves(?:\/([^/]+))?$/);
  if (saveRoute && (saveRoute[1] ? method === "POST" : method === "GET")) {
    const auth = checkDashboardAuth(req);
    if (!auth) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (saveRoute[1]) void memorySavePost(req, res, auth, decodeURIComponent(saveRoute[1]));
    else {
      // The prepared text is for the owner alone; other dashboard roles see only the count on the card.
      try { json(res, 200, { items: listSaveRequests(auth.workspace_id, auth.agent_id) }); }
      catch { json(res, 403, { error: "forbidden" }); }
    }
    return true;
  }

  if (method !== "GET") {
    res.setHeader("allow", "GET, HEAD");
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const auth = checkDashboardAuth(req);
  if (!auth) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Valid agent Bearer token required (owner, steward or agent)",
    });
    return true;
  }

  if (path === "/api/dashboard/v4/state") {
    if (!requireV4Admin(res, auth)) return true;
    dashboardV4State(res, auth);
    return true;
  }
  if (path === "/api/dashboard/v4/chain") {
    if (!requireV4Admin(res, auth)) return true;
    try {
      json(res, 200, getSupersedeChain({ auth: v4Auth(auth), note_id: u.searchParams.get("note_id") || "" }));
    } catch (error) {
      json(res, 404, { error: "not_found", error_description: error instanceof Error ? error.message : "not found" });
    }
    return true;
  }
  if (path === "/api/dashboard/v4/lifecycle") {
    if (!requireV4Admin(res, auth)) return true;
    try {
      json(res, 200, getMemoryLifecycle({ auth: v4Auth(auth), note_id: u.searchParams.get("note_id") || "" }));
    } catch (error) {
      json(res, 404, { error: "not_found", error_description: error instanceof Error ? error.message : "not found" });
    }
    return true;
  }

  // /api/dashboard/files/folders — folders + counts
  if (path === "/api/dashboard/files/folders") {
    json(res, 200, fileListFolders({ workspace_id: auth.workspace_id }));
    return true;
  }
  // /api/dashboard/files/:id/download — stream bytes
  const fdl = path.match(/^\/api\/dashboard\/files\/([^/]+)\/download$/);
  if (fdl) {
    downloadFileHandler(res, auth, decodeURIComponent(fdl[1]!));
    return true;
  }
  // /api/dashboard/files?folder= — list files
  if (path === "/api/dashboard/files") {
    json(res, 200, fileListByFolder({ workspace_id: auth.workspace_id, folder: u.searchParams.get("folder") || undefined }));
    return true;
  }

  // /api/dashboard/agents
  if (path === "/api/dashboard/agents") {
    listAgents(res, auth);
    return true;
  }

  // /api/dashboard/agents/:agent_id/sessions
  let m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/sessions$/);
  if (m) {
    const limit = intParam("limit", 100);
    listSessions(res, auth, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/notes
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/notes$/);
  if (m) {
    const type = u.searchParams.get("type");
    const limit = intParam("limit", 200);
    listNotesByAgent(res, auth, decodeURIComponent(m[1]!), type, limit, u.searchParams.get("before"));
    return true;
  }

  // /api/dashboard/sessions/:session_id/messages
  m = path.match(/^\/api\/dashboard\/sessions\/([^/]+)\/messages$/);
  if (m) {
    const limit = intParam("limit", 500);
    sessionMessages(res, auth, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/search?q=...
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/search$/);
  if (m) {
    const q = u.searchParams.get("q") || "";
    const limit = intParam("limit", 50);
    searchMessages(res, auth, decodeURIComponent(m[1]!), q, limit);
    return true;
  }

  if (path === "/api/dashboard/search") {
    dashboardSearch(res, auth, u.searchParams.get("q") || "", intParam("limit", 50),
      u.searchParams.get("messages_before"), u.searchParams.get("notes_before"));
    return true;
  }

  // ---- Command Center (CC-001) read-only endpoints ----
  if (path === "/api/dashboard/overview") {
    ccOverview(res, auth);
    return true;
  }
  if (path === "/api/dashboard/activity") {
    const limit = intParam("limit", 100);
    const before = u.searchParams.get("before");
    ccActivity(res, auth, limit, before);
    return true;
  }
  // ---- AgentComm reader (AC-READ-001) ----
  if (path === "/api/dashboard/agentcomm/threads") {
    const limit = intParam("limit", 100);
    acThreads(res, auth, limit);
    return true;
  }
  if (path === "/api/dashboard/agentcomm/thread") {
    const limit = intParam("limit", 200);
    acThread(
      res,
      auth,
      (u.searchParams.get("a") || "").trim(),
      (u.searchParams.get("b") || "").trim(),
      limit,
      u.searchParams.get("before"),
    );
    return true;
  }
  if (path === "/api/dashboard/entities") {
    const type = u.searchParams.get("type");
    const q = u.searchParams.get("q");
    const limit = intParam("limit", 100);
    ccEntities(res, auth, type, q, limit);
    return true;
  }
  if (path === "/api/dashboard/skills") {
    const limit = intParam("limit", 100);
    ccSkills(res, auth, limit);
    return true;
  }

  json(res, 404, { error: "not_found", path });
  return true;
}

