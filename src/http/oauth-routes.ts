/** OAuth 2.1 endpoints of the HTTP server: authorize and finalize, dynamic client registration,
 * the dashboard-scoped consent bridge (ADR-017), token and revoke. */
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { brandHead, brandLockup } from "../brand.ts";
import { browserAgent } from "../services/browser-connections.ts";
import { connectionOrigin, connectionResource, connectionIssuer, resourceConnection, publicConnection } from "../services/connection-identity.ts";
import { ownerIdentity } from "../identity/local.ts";
import {
  checkDashboardAuth,
  originAllowed as dashboardOriginAllowed,
  dashboardOriginDiagnostics,
  type DashboardAuth,
} from "../dashboard-api.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { stringArrayEquals, stringArraySubsetOf, isChatGptRedirectArray } from "../auth/dcr-policy.ts";
import {
  createAuthorizationCode,
  exchangeCodeForTokens,
  refreshTokens,
  revokeTokenForClient,
  registerClient,
  assertCanRegisterOAuth,
  getClient,
  createConsentTicket,
  getConsentTicket,
  consentTicketStatus,
  approveConsentTicket,
  denyConsentTicket,
  redeemConsentTicket,
  consumeConsentNonce,
  rotateConsentNonce,
  pruneConsentTickets,
  normalizeScope,
  parseGrantedScope,
  describeScope,
  assertValidPkceS256Challenge,
  validateOAuthResource,
} from "../auth/oauth.ts";
import { QoopiaError } from "../utils/errors.ts";
import { db } from "../db/connection.ts";
import { env } from "../utils/env.ts";
import { logger } from "../utils/logger.ts";
import { audit } from "../utils/audit.ts";
import { isReadOnlyInstance } from "../utils/instance-role.ts";
import { escapeHtml, json, securityHeaders, sendHtml } from "./respond.ts";

/** Where the owner identity lives: the standalone layout root, or the server root. */
export function connectionIdentityRoot():string|undefined {
  return process.env.QOOPIA_STANDALONE==='true'?
    (process.env.QOOPIA_STANDALONE_LAYOUT?JSON.parse(process.env.QOOPIA_STANDALONE_LAYOUT).root:undefined):env.ROOT_DIR;
}

// ADR-017: in-memory consentNonces is gone. Consent is brokered through
// the consent_tickets table; nonces live as `approve_nonce` columns and are
// rotated atomically. The dashboard-side approve POST uses
// consumeConsentNonce() for one-time semantics.
// Short-lived replay cache for OAuth finalize redirects. Browser-mediated
// OAuth can double-hit /oauth/authorize/finalize after a successful consent
// handoff; the ticket must stay single-use, but a duplicate GET should see the
// same redirect instead of surfacing {ticket redeemed} to the operator.
const finalizeRedirectReplay = new Map<string, { location: string; expiresAtMs: number }>();
export function rememberFinalizeRedirect(ticketId: string, location: string): void {
  finalizeRedirectReplay.set(ticketId, { location, expiresAtMs: Date.now() + 10 * 60_000 });
}
export function replayFinalizeRedirect(ticketId: string): string | null {
  const row = finalizeRedirectReplay.get(ticketId);
  if (!row) return null;
  if (row.expiresAtMs <= Date.now()) {
    finalizeRedirectReplay.delete(ticketId);
    return null;
  }
  return row.location;
}

export function oauthAlreadyCompletedHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorization already completed</title>
  ${brandHead}
</head>
<body class="q-auth">
  <main>${brandLockup}
    <h1>Authorization already completed</h1>
    <p>This OAuth approval link was already used.</p>
    <p>You can close this tab and return to Claude.</p>
    <p>If Claude still does not show the connector, start a new connector flow.</p>
  </main>
