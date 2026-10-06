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
  dashboardMutationAllowed,
  originAllowed as dashboardOriginAllowed,
  dashboardOriginDiagnostics,
  type DashboardAuth,
} from "../dashboard-api.ts";
import type { AuthContext } from "../auth/middleware.ts";
import { stringArraySubsetOf, isChatGptRedirectArray, isClaudeRedirectArray } from "../auth/dcr-policy.ts";
import {
  exchangeCodeForTokens,
  refreshTokens,
  revokeTokenForClient,
  registerClient,
  assertCanRegisterOAuth,
  getClient,
  createConsentTicket,
  getConsentTicket,
  finalizeConsentTicket,
  replayFinalizeRedirect,
  consentTicketStatus,
  approveConsentTicket,
  denyConsentTicket,
  consumeConsentNonce,
  rotateConsentNonce,
  pruneConsentTickets,
  normalizeScope,
  parseGrantedScope,
  describeScope,
  assertValidPkceS256Challenge,
  validateOAuthResource,
  type OAuthScope,
} from "../auth/oauth.ts";
import { QoopiaError } from "../utils/errors.ts";
import { db } from "../db/connection.ts";
import { env } from "../utils/env.ts";
import { logger } from "../utils/logger.ts";
import { audit } from "../utils/audit.ts";
import { isReadOnlyInstance } from "../utils/instance-role.ts";
import { ownerIdentityRoot } from "../utils/standalone.ts";
import { edgeClientKey } from "../delivery/mcp-edge.ts";
import { parseJsonObject } from "../utils/http-json.ts";
import { escapeHtml, json, securityHeaders, sendHtml } from "./respond.ts";

/** Account-bound consent reuses only the exact human owner's browser session. */
function accountConsentOrigin(ticket: NonNullable<ReturnType<typeof getConsentTicket>>): string | undefined {
  const id=ticket.resource?resourceConnection(ticket.resource):undefined;
  const root=ownerIdentityRoot(),binding=root?ownerIdentity(root):null;
  if(!id||!binding)return undefined;
  const connection=publicConnection(id),origin=connectionOrigin(id);
  return connection.owner_id===binding.ownerId&&origin.startsWith('https://')?origin:undefined;
}
function accountConsentAllowed(ticket: NonNullable<ReturnType<typeof getConsentTicket>>,auth:DashboardAuth):boolean {
  if(!accountConsentOrigin(ticket))return true;
  const connection=publicConnection(resourceConnection(ticket.resource!)!);
  // No workspace_owners join: owner_id was bound through localOwner, which required it, and an owner binding is never removed.
  return auth.source==='cookie'&&auth.agent_id===connection.owner_id&&auth.workspace_id===connection.workspace_id&&
    !!db.query("SELECT 1 FROM agents WHERE id=? AND active=1 AND principal_kind='human' AND authority_profile='owner'").get(auth.agent_id);
}

// ADR-017: in-memory consentNonces is gone. Consent is brokered through
// the consent_tickets table; nonces live as `approve_nonce` columns and are
// rotated atomically. The dashboard-side approve POST uses
// consumeConsentNonce() for one-time semantics.

type ConsentLanguage = "en" | "ru";
/** Same order as the dashboard's i18n.js: ?lang, the shared language cookie, then the browser language. */
function consentLanguage(req: IncomingMessage): ConsentLanguage {
  const query = new URL(req.url || "/", "http://localhost").searchParams.get("lang");
  if (query === "en" || query === "ru") return query;
  const cookie = /(?:^|;\s*)qoopia_language=(en|ru)(?:;|$)/.exec(req.headers.cookie || "")?.[1];
  if (cookie === "en" || cookie === "ru") return cookie;
  return /^\s*ru\b/i.test(req.headers["accept-language"] || "") ? "ru" : "en";
}
const scopeDescriptionRu: Record<OAuthScope, string> = {
  "mcp:read": "Читать память и журнал аудита Qoopia без изменений.",
  "mcp:write": "Добавлять новые записи памяти и вносить другие неразрушающие изменения. Для изменения или удаления заметок нужен mcp:admin.",
  "mcp:admin": "Удаляющие и административные операции MCP.",
};

