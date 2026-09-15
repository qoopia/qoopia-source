import {connectionOrigin, connectionResource, connectionIssuer, resourceConnection, publicConnection} from "../services/connection-identity.ts";
import crypto from "node:crypto";
import { db } from "../db/connection.ts";
import { sha256Hex } from "./api-keys.ts";
import { nowIso, QoopiaError } from "../utils/errors.ts";
import { env } from "../utils/env.ts";
import type { AuthContext } from "./middleware.ts";
import type { RiskClass } from "../mcp/tools.ts";

/**
 * OAuth 2.1 PKCE code flow with opaque tokens.
 * Codes and tokens are stored in the same table `oauth_tokens` with
 * `token_type ∈ {code, access, refresh}`.
 *
 * Endpoints:
 *  - GET  /.well-known/oauth-authorization-server
 *  - GET  /.well-known/oauth-protected-resource
 *  - GET  /oauth/authorize
 *  - POST /oauth/token
 *  - POST /oauth/revoke
 */

const CODE_TTL_SEC = 600; // 10 minutes
const ACCESS_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const PKCE_S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export const OAUTH_SCOPES = [
  "mcp:read",
  "mcp:write",
  "mcp:admin",
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

const OAUTH_SCOPE_SET = new Set<OAuthScope>(OAUTH_SCOPES);
const OAUTH_SCOPE_ORDER = new Map<OAuthScope, number>([
  ["mcp:read", 0],
  ["mcp:write", 1],
  ["mcp:admin", 2],
]);

export function normalizeScope(raw: string | null | undefined): {
  normalized: string;
  scopes: OAuthScope[];
} {
  const tokens = (raw || "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return { normalized: "", scopes: [] };
  }

  const seen = new Set<OAuthScope>();
  const scopes: OAuthScope[] = [];
  for (const token of tokens) {
    if (!OAUTH_SCOPE_SET.has(token as OAuthScope)) {
      throw new Error(`invalid_scope:${token}`);
    }
    const scope = token as OAuthScope;
    if (seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }

  scopes.sort((a, b) => OAUTH_SCOPE_ORDER.get(a)! - OAUTH_SCOPE_ORDER.get(b)!);
  return {
    normalized: scopes.join(" "),
    scopes,
  };
}

export function parseGrantedScope(raw: string | null | undefined): OAuthScope[] | undefined {
  const { scopes } = normalizeScope(raw);
  return scopes.length > 0 ? scopes : undefined;
}

export function grantedScopeAllowsRisk(
  scopes: readonly OAuthScope[] | undefined,
  risk: RiskClass,
): boolean {
  if (!scopes) return true; // API keys / legacy unscoped OAuth; callers still enforce the current profile.
  if (scopes.length === 0) return false; // An OAuth token with no grants has no authority.
  if (scopes.includes("mcp:admin")) return true;
  if (risk === "read") {
    return scopes.includes("mcp:read") || scopes.includes("mcp:write");
  }
  if (risk === "write-low") {
    return scopes.includes("mcp:write");
  }
  return false;
}

export function describeScope(scope: OAuthScope): string {
  switch (scope) {
    case "mcp:read":
      return "Read Qoopia memory and audit data without making changes.";
    case "mcp:write":
      return "Create and update non-destructive Qoopia records.";
    case "mcp:admin":
      return "Destructive and administrative MCP operations.";
  }
}

function genOpaque(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function plusSec(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeLoopbackHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackRedirectHost(hostname: string): boolean {
  const host = normalizeLoopbackHost(hostname);
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host === "::ffff:7f00:1"
  );
}

export function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length % 2 !== 0) return false;
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function assertValidPkceS256Challenge(challenge: string): void {
  if (!PKCE_S256_CHALLENGE_RE.test(challenge)) {
    throw new Error("invalid_request");
  }
}

export function assertValidPkceVerifier(verifier: string): void {
  if (!PKCE_VERIFIER_RE.test(verifier)) {
    throw new Error("invalid_request");
  }
}

export function oauthResource(): string { return new URL("/mcp", env.PUBLIC_URL).href; }

/** Every connection has a pinned MCP audience; never accept a caller-selected destination. */
export function validateOAuthResource(resource?: string | null): string {
  const expected = oauthResource();
  if (resource === undefined || resource === null || resource === expected) return expected;
  try { const id=resourceConnection(resource); if(id){publicConnection(id);return resource;} } catch {}
  throw new Error("invalid_target");
}

export interface OAuthTokenRecord {
  resource: string | null;
  token_hash: string;
  client_id: string;
  agent_id: string;
  workspace_id: string;
  token_type: "code" | "access" | "refresh";
  code_challenge: string | null;
  code_challenge_method: string | null;
  redirect_uri: string | null;
  granted_scope: string | null;
  expires_at: string;
  revoked: number;
  created_at: string;
}

export function findActiveToken(token: string): OAuthTokenRecord | null {
  const hash = sha256Hex(token);
  const row = db
    .prepare(
      `SELECT * FROM oauth_tokens WHERE token_hash = ? AND revoked = 0 LIMIT 1`,
    )
    .get(hash) as OAuthTokenRecord | undefined;
  if (!row) return null;
  if (row.expires_at <= nowIso()) return null;
  return row;
}

export function createAuthorizationCode(opts: {
  clientId: string;
  agentId: string;
  workspaceId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  grantedScope: string;
  resource?: string;
}): string {
  const resource = validateOAuthResource(opts.resource);
  const code = genOpaque("qc");
  const hash = sha256Hex(code);
  db.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, client_id, agent_id, workspace_id, token_type, code_challenge, code_challenge_method, redirect_uri, granted_scope, expires_at, revoked, created_at, resource)
     VALUES (?, ?, ?, ?, 'code', ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    hash,
    opts.clientId,
    opts.agentId,
    opts.workspaceId,
    opts.codeChallenge,
    opts.codeChallengeMethod,
    opts.redirectUri,
    opts.grantedScope,
    plusSec(CODE_TTL_SEC),
    nowIso(),
    resource,
  );
  return code;
}

export function exchangeCodeForTokens(opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}): { access: string; refresh: string; expiresInSec: number; grantedScope: string } {
  const resource = validateOAuthResource(opts.resource);
  assertValidPkceVerifier(opts.codeVerifier);

  // Validate client_secret before entering the transaction (read-only check)
  const clientRow = getClient(opts.clientId);
  if (clientRow && clientRow.client_secret_hash) {
    if (!opts.clientSecret) throw new Error("invalid_client");
    if (!constantTimeHexEqual(sha256Hex(opts.clientSecret), clientRow.client_secret_hash)) {
      throw new Error("invalid_client");
    }
  }

  return db.transaction(() => {
    const codeHash = sha256Hex(opts.code);
    // Atomically revoke the code — only succeeds if it exists and is still active
    const revokeInfo = db.prepare(
      `UPDATE oauth_tokens SET revoked = 1
       WHERE token_hash = ? AND revoked = 0 AND token_type = 'code'
         AND expires_at > ? AND client_id = ?
         AND EXISTS (
           SELECT 1
             FROM agents a
             JOIN oauth_clients c ON c.id = oauth_tokens.client_id
            WHERE a.id = oauth_tokens.agent_id
              AND a.active = 1
              AND a.workspace_id = oauth_tokens.workspace_id
              AND c.workspace_id = oauth_tokens.workspace_id
         )`,
    ).run(codeHash, nowIso(), opts.clientId);

    if (revokeInfo.changes !== 1) throw new Error("invalid_grant");

    // Fetch the code row we just revoked (for PKCE & redirect verification)
    const codeRow = db.prepare(
      `SELECT * FROM oauth_tokens WHERE token_hash = ?`,
    ).get(codeHash) as OAuthTokenRecord | undefined;
    if (!codeRow) throw new Error("invalid_grant");
    if (codeRow.resource && codeRow.resource !== (opts.resource ?? oauthResource())) throw new Error("invalid_target");
    if (codeRow.redirect_uri !== opts.redirectUri) throw new Error("invalid_grant");

    // PKCE verify
    const method = (codeRow.code_challenge_method || "S256").toUpperCase();
    let computed: string;
    if (method === "S256") {
      computed = crypto
        .createHash("sha256")
        .update(opts.codeVerifier)
        .digest("base64url");
    } else {
      computed = opts.codeVerifier;
    }
    if (computed !== codeRow.code_challenge) {
      throw new Error("invalid_grant");
    }

    // Issue tokens
    const access = genOpaque("qa");
    const refresh = genOpaque("qr");
    const now = nowIso();
    const stmt = db.prepare(
      `INSERT INTO oauth_tokens
        (token_hash, client_id, agent_id, workspace_id, token_type, granted_scope, expires_at, revoked, created_at, resource)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    stmt.run(
      sha256Hex(access),
      codeRow.client_id,
      codeRow.agent_id,
      codeRow.workspace_id,
      "access",
      codeRow.granted_scope,
      plusSec(ACCESS_TTL_SEC),
      now,
      resource,
    );
    stmt.run(
      sha256Hex(refresh),
      codeRow.client_id,
      codeRow.agent_id,
      codeRow.workspace_id,
      "refresh",
      codeRow.granted_scope,
      plusSec(REFRESH_TTL_SEC),
      now,
      resource,
    );
    return {
      access,
      refresh,
      expiresInSec: ACCESS_TTL_SEC,
      grantedScope: codeRow.granted_scope || "",
    };
  })();
}

export function refreshTokens(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}): { access: string; refresh: string; expiresInSec: number; grantedScope: string } {
  const resource = validateOAuthResource(opts.resource);
  // Validate client_secret before entering the transaction (read-only check)
  const clientRow = getClient(opts.clientId);
  if (clientRow && clientRow.client_secret_hash) {
    if (!opts.clientSecret) throw new Error("invalid_client");
    if (!constantTimeHexEqual(sha256Hex(opts.clientSecret), clientRow.client_secret_hash)) {
      throw new Error("invalid_client");
    }
  }

  return db.transaction(() => {
    const refreshHash = sha256Hex(opts.refreshToken);
    // Atomically revoke the refresh token — only succeeds once
    const revokeInfo = db.prepare(
      `UPDATE oauth_tokens SET revoked = 1
       WHERE token_hash = ? AND revoked = 0 AND token_type = 'refresh'
         AND expires_at > ? AND client_id = ?
         AND EXISTS (
           SELECT 1
             FROM agents a
             JOIN oauth_clients c ON c.id = oauth_tokens.client_id
            WHERE a.id = oauth_tokens.agent_id
              AND a.active = 1
              AND a.workspace_id = oauth_tokens.workspace_id
              AND c.workspace_id = oauth_tokens.workspace_id
         )`,
    ).run(refreshHash, nowIso(), opts.clientId);

    if (revokeInfo.changes !== 1) throw new Error("invalid_grant");

    // Fetch row for agent/workspace
    const row = db.prepare(
      `SELECT * FROM oauth_tokens WHERE token_hash = ?`,
    ).get(refreshHash) as OAuthTokenRecord | undefined;
    if (!row) throw new Error("invalid_grant");
    if (row.resource && row.resource !== resource) throw new Error("invalid_target");

    const access = genOpaque("qa");
    const refresh = genOpaque("qr");
    const now = nowIso();
    const stmt = db.prepare(
      `INSERT INTO oauth_tokens
        (token_hash, client_id, agent_id, workspace_id, token_type, granted_scope, expires_at, revoked, created_at, resource)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    stmt.run(
      sha256Hex(access),
      row.client_id,
      row.agent_id,
      row.workspace_id,
      "access",
      row.granted_scope,
      plusSec(ACCESS_TTL_SEC),
      now,
      resource,
    );
    stmt.run(
      sha256Hex(refresh),
      row.client_id,
      row.agent_id,
      row.workspace_id,
      "refresh",
      row.granted_scope,
      plusSec(REFRESH_TTL_SEC),
      now,
      resource,
    );
    return {
      access,
      refresh,
      expiresInSec: ACCESS_TTL_SEC,
      grantedScope: row.granted_scope || "",
    };
  })();
}


/**
 * Revoke a token only if it belongs to the specified client.
 * Per RFC 7009: confidential clients must authenticate with client_secret before revocation.
 * Public clients (no client_secret_hash) may revoke without a secret.
 */
export function revokeTokenForClient(
  token: string,
  clientId: string,
  clientSecret?: string,
): boolean {
  const client = getClient(clientId);
  if (!client) {
    // Unknown client — return false (RFC 7009: don't reveal token existence)
    return false;
  }
  // Confidential client: require and verify client_secret
  if (client.client_secret_hash) {
    if (!clientSecret) {
      throw new Error("invalid_client");
    }
    if (!constantTimeHexEqual(sha256Hex(clientSecret), client.client_secret_hash)) {
      throw new Error("invalid_client");
    }
  }
  const hash = sha256Hex(token);
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?`)
    .run(hash, clientId);
  return info.changes > 0;
}

/**
 * ADR-017 §1: only steward and claude-privileged agents may register OAuth
 * clients. Standard-agent-creates-connector is a quiet privilege escalation:
 * a compromised standard agent could mint an OAuth surface targeting its own
 * workspace data.
 *
 * Codex QSA-H (2026-04-28): registration must also be unreachable via OAuth
 * access tokens. Otherwise a single approved connector becomes a self-replicating
 * surface — the bearer can /oauth/register a new client, never expiring as long
 * as the original token lives. /oauth/register is api-key-only.
 */
export function assertCanRegisterOAuth(auth: AuthContext): void {
  if (auth.source !== "api-key") {
    throw new QoopiaError(
      "FORBIDDEN",
      "OAuth client registration requires a static API key (Bearer api_*); OAuth access tokens are not accepted on /oauth/register.",
    );
  }
  if (auth.type !== "steward" && auth.type !== "claude-privileged" && auth.type !== "owner") {
    throw new QoopiaError(
      "FORBIDDEN",
      "Only steward or claude-privileged agents may register OAuth clients.",
    );
  }
}

/**
 * RFC 7591 dynamic client registration (ADR-017 multi-tenant variant).
 *
 * The new client is bound to the calling agent's `agent_id` and to that
 * agent's `workspace_id` (snapshotted into oauth_clients.workspace_id by
 * migration 011). The legacy "first active agent in the default workspace"
 * inference is gone, as is the wsCount > 1 guard — multi-tenant is the
 * supported shape now.
 *
 * Caller must pre-authenticate the AuthContext and run
 * `assertCanRegisterOAuth(auth)` (the HTTP handler does this).
 */
export function registerClient(
  input: {
    client_name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
    grant_types?: string[];
    response_types?: string[];
  },
  auth: AuthContext,
): {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
} {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris must be a non-empty array");
  }
  for (const uri of input.redirect_uris) {
    if (typeof uri !== "string") {
      throw new Error(`Invalid redirect URI: must be a string`);
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`Invalid redirect URI: ${uri}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Invalid redirect URI scheme: ${uri} (only http/https allowed)`);
    }
    if (parsed.protocol === "http:" && !isLoopbackRedirectHost(parsed.hostname)) {
      throw new Error(
        `Invalid redirect URI: non-loopback http:// redirect URIs are not allowed (${uri})`,
      );
    }
  }

  const authMethod = input.token_endpoint_auth_method || "none";
  if (authMethod !== "none" && authMethod !== "client_secret_post" && authMethod !== "client_secret_basic") {
    throw new Error("token_endpoint_auth_method must be 'none', 'client_secret_post', or 'client_secret_basic'");
  }
  const isPublic = authMethod === "none";

  const client_id = `qc_${crypto.randomBytes(16).toString("base64url")}`;
  let client_secret: string | undefined;
  let secretHash = "";
  if (!isPublic) {
    client_secret = `qcs_${crypto.randomBytes(32).toString("base64url")}`;
    secretHash = sha256Hex(client_secret);
  }

  db.prepare(
    `INSERT INTO oauth_clients
       (id, name, agent_id, workspace_id, client_secret_hash, redirect_uris, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client_id,
    input.client_name || "Unnamed Client",
    auth.agent_id,
    auth.workspace_id,
    secretHash,
    JSON.stringify(input.redirect_uris),
    nowIso(),
  );

  return {
    client_id,
    ...(client_secret ? { client_secret } : {}),
    client_name: input.client_name || "Unnamed Client",
    redirect_uris: input.redirect_uris,
    grant_types: input.grant_types || ["authorization_code", "refresh_token"],
    response_types: input.response_types || ["code"],
    token_endpoint_auth_method: authMethod,
  };
}

/**
 * Look up a registered client by id. Returns the row or null.
 *
 * `workspace_id` was added by migration 011 (ADR-017) and may be NULL for
 * pre-existing rows that were created by older code paths and somehow
 * escaped the migration's backfill (e.g. an orphan agent_id). Callers that
 * need workspace-isolation checks must treat NULL as "wrong workspace" /
 * fail closed.
 */
export function getClient(client_id: string): {
  id: string;
  name: string;
  agent_id: string;
  workspace_id: string | null;
  client_secret_hash: string;
  redirect_uris: string[];
} | null {
  const row = db
    .prepare(`SELECT * FROM oauth_clients WHERE id = ?`)
    .get(client_id) as
    | {
        id: string;
        name: string;
        agent_id: string;
        workspace_id: string | null;
        client_secret_hash: string;
        redirect_uris: string;
      }
    | undefined;
  if (!row) return null;
  let uris: string[] = [];
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {}
  return { ...row, redirect_uris: uris };
}

/**
 * Resolve a client to its associated agent + workspace (single-user
 * auto-approve path). Returns null if client unknown or agent gone.
 */
export function clientWorkspace(client_id: string): {
  agent_id: string;
  workspace_id: string;
} | null {
  const c = getClient(client_id);
  if (!c) return null;
  // C2 fix: only return workspace if agent is still active
  const a = db
    .prepare(`SELECT id, workspace_id FROM agents WHERE id = ? AND active = 1`)
    .get(c.agent_id) as { id: string; workspace_id: string } | undefined;
  if (!a) return null;
  return { agent_id: a.id, workspace_id: a.workspace_id };
}

/**
 * Revoke all OAuth tokens for an agent (call on deactivation).
 */
export function revokeAllAgentTokens(agentId: string): number {
  const info = db
    .prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE agent_id = ? AND revoked = 0`)
    .run(agentId);
  return info.changes;
}