</body>
</html>`;
}


// Periodic GC for finalized/expired/denied consent_tickets. Runs on the
// process's main interval; cheap because the SQL is indexed on expires_at.
let _consentTicketGc: ReturnType<typeof setInterval> | null = null;
export function startConsentTicketGc(): void {
  if (_consentTicketGc || isReadOnlyInstance()) return;
  _consentTicketGc = setInterval(() => {
    try {
      pruneConsentTickets();
    } catch (err) {
      logger.warn("pruneConsentTickets failed", { error: String(err) });
    }
  }, 60_000);
  // Don't keep the process alive for the GC alone — when the http server
  // closes, the timer should not block test exit.
  if (typeof _consentTicketGc.unref === "function") _consentTicketGc.unref();
}
export function stopConsentTicketGc(): void {
  if (_consentTicketGc) {
    clearInterval(_consentTicketGc);
    _consentTicketGc = null;
  }
}

// ---------- OAuth handlers ----------

// ADR-017: checkAdminSecret() and verifyConsentSecret() are deleted along
// with the consent HTML form. Approval is brokered through a dashboard-side
// POST authenticated by the qoopia_dash cookie (per ADR-015), and OAuth
// client registration is gated on Bearer api_key + steward/claude-priv type.

export function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const s = body.toString("utf8");
  for (const pair of s.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    let key: string;
    let val: string;
    try {
      key = decodeURIComponent(k);
      val = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      // Malformed percent-encoding — throw controlled 400 (caught by callers)
      throw Object.assign(new Error("invalid_request"), { statusCode: 400 });
    }
    out[key] = val;
  }
  return out;
}

/**
 * Parse an application/json token-endpoint body into the same flat string map
 * parseForm produces. Some MCP clients (incl. claude.ai) POST /oauth/token as
 * application/json instead of the RFC6749 x-www-form-urlencoded; without this
 * branch the body was unreadable → grant_type undefined → unsupported_grant_type
 * → no access token (claude.ai connector stuck at code→token exchange).
 */
export function parseJsonForm(body: Buffer): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_request"), { statusCode: 400 });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("invalid_request"), { statusCode: 400 });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    // nested objects/arrays are ignored — OAuth token params are flat scalars
  }
  return out;
}

/**
 * ADR-017: GET /oauth/authorize.
 *
 * The /oauth/* surface trusts no browser-carried state beyond an opaque
 * ticket id. This handler:
 *   - validates OAuth params + the registered client + the redirect_uri
 *     allowlist (same as before),
 *   - snapshots the parameters into a server-side consent_ticket row,
 *   - 302s the browser to /api/dashboard/oauth-consent?ticket=<id>.
 *
 * The dashboard-scoped consent UI then handles cookie auth, workspace
 * matching, and approval. No HTML is rendered here, no cookies are read.
 */
export function handleAuthorizeRedirect(
  req: IncomingMessage,
  res: ServerResponse,
  clientIp: string,
) {
  const u = new URL(req.url || "/", env.PUBLIC_URL);
  const clientId = u.searchParams.get("client_id");
  const redirectUri = u.searchParams.get("redirect_uri");
  const responseType = u.searchParams.get("response_type");
  const codeChallenge = u.searchParams.get("code_challenge");
  const codeChallengeMethod = u.searchParams.get("code_challenge_method") || "S256";
  const state = u.searchParams.get("state") || "";
  const selectedConnection=u.searchParams.get("connection");
  let resource: string;
  let scope = "";
  try {
    if (u.searchParams.getAll("resource").length > 1) throw new Error("invalid_target");
    resource=validateOAuthResource(u.searchParams.get("resource") ?? (selectedConnection?connectionResource(selectedConnection):undefined));
  } catch { return json(res, 400, {error: "invalid_target"}); }
  logger.info(`OAuth authorize ENTER client=${clientId || "<none>"} redirect=${redirectUri || "<none>"} has_state=${state ? "y" : "n"} ua=${(req.headers["user-agent"] || "").slice(0, 40)}`);

  try {
    scope = normalizeScope(u.searchParams.get("scope")).normalized;
  } catch (err) {
    const msg = (err as Error).message || "invalid_scope";
    if (msg.startsWith("invalid_scope:")) {
      return json(res, 400, {
        error: "invalid_scope",
        error_description: `Unknown scope '${msg.slice("invalid_scope:".length)}'`,
      });
    }
    throw err;
  }

  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
    return json(res, 400, {
      error: "invalid_request",
      error_description:
        "Missing required: client_id, redirect_uri, response_type=code, code_challenge",
    });
  }
  if (codeChallengeMethod !== "S256") {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Only S256 code_challenge_method is supported",
    });
  }
  try {
    assertValidPkceS256Challenge(codeChallenge);
  } catch {
    return json(res, 400, {
      error: "invalid_request",
      error_description:
        "code_challenge must be a 43-character base64url S256 challenge",
    });
  }

  const client = getClient(clientId);
  if (!client) {
    return json(res, 400, {
      error: "invalid_client",
      error_description: "Unknown client_id — register first via /oauth/register",
    });
  }
  const assignedConnection=db.query("SELECT id FROM client_connections WHERE agent_id=?").get(client.agent_id) as {id:string}|null;
  if(assignedConnection && resource !== connectionResource(assignedConnection.id))return json(res,400,{error:'invalid_target'});
  const resourceId=resourceConnection(resource!);
  if(resourceId){
    const connection=publicConnection(resourceId);
    if(client.agent_id!==connection.agent_id||client.workspace_id!==connection.workspace_id)return json(res,400,{error:"invalid_target"});
    if(connection.access_mode==="read"&&scope.split(" ").some(s=>s!=="mcp:read"))return json(res,400,{error:"invalid_scope"});
    if(scope.includes("mcp:admin"))return json(res,400,{error:"invalid_scope"});
    if(!scope)scope=connection.access_mode==="read"?"mcp:read":"mcp:read mcp:write";
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri not registered for this client",
    });
  }
  if (!client.workspace_id) {
    // Legacy oauth_clients row that escaped migration 011's backfill.
    // Refuse rather than silently bind to whatever workspace getClient()
    // would have inferred — fail-closed per ADR-017 §Migration.
    return json(res, 500, {
      error: "server_error",
      error_description:
        "OAuth client is not bound to a workspace. Re-register the client.",
    });
  }

  const ticket = createConsentTicket({
    clientId,
    workspaceId: client.workspace_id,
    resource: resource!,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    state,
  });

  audit({
    event: "oauth_consent",
    result: "allow",
    ip: clientIp,
    workspace_id: client.workspace_id,
    detail: `client=${clientId} ticket_fp=${fingerprintIdentifier(ticket.id, 12)} created`,
  });

  // Every new authorization goes through consent, including trusted client callbacks.
  // Account-bound connections use the dedicated consent surface. The existing
  // local owner consent remains available for installations without an account binding.
  const identityRoot=connectionIdentityRoot(),binding=identityRoot?ownerIdentity(identityRoot):null;
  const remote=!!(resourceId&&binding&&connectionOrigin(resourceId).startsWith('https://')&&publicConnection(resourceId).owner_id===binding.ownerId);
  const consentOrigin=remote?connectionOrigin(resourceId!):process.env.QOOPIA_STANDALONE==='true'?`http://127.0.0.1:${env.PORT}`:resourceId?connectionOrigin(resourceId):env.PUBLIC_URL;
  const target = new URL(remote?'/oauth/consent':"/api/dashboard/oauth-consent", consentOrigin);
  target.searchParams.set("ticket", ticket.id);
  res.writeHead(302, {
    location: target.toString(),
    "cache-control": "no-store",
  });
  res.end();
}

/**
 * ADR-017: GET /oauth/authorize/finalize?ticket=...
 *
 * Reads the consent_ticket, requires it to be approved-but-not-redeemed-and-
 * not-expired-and-not-denied, atomically marks redeemed=1, emits the OAuth
 * code, and 302s to client.redirect_uri. Single-use: replaying the URL
 * returns 400.
 *
 * Cookies are NOT read here. The only state trusted is the ticket row,
 * whose `approved_by_agent_id` was set by the dashboard-side approve POST.
 */
