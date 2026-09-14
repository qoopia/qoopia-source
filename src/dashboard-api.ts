import { opsSummary } from "./delivery/ops-state.ts";
import { inspectScheduledBackups } from "./delivery/doctor-checks.ts";
/**
 * Dashboard V4 — read-only HTTP API for the agent monitor dashboard.
 *
 * Authorization model (QSEC-001, Codex review 2026-04-25):
 *   - `steward` and `claude-privileged` agents see the whole workspace
 *     (this is the dashboard/admin view).
 *   - `standard` agents can ONLY see their own agent record, sessions,
 *     messages, notes, and search. Cross-agent access returns 403.
 *   - `ingest-daemon` and any other type get 403 from dashboard endpoints.
 *
 * Before this change, any valid agent Bearer token could read every other
 * agent's transcripts and memory in the same workspace. The new auth context
 * carries `isAdmin` and `agent_id` so each handler can enforce scope.
 *
 * Routes (read GETs unless noted):
 *   POST /api/dashboard/login   — exchange Bearer for session cookie
 *   POST /api/dashboard/logout  — clear session cookie
 *   GET  /api/dashboard/agents
 *   GET  /api/dashboard/agents/:agent_id/sessions
 *   GET  /api/dashboard/sessions/:session_id/messages
 *   GET  /api/dashboard/agents/:agent_id/notes?type=...&limit=...
 *   GET  /api/dashboard/agents/:agent_id/search?q=...
 *
 * QDASH-COOKIE (Codex review 2026-04-26 follow-up):
 *   The browser dashboard no longer keeps the Bearer in JS storage. POST
 *   /login validates the Bearer and sets `qoopia_dash` as an HttpOnly +
 *   SameSite=Strict cookie scoped to /api/dashboard. Subsequent GETs are
 *   authenticated by the cookie automatically; if the Authorization header
 *   is also supplied (curl, scripts) it still wins. POST /logout clears
 *   the cookie.
 *
 *   The cookie value is a server-signed `{agent_id, sv, exp}` payload —
 *   `base64url(JSON) "." base64url(HMAC-SHA256)` — NOT the raw Bearer.
 *   `sv` is the agent's `session_version` snapshot at login.
 *   Cookie minting is restricted to static `api_key` Bearers (see
 *   loginHandler / QDASHCOOKIE-001 fix). OAuth access tokens are NOT
 *   accepted at /api/dashboard/login: an OAuth token's lifetime and
 *   revocation are managed in `oauth_tokens`, and minting a one-year dashboard
 *   cookie from a 1h OAuth token would silently extend its blast radius.
 *
 *   Cookie revocation surface (post-#34):
 *     • agent deactivation (per-request `active=1` DB check + sv bump),
 *     • api_key rotation (`rotateAgentKey()` increments
 *       `agents.session_version`; outstanding cookies fail the sv check),
 *     • rotation of `QOOPIA_SESSION_SECRET` (or process restart on the
 *       ephemeral fallback key) — invalidates every outstanding cookie,
 *     • cookie expiry (one-year Max-Age + payload `exp`).
 *
 *   Tag comparison uses `crypto.timingSafeEqual` over fixed-length raw
 *   HMAC buffers (32 bytes); tags that don't decode to exactly 32 bytes
 *   are rejected before the compare runs (QDASHCOOKIE-003).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { db } from "./db/connection.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { sha256Hex } from "./auth/api-keys.ts";
import { env } from "./utils/env.ts";
import { fileListFolders, fileListByFolder, fileGetForDownload } from "./services/files.ts";
import { recall } from "./services/recall.ts";
import { getSupersedeChain } from "./services/note-relations.ts";
import { confirmMemory, getMemoryLifecycle, setMemoryPin } from "./services/memory-lifecycle.ts";
import { listExtractionRuns, getExtractionRun, reviewExtractionCandidate } from "./services/extraction.ts";
import { recordRecallFeedback } from "./services/recall-feedback.ts";
import { assertNoSecrets } from "./utils/secret-guard.ts";
import { assignmentReadiness, compatibility, type Assignment } from "./skills/loop.ts";

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

const ADMIN_TYPES = new Set(["owner", "steward", "claude-privileged"]);
/** ingest-daemon and unknown types must NOT see dashboard data. */
const ALLOWED_TYPES = new Set(["owner", "steward", "claude-privileged", "standard"]);