function oauthAlreadyCompletedHtml(lang: ConsentLanguage = "en"): string {
  const tr = (en: string, ru: string) => (lang === "ru" ? ru : en);
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${tr("Authorization already completed", "Доступ уже подтверждён")}</title>
  ${brandHead}
</head>
<body class="q-auth">
  <main>${brandLockup}
    <h1>${tr("Authorization already completed", "Доступ уже подтверждён")}</h1>
    <p>${tr("This OAuth approval link was already used.", "Эта ссылка подтверждения OAuth уже использована.")}</p>
    <p>${tr("You can close this tab and return to Claude.", "Можно закрыть вкладку и вернуться в Claude.")}</p>
    <p>${tr("If Claude still does not show the connector, start a new connector flow.", "Если Claude всё ещё не показывает подключение, начните подключение заново.")}</p>
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

function parseForm(body: Buffer): Record<string, string> {
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
function parseJsonForm(body: Buffer): Record<string, string> {
  const parsed = parseJsonObject(body);
  if (!parsed) throw Object.assign(new Error("invalid_request"), { statusCode: 400 });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
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
  logger.info(`OAuth authorize ENTER client=${clientId || "<none>"} redirect=${redirectUri || "<none>"} has_state=${state ? "y" : "n"} ua=${(req.headers["user-agent"] || "").slice(0, 40)}`);

  // RFC 6749 §4.1.2.1: a missing/unknown client or an unregistered redirect_uri is
  // answered here and never redirected, so this endpoint cannot become an open redirect.
  if (!clientId || !redirectUri) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Missing required: client_id, redirect_uri",
    });
  }
  const client = getClient(clientId);
  if (!client) {
    return json(res, 400, {
      error: "invalid_client",
      error_description: "Unknown client_id — register first via /oauth/register",
    });
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "redirect_uri not registered for this client",
    });
  }
  const assignedConnection=db.query("SELECT id FROM client_connections WHERE agent_id=?").get(client.agent_id) as {id:string}|null;
  // F-190: every other error goes back to the validated callback with state and iss.
  const fail = (error: string, description?: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    if (description) url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    url.searchParams.set("iss", assignedConnection ? connectionIssuer(assignedConnection.id) : env.OAUTH_ISSUER);
    res.writeHead(302, { location: url.toString(), "cache-control": "no-store" });
    res.end();
  };
  let resource: string;
  let scope = "";
  try {
    if (u.searchParams.getAll("resource").length > 1) throw new Error("invalid_target");
    resource=validateOAuthResource(u.searchParams.get("resource") ?? (selectedConnection?connectionResource(selectedConnection):undefined));
  } catch { return fail("invalid_target"); }

  try {
    scope = normalizeScope(u.searchParams.get("scope")).normalized;
  } catch (err) {
    const msg = (err as Error).message || "invalid_scope";
    if (msg.startsWith("invalid_scope:")) {
      return fail("invalid_scope", `Unknown scope '${msg.slice("invalid_scope:".length)}'`);
    }
    throw err;
  }

  if (responseType !== "code") return fail("unsupported_response_type");
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required");
  if (codeChallengeMethod !== "S256") return fail("invalid_request", "Only S256 code_challenge_method is supported");
  try {
    assertValidPkceS256Challenge(codeChallenge);
  } catch {
    return fail("invalid_request", "code_challenge must be a 43-character base64url S256 challenge");
  }

  if(assignedConnection && resource !== connectionResource(assignedConnection.id))return fail("invalid_target");
  const resourceId=resourceConnection(resource);
  // The general flow consents on this computer's own dashboard with every scope. Through the tunnel that
  // page is someone else's loopback, so a remote client must use its connection address instead.
  if(!resourceId&&edgeClientKey(req))return fail("invalid_target","Use the connection address from Qoopia (Connections → the agent → its /mcp/c/… URL), not the general /mcp address");
  if(resourceId){
    const connection=publicConnection(resourceId);
    if(client.agent_id!==connection.agent_id||client.workspace_id!==connection.workspace_id)return fail("invalid_target");
    // A client that names no scope gets the connection's own; "".split(" ") is [""], never a scope.
    if(!scope)scope=connection.access_mode==="read"?"mcp:read":"mcp:read mcp:write";
    if(connection.access_mode==="read"&&scope.split(" ").some(s=>s!=="mcp:read"))return fail("invalid_scope");
    if(scope.includes("mcp:admin"))return fail("invalid_scope");
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
    resource,
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
  const identityRoot=ownerIdentityRoot(),binding=identityRoot?ownerIdentity(identityRoot):null;
  const remote=!!(resourceId&&binding&&connectionOrigin(resourceId).startsWith('https://')&&publicConnection(resourceId).owner_id===binding.ownerId);
  const consentOrigin=remote?connectionOrigin(resourceId!):process.env.QOOPIA_STANDALONE==='true'?`http://127.0.0.1:${env.PORT}`:resourceId?connectionOrigin(resourceId):env.PUBLIC_URL;
  // The tunnel edge publishes only /oauth/consent, never /api/dashboard/*, and strips the dashboard
  // cookie, so an edge request skips the session-reuse hop that only a same-origin dashboard can serve.
  const target = new URL(remote&&edgeClientKey(req)?'/oauth/consent':'/api/dashboard/oauth-consent', consentOrigin);
  target.searchParams.set("ticket", ticket.id);
  res.writeHead(302, {
    location: target.toString(),
    "cache-control": "no-store",
  });
  res.end();
}