export function wellKnownAuthorizationServer(connection?:string) {
  const origin=connection?connectionOrigin(connection):env.PUBLIC_URL;
  return {
    issuer: connection ? connectionIssuer(connection) : env.OAUTH_ISSUER,
    authorization_endpoint: `${origin}/oauth/authorize${connection ? "?connection="+connection : ""}`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    registration_endpoint: `${origin}/oauth/register${connection ? "?connection="+connection : ""}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: connection ? (publicConnection(connection).access_mode === "read" ? ["mcp:read"] : ["mcp:read","mcp:write"]) : [...OAUTH_SCOPES],
    // RFC 9207: the authorization response carries an `iss` parameter.
    authorization_response_iss_parameter_supported: true,
  };
}

export function wellKnownProtectedResource(connection?:string) {
  return {
    resource: connection ? connectionResource(connection) : `${env.PUBLIC_URL}/mcp`,
    authorization_servers: [connection ? connectionIssuer(connection) : env.OAUTH_ISSUER],
    bearer_methods_supported: ["header"],
  };
}

// ---------- Consent tickets (ADR-017 cookie-bridge) ----------
//
// Each /oauth/authorize hit lands an in-flight ticket here. The ticket is the
// only state the dashboard side has to honor when finalizing — the OAuth
// surface itself never reads the dashboard cookie. The ticket id IS the
// browser-carried state; everything else is server-side.

const CONSENT_TICKET_TTL_SEC = 600; // 10 minutes (ADR-017 §2 "TTL")
/** Hard-delete grace window for finalized/expired/denied tickets. */
const CONSENT_TICKET_PRUNE_AFTER_SEC = 60 * 60; // 1h

export interface ConsentTicket {
  resource: string | null;
  id: string;
  client_id: string;
  workspace_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
  approved_by_agent_id: string | null;
  denied: number;
  redeemed: number;
  approve_nonce: string;
  created_at: string;
  expires_at: string;
}

/**
 * Create a fresh consent ticket. Caller is responsible for having validated
 * the OAuth params + client + redirect_uri allowlist before reaching here —
 * this function does not re-validate. `workspace_id` MUST be passed in and
 * MUST equal the client's workspace_id; the http handler reads it from
 * `getClient()` so that a NULL `oauth_clients.workspace_id` (legacy row)
 * still requires the caller to make a deliberate choice.
 */
export function createConsentTicket(opts: {
  clientId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource?: string;
}): ConsentTicket {
  const id = `qct_${crypto.randomBytes(16).toString("base64url")}`;
  const approve_nonce = `qcn_${crypto.randomBytes(16).toString("base64url")}`;
  const created_at = nowIso();
  const expires_at = plusSec(CONSENT_TICKET_TTL_SEC);
  db.prepare(
    `INSERT INTO consent_tickets
      (id, client_id, workspace_id, redirect_uri, code_challenge,
       code_challenge_method, scope, state, approve_nonce, created_at, expires_at, resource)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.clientId,
    opts.workspaceId,
    opts.redirectUri,
    opts.codeChallenge,
    opts.codeChallengeMethod,
    opts.scope,
    opts.state,
    approve_nonce,
    created_at,
    expires_at,
    validateOAuthResource(opts.resource),
  );
  return {
    id,
    client_id: opts.clientId,
    workspace_id: opts.workspaceId,
    resource: validateOAuthResource(opts.resource),
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: opts.codeChallengeMethod,
    scope: opts.scope,
    state: opts.state,
    approved_by_agent_id: null,
    denied: 0,
    redeemed: 0,
    approve_nonce,
    created_at,
    expires_at,
  };
}