export function handleAuthorizeFinalize(
  req: IncomingMessage,
  res: ServerResponse,
  clientIp: string,
) {
  const u = new URL(req.url || "/", env.PUBLIC_URL);
  const ticketId = u.searchParams.get("ticket") || "";
  const ticketFp = ticketId ? fingerprintIdentifier(ticketId, 12) : "";
  logger.info(`OAuth finalize ENTER ticket_fp=${ticketFp} ua=${(req.headers["user-agent"] || "").slice(0, 50)}`);
  if (!ticketId) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing ticket parameter",
    });
  }
  const ticket = getConsentTicket(ticketId);
  if (!ticket) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket not found",
    });
  }
  if (ticket.redeemed) {
    const replayLocation = replayFinalizeRedirect(ticket.id);
    if (replayLocation) {
      logger.info(`OAuth finalize REPLAY-redirect ticket_fp=${ticketFp}`);
      res.writeHead(302, {
        location: replayLocation,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    logger.warn(`OAuth finalize ALREADY-USED (redeemed, no replay entry) ticket_fp=${ticketFp}`);
    return sendHtml(res, 400, oauthAlreadyCompletedHtml(), req);
  }
  if (ticket.denied) {
    return json(res, 400, {
      error: "access_denied",
      error_description: "ticket denied",
    });
  }
  if (ticket.expires_at <= nowIsoUtc()) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket expired",
    });
  }
  if (!ticket.approved_by_agent_id) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket not approved",
    });
  }
  const client = getClient(ticket.client_id);
  if (!client) {
    return json(res, 400, { error: "invalid_client" });
  }
  // Codex HIGH #1 (2026-04-28): re-verify the *approving agent's current
  // workspace* still matches the ticket's workspace, not the registering
  // client owner's. The previous version called clientWorkspace(client_id),
  // which resolves the registrar — that doesn't catch the actual drift case
  // (approver moves workspaces between approve and finalize). Also reject
  // if the approver was deactivated in the gap.
  const approver = db
    .prepare(
      `SELECT id, workspace_id, active FROM agents WHERE id = ?`,
    )
    .get(ticket.approved_by_agent_id) as
    | { id: string; workspace_id: string; active: number }
    | undefined;
  if (!approver || !approver.active) {
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      workspace_id: ticket.workspace_id,
      agent_id: ticket.approved_by_agent_id,
      detail: `finalize: approver missing/inactive ticket_fp=${ticketFp}`,
    });
    return json(res, 400, {
      error: "invalid_request",
      error_description: "approving agent is no longer active",
    });
  }
  if (approver.workspace_id !== ticket.workspace_id) {
    audit({
      event: "workspace_mismatch",
      result: "deny",
      ip: clientIp,
      workspace_id: ticket.workspace_id,
      agent_id: ticket.approved_by_agent_id,
      detail: `finalize: approver moved workspaces ticket=${ticket.workspace_id} approver_now=${approver.workspace_id}`,
    });
    return json(res, 400, {
      error: "invalid_request",
      error_description: "approving agent's workspace no longer matches the ticket",
    });
  }

  // Atomic redeem; fails if a parallel request already redeemed OR if the
  // approver/workspace state drifted between the pre-check SELECT above
  // and this UPDATE. The redeemConsentTicket UPDATE folds the approver
  // active+workspace predicates into the same statement (Codex HIGH #1
  // round 2, 2026-04-28), so this is fully atomic in SQLite. If the
  // pre-check passed but redeem failed, log the race-loss for forensics —
  // the only ways for that to happen are (a) parallel finalize won the
  // race, or (b) approver state flipped in the gap.
  if (!redeemConsentTicket(ticket.id)) {
    logger.warn(`OAuth finalize REDEEM-RACE-LOST (parallel finalize won or approver drift) ticket_fp=${ticketFp}`);
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      workspace_id: ticket.workspace_id,
      agent_id: ticket.approved_by_agent_id,
      detail: `finalize: redeem race lost or approver drift after pre-check ticket_fp=${ticketFp}`,
    });
    return sendHtml(res, 400, oauthAlreadyCompletedHtml(), req);
  }

  const code = createAuthorizationCode({
    clientId: ticket.client_id,
    // Bind the OAuth code to the *approving* agent's id so the resulting
    // token is workspace-scoped to the operator who approved (ADR-017 §4).
    agentId: ticket.approved_by_agent_id,
    workspaceId: ticket.workspace_id,
    codeChallenge: ticket.code_challenge,
    codeChallengeMethod: ticket.code_challenge_method,
    redirectUri: ticket.redirect_uri,
    grantedScope: ticket.scope,
    resource: ticket.resource ?? undefined,
  });

  audit({
    event: "oauth_consent",
    result: "allow",
    ip: clientIp,
    workspace_id: ticket.workspace_id,
    agent_id: ticket.approved_by_agent_id,
    detail: `client=${ticket.client_id} ticket_fp=${ticketFp} finalized`,
  });

  const url = new URL(ticket.redirect_uri);
  url.searchParams.set("code", code);
  if (ticket.state) url.searchParams.set("state", ticket.state);
  // RFC 9207 Authorization Server Issuer Identification — strict OAuth 2.1 / MCP
  // clients (incl. claude.ai) require `iss` in the authorization response and
  // silently drop the callback (no token exchange) when it is absent.
  url.searchParams.set("iss", ticket.resource && resourceConnection(ticket.resource) ? connectionIssuer(resourceConnection(ticket.resource)!) : env.OAUTH_ISSUER);
  const redirectLocation = url.toString();
  rememberFinalizeRedirect(ticket.id, redirectLocation);
  logger.info(`OAuth finalize SUCCESS → 302 host=${url.host} path=${url.pathname} has_state=${ticket.state ? "y" : "n"} ticket_fp=${ticketFp}`);
  res.writeHead(302, {
    location: redirectLocation,
    "cache-control": "no-store",
  });
  res.end();
}