/**
 * GET /oauth/authorize/finalize — retired (F-076).
 *
 * A bare ticket id is not a credential: /oauth/authorize hands it to whoever
 * started the flow, so redeeming it here gave that party the code once the
 * owner approved. The approve handlers now redeem the ticket and redirect
 * straight to the registered redirect_uri. Stale links get the completed page.
 */
export function handleAuthorizeFinalize(req: IncomingMessage, res: ServerResponse) {
  logger.warn(`OAuth finalize REFUSED (retired; approve redirects to the client) ua=${(req.headers["user-agent"] || "").slice(0, 50)}`);
  return sendHtml(res, 400, oauthAlreadyCompletedHtml(consentLanguage(req)), req);
}

const CLAUDE_PRIVILEGED_AGENT_ID = "01CLAUDE0CODE0AGENT0000001";
const PUBLIC_DCR_AGENT_NAME = process.env.QOOPIA_PUBLIC_DCR_AGENT_NAME || "GPT";
const PUBLIC_DCR_WORKSPACE_SLUG = process.env.QOOPIA_PUBLIC_DCR_WORKSPACE_SLUG || "default";
function authContextFromAgentRow(row: {
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

function resolveChatGptUnauthenticatedDcrAuth(parsed: Record<string, unknown>): AuthContext | null {
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
  const parsed = parseJsonObject(body);
  if (!parsed) return null;

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
 * to the default Claude connector agent. V1 installations bind it to the owner's ordinary "Claude"
 * agent; a pre-V1 installation (no human owner) keeps its legacy connector row, whose
 * 'claude-privileged' type string is an ordinary agent since ADR-020 and selects nothing else.
 */
function resolveClaudeAiUnauthenticatedDcrAuthParsed(parsed: Record<string, unknown>): AuthContext | null {
  if (!isClaudeRedirectArray(parsed.redirect_uris)) return null;
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "Body must be a JSON object",
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
    // Only registerClient's own validation text reaches the caller; anything else is a server fault.
    if (!(err instanceof QoopiaError)) throw err;
    return json(res, 400, {
      error: "invalid_request",
      error_description: err.message,
    });
  }
}

// ---------- Dashboard-scoped OAuth consent bridge (ADR-017) ----------

function escapeHtmlSafe(s: string): string {
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
 *   2) ordinary agents (a legacy 'claude-privileged' row included, ADR-020) —
 *      registration is restricted to the steward and the owner
 *      (assertCanRegisterOAuth), so consent must be at least as restrictive.
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
      return sendHtml(res, 400, oauthAlreadyCompletedHtml(consentLanguage(req)), req);
    }
    return json(res, 400, {
      error: "invalid_request",
      error_description: `ticket ${status}`,
    });
  }

  const auth = checkDashboardAuth(req);
  if (!auth) {
    const remote=accountConsentOrigin(ticket!);
    if(remote){
      // SameSite=Strict omits the dashboard cookie on the initial external navigation.
      // Commit a same-origin page before checking the existing session again.
      if(!u.searchParams.has('session_check')){
        const next='/api/dashboard/oauth-consent?'+new URLSearchParams({ticket:ticketId,session_check:'1'});
        return sendHtml(res,200,`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">${brandHead}<body class="q-auth"><main>${brandLockup}<p>Opening your connection…</p><a data-consent-session href="${escapeHtmlSafe(next)}">Continue</a></main><script src="/brand/consent-session.js" defer></script></body></html>`,req);
      }
      res.writeHead(302,{location:remote+'/oauth/consent?'+new URLSearchParams({ticket:ticketId}),'cache-control':'no-store'});
      return res.end();
    }
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
          : "OAuth client consent requires the steward or the workspace owner.",
    });
  }

  if(!accountConsentAllowed(ticket!,auth))return json(res,403,{error:'forbidden',error_description:'Use this installation’s human owner session.'});
  const t = ticket!;
  const lang = consentLanguage(req);
  const tr = (en: string, ru: string) => (lang === "ru" ? ru : en);
  const client = getClient(t.client_id);
  const safeClientName = escapeHtmlSafe(client?.name || tr("Unknown client", "Неизвестный клиент"));
  const requestedScopes = parseGrantedScope(t.scope) || [];
  const scopeRows = requestedScopes.length > 0
    ? requestedScopes
        .map(
          (scope) =>
            `<li><strong>${escapeHtmlSafe(scope)}</strong> — ${escapeHtmlSafe(lang === "ru" ? scopeDescriptionRu[scope] : describeScope(scope))}</li>`,
        )
        .join("")
    : tr(`<li><strong>legacy/full agent profile</strong> — this client did not request explicit OAuth scopes, so access is limited by the connected agent’s MCP tool profile.</li>`,
        `<li><strong>устаревший/полный профиль агента</strong> — клиент не запросил явные права OAuth, поэтому доступ ограничен профилем инструментов MCP подключённого агента.</li>`);
  const languageLinks = `<nav class="languages" aria-label="${tr("Language", "Язык")}"><a lang="en" href="?${escapeHtmlSafe(new URLSearchParams({ ticket: t.id, lang: "en" }).toString())}">EN</a> / <a lang="ru" href="?${escapeHtmlSafe(new URLSearchParams({ ticket: t.id, lang: "ru" }).toString())}">RU</a></nav>`;

  const sharedCss = `.scope-list{padding-left:24px}.info.warn{border:2px solid var(--qoopia-ivory);padding:16px}.languages{text-align:right}.languages a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px}`;

  if (auth.workspace_id !== t.workspace_id) {
    audit({
      event: "workspace_mismatch",
      result: "deny",
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent GET cookie=${auth.workspace_id} ticket=${t.workspace_id}`,
    });
    const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${tr("Wrong workspace", "Другое пространство")} — Qoopia</title><meta name="viewport" content="width=device-width,initial-scale=1">
  ${brandHead}<style>${sharedCss}</style>
</head>
<body class="q-auth">
  <main class="card">
    ${brandLockup}
    <h1>${tr("Wrong workspace", "Другое пространство")}</h1>
    <p class="info warn">${tr(`You are signed in to one workspace, but <span class="client">${safeClientName}</span> belongs to a different workspace.`, `Вы вошли в одно пространство, а <span class="client">${safeClientName}</span> относится к другому.`)}</p>
    <p class="info">${tr("Sign out, then sign in as the agent that registered this connector.", "Выйдите и войдите как агент, который зарегистрировал это подключение.")}</p>
  </main>
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

  const callbackHost = escapeHtmlSafe(new URL(t.redirect_uri).host);
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${tr("Authorize", "Разрешение доступа")} — Qoopia</title>
  ${brandHead}<style>${sharedCss}</style>
</head>
<body class="q-auth">
  <main class="card">
    ${brandLockup}
    ${languageLinks}
    <h1>${tr("Authorize access", "Разрешить доступ")}</h1>
    <p>${tr(`<span class="client">${safeClientName}</span> wants to connect to your workspace.`, `<span class="client">${safeClientName}</span> хочет подключиться к вашему пространству.`)}</p>
    <p class="info">${tr(`Approving sends the authorization to <strong>${callbackHost}</strong>. Continue only if you started this connection there.`, `После разрешения доступ будет передан на <strong>${callbackHost}</strong>. Продолжайте, только если вы сами начали это подключение там.`)}</p>
    <p class="info">${tr("Approving will connect this client through its agent in this workspace. Your owner account stays separate.", "Клиент подключится через своего агента в этом пространстве. Ваша учётная запись владельца остаётся отдельной.")}</p>
    <ul class="scope-list">${scopeRows}</ul>
    <div class="actions">
      <form method="POST" action="/api/dashboard/oauth-consent/deny">
        <input type="hidden" name="ticket" value="${escapeHtmlSafe(t.id)}">
        <input type="hidden" name="nonce" value="${escapeHtmlSafe(fresh)}">
        <button type="submit" class="deny">${tr("Deny", "Отклонить")}</button>
      </form>
      <form method="POST" action="/api/dashboard/oauth-consent/approve">
        <input type="hidden" name="ticket" value="${escapeHtmlSafe(t.id)}">
        <input type="hidden" name="nonce" value="${escapeHtmlSafe(fresh)}">
        <button type="submit" class="approve">${tr("Approve", "Разрешить")}</button>
      </form>
    </div>
  </main>
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

/** The approve/deny prelude: Origin, form, ticket + nonce, dashboard auth, the QSA-H eligibility
 * gate, the account owner and ticket existence. Returns null once it has answered the request. */
function consentPrelude(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  clientIp: string,
  action: "approve" | "deny",
): {
  ticketId: string;
  nonce: string;
  auth: DashboardAuth;
  ticket: NonNullable<ReturnType<typeof getConsentTicket>>;
  status: ReturnType<typeof consentTicketStatus>;
} | null {
  if (!dashboardOriginAllowed(req)) {
    logger.warn(`Dashboard OAuth consent ${action} Origin guard denied`, dashboardOriginDiagnostics(req));
    json(res, 403, {
      error: "forbidden",
      error_description: "Origin not allowed.",
    });
    return null;
  }
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    json(res, 400, {
      error: "invalid_request",
      error_description: "malformed form body",
    });
    return null;
  }
  const ticketId = form.ticket || "";
  const nonce = form.nonce || "";
  if (!ticketId || !nonce) {
    json(res, 400, {
      error: "invalid_request",
      error_description: "ticket and nonce required",
    });
    return null;
  }
  if (action === "approve") logger.info(`OAuth consent APPROVE received ticket_fp=${fingerprintIdentifier(ticketId, 12)}`);

  const auth = checkDashboardAuth(req);
  if (!auth) {
    json(res, 401, {
      error: "unauthorized",
      error_description: "Dashboard session required.",
    });
    return null;
  }
  // QSA-H: reject OAuth bearers and standard agents BEFORE any state read. Deny too: a party that
  // can't approve shouldn't deny either — denying still burns the ticket and signals intent into the
  // audit log.
  const reject = oauthConsentRejection(auth);
  if (reject) {
    audit({
      event: "oauth_consent",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent ${action} rejected reason=${reject} source=${auth.source} type=${auth.type}`,
    });
    json(res, 403, {
      error: "forbidden",
      error_description:
        reject === "oauth_token_not_accepted"
          ? "OAuth access tokens are not accepted on the consent surface."
          : "OAuth client consent requires the steward or the workspace owner.",
    });
    return null;
  }
  const ticket = getConsentTicket(ticketId);
  if(ticket&&!accountConsentAllowed(ticket,auth)){json(res,403,{error:'forbidden',error_description:'Use this installation’s human owner session.'});return null;}
  const status = consentTicketStatus(ticket);
  if (status === "not_found") {
    json(res, 404, {
      error: "not_found",
      error_description: "ticket not found",
    });
    return null;
  }
  return { ticketId, nonce, auth, ticket: ticket!, status };
}