export function getConsentTicket(id: string): ConsentTicket | null {
  const row = db
    .prepare(`SELECT * FROM consent_tickets WHERE id = ?`)
    .get(id) as ConsentTicket | undefined;
  return row || null;
}

export type ConsentTicketState =
  | "ok"
  | "not_found"
  | "expired"
  | "redeemed"
  | "denied"
  | "already_finalized";

/**
 * Returns a string describing the ticket's terminal status, or "ok" if the
 * ticket is still in-flight (whether or not approved). Expiry is checked
 * against system clock.
 */
export function consentTicketStatus(t: ConsentTicket | null): ConsentTicketState {
  if (!t) return "not_found";
  if (t.redeemed) return "redeemed";
  if (t.denied) return "denied";
  if (t.expires_at <= nowIso()) return "expired";
  return "ok";
}

/**
 * Mark the ticket approved by the supplied agent. Atomic: only succeeds if
 * the ticket exists, is not already approved/denied/redeemed, and is not
 * expired. Callers SHOULD also have already verified the approve_nonce and
 * (defense-in-depth) that the agent's workspace matches the ticket.
 *
 * Returns true on success, false on any not-found / wrong-state / expired
 * condition.
 */
export function approveConsentTicket(
  ticketId: string,
  agentId: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET approved_by_agent_id = ?
        WHERE id = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(agentId, ticketId, nowIso());
  return info.changes === 1;
}