const CLAUDE_AI_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_PRIVILEGED_AGENT_ID = "01CLAUDE0CODE0AGENT0000001";
const PUBLIC_DCR_AGENT_NAME = process.env.QOOPIA_PUBLIC_DCR_AGENT_NAME || "GPT";
const PUBLIC_DCR_WORKSPACE_SLUG = process.env.QOOPIA_PUBLIC_DCR_WORKSPACE_SLUG || "default";
export function authContextFromAgentRow(row: {
  id: string;
  name: string;
  workspace_id: string;
  type: string;
  tool_profile?: string | null;
}): AuthContext {
  return {
    agent_id: row.id,
    agent_name: row.name,
    workspace_id: row.workspace_id,
    type: row.type,
    source: "api-key",
    tool_profile: row.tool_profile ?? null,
  };
}

export function resolveChatGptUnauthenticatedDcrAuth(parsed: Record<string, unknown>): AuthContext | null {
  if (!isChatGptRedirectArray(parsed.redirect_uris)) return null;
  if (
    parsed.token_endpoint_auth_method !== undefined &&
    parsed.token_endpoint_auth_method !== "none" &&
    parsed.token_endpoint_auth_method !== "client_secret_post" &&
    parsed.token_endpoint_auth_method !== "client_secret_basic"
  ) {
    return null;
  }
  if (!stringArraySubsetOf(parsed.grant_types, ["authorization_code", "refresh_token"])) {
    return null;
  }
  if (!stringArraySubsetOf(parsed.response_types, ["code"])) return null;

  const v1=browserAgent('GPT');
  if(v1!==undefined)return v1?authContextFromAgentRow(v1):null;

  const row = db
    .prepare(
      `SELECT a.id, a.name, a.workspace_id, a.type, a.tool_profile
         FROM agents a
         JOIN workspaces w ON w.id = a.workspace_id
        WHERE a.name = ? AND w.slug = ? AND a.active = 1 AND a.type = 'claude-privileged'
        LIMIT 1`,
    )
    .get(PUBLIC_DCR_AGENT_NAME, PUBLIC_DCR_WORKSPACE_SLUG) as
    | { id: string; name: string; workspace_id: string; type: string; tool_profile?: string | null }
    | undefined;

  return row ? authContextFromAgentRow(row) : null;
}

type TrustedDcrAuth = { auth: AuthContext; detail: string };

export function resolveTrustedUnauthenticatedDcrAuth(body: Buffer): TrustedDcrAuth | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }

  const claudeAiAuth = resolveClaudeAiUnauthenticatedDcrAuthParsed(parsed);
  if (claudeAiAuth) {
    return { auth: claudeAiAuth, detail: "claude.ai restricted unauthenticated DCR" };
  }

  const chatGptAuth = resolveChatGptUnauthenticatedDcrAuth(parsed);
  if (chatGptAuth) {
    return { auth: chatGptAuth, detail: "chatgpt restricted unauthenticated DCR" };
  }

  // ADR-018: generic unauthenticated DCR is closed. Only the two explicit
  // connector profiles above may self-register without an API-key identity.
  return null;
}

/**
 * Claude.ai still relies on RFC 7591 Dynamic Client Registration when adding
 * a custom MCP connector. ADR-017 correctly closed generic unauthenticated DCR,
 * but that also broke Claude.ai self-registration. Keep the unauthenticated
 * exception intentionally tiny: only Claude's fixed callback URL, public or
 * client_secret_post auth, authorization_code/refresh_token grants, code response, and only bound
 * to the default claude-privileged agent.
 */