export interface DashboardAuth {
  workspace_id: string;
  agent_id: string;
  type: string;
  isAdmin: boolean;
  /**
   * Codex QSA-H (2026-04-28): how this dashboard auth was established.
   * - "api-key": static Bearer api_* (curl, scripts, login flow, tests)
   * - "oauth": OAuth access token reaching the dashboard via the Bearer fallback
   * - "cookie": signed qoopia_dash session (the browser dashboard)
   *
   * The OAuth bridge consent surface uses this to fail closed on OAuth tokens —
   * otherwise an OAuth bearer could fetch the consent page, read the nonce, and
   * self-approve new tickets, defeating the whole bridge pattern.
   */
  source: "api-key" | "oauth" | "cookie";
  granted_scope?: AuthContext["granted_scope"];
}

/** Parse a Cookie header into a name→value map. Empty/missing → {}. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Cookie name for the dashboard session token. */
export const DASHBOARD_COOKIE = "qoopia_dash";

/** One-year (365-day) cookie lifetime, per owner decision 2026-07-16. */
const SESSION_TTL_SEC = 31_536_000;

/**
 * Length of the HMAC-SHA256 tag in bytes. Pinned so a malformed cookie
 * (truncated/extended tag) is rejected before reaching `timingSafeEqual`,
 * which throws on length mismatch.
 */
const HMAC_TAG_BYTES = 32;

/**
 * Constant-time buffer compare wrapper. Returns false for any size
 * mismatch (instead of throwing, which `crypto.timingSafeEqual` does)
 * and otherwise delegates to the platform implementation. Length check
 * is intentionally branch-on-length-only so we don't leak content via
 * differential timing once we're past it.
 */
function buffersEqualConstantTime(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(a, b);
}

/**
 * HMAC-SHA256 signing key for dashboard session cookies.
 *
 * Resolution order:
 *   1. QOOPIA_SESSION_SECRET — explicit env, recommended for prod.
 *   2. QOOPIA_ADMIN_SECRET   — already lives in the LaunchAgent plist.
 *   3. Ephemeral random      — generated once per process; cookies invalidate
 *                              on restart (acceptable: dashboard is a tool,
 *                              not a multi-user product).
 *
 * The cookie value never embeds this key — it is HMAC-only, so leaking the
 * cookie does not leak the key.
 */
let _sessionKey: Buffer | null = null;
function sessionKey(): Buffer {
  if (_sessionKey) return _sessionKey;
  const explicit = process.env.QOOPIA_SESSION_SECRET || "";
  let key: Buffer;
  if (explicit) {
    key = Buffer.from(explicit, "utf8");
  } else if (env.ADMIN_SECRET) {
    // Domain-separate so the same secret can't be cross-used by other
    // signers in the future (defense-in-depth, not exploitable today).
    key = createHmac("sha256", env.ADMIN_SECRET)
      .update("qoopia-dashboard-session-v1")
      .digest();
  } else {
    key = randomBytes(32);
  }
  _sessionKey = key;
  return key;
}

function b64uEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64uDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface SessionPayload {
  /** Agent the cookie was minted for. */
  agent_id: string;
  /** session_version snapshot at login. Bumped by rotateAgentKey() and
   *  deleteAgent(). Mismatch with the live row → 401 (QDASHCOOKIE-002). */
  sv: number;
  /** Expiry (unix seconds). Validated against system clock. */
  exp: number | null;
  /** Local human owner sessions end on revocation, not a timer. */
  owner?: true;
  issued?: number;
}

/**
 * Build a signed session cookie value. Format:
 *   base64url(JSON({agent_id, sv, exp})) "." base64url(HMAC-SHA256(payload))
 *
 * The HMAC is computed over the base64url-encoded payload (not the raw
 * JSON), so a verifier never has to re-canonicalise JSON before comparing.
 * No raw Bearer token is ever stored in or derivable from this value.
 */
function signSession(
  agent_id: string,
  session_version: number,
  ttlSec: number | null = SESSION_TTL_SEC,
): string {
  const payload: SessionPayload = {
    agent_id,
    sv: session_version,
    exp: ttlSec === null ? null : Math.floor(Date.now() / 1000) + ttlSec,
    ...(ttlSec === null ? {owner:true as const,issued:Math.floor(Date.now()/1000)} : {}),
  };
  const payloadB64 = b64uEncode(JSON.stringify(payload));
  const tag = createHmac("sha256", sessionKey()).update(payloadB64).digest();
  const tagB64 = b64uEncode(tag);
  return `${payloadB64}.${tagB64}`;
}