/**
 * Atomically rotate the approve_nonce on a still-in-flight ticket. Used by
 * the dashboard consent GET handler so each render of the consent UI hands
 * the operator a fresh, single-use nonce. Returns the new nonce on success
 * or null if the ticket is missing / expired / already finalized.
 */
export function rotateConsentNonce(ticketId: string): string | null {
  const fresh = `qcn_${crypto.randomBytes(16).toString("base64url")}`;
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET approve_nonce = ?
        WHERE id = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(fresh, ticketId, nowIso());
  return info.changes === 1 ? fresh : null;
}

/**
 * Atomically consume a ticket's approve_nonce. Single-use: the row's
 * approve_nonce is rotated to a fresh random string after a successful
 * compare so the same nonce cannot be replayed even if it leaks.
 *
 * Note: this is purely best-effort defense-in-depth. The dashboard handler
 * still has to verify the cookie, the Origin, and the workspace match.
 */
export function consumeConsentNonce(ticketId: string, nonce: string): boolean {
  const replacement = `qcn_${crypto.randomBytes(16).toString("base64url")}`;
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET approve_nonce = ?
        WHERE id = ?
          AND approve_nonce = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(replacement, ticketId, nonce, nowIso());
  return info.changes === 1;
}

/**
 * Mark the ticket denied. Atomic: only succeeds for an in-flight ticket
 * (not already approved/denied/redeemed/expired).
 */