export function resolveClaudeAiUnauthenticatedDcrAuthParsed(parsed: Record<string, unknown>): AuthContext | null {
  if (!stringArrayEquals(parsed.redirect_uris, [CLAUDE_AI_REDIRECT_URI])) return null;
  if (
    parsed.token_endpoint_auth_method !== undefined &&
    parsed.token_endpoint_auth_method !== "none" &&
    parsed.token_endpoint_auth_method !== "client_secret_post"
  ) {
    return null;
  }
  if (!stringArraySubsetOf(parsed.grant_types, ["authorization_code", "refresh_token"])) {
    return null;
  }
  if (!stringArraySubsetOf(parsed.response_types, ["code"])) return null;

  const v1=browserAgent('Claude');
  if(v1!==undefined)return v1?authContextFromAgentRow(v1):null;

  const row = db
    .prepare(
      `SELECT id, name, workspace_id, type, tool_profile
         FROM agents
        WHERE id = ? AND active = 1 AND type = 'claude-privileged'
        LIMIT 1`,
    )
    .get(CLAUDE_PRIVILEGED_AGENT_ID) as
    | { id: string; name: string; workspace_id: string; type: string; tool_profile?: string | null }
    | undefined;

  const fallback = row ?? (db
    .prepare(
      `SELECT id, name, workspace_id, type, tool_profile
         FROM agents
        WHERE active = 1 AND type = 'claude-privileged'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get() as
    | { id: string; name: string; workspace_id: string; type: string; tool_profile?: string | null }
    | undefined);

  if (!fallback) return null;
  return authContextFromAgentRow(fallback);
}

export function handleRegister(
  body: Buffer,
  res: ServerResponse,
  auth: AuthContext,
) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Body must be JSON",
    });
  }
  try {
    const out = registerClient(
      {
        client_name: parsed.client_name as string | undefined,
        redirect_uris: parsed.redirect_uris as string[],
        token_endpoint_auth_method:
          parsed.token_endpoint_auth_method as string | undefined,
        grant_types: parsed.grant_types as string[] | undefined,
        response_types: parsed.response_types as string[] | undefined,
      },
      auth,
    );
    logger.info(
      `OAuth register client_id=${out.client_id} name="${out.client_name}" auth=${out.token_endpoint_auth_method} workspace=${auth.workspace_id}`,
    );
    res.writeHead(201, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        ...out,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(out.client_secret ? { client_secret_expires_at: 0 } : {}),
      }),
    );
  } catch (err) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: err instanceof Error ? err.message : String(err),
    });
  }
}

// nowIsoUtc trims sub-second precision to align with `nowIso()` in
// auth/oauth.ts so SQL string compares (`expires_at <= ?`) match.
export function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------- Dashboard-scoped OAuth consent bridge (ADR-017) ----------

export function escapeHtmlSafe(s: string): string {
  return escapeHtml(s);
}

/**
 * Codex QSA-H (2026-04-28): the consent surface must reject:
 *
 *   1) OAuth access tokens — checkDashboardAuth() falls back to Bearer when
 *      the cookie is absent, and authenticate() accepts both api-key bearers
 *      AND OAuth access tokens. If we let an OAuth bearer in here, an existing
 *      OAuth client could fetch the consent page, read the rotated nonce, and
 *      self-approve a new ticket — defeating the bridge pattern entirely.
 *
 *   2) standard agents — registration is restricted to steward/claude-priv
 *      (assertCanRegisterOAuth), so consent (which trusts a connector with the
 *      caller's full agent surface) must be at least as restrictive. A standard
 *      agent in the same workspace approving a ticket would mint OAuth tokens
 *      bound to itself.
 *
 * Returns null if eligible, else a short reason code for the caller to
 * translate into the right HTTP shape.
 */
export function oauthConsentRejection(
  auth: DashboardAuth,
): "oauth_token_not_accepted" | "consent_requires_admin" | null {
  if (auth.source === "oauth") return "oauth_token_not_accepted";
  if (!auth.isAdmin) return "consent_requires_admin";
  return null;
}

/**
 * GET /api/dashboard/oauth-consent?ticket=<id>
 *
 * The browser was 302'd here from /oauth/authorize. The dashboard cookie
 * auto-attaches because the path is /api/dashboard/*. We:
 *   - look up the ticket; reject if missing/expired/finalized,
 *   - require a verified dashboard cookie (no Bearer fallback) — the
 *     primary user is a browser session,
 *   - check cookie.workspace_id === ticket.workspace_id; mismatch renders
 *     a "wrong workspace" page with no approve button,
 *   - else rotate `approve_nonce` and render the consent UI.
 */
export function handleDashboardOAuthConsentGet(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const u = new URL(req.url || "/", env.PUBLIC_URL);
  const ticketId = u.searchParams.get("ticket") || "";
  if (!ticketId) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing ticket parameter",
    });
  }
  const ticket = getConsentTicket(ticketId);
  const status = consentTicketStatus(ticket);
  if (status === "not_found") {
    return json(res, 404, {
      error: "not_found",
      error_description: "ticket not found",
    });
  }
  if (status !== "ok") {
    if (status === "redeemed") {
      return sendHtml(res, 400, oauthAlreadyCompletedHtml(), req);
    }
    return json(res, 400, {
      error: "invalid_request",
      error_description: `ticket ${status}`,
    });
  }

  const auth = checkDashboardAuth(req);
  if (!auth) {
    // Not logged into dashboard → bounce through /dashboard?next=...
    const next = `/api/dashboard/oauth-consent?ticket=${encodeURIComponent(ticketId)}`;
    const target = `/dashboard?next=${encodeURIComponent(next)}`;
    res.writeHead(302, { location: target, "cache-control": "no-store" });
    return res.end();
  }
  // QSA-H: reject OAuth bearers and standard agents — see oauthConsentRejection().
  const reject = oauthConsentRejection(auth);
  if (reject) {
    audit({
      event: "oauth_consent",
      result: "deny",
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent GET rejected reason=${reject} source=${auth.source} type=${auth.type}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description:
        reject === "oauth_token_not_accepted"
          ? "OAuth access tokens are not accepted on the consent surface; sign in to the dashboard with a static API key."
          : "OAuth client consent requires a steward or claude-privileged agent.",
    });
  }

  const t = ticket!;
  const client = getClient(t.client_id);
  const safeClientName = escapeHtmlSafe(client?.name || "Unknown client");
  const requestedScopes = parseGrantedScope(t.scope) || [];
  const scopeRows = requestedScopes.length > 0
    ? requestedScopes
        .map(
          (scope) =>
            `<li><strong>${escapeHtmlSafe(scope)}</strong> — ${escapeHtmlSafe(describeScope(scope))}</li>`,
        )
        .join("")
    : `<li><strong>legacy/full agent profile</strong> — this client did not request explicit OAuth scopes, so access is limited by the connected agent’s MCP tool profile.</li>`;

  const sharedCss = `.scope-list{padding-left:24px}.info.warn{border:2px solid var(--qoopia-white);padding:16px}`;

  if (auth.workspace_id !== t.workspace_id) {
    audit({
      event: "workspace_mismatch",
      result: "deny",
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent GET cookie=${auth.workspace_id} ticket=${t.workspace_id}`,
    });
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Wrong workspace — Qoopia</title><meta name="viewport" content="width=device-width,initial-scale=1">
  ${brandHead}<style>${sharedCss}</style>
</head>
<body class="q-auth">
  <div class="card">
    ${brandLockup}
    <h1>Wrong workspace</h1>
    <p class="info warn">You are signed in to one workspace, but <span class="client">${safeClientName}</span> belongs to a different workspace.</p>
    <p class="info">Sign out, then sign in as the agent that registered this connector.</p>
  </div>
</body>
</html>`;
    res.writeHead(403, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...securityHeaders(req),
    });
    return res.end(html);
  }

  // Match — rotate the approve_nonce so each render gets a fresh value.
  const fresh = rotateConsentNonce(t.id);
  if (!fresh) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket no longer in-flight",
    });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Qoopia</title>
  ${brandHead}<style>${sharedCss}</style>
</head>
<body class="q-auth">
  <div class="card">
    ${brandLockup}
    <h1>Authorize access</h1>
    <p><span class="client">${safeClientName}</span> wants to connect to your workspace.</p>
    <p class="info">Approving will connect this client through its agent in this workspace. Your owner account stays separate.</p>
    <ul class="scope-list">${scopeRows}</ul>
    <div class="actions">
      <form method="POST" action="/api/dashboard/oauth-consent/deny">
        <input type="hidden" name="ticket" value="${escapeHtmlSafe(t.id)}">
        <input type="hidden" name="nonce" value="${escapeHtmlSafe(fresh)}">
        <button type="submit" class="deny">Deny</button>
      </form>
      <form method="POST" action="/api/dashboard/oauth-consent/approve">
        <input type="hidden" name="ticket" value="${escapeHtmlSafe(t.id)}">
        <input type="hidden" name="nonce" value="${escapeHtmlSafe(fresh)}">
        <button type="submit" class="approve">Approve</button>
      </form>
    </div>
  </div>
</body>
</html>`;
  // Allow the OAuth client's callback origin in form-action/navigate-to so the
  // approve form's cross-origin redirect to the client is not CSP-blocked.
  let clientOrigin: string | undefined;
  try {
    clientOrigin = new URL(t.redirect_uri).origin;
  } catch {
    clientOrigin = undefined;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(req, clientOrigin),
  });
  res.end(html);
}