/**
 * Verify a signed session cookie. Returns the parsed payload on success,
 * null on any failure (malformed, bad HMAC, expired, bad shape). Does NOT
 * consult the DB — the caller still resolves the agent row so a
 * deactivated/deleted/rotated agent cannot ride a stale-but-signed cookie.
 *
 * QDASHCOOKIE-003: tag comparison goes through `crypto.timingSafeEqual`
 * over fixed-length raw HMAC buffers, not a hand-rolled string compare.
 * Tags that don't decode to exactly 32 bytes are rejected before the
 * compare runs.
 */
function verifySession(value: string): SessionPayload | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payloadB64 = value.slice(0, dot);
  const tagB64 = value.slice(dot + 1);

  // Decode the supplied tag; reject anything that is not exactly 32 bytes.
  let actualTag: Buffer;
  try {
    actualTag = b64uDecode(tagB64);
  } catch {
    return null;
  }
  if (actualTag.length !== HMAC_TAG_BYTES) return null;

  // Recompute the expected tag and compare in constant time.
  const expectedTag = createHmac("sha256", sessionKey())
    .update(payloadB64)
    .digest();
  if (!buffersEqualConstantTime(expectedTag, actualTag)) return null;

  // Signature is valid — now decode and shape-check the payload.
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64uDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.agent_id !== "string" ||
    typeof payload.sv !== "number" ||
    !(typeof payload.exp === 'number' && Number.isFinite(payload.exp) ||
      payload.exp === null && payload.owner === true && ownerIdentityEnabled() &&
      Number.isSafeInteger(payload.issued) && payload.issued! >= 0) ||
    !Number.isFinite(payload.sv) ||
    !Number.isInteger(payload.sv) ||
    payload.sv < 0
  ) {
    return null;
  }
  if (payload.exp !== null && payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/**
 * Determine whether the request reached us over HTTPS. Honors x-forwarded-proto
 * only when TRUST_PROXY is enabled and the upstream peer is in TRUSTED_PROXIES
 * — otherwise an attacker on a non-loopback interface could spoof the header
 * and trick us into setting cookies without the Secure flag.
 */
// Exported so http.ts can decide whether to emit HSTS on dashboard /
// /oauth/authorize HTML responses (QSA-G).
export function isHttps(req: IncomingMessage): boolean {
  const sock = (req as unknown as { socket?: { encrypted?: boolean } }).socket;
  if (sock && sock.encrypted) return true;
  if (!env.TRUST_PROXY) return false;
  const peer = (req.socket?.remoteAddress || "").toLowerCase();
  if (!env.TRUSTED_PROXIES.includes(peer)) return false;
  const xfp = (req.headers["x-forwarded-proto"] as string | undefined) || "";
  return xfp.split(",")[0]?.trim().toLowerCase() === "https";
}

/** Build the Set-Cookie value for a freshly-signed dashboard session. */
function buildSessionCookie(req: IncomingMessage, signedValue: string): string {
  const parts = [
    `${DASHBOARD_COOKIE}=${signedValue}`,
    "Path=/api/dashboard",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/** Build the Set-Cookie value to clear the dashboard session. */
function buildClearCookie(req: IncomingMessage): string {
  const parts = [
    `${DASHBOARD_COOKIE}=`,
    "Path=/api/dashboard",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Resolve a session cookie to a live agent. Returns null if the signature is
 * bad, the cookie is expired, the agent no longer exists, the agent is
 * deactivated, or the agent's type is not dashboard-eligible.
 */
function authFromSessionCookie(req: IncomingMessage): DashboardAuth | null {
  const cookies = parseCookies(req.headers["cookie"] as string | undefined);
  const value = cookies[DASHBOARD_COOKIE];
  if (!value) return null;
  const verified = verifySession(value);
  if (!verified) return null;
  const row = db
    .prepare(
      `SELECT id, workspace_id, type, active, session_version
         FROM agents
        WHERE id = ?`,
    )
    .get(verified.agent_id) as
    | {
        id: string;
        workspace_id: string;
        type: string;
        active: number;
        session_version: number;
      }
    | undefined;
  if (!row || !row.active) return null;
  if (!ALLOWED_TYPES.has(row.type)) return null;
  // QDASHCOOKIE-002: cookie's session_version snapshot must still match
  // the live row. rotateAgentKey() and deleteAgent() bump this, so
  // outstanding cookies fail closed on the next request.
  if (row.session_version !== verified.sv) return null;
  if (verified.exp === null && !db.query(`SELECT 1 FROM workspace_owners o JOIN agents a ON a.id=o.actor_id AND a.workspace_id=o.workspace_id
    WHERE a.id=? AND a.principal_kind='human' AND a.authority_profile='owner'`).get(row.id)) return null;
  return {
    workspace_id: row.workspace_id,
    agent_id: row.id,
    type: row.type,
    isAdmin: ADMIN_TYPES.has(row.type),
    source: "cookie",
  };
}

/**
 * Authenticate dashboard requests. Authorization: Bearer is the primary path
 * (curl, scripts, the login flow). The signed `qoopia_dash` cookie is the
 * fallback used only by the browser dashboard. Both go through the same
 * eligibility filter (steward/standard/claude-privileged).
 */
export function checkDashboardAuth(req: IncomingMessage): DashboardAuth | null {
  const header = (req.headers["authorization"] as string | undefined) || "";
  if (header) {
    const fetchReq = new Request("http://local/", {
      headers: { authorization: header },
    });
    const auth = authenticate(fetchReq);
    if (!auth) return null;
    if (!ALLOWED_TYPES.has(auth.type)) return null;
    return {
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      type: auth.type,
      isAdmin: ADMIN_TYPES.has(auth.type),
      // QSA-H: propagate underlying source so OAuth-sensitive surfaces
      // (the consent bridge) can fail closed on OAuth bearers.
      source: auth.source,
      granted_scope: auth.granted_scope,
    };
  }
  // No Authorization header — fall back to the signed session cookie.
  return authFromSessionCookie(req);
}

/**
 * Origin guard for the POST endpoints (/login, /logout). If Origin or Referer
 * is present, it must match either env.PUBLIC_URL or the request's own Host
 * (for tests / local dev where PUBLIC_URL is set to a domain we aren't
 * actually serving from). If neither header is present (curl), we allow the
 * request — the Bearer in Authorization is itself proof of authenticity, and
 * forcing CSRF tokens on a non-browser caller would just push people back
 * onto the cookie path we are trying to harden.
 */
function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function addOrigin(allowed: Set<string>, raw: string): void {
  if (!raw) return;
  try {
    allowed.add(new URL(raw).origin);
  } catch {
    /* malformed config/header candidate — ignore */
  }
}

function addHostOrigins(allowed: Set<string>, rawHost: string, rawProto = "https"): void {
  const host = rawHost.split(",")[0]?.trim();
  if (!host) return;
  const proto = rawProto.split(",")[0]?.trim() || "https";
  allowed.add(`http://${host}`);
  allowed.add(`https://${host}`);
  if (proto === "http" || proto === "https") allowed.add(`${proto}://${host}`);
}

function dashboardAllowedOrigins(req: IncomingMessage): string[] {
  const allowed = new Set<string>();
  addOrigin(allowed, env.PUBLIC_URL);
  for (const raw of env.DASHBOARD_ALLOWED_ORIGINS) addOrigin(allowed, raw);

  // Local tests and reverse proxies can present a Host that differs from
  // QOOPIA_PUBLIC_URL. Keep the historical Host behavior and also honor
  // forwarded host/proto so cloudflared/nginx deployments do not fail closed
  // when the upstream Host is rewritten to the container service name.
  addHostOrigins(allowed, firstHeaderValue(req.headers["host"]));
  addHostOrigins(
    allowed,
    firstHeaderValue(req.headers["x-forwarded-host"]),
    firstHeaderValue(req.headers["x-forwarded-proto"]),
  );
  return [...allowed];
}

export function dashboardOriginDiagnostics(req: IncomingMessage): Record<string, unknown> {
  return {
    origin: firstHeaderValue(req.headers["origin"]),
    referer: firstHeaderValue(req.headers["referer"]),
    host: firstHeaderValue(req.headers["host"]),
    forwarded_host: firstHeaderValue(req.headers["x-forwarded-host"]),
    forwarded_proto: firstHeaderValue(req.headers["x-forwarded-proto"]),
    public_origin: (() => {
      try { return new URL(env.PUBLIC_URL).origin; } catch { return ""; }
    })(),
    allowed_origins: dashboardAllowedOrigins(req),
  };
}

export function originAllowed(req: IncomingMessage): boolean {
  // Some browser-mediated OAuth popups submit with Origin: null. Treat the
  // literal opaque-origin value as absent; the dashboard POST is still gated by
  // the HttpOnly dashboard session plus one-time nonce, and forged concrete
  // origins/referers remain denied.
  const origin = firstHeaderValue(req.headers["origin"]);
  const normalizedOrigin = origin === "null" ? "" : origin;
  const referer = firstHeaderValue(req.headers["referer"]);
  if (!normalizedOrigin && !referer) return true;
  const allowed = dashboardAllowedOrigins(req);
  const candidates = [normalizedOrigin, referer].filter(Boolean);
  for (const c of candidates) {
    let cOrigin: string;
    try {
      cOrigin = new URL(c).origin;
    } catch {
      return false;
    }
    if (!allowed.includes(cOrigin)) return false;
  }
  return true;
}

/**
 * POST /api/dashboard/login — validates the Bearer in the Authorization
 * header, then replies 200 with Set-Cookie carrying a signed session payload
 * (NOT the Bearer itself). The cookie payload is `{agent_id, exp}` HMAC'd
 * with the server-side session key; verification on later requests resolves
 * the agent_id back to a live DB row, so deactivating the agent invalidates
 * any outstanding cookie immediately.
 *
 * QDASHCOOKIE-001: cookie minting is restricted to static `api_key`
 * Bearers. Accepting OAuth access tokens here would let a 1h OAuth token
 * be exchanged for a one-year dashboard cookie that survives OAuth token
 * revocation (the cookie does not carry a back-pointer to the token row).
 * Mixing OAuth into dashboard sessions is a separate auth-semantics
 * decision that requires explicit TTL/revocation binding; not in this PR.
 */
export function ownerIdentityEnabled() {
  return process.env.QOOPIA_STANDALONE === 'true' || process.env.QOOPIA_OWNER_LOGIN === 'true';
}

/** Hosted login is opt-in, HTTPS-only, and confined to configured dashboard hosts. */
export function ownerIdentityRequestAllowed(req: IncomingMessage, mutation = true) {
  if (!ownerIdentityEnabled()) return false;
  if (process.env.QOOPIA_STANDALONE === 'true') {
    const host = `127.0.0.1:${env.PORT}`;
    return req.headers.host === host && ['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') &&
      (!mutation || req.headers.origin === `http://${host}`);
  }
  if (!isHttps(req)) return false;
  return [env.PUBLIC_URL, ...env.DASHBOARD_ALLOWED_ORIGINS].some(value => {
    try {
      const origin = new URL(value);
      return origin.protocol === 'https:' && req.headers.host === origin.host && (!mutation || req.headers.origin === origin.origin);
    } catch { return false; }
  });
}

/** Called after the launcher capability or the bound identity proof is consumed. */
export function localOwnerLoginHandler(req: IncomingMessage, res: ServerResponse, ownerId: string) {
  if (!ownerIdentityRequestAllowed(req) || !originAllowed(req)) {
    json(res,403,{error:'forbidden'});return;
  }
  const owner = db.query(`SELECT a.id,a.session_version FROM workspace_owners o JOIN agents a ON a.id=o.actor_id AND a.workspace_id=o.workspace_id
    WHERE a.id=? AND a.principal_kind='human' AND a.authority_profile='owner' AND a.active=1`).get(ownerId) as {id:string;session_version:number}|null;
  if(!owner){json(res,401,{error:'owner_unavailable'});return;}
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',
    'set-cookie':buildSessionCookie(req,signSession(owner.id,owner.session_version,null))});
  res.end(JSON.stringify({ok:true}));
}

/** Browser storage has its own lifetime; renew it during use without extending revoked sessions. */
export function renewLocalOwnerSession(req: IncomingMessage, res: ServerResponse) {
  if (!ownerIdentityRequestAllowed(req, false)) return;
  const value = parseCookies(req.headers.cookie)[DASHBOARD_COOKIE];
  const session = value ? verifySession(value) : null;
  if (session?.exp !== null || !session.issued || session.issued > Math.floor(Date.now()/1000)-86400 || !authFromSessionCookie(req)) return;
  res.setHeader('set-cookie',buildSessionCookie(req,signSession(session.agent_id,session.sv,null)));
}

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
        "Login requires Authorization: Bearer <agent_api_key> with steward/standard/claude-privileged scope.",
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
  if (!originAllowed(req)) {
    json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed for /api/dashboard/logout.",
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
 * Enforce per-agent scope for standard agents. Returns true if the request
 * should be denied (403 already written).
 */
function denyIfNotOwn(
  res: ServerResponse,
  auth: DashboardAuth,
  requestedAgentId: string,
): boolean {
  if (auth.isAdmin) return false;
  if (requestedAgentId === auth.agent_id) return false;
  json(res, 403, {
    error: "forbidden",
    error_description:
      "Standard agents can only read their own dashboard data; ask a steward for cross-agent visibility.",
  });
  return true;
}

// Re-export for any internal callers that imported the old AuthContext.
export type { AuthContext };

// ---- /api/dashboard/agents ----
function listAgents(res: ServerResponse, auth: DashboardAuth) {
  // Standard agents only see themselves; admins see the workspace.
  const sql = auth.isAdmin
    ? `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ?
       ORDER BY name ASC`
    : `SELECT id, workspace_id, name, type, active, last_seen, created_at
       FROM agents
       WHERE active = 1 AND workspace_id = ? AND id = ?
       ORDER BY name ASC`;
  const args: string[] = auth.isAdmin
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
  const countNotes = db.prepare(
    `SELECT COUNT(*) as c FROM notes WHERE agent_id = ? AND deleted_at IS NULL`,
  );
  const countMessages = db.prepare(
    `SELECT COUNT(*) as c FROM session_messages WHERE agent_id = ?`,
  );
  const lastSession = db.prepare(
    `SELECT id, last_active FROM sessions
     WHERE agent_id = ?
     ORDER BY last_active DESC LIMIT 1`,
  );

  const items = rows.map((a) => {
    const s = countSessions.get(a.id) as { c: number };
    const n = countNotes.get(a.id) as { c: number };
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
) {
  if (denyIfNotOwn(res, auth, agentId)) return;
  const workspaceId = auth.workspace_id;
  const where: string[] = [`agent_id = ?`, `workspace_id = ?`, `deleted_at IS NULL`];
  const params: any[] = [agentId, workspaceId];
  if (type) {
    where.push(`type = ?`);
    params.push(type);
  }
  const rows = db
    .prepare(
      `SELECT id, workspace_id, agent_id, type, text, metadata, tags,
              project_id, task_bound_id, session_id, source,
              created_at, updated_at
       FROM notes
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(limit, 1), 1000)) as Array<{
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

  // Breakdown by type (all types, not filtered by `type`)
  const typeBreakdown = db
    .prepare(
      `SELECT type, COUNT(*) as c
       FROM notes WHERE agent_id = ? AND workspace_id = ? AND deleted_at IS NULL
       GROUP BY type ORDER BY c DESC`,
    )
    .all(agentId, workspaceId) as Array<{ type: string; c: number }>;

  return json(res, 200, {
    items: rows.map((r) => ({
      ...r,
      metadata: safeJson(r.metadata),
      tags: safeJson(r.tags) ?? [],
    })),
    total: rows.length,
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
  // Sanitize FTS query: strip characters SQLite FTS5 treats as operators
  // and just quote the bare tokens. This matches the simple-search UX users expect.
  const cleaned = query
    .replace(/[-\"\'`():*^~]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" AND ");
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
    return json(res, 400, {
      error: "invalid_query",
      error_description: (e as Error).message,
    });
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
// All scoped to auth.workspace_id. Admins (steward/claude-privileged) see
// the whole workspace; standard agents see only their own slice for
// per-agent tables (agents/sessions/messages/notes/activity) and their own
// comm traffic. Workspace knowledge (entity_pages/skills) is shared, so it
// is visible to standard agents too. Every sub-query is wrapped so a single
// failure degrades to null/[] instead of 500-ing the whole response.
// ============================================================

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
  const admin = auth.isAdmin;
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

  const notes = ccTry(() => ({
    total: ccCount("notes", `workspace_id = ?${af} AND deleted_at IS NULL`, [ws, ...ap]),
    by_type: db
      .prepare(
        `SELECT type, COUNT(*) AS c FROM notes WHERE workspace_id = ?${af} AND deleted_at IS NULL GROUP BY type ORDER BY c DESC LIMIT 8`,
      )
      .all(ws, ...ap),
  }), null as any);

  const entities = ccTry(() => ({
    total: ccCount("entity_pages", "workspace_id = ?", [ws]),
    by_type: db
      .prepare(`SELECT type, COUNT(*) AS c FROM entity_pages WHERE workspace_id = ? GROUP BY type ORDER BY c DESC`)
      .all(ws),
  }), null as any);

  const skills = ccTry(() => {
    const total = ccCount("entity_pages", "workspace_id = ? AND type = 'skill'", [ws]);
    const rows = db
      .prepare(`SELECT metadata, status FROM entity_pages WHERE workspace_id = ? AND type = 'skill'`)
      .all(ws) as Array<{ metadata: string; status: string }>;
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
    const rf = admin ? "" : " AND recipient_agent_id = ?";
    const rp: any[] = admin ? [] : [aid];
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
      `workspace_id = ?${admin ? "" : " AND agent_id = ?"} AND created_at >= ?`,
      [ws, ...(admin ? [] : [aid]), since24],
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
    const backup = admin ? ccTry(() => {
      const instance = db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string} | null;
      return instance ? inspectScheduledBackups(env.BACKUP_DIR, instance.instance_id) : { status: 'unknown' };
    }, {status:'unknown'}) : {status:'owner_only'};
    return {
      schema_version,
      recall_mode: process.env.QOOPIA_RECALL_MODE || "hybrid",
      uptime_seconds: Math.floor(process.uptime()),
      last_backup: null, // Legacy filename/mtime is not verification evidence.
      verified_backup: admin ? backup : { status: 'owner_only' },
      operations: admin ? opsSummary(env.OPS_STATE_DIR) : { status: 'owner_only' },
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

// ---- /api/dashboard/activity — live activity feed ----
function ccActivity(
  res: ServerResponse,
  auth: DashboardAuth,
  limit: number,
  before: string | null,
) {
  const ws = auth.workspace_id;
  const lim = Math.min(Math.max(limit || 100, 1), 500);
  const where: string[] = ["a.workspace_id = ?"];
  const params: any[] = [ws];
  if (!auth.isAdmin) {
    where.push("a.agent_id = ?");
    params.push(auth.agent_id);
  }
  if (before) {
    where.push("a.created_at < ?");
    params.push(before);
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
      next_before: rows.length ? rows[rows.length - 1].created_at : null,
    });
  } catch (e) {
    return json(res, 200, { items: [], total: 0, next_before: null, error: (e as Error).message });
  }
}

// ============================================================
// AgentComm reader (AC-READ-001) — additive, read-only, GET-only.
//
// Two levels, mirroring a messenger:
//   • /api/dashboard/agentcomm/threads — one row per agent PAIR,
//   • /api/dashboard/agentcomm/thread  — the full transcript of one pair.
//
// Scope follows the same rule as the neighbouring dashboard endpoints:
// admins (steward/claude-privileged) see the whole workspace, standard
// agents see only conversations they are a party to.
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

// ---- /api/dashboard/agentcomm/threads — one row per agent pair ----
function acThreads(res: ServerResponse, auth: DashboardAuth, limit: number) {
  const ws = auth.workspace_id;
  const admin = auth.isAdmin;
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
  const lastOf = db.prepare(
    `SELECT m.id, m.sender_agent_id, m.recipient_agent_id, m.kind, m.body, m.created_at
     FROM agent_comm_messages m
     WHERE m.workspace_id = ?
       AND ((m.sender_agent_id = ? AND m.recipient_agent_id = ?)
         OR (m.sender_agent_id = ? AND m.recipient_agent_id = ?))
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 1`,
  );

  const items = rows.map((r) => {
    const an = ccTry(() => (nameOf.get(r.agent_a_id) as { name: string } | undefined)?.name, undefined);
    const bn = ccTry(() => (nameOf.get(r.agent_b_id) as { name: string } | undefined)?.name, undefined);
    const last = ccTry(
      () =>
        lastOf.get(ws, r.agent_a_id, r.agent_b_id, r.agent_b_id, r.agent_a_id) as
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
  // Standard agents may only read threads they are a party to.
  if (!auth.isAdmin && auth.agent_id !== agentA && auth.agent_id !== agentB) {
    return json(res, 403, {
      error: "forbidden",
      error_description:
        "Standard agents can only read their own dashboard data; ask a steward for cross-agent visibility.",
    });
  }

  const ws = auth.workspace_id;
  const lim = clampLimit(limit, 200, 500);
  const cursor = before && before.trim() ? before.trim() : null;

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
           FROM agent_comm_messages m
           LEFT JOIN agents s ON s.id = m.sender_agent_id
           LEFT JOIN agents r ON r.id = m.recipient_agent_id
           LEFT JOIN agent_comm_sessions cs ON cs.id = m.session_id
           WHERE m.workspace_id = ?
             AND ((m.sender_agent_id = ? AND m.recipient_agent_id = ?)
               OR (m.sender_agent_id = ? AND m.recipient_agent_id = ?))
             ${cursor ? "AND m.created_at < ?" : ""}
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT ?`,
        )
        .all(ws, agentA, agentB, agentB, agentA, ...(cursor ? [cursor] : []), lim) as Array<
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

  const nameOf = db.prepare(`SELECT name FROM agents WHERE id = ?`);
  const total = ccTry(
    () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM agent_comm_messages
             WHERE workspace_id = ?
               AND ((sender_agent_id = ? AND recipient_agent_id = ?)
                 OR (sender_agent_id = ? AND recipient_agent_id = ?))`,
          )
          .get(ws, agentA, agentB, agentB, agentA) as { c: number }
      ).c,
    0,
  );

  return json(res, 200, {
    pair_key: pairKey(agentA, agentB),
    agent_a: {
      id: agentA,
      name: ccTry(() => (nameOf.get(agentA) as { name: string } | undefined)?.name ?? null, null),
    },
    agent_b: {
      id: agentB,
      name: ccTry(() => (nameOf.get(agentB) as { name: string } | undefined)?.name ?? null, null),
    },
    total,
    messages,
    // Cursor for the previous (older) page; null when the head is reached.
    has_more: rows.length === lim,
    next_before: rows.length === lim ? messages[0]!.created_at : null,
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
  const where: string[] = ["e.workspace_id = ?", "e.status != 'archived'"];
  const params: any[] = [ws];
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
          `SELECT type, COUNT(*) AS c FROM entity_pages WHERE workspace_id = ? AND status != 'archived' GROUP BY type ORDER BY c DESC`,
        )
        .all(ws),
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
         WHERE workspace_id = ? AND type = 'skill' AND (authority_private=0 OR authority_owner_id=? OR EXISTS(SELECT 1 FROM workspace_owners WHERE workspace_id=? AND actor_id=?))
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(ws, auth.agent_id, ws, auth.agent_id, lim) as any[];
    return json(res, 200, {
      items: rows.map((r) => ({ ...r, metadata: safeJson(r.metadata) })),
      total: rows.length,
    });
  } catch (e) {
    return json(res, 200, { items: [], total: 0, error: (e as Error).message });
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
  const safe = f.filename.replace(/[\r\n"\\]/g, "_");
  res.writeHead(200, {
    "content-type": f.mime || "application/octet-stream",
    "content-length": String(f.size),
    "content-disposition": `attachment; filename="${safe}"`,
    "x-content-type-options": "nosniff",
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
  if (auth.isAdmin) return true;
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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(value);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json_object");
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
    feature_flags: {
      relations: process.env.QOOPIA_V4_RELATIONS === "true",
      recall_explain: process.env.QOOPIA_V4_RECALL_EXPLAIN === "true",
      lifecycle: process.env.QOOPIA_V4_LIFECYCLE === "true",
      extraction: process.env.QOOPIA_V4_EXTRACTION === "true",
      feedback: process.env.QOOPIA_V4_FEEDBACK === "true",
      dashboard: process.env.QOOPIA_V4_DASHBOARD === "true",
    },
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
        is_admin: auth.isAdmin,
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
  const method = (req.method || "GET").toUpperCase();
  const u = new URL(url, "http://local");
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
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    loginHandler(req, res);
    return true;
  }
  if (path === "/api/dashboard/logout") {
    if (method !== "POST") {
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

  if (method !== "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const auth = checkDashboardAuth(req);
  if (!auth) {
    json(res, 401, {
      error: "unauthorized",
      error_description:
        "Valid agent Bearer token required (steward/standard/claude-privileged)",
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
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    listSessions(res, auth, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/notes
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/notes$/);
  if (m) {
    const type = u.searchParams.get("type");
    const limit = parseInt(u.searchParams.get("limit") || "200", 10);
    listNotesByAgent(res, auth, decodeURIComponent(m[1]!), type, limit);
    return true;
  }

  // /api/dashboard/sessions/:session_id/messages
  m = path.match(/^\/api\/dashboard\/sessions\/([^/]+)\/messages$/);
  if (m) {
    const limit = parseInt(u.searchParams.get("limit") || "500", 10);
    sessionMessages(res, auth, decodeURIComponent(m[1]!), limit);
    return true;
  }

  // /api/dashboard/agents/:agent_id/search?q=...
  m = path.match(/^\/api\/dashboard\/agents\/([^/]+)\/search$/);
  if (m) {
    const q = u.searchParams.get("q") || "";
    const limit = parseInt(u.searchParams.get("limit") || "50", 10);
    searchMessages(res, auth, decodeURIComponent(m[1]!), q, limit);
    return true;
  }

  // ---- Command Center (CC-001) read-only endpoints ----
  if (path === "/api/dashboard/overview") {
    ccOverview(res, auth);
    return true;
  }
  if (path === "/api/dashboard/activity") {
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    const before = u.searchParams.get("before");
    ccActivity(res, auth, limit, before);
    return true;
  }
  // ---- AgentComm reader (AC-READ-001) ----
  if (path === "/api/dashboard/agentcomm/threads") {
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    acThreads(res, auth, limit);
    return true;
  }
  if (path === "/api/dashboard/agentcomm/thread") {
    const limit = parseInt(u.searchParams.get("limit") || "200", 10);
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
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    ccEntities(res, auth, type, q, limit);
    return true;
  }
  if (path === "/api/dashboard/skills") {
    const limit = parseInt(u.searchParams.get("limit") || "100", 10);
    ccSkills(res, auth, limit);
    return true;
  }

  json(res, 404, { error: "not_found", path });
  return true;
}