export function denyConsentTicket(ticketId: string): boolean {
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET denied = 1
        WHERE id = ?
          AND approved_by_agent_id IS NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?`,
    )
    .run(ticketId, nowIso());
  return info.changes === 1;
}

/**
 * Single-use redeem on the finalize path. Atomic: only succeeds if the
 * ticket has been approved, has not been redeemed yet, has not been denied,
 * has not expired, AND the approving agent is still active in the same
 * workspace as the ticket. Replay attempts return false.
 *
 * Codex HIGH #1 round 2 (2026-04-28): the EXISTS subquery on agents was
 * added to close a TOCTOU window between finalize's pre-check SELECT and
 * this UPDATE. Previously, an approver could be deactivated or moved
 * between the two statements and the redeem would still succeed. Folding
 * both predicates into the same SQL statement makes the check atomic
 * (SQLite serializes statement execution), so the only way this UPDATE
 * succeeds is if the approver is still active and workspace-matched at the
 * moment of redeem.
 */
export function redeemConsentTicket(ticketId: string): boolean {
  const info = db
    .prepare(
      `UPDATE consent_tickets
          SET redeemed = 1
        WHERE id = ?
          AND approved_by_agent_id IS NOT NULL
          AND denied = 0
          AND redeemed = 0
          AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM agents a
             WHERE a.id = consent_tickets.approved_by_agent_id
               AND a.active = 1
               AND a.workspace_id = consent_tickets.workspace_id
          )`,
    )
    .run(ticketId, nowIso());
  return info.changes === 1;
}

/**
 * Hard-delete tickets whose audit retention window has elapsed.
 *
 * Codex MED #6 (2026-04-28): the prior version anchored the grace window on
 * `created_at`, so redeemed/denied tickets could be deleted only `grace - δ`
 * after the terminal event (where δ = "how long approval took"). Retention
 * effectively varied with operator latency, weakening the audit trail.
 *
 * Schema-light fix: anchor on `expires_at` instead. Every ticket — pending,
 * redeemed, denied, or expired — is retained for at least `expires_at +
 * CONSENT_TICKET_PRUNE_AFTER_SEC`. That gives:
 *   - predictable retention (TTL + grace from creation, deterministic),
 *   - no tightening of the window when an operator approves quickly,
 *   - no schema churn (no `redeemed_at`/`denied_at` columns needed).
 *
 * The `redeemed = 1 OR denied = 1` branch is dropped — we already wait for
 * `expires_at < cutoff`, which is a strict superset (TTL is always finite).
 */
export function pruneConsentTickets(): number {
  const cutoffIso = new Date(Date.now() - CONSENT_TICKET_PRUNE_AFTER_SEC * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const info = db
    .prepare(
      `DELETE FROM consent_tickets
        WHERE expires_at < ?`,
    )
    .run(cutoffIso);
  return info.changes;
}