/**
 * POST /api/dashboard/oauth-consent/approve
 *
 * Cookie auth + Origin/Referer match + nonce one-time consume + workspace
 * re-check (defense in depth even though the GET hides the button on
 * mismatch). On success, marks ticket approved by cookie.agent_id and 302s
 * to /oauth/authorize/finalize?ticket=...
 */
export function handleDashboardOAuthConsentApprove(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  clientIp: string,
) {
  if (!dashboardOriginAllowed(req)) {
    logger.warn("Dashboard OAuth consent approve Origin guard denied", dashboardOriginDiagnostics(req));
    return json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed.",
    });
  }
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "malformed form body",
    });
  }
  const ticketId = form.ticket || "";
  const nonce = form.nonce || "";
  if (!ticketId || !nonce) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket and nonce required",
    });
  }
  logger.info(`OAuth consent APPROVE received ticket_fp=${fingerprintIdentifier(ticketId, 12)}`);

  const auth = checkDashboardAuth(req);
  if (!auth) {
    return json(res, 401, {
      error: "unauthorized",
      error_description: "Dashboard session required.",
    });
  }
  // QSA-H: reject OAuth bearers and standard agents BEFORE any state read.
  const reject = oauthConsentRejection(auth);
  if (reject) {
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent approve rejected reason=${reject} source=${auth.source} type=${auth.type}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description:
        reject === "oauth_token_not_accepted"
          ? "OAuth access tokens are not accepted on the consent surface."
          : "OAuth client consent requires a steward or claude-privileged agent.",
    });
  }
  const ticket = getConsentTicket(ticketId);
  const status = consentTicketStatus(ticket);
  if (status === "not_found") {
    return json(res, 404, {
      error: "not_found",
      error_description: "ticket not found",
    });
  }
  if (status !== "ok") {
    if (status === "redeemed") {
      // Idempotent double-submit recovery. claude.ai's browser POSTs this approve
      // more than once (duplicate consent-form submit). The first approve already
      // ran finalize → redeemed the ticket, minted the code, and stored the
      // finalize redirect. Returning a dead-end "already used" page on the second
      // POST strands the OAuth client: the duplicate POST is the navigation the
      // browser actually displays, so it never follows the code-bearing redirect
      // to the client callback and never exchanges the code (the exact claude.ai
      // failure). Re-issue the SAME finalize redirect (302 → client callback with
      // the code) so whichever approve the browser lands on reaches the callback.
      const replay = replayFinalizeRedirect(ticketId);
      if (replay) {
        logger.info(`OAuth consent APPROVE on redeemed ticket → replay redirect ticket_fp=${fingerprintIdentifier(ticketId, 12)}`);
        res.writeHead(302, { location: replay, "cache-control": "no-store" });
        res.end();
        return;
      }
      logger.warn(`OAuth consent APPROVE on redeemed ticket, no replay entry → already-used ticket_fp=${fingerprintIdentifier(ticketId, 12)}`);
      return sendHtml(res, 400, oauthAlreadyCompletedHtml(), req);
    }
    return json(res, 400, {
      error: "invalid_request",
      error_description: `ticket ${status}`,
    });
  }
  if (auth.workspace_id !== ticket!.workspace_id) {
    audit({
      event: "workspace_mismatch",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent approve cookie=${auth.workspace_id} ticket=${ticket!.workspace_id}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description: "Workspace mismatch.",
    });
  }

  // Atomic single-use nonce consume.
  if (!consumeConsentNonce(ticket!.id, nonce)) {
    return json(res, 403, {
      error: "forbidden",
      error_description: "Invalid or expired nonce.",
    });
  }

  // A human authorizes the registered agent, never lends the connector human-owner authority.
  const principal=db.query('SELECT principal_kind FROM agents WHERE id=?').get(auth.agent_id) as {principal_kind:string}|null;
  let delegate=auth.agent_id;
  if(principal?.principal_kind==='human') {
    const client=getClient(ticket!.client_id);
    const agent=client&&db.query("SELECT id FROM agents WHERE id=? AND workspace_id=? AND active=1 AND principal_kind='agent'").get(client.agent_id,auth.workspace_id) as {id:string}|null;
    if(!agent)return json(res,403,{error:'forbidden',error_description:'Connect with a separate active agent identity.'});
    delegate=agent.id;
  }
  if (!approveConsentTicket(ticket!.id, delegate)) {
    // Lost the race — ticket was approved/denied/redeemed/expired between
    // status check and approve.
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket no longer in-flight",
    });
  }

  const ticketFp = fingerprintIdentifier(ticket!.id, 12);
  audit({
    event: "oauth_consent",
    result: "allow",
    ip: clientIp,
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    detail: `client=${ticket!.client_id} ticket_fp=${ticketFp} approved`,
  });

  // Finalize on the consent page's origin. A desktop dashboard and its public
  // MCP edge have different origins; sending this form through the public edge
  // violates the consent page's CSP before the client callback is reached.
  // The ticket still determines the resource, issuer and registered callback.
  const target = "/oauth/authorize/finalize?" + new URLSearchParams({ticket: ticket!.id});
  logger.info(`OAuth consent APPROVED → 302 finalize ticket_fp=${fingerprintIdentifier(ticket!.id, 12)}`);
  res.writeHead(302, {
    location: target,
    "cache-control": "no-store",
  });
  res.end();
}