/**
 * POST /api/dashboard/oauth-consent/approve
 *
 * Cookie auth + Origin/Referer match + nonce one-time consume + workspace
 * re-check (defense in depth even though the GET hides the button on
 * mismatch). On success, marks the ticket approved, redeems it in the same
 * request and 302s straight to the registered redirect_uri with the code
 * (F-076: the code never leaves through a URL that only needs the ticket id).
 */
export function handleDashboardOAuthConsentApprove(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  clientIp: string,
) {
  const ctx = consentPrelude(req, body, res, clientIp, "approve");
  if (!ctx) return;
  const { ticketId, nonce, auth, ticket, status } = ctx;
  // F-076: the workspace check precedes the redeemed-replay branch, so a
  // foreign-workspace caller holding the ticket id cannot collect the code.
  if (auth.workspace_id !== ticket.workspace_id) {
    audit({
      event: "workspace_mismatch",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent approve cookie=${auth.workspace_id} ticket=${ticket.workspace_id}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description: "Workspace mismatch.",
    });
  }
  if (status !== "ok") {
    if (status === "redeemed") {
      // Idempotent double-submit recovery. claude.ai's browser POSTs this approve
      // more than once (duplicate consent-form submit). The first approve already
      // redeemed the ticket, minted the code and cached the callback. Returning a
      // dead-end "already used" page on the second POST strands the OAuth client:
      // the duplicate POST is the navigation the browser actually displays, so it
      // never reaches the client callback (the exact claude.ai failure). Re-issue
      // the SAME callback, but only to the principal that approved (F-076).
      const replay = replayFinalizeRedirect(ticketId, auth.agent_id);
      if (replay) {
        logger.info(`OAuth consent APPROVE on redeemed ticket → replay redirect ticket_fp=${fingerprintIdentifier(ticketId, 12)}`);
        res.writeHead(302, { location: replay, "cache-control": "no-store" });
        res.end();
        return;
      }
      logger.warn(`OAuth consent APPROVE on redeemed ticket, no replay entry for this approver → already-used ticket_fp=${fingerprintIdentifier(ticketId, 12)}`);
      return sendHtml(res, 400, oauthAlreadyCompletedHtml(consentLanguage(req)), req);
    }
    return json(res, 400, {
      error: "invalid_request",
      error_description: `ticket ${status}`,
    });
  }

  // Atomic single-use nonce consume.
  if (!consumeConsentNonce(ticket.id, nonce)) {
    return json(res, 403, {
      error: "forbidden",
      error_description: "Invalid or expired nonce.",
    });
  }

  // The owner or the steward authorizes the client's registered agent and never lends the
  // connector its own authority (ADR-020: a steward approving a legacy connector grant binds
  // that connector's ordinary agent, not the steward).
  const client=getClient(ticket.client_id);
  const agent=client&&db.query("SELECT id FROM agents WHERE id=? AND workspace_id=? AND active=1 AND principal_kind='agent'").get(client.agent_id,auth.workspace_id) as {id:string}|null;
  if(!agent)return json(res,403,{error:'forbidden',error_description:'Connect with a separate active agent identity.'});
  if (!approveConsentTicket(ticket.id, agent.id)) {
    // Lost the race — ticket was approved/denied/redeemed/expired between
    // status check and approve.
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket no longer in-flight",
    });
  }

  const ticketFp = fingerprintIdentifier(ticket.id, 12);
  audit({
    event: "oauth_consent",
    result: "allow",
    ip: clientIp,
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    detail: `client=${ticket.client_id} ticket_fp=${ticketFp} approved`,
  });

  // Redeem here and go straight to the registered callback; the consent page's
  // CSP form-action already allows that origin (securityHeaders(req, clientOrigin)).
  const target = finalizeConsentTicket(ticket.id, auth.agent_id, clientIp);
  if (!target) return sendHtml(res, 400, oauthAlreadyCompletedHtml(consentLanguage(req)), req);
  logger.info(`OAuth consent APPROVED → 302 client callback ticket_fp=${ticketFp}`);
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
  const ctx = consentPrelude(req, body, res, clientIp, "deny");
  if (!ctx) return;
  const { nonce, auth, ticket, status } = ctx;
  if (status !== "ok") {
    return json(res, 400, {
      error: "invalid_request",
      error_description: `ticket ${status}`,
    });
  }
  if (auth.workspace_id !== ticket.workspace_id) {
    // Codex MED #5 (2026-04-28): audit cross-workspace deny attempts the same
    // way GET/approve mismatches are audited. A wrong-workspace deny is
    // security-relevant — it could be reconnaissance or a confused agent.
    audit({
      event: "workspace_mismatch",
      result: "deny",
      ip: clientIp,
      workspace_id: auth.workspace_id,
      agent_id: auth.agent_id,
      detail: `oauth-consent deny cookie=${auth.workspace_id} ticket=${ticket.workspace_id}`,
    });
    return json(res, 403, {
      error: "forbidden",
      error_description: "Workspace mismatch.",
    });
  }
  if (!consumeConsentNonce(ticket.id, nonce)) {
    return json(res, 403, {
      error: "forbidden",
      error_description: "Invalid or expired nonce.",
    });
  }
  if (!denyConsentTicket(ticket.id)) {
    return json(res, 400, {
      error: "invalid_request",
      error_description: "ticket no longer in-flight",
    });
  }
  const ticketFp = fingerprintIdentifier(ticket.id, 12);
  audit({
    event: "oauth_consent",
    result: "deny",
    ip: clientIp,
    workspace_id: auth.workspace_id,
    agent_id: auth.agent_id,
    detail: `client=${ticket.client_id} ticket_fp=${ticketFp} denied`,
  });

  const url = new URL(ticket.redirect_uri);
  url.searchParams.set("error", "access_denied");
  const deniedConnection=ticket.resource?resourceConnection(ticket.resource):undefined;
  url.searchParams.set('iss',deniedConnection?connectionIssuer(deniedConnection):env.OAUTH_ISSUER);
  if (ticket.state) url.searchParams.set("state", ticket.state);
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
  if (!dashboardMutationAllowed(req, dauth)) {
    return json(res, 403, {
      error: "forbidden",
      error_description: "Same-origin dashboard request required.",
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

function jsonToken(res: ServerResponse, status: number, body: unknown) {
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

function fingerprintIdentifier(value: string, length = 16): string {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, length);
}

function parseTokenBasicAuth(req: IncomingMessage): { client_id: string; client_secret: string } | null {
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

const TOKEN_ERRORS = new Set(["invalid_request", "invalid_client", "invalid_grant", "invalid_target", "invalid_scope", "unsupported_grant_type"]);

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
    const msg = (err as Error).message || "";
    logger.warn(`OAuth token failed error=${msg}`);
    // F-190: only RFC error codes leave this endpoint; anything else is an internal fault.
    return TOKEN_ERRORS.has(msg) ? jsonToken(res, 400, { error: msg }) : jsonToken(res, 500, { error: "server_error" });
  }
}

export function handleRevoke(req: IncomingMessage, body: Buffer, res: ServerResponse, clientIp: string) {
  let form: Record<string, string>;
  try {
    form = parseForm(body);
  } catch {
    return json(res, 400, { error: "invalid_request", error_description: "malformed form body" });
  }
  // F-129: the same client authentication methods as /oauth/token.
  const basic = parseTokenBasicAuth(req);
  if (basic) {
    form.client_id ||= basic.client_id;
    form.client_secret ||= basic.client_secret;
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
