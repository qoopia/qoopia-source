/**
 * Dashboard session layer: cookie format and HMAC signature, the origin
 * allowlist, and owner identity.
 *
 * dashboard-api.ts held two unrelated subjects. This is the first: who the
 * caller is and whether the request may act. The second, the read models the
 * dashboard renders, stays behind. http.ts, identity/local.ts and the tests
 * already 

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
import { env } from "./utils/env.ts";
import { ADMIN_TYPES } from "./auth/principal.ts";
import { json } from "./utils/http-json.ts";

/** ingest-daemon and unknown types must NOT see dashboard data. */
export const ALLOWED_TYPES = new Set(["owner", "steward", "claude-privileged", "standard"]);

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
export function parseCookies(header: string | undefined): Record<string, string> {
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
export const SESSION_TTL_SEC = 31_536_000;

/**
 * Length of the HMAC-SHA256 tag in bytes. Pinned so a malformed cookie
 * (truncated/extended tag) is rejected before reaching `timingSafeEqual`,
 * which throws on length mismatch.
 */
export const HMAC_TAG_BYTES = 32;

/**
 * Constant-time buffer compare wrapper. Returns false for any size
 * mismatch (instead of throwing, which `crypto.timingSafeEqual` does)
 * and otherwise delegates to the platform implementation. Length check
 * is intentionally branch-on-length-only so we don't leak content via
 * differential timing once we're past it.
 */
export function buffersEqualConstantTime(a: Buffer, b: Buffer): boolean {
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
export let _sessionKey: Buffer | null = null;
export function sessionKey(): Buffer {
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

export function b64uEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
export function b64uDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export interface SessionPayload {
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
export function signSession(
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
export function verifySession(value: string): SessionPayload | null {
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
export function buildSessionCookie(req: IncomingMessage, signedValue: string): string {
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
export function buildClearCookie(req: IncomingMessage): string {
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
export function authFromSessionCookie(req: IncomingMessage): DashboardAuth | null {
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
export function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

export function addOrigin(allowed: Set<string>, raw: string): void {
  if (!raw) return;
  try {
    allowed.add(new URL(raw).origin);
  } catch {
    /* malformed config/header candidate — ignore */
  }
}

export function addHostOrigins(allowed: Set<string>, rawHost: string, rawProto = "https"): void {
  const host = rawHost.split(",")[0]?.trim();
  if (!host) return;
  const proto = rawProto.split(",")[0]?.trim() || "https";
  allowed.add(`http://${host}`);
  allowed.add(`https://${host}`);
  if (proto === "http" || proto === "https") allowed.add(`${proto}://${host}`);
}

export function dashboardAllowedOrigins(req: IncomingMessage): string[] {
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

/**
 * Standalone owner login is confined to the address the operator explicitly
 * bound the server to. The default bind is loopback, so default behaviour is
 * unchanged: only 127.0.0.1 is accepted, and only from a loopback peer. An
 * operator who sets QOOPIA_HOST to one specific private address (a headless
 * install reached over a private network) gets that exact host:port accepted
 * as well, and only it. Wildcard binds are deliberately NOT trusted: they
 * carry no operator statement about which address is reachable.
 */
export function standaloneOwnerLoginHosts(): string[] {
  const bound = (process.env.QOOPIA_HOST || '').trim();
  const hosts = ['127.0.0.1'];
  if (bound && !['0.0.0.0', '::', '*', '127.0.0.1'].includes(bound)) hosts.push(bound);
  return hosts.map(host => (host.includes(':') ? `[${host}]` : host) + `:${env.PORT}`);
}

/** Hosted login is opt-in, HTTPS-only, and confined to configured dashboard hosts. */
export function ownerIdentityRequestAllowed(req: IncomingMessage, mutation = true) {
  if (!ownerIdentityEnabled()) return false;
  if (process.env.QOOPIA_STANDALONE === 'true') {
    const hosts = standaloneOwnerLoginHosts();
    const host = req.headers.host ?? '';
    if (!hosts.includes(host)) return false;
    if (hosts.length === 1 && !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')) return false;
    return !mutation || req.headers.origin === `http://${host}`;
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