/**
 * POST /api/dashboard/oauth-consent/deny
 *
 * Cookie auth + Origin + nonce. Sets denied=1; 302s to client.redirect_uri
 * with error=access_denied&state=... so the OAuth client sees a clean RFC
 * 6749 §4.1.2.1 deny.
 */
export function handleDashboardOAuthConsentDeny(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  clientIp: string,
) {
  if (!dashboardOriginAllowed(req)) {
    logger.warn("Dashboard OAuth consent deny Origin guard denied", dashboardOriginDiagnostics(req));
    return json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed.",
    });
  }
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "malformed form body",
    });
  }
  const ticketId = form.ticket || "";
  const nonce = form.nonce || "";
  if (!ticketId || !nonce) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket and nonce required",
    });
  }
  const auth = checkDashboardAuth(req);
  if (!auth) {
    return json(res, 401, {
      error: "unauthorized",
      error_description: "Dashboard session required.",
    });
  }
  // QSA-H: same eligibility gate as approve. A standard agent / OAuth bearer
  // can't approve, so they shouldn't be able to deny either — denying still
  // burns the ticket and signals intent into the audit log.
  const reject = oauthConsentRejection(auth);
  if (reject) {
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent deny rejected reason=${reject} source=${auth.source} type=${auth.type}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description:
        reject === "oauth_token_not_accepted"
          ? "OAuth access tokens are not accepted on the consent surface."
          : "OAuth client consent requires a steward or claude-privileged agent.",
    });
  }
  const ticket = getConsentTicket(ticketId);
  const status = consentTicketStatus(ticket);
  if (status === "not_found") {
    return json(res, 404, {
      error: "not_found",
      error_description: "ticket not found",
    });
  }
  if (status !== "ok") {
    return json(res, 400, {
      error: "invalid_request",
      error_description: `ticket ${status}`,
    });
  }
  if (auth.workspace_id !== ticket!.workspace_id) {
    // Codex MED #5 (2026-04-28): audit cross-workspace deny attempts the same
    // way GET/approve mismatches are audited. A wrong-workspace deny is
    // security-relevant — it could be reconnaissance or a confused agent.
    audit({
      event: "workspace_mismatch",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent deny cookie=${auth.workspace_id} ticket=${ticket!.workspace_id}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description: "Workspace mismatch.",
    });
  }
  if (!consumeConsentNonce(ticket!.id, nonce)) {
    return json(res, 403, {
      error: "forbidden",
      error_description: "Invalid or expired nonce.",
    });
  }
  if (!denyConsentTicket(ticket!.id)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket no longer in-flight",
    });
  }
  const ticketFp = fingerprintIdentifier(ticket!.id, 12);
  audit({
    event: "oauth_consent",
    result: "deny",
    ip: clientIp,
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    detail: `client=${ticket!.client_id} ticket_fp=${ticketFp} denied`,
  });

  const url = new URL(ticket!.redirect_uri);
  url.searchParams.set("error", "access_denied");
  const deniedConnection=ticket!.resource?resourceConnection(ticket!.resource):undefined;
  url.searchParams.set('iss',deniedConnection?connectionIssuer(deniedConnection):env.OAUTH_ISSUER);
  if (ticket!.state) url.searchParams.set("state", ticket!.state);
  res.writeHead(302, {
    location: url.toString(),
    "cache-control": "no-store",
  });
  res.end();
}

/**
 * POST /api/dashboard/oauth/clients
 *
 * Browser-initiated client registration. Cookie auth required; delegates to
 * registerClient() with the cookie's AuthContext. Pure ergonomic shim — same
 * steward/claude-priv check as /oauth/register.
 */
export function handleDashboardRegisterClient(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  clientIp: string,
) {
  if (!dashboardOriginAllowed(req)) {
    logger.warn("Dashboard OAuth connect Origin guard denied", dashboardOriginDiagnostics(req));
    return json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed.",
    });
  }
  const dauth = checkDashboardAuth(req);
  if (!dauth) {
    return json(res, 401, {
      error: "unauthorized",
      error_description: "Dashboard session required.",
    });
  }
  // Codex CRITICAL #1 (2026-04-28 round 2): explicitly reject OAuth bearers
  // here. checkDashboardAuth() accepts both cookie sessions and Bearer
  // tokens; Bearer can be either api_key or an OAuth access token. The
  // dashboard shim is intended for cookie-driven browser flows, with
  // api_key Bearer accepted for parity with /oauth/register. OAuth bearers
  // must NOT be able to register new clients via this shim, otherwise the
  // source-rejection in assertCanRegisterOAuth() at /oauth/register is
  // trivially bypassable. The forge to source="api-key" below is preserved
  // so the legitimate cookie path (source="cookie") still passes
  // assertCanRegisterOAuth's api-key-only check.
  if (dauth.source === "oauth") {
    audit({
      event: "oauth_register",
      result: "deny",
      ip: clientIp,
      workspace_id: dauth.workspace_id,
      agent_id: dauth.agent_id,
      detail: "dashboard register: OAuth bearer source not accepted",
    });
    return json(res, 403, {
      error: "forbidden",
      error_description:
        "OAuth access tokens cannot register new clients via the dashboard. Use a static API key or browser cookie session.",
    });
  }
  // Build a minimal AuthContext to feed registerClient. We only need
  // {agent_id, workspace_id, type} for the registerClient + assertCanRegister
  // path — the dashboard cookie auth carries exactly those fields. Source
  // is forged to "api-key" here so cookie sessions pass the api-key-only
  // check in assertCanRegisterOAuth(); OAuth bearers were already rejected
  // above.
  const auth: AuthContext = {
    agent_id: dauth.agent_id,
    agent_name: "",
    workspace_id: dauth.workspace_id,
    type: dauth.type,
    source: "api-key",
  };
  try {
    assertCanRegisterOAuth(auth);
  } catch (err) {
    if (err instanceof QoopiaError && err.code === "FORBIDDEN") {
      audit({
        event: "oauth_register",
        result: "deny",
        ip: clientIp,
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        detail: `dashboard register: agent type=${auth.type}`,
      });
      return json(res, 403, {
        error: "forbidden",
        error_description: err.message,
      });
    }
    throw err;
  }
  audit({
    event: "oauth_register",
    result: "allow",
    ip: clientIp,
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    detail: "via dashboard",
  });
  return handleRegister(body, res, auth);
}

export function jsonToken(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

export function fingerprintIdentifier(value: string, length = 16): string {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, length);
}

export function parseTokenBasicAuth(req: IncomingMessage): { client_id: string; client_secret: string } | null {
  const h = req.headers.authorization || "";
  if (!h.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx <= 0) return null;
    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return null;
  }
}

export function handleToken(req: IncomingMessage, body: Buffer, res: ServerResponse) {
  let form: Record<string, string>;
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  try {
    form = contentType.includes("application/json")
      ? parseJsonForm(body)
      : parseForm(body);
  } catch {
    logger.warn("OAuth token invalid_request: malformed body");
    return jsonToken(res, 400, { error: "invalid_request" });
  }
  const basic = parseTokenBasicAuth(req);
  if (basic) {
    form.client_id ||= basic.client_id;
    form.client_secret ||= basic.client_secret;
  }
  const grantType = form.grant_type;
  const formKeys = Object.keys(form).filter((key) => key !== "client_secret" && key !== "code" && key !== "refresh_token").sort();
  logger.info(
    `OAuth token request grant_type=${grantType || "<missing>"} auth=${basic ? "client_secret_basic" : form.client_secret ? "client_secret_post" : "none"} content_type=${req.headers["content-type"] || "<missing>"} keys=${formKeys.join(",")}`,
  );
  try {
    if (grantType === "authorization_code") {
      if (!form.code || !form.code_verifier || !form.redirect_uri || !form.client_id) {
        logger.warn("OAuth token authorization_code invalid_request: missing required field");
        return jsonToken(res, 400, { error: "invalid_request" });
      }
      const out = exchangeCodeForTokens({
        code: form.code,
        codeVerifier: form.code_verifier,
        redirectUri: form.redirect_uri,
        clientId: form.client_id,
        clientSecret: form.client_secret,
        resource: form.resource,
      });
      return jsonToken(res, 200, {
        access_token: out.access,
        refresh_token: out.refresh,
        token_type: "Bearer",
        expires_in: out.expiresInSec,
        ...(out.grantedScope ? { scope: out.grantedScope } : {}),
      });
    }
    if (grantType === "refresh_token") {
      if (!form.refresh_token || !form.client_id) {
        logger.warn("OAuth token refresh invalid_request: missing required field");
        return jsonToken(res, 400, { error: "invalid_request" });
      }
      const out = refreshTokens({
        refreshToken: form.refresh_token,
        clientId: form.client_id,
        clientSecret: form.client_secret,
        resource: form.resource,
      });
      return jsonToken(res, 200, {
        access_token: out.access,
        refresh_token: out.refresh,
        token_type: "Bearer",
        expires_in: out.expiresInSec,
        ...(out.grantedScope ? { scope: out.grantedScope } : {}),
      });
    }
    logger.warn(`OAuth token unsupported_grant_type grant_type=${grantType || "<missing>"}`);
    return jsonToken(res, 400, { error: "unsupported_grant_type" });
  } catch (err) {
    const msg = (err as Error).message || "invalid_grant";
    logger.warn(`OAuth token failed error=${msg}`);
    return jsonToken(res, 400, { error: msg });
  }
}

export function handleRevoke(body: Buffer, res: ServerResponse, clientIp: string) {
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return json(res, 400, { error: "invalid_request", error_description: "malformed form body" });
  }
  const token = form.token;
  const clientId = form.client_id;
  if (!token) return json(res, 400, { error: "invalid_request", error_description: "token is required" });
  if (!clientId) return json(res, 400, { error: "invalid_request", error_description: "client_id is required" });
  // Revoke audit logs intentionally use a short deterministic fingerprint,
  // not the raw OAuth client_id, so token-shaped ids never land in audit.log.
  const clientFingerprint = fingerprintIdentifier(clientId);
  // Per RFC 7009: confidential clients must supply client_secret.
  // revokeTokenForClient validates the secret and throws "invalid_client" if wrong.
  try {
    revokeTokenForClient(token, clientId, form.client_secret);
    audit({
      event: "oauth_revoke",
      result: "allow",
      ip: clientIp,
      detail: `client_fp=${clientFingerprint}`,
    });
    // RFC 7009 §2.2: always return 200 even if token was not found (avoid enumeration)
    return json(res, 200, {});
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg === "invalid_client") {
      audit({
        event: "auth_failure",
        result: "deny",
        ip: clientIp,
        scope: "/oauth/revoke",
        detail: `client_fp=${clientFingerprint} authentication failed`,
      });
      return json(res, 401, { error: "invalid_client", error_description: "Client authentication failed" });
    }
    return json(res, 500, { error: "server_error" });
  }
}
