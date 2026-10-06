import { connectionAction, connectionRegistrationAuth } from "./services/client-connections.ts";
import {AGENT_KIT_REVISION} from './agent-kit/index.ts';
import { publicConnection } from "./services/connection-identity.ts";
import { brandAsset } from './brand.ts';
import {webAppAsset} from './http/web-app.ts';
import { browserConnectionState } from './services/browser-connections.ts';
import { localOwnerLoginHandler, renewLocalOwnerSession, ownerIdentityEnabled, ownerIdentityRequestAllowed } from "./dashboard-api.ts";
import { consumeLocalLogin, parseLocalLoginBody } from "./delivery/local-login.ts";
import { localIdentityLogin, ownerIdentity } from "./identity/local.ts";
import { remoteConnectionConsent } from './identity/connection-consent.ts';
import { assetPath } from "./utils/assets.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, statfsSync } from "node:fs";
let identityHandler: ReturnType<typeof localIdentityLogin> | undefined;
let connectionConsentHandler:{root:string;handler:ReturnType<typeof remoteConnectionConsent>}|undefined;
import {
  handleDashboardApi,
  checkDashboardAuth,
  dashboardMutationAllowed,
  originAllowed as dashboardOriginAllowed,
  type DashboardAuth,
} from "./dashboard-api.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { getAllowlist } from "./admin/claude-agents.ts";
import { saveMessage } from "./services/sessions.ts";
import { fileUpload, fileDelete, validateFileUpload } from "./services/files.ts";
import {
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
  assertCanRegisterOAuth,
} from "./auth/oauth.ts";
import { QoopiaError } from "./utils/errors.ts";
import { myAgentState, submitMyAgentAction, readAgentArtifact, recoverMyAgentRuns, stopMyAgents } from './services/my-agent.ts';
import { telegramState, telegramAction, startTelegramChannels, stopTelegramChannels } from './services/my-agent-telegram.ts';
import { db } from "./db/connection.ts";
import { getPendingMigrations, latestShippedMigration } from "./db/migrate.ts";
import { env } from "./utils/env.ts";
import { cookieSigningSecretIssue } from "./utils/runtime-config.ts";
import { backgroundFailure, logger } from "./utils/logger.ts";
import {
  globalLimiter,
  mcpLimiter,
  ingestLimiter,
  dashboardLimiter,
  authLimiter,
  type RateLimiter,
} from "./utils/rate-limit.ts";
import { audit } from "./utils/audit.ts";
import { isReadOnlyInstance } from "./utils/instance-role.ts";
import { getVerifiedReleaseBaseline } from "./utils/release-baseline.ts";
import { PRODUCT_VERSION } from "./utils/product-version.ts";
import { apiError, handleAuthorityRequest } from "./api/authority.ts";
import { attachmentDisposition, CONTINUITY_MAX_BODY_BYTES, parseJsonObject, REQUEST_TIMEOUTS, RequestBodyError, repeatsSingletonHeader, unreadBody } from "./utils/http-json.ts";
import { MAX_UPLOAD_BYTES, dropHeadBody, getAllowedOrigin, getClientIp, json, methodNotAllowed, nodeReqToFetchRequest, readBody, readBodyLimited, securityHeaders, sendHtml, text } from "./http/respond.ts";
import { dashboardVersion, serveDashboard } from "./http/dashboard-static.ts";
import { DASHBOARD_COOKIE, parseCookies } from "./dashboard-session.ts";
import { handleServiceOwner, serviceOwnerEmail } from './http/service-owner.ts';
import { handleMcp } from "./http/mcp-route.ts";
import {
  handleAuthorizeFinalize,
  handleAuthorizeRedirect,
  handleDashboardOAuthConsentApprove,
  handleDashboardOAuthConsentDeny,
  handleDashboardOAuthConsentGet,
  handleDashboardRegisterClient,
  handleRegister,
  handleRevoke,
  handleToken,
  resolveTrustedUnauthenticatedDcrAuth,
  startConsentTicketGc,
  stopConsentTicketGc,
} from "./http/oauth-routes.ts";
import {
  createWriteProbe,
  evaluateReadiness,
  getV4FeatureFlags,
  readSchemaVersion,
} from "./utils/health-metadata.ts";
import { storageDegradation } from "./utils/storage-degradation.ts";
import { ownerIdentityRoot } from "./utils/standalone.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./db/sqlite.ts";
import { embeddingHealth } from "./services/embedding-store.ts";

// Writable instances only: a legacy-readonly export never writes, so neither probe applies there.
const writeReadiness = isReadOnlyInstance() ? {} : {
  probeWrite: createWriteProbe(db, SQLITE_BUSY_TIMEOUT_MS),
  freeBytes: () => { const volume = statfsSync(env.DATA_DIR); return volume.bavail * volume.bsize; },
  minFreeBytes: env.MIN_FREE_BYTES,
};

/**
 * Single Node http server for MCP (/mcp, /mcp/c/<id>), OAuth, health,
 * dashboard, ingest and file routes; handleRequest below is the route table.
 *
 * We use node:http (via Bun's Node compat) because the MCP SDK's
 * StreamableHTTPServerTransport is built around IncomingMessage/ServerResponse.
 * This keeps the transport layer tiny — we don't reimplement Streamable HTTP.
 */

interface NodeReqWithBody extends IncomingMessage {
  _body?: Buffer;
}

// ---------- Dashboard file upload / delete (owner-only) ----------
// Owner/steward session or static key only. An OAuth token carries an MCP scope
// (possibly read-only) that these routes cannot honour, so it is refused like on
// every other dashboard mutation.
function fileMutationAuth(req: IncomingMessage, res: ServerResponse) {
  const auth = checkDashboardAuth(req);
  if (!auth) return void json(res, 401, { error: "unauthorized" }, req);
  if (!auth.isAdmin || auth.source === "oauth")
    return void json(res, 403, { error: "forbidden", detail: "owner only" }, req);
  if (!dashboardMutationAllowed(req, auth)) return void json(res, 403, { error: "forbidden_origin" }, req);
  return auth;
}

// ---------- Owner dashboard routes (my agent, bridges, memory, connections, workspace) ----------
/** The owner's browser session on a canonical workspace; otherwise 401/403 is already sent. */
function ownerSession(req: IncomingMessage, res: ServerResponse) {
  const auth=checkDashboardAuth(req);
  if(!auth||auth.source!=='cookie')return void json(res,401,{error_description:'Sign in as owner'},req);
  if(isReadOnlyInstance())return void json(res,403,{error_description:'Canonical workspace required'},req);
  return auth;
}
/** The JSON body of a same-origin owner POST; undefined once 403 `refused` is sent. */
async function ownerPost(req: IncomingMessage, res: ServerResponse, auth: DashboardAuth, maxBytes: number, refused: object = {error_description:'Same-origin action required'}) {
  if(req.method?.toUpperCase()!=='POST'||!dashboardMutationAllowed(req,auth))return void json(res,403,refused,req);
  return JSON.parse((await readBodyLimited(req,maxBytes)).toString());
}
/** An over-limit or stalled body keeps its 413/408 (the server answers it); FORBIDDEN is 403, any other failure 400. */
function ownerFailure(req: IncomingMessage, res: ServerResponse, error: unknown, body: object) {
  if(error instanceof RequestBodyError)throw error;
  return json(res,error instanceof QoopiaError&&error.code==='FORBIDDEN'?403:400,body,req);
}

async function handleFileUpload(req: IncomingMessage, res: ServerResponse) {
  const auth = fileMutationAuth(req, res);
  if (!auth) return;
  let body: Buffer;
  try {
    body = await readBodyLimited(req, MAX_UPLOAD_BYTES);
  } catch (error) {
    if (!(error instanceof RequestBodyError) || error.status !== 413) throw error; // a stalled body is 408, an abort is logged
    return json(res, 413, { error: "payload_too_large", detail: "max 100MB per request" }, req);
  }
  let folder = "inbox";
  let entries: Array<{
    arrayBuffer(): Promise<ArrayBuffer>;
    name: string;
    type: string;
  }>;
  try {
    const form = await nodeReqToFetchRequest(req, body).formData();
    const folderRaw = form.get("folder");
    folder = (typeof folderRaw === "string" ? folderRaw : "") || "inbox";
    entries = form.getAll("file").filter((value) => typeof value !== "string");
  } catch {
    return json(res, 400, { error: "bad_multipart" }, req);
  }
  if (!entries.length) return json(res, 400, { error: "no_file", detail: "expected a 'file' field" }, req);
  try {
    // All or nothing: every entry is checked before the first one is written.
    const batch = [];
    for (const file of entries) {
      const bytes = Buffer.from(await file.arrayBuffer());
      validateFileUpload({ folder, filename: file.name || "file", bytes });
      batch.push({ filename: file.name || "file", mime: file.type || "application/octet-stream", bytes });
    }
    const uploaded = [];
    for (const file of batch) {
      uploaded.push(await fileUpload({ workspace_id: auth.workspace_id, owner_agent_id: auth.agent_id, uploaded_by_agent_id: auth.agent_id, folder, ...file }));
    }
    return json(res, 200, { uploaded }, req);
  } catch (e) {
    const er = e as { code?: string; message?: string; details?: Record<string, unknown> };
    if (er.code === "INVALID_INPUT") return json(res, 400, { error: "invalid_input", detail: er.message, ...er.details }, req);
    throw e;
  }
}

async function handleFileDelete(req: IncomingMessage, res: ServerResponse, id: string) {
  const auth = fileMutationAuth(req, res);
  if (!auth) return;
  try {
    return json(res, 200, fileDelete({ workspace_id: auth.workspace_id, id, agent_id: auth.agent_id }), req);
  } catch (e) {
    const er = e as { code?: string };
    if (er.code === "NOT_FOUND") return json(res, 404, { error: "not_found" }, req);
    throw e;
  }
}

/**
 * Fail closed on every server start, dev included: QOOPIA_ADMIN_SECRET is
 * required, and the effective dashboard cookie-signing secret
 * (QOOPIA_SESSION_SECRET, else a key derived from QOOPIA_ADMIN_SECRET) must
 * be at least 32 bytes. ADR-017 removed the ADMIN_SECRET consent path; the
 * consent POST now authenticates the owner through the qoopia_dash cookie.
 *
 * Throws so launchd surfaces the failure in stderr.
 */
export function assertOAuthReady(): void {
  const issue = env.ADMIN_SECRET
    ? cookieSigningSecretIssue()
    : "QOOPIA_ADMIN_SECRET is not set; it keys dashboard session cookies when QOOPIA_SESSION_SECRET is unset. " +
      "Generate one and add it to your launchd plist or shell env: `openssl rand -base64 32`";
  if (!issue) return;
  logger.error(issue);
  throw new Error(issue);
}

const stopBackgroundWork=new WeakMap<Server,()=>Promise<void>>();
/** Stop agents and Telegram before draining connections: an open streaming response
 * (MCP SSE) keeps 'close' from firing, so it cannot be the only place that stops them.
 * Resolves when both are done or after the deadline, whichever comes first. */
export async function shutdownHttpServer(server:Server,deadlineMs=5000):Promise<void>{
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<void>(resolve=>{timer=setTimeout(resolve,deadlineMs);});
  try{await Promise.race([Promise.all([closed,stopBackgroundWork.get(server)?.()]),deadline]);}finally{clearTimeout(timer);}
}

/** The request pathname (never the query string) the router, logs and audit all use. An
 * origin-form target is joined to the base as text: resolved against it, `//host/x` would turn
 * `host` into an authority and route as `/x`. Absolute-form (RFC 9112 §3.2.2) still parses. */
const CONNECTION_SLASH = /^\/(?:mcp|\.well-known\/oauth-(?:protected-resource\/mcp|authorization-server\/(?:oauth|mcp)))\/c\/[a-f0-9-]{36}\/(?:\?|$)/;

function requestPath(req: IncomingMessage): string {
  const raw = req.url || "/";
  try { return new URL(raw.startsWith("/") ? `http://local${raw}` : raw, "http://local").pathname; }
  catch { return raw.split("?", 1)[0] || "/"; }
}

/**
 * One audit line per 401 that rejected a presented credential (Bearer header
 * or dashboard cookie), on every route. Anonymous 401s are the normal MCP
 * OAuth discovery step and stay unlogged; /oauth/* audits its own denials.
 * Path only: never the query string, headers or token.
 */
function auditRejectedCredential(req: IncomingMessage, res: ServerResponse): void {
  if (res.statusCode !== 401) return;
  if (!req.headers.authorization && !parseCookies(req.headers.cookie)[DASHBOARD_COOKIE]) return;
  const pathname = requestPath(req);
  if (pathname.startsWith("/oauth/")) return;
  audit({ event: "auth_failure", result: "deny", ip: getClientIp(req), scope: pathname.slice(0, 256) });
}

/** Bun ignores keepAliveTimeout, so an idle keep-alive socket is closed here; the timer
 * starts only when a response has finished, so long or streaming requests are never cut. */
const keepAliveTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

export function startHttpServer() {
  assertOAuthReady();
  startConsentTicketGc();
  const httpServer = createServer(async (req, res) => {
    const socket = req.socket;
    clearTimeout(keepAliveTimers.get(socket));
    if (req.method === "HEAD") dropHeadBody(res);
    // Framing is ambiguous after a repeated Content-Length/Transfer-Encoding, so nothing more is read from this socket.
    const repeated = repeatsSingletonHeader(req);
    res.once("finish", () => {
      auditRejectedCredential(req, res);
      if (repeated || unreadBody(req)) return void req.destroy();
      keepAliveTimers.set(socket, setTimeout(() => socket.destroy(), REQUEST_TIMEOUTS.keepAliveIdleMs).unref());
    });
    if (repeated) {
      res.setHeader("connection", "close");
      return json(res, 400, { error: "duplicate_header" }, req);
    }
    try {
      await handleRequest(req as NodeReqWithBody, res);
    } catch (err) {
      const where = { method: req.method, path: requestPath(req).slice(0, 256) };
      // A client that disconnected mid-request is not a server fault, and its socket is gone.
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET" || (err as Error).message === "aborted")
        return void logger.info("Client closed the request", where);
      if (!res.headersSent) {
        if (err instanceof RequestBodyError) {
          res.setHeader("connection", "close");
          json(res, err.status, err.status === 413 ? { error: err.message, max_bytes: err.maxBytes } : { error: err.message }, req);
        } else {
          // Client-input errors (unknown connection, malformed id or %-encoding) keep their 4xx;
          // only a 5xx is logged, and its body stays generic unless it is a full disk the owner can act on.
          const mapped = apiError(err);
          if (mapped.status >= 500) logger.error("Request handler failed", { ...where, error: String(err) });
          json(res, mapped.status, mapped.status >= 500 && mapped.error.code !== "STORAGE_FULL" ? { error: "internal_error" }
            : { error: mapped.error.code.toLowerCase(), error_description: mapped.error.message }, req);
        }
      }
    }
  });

  let bridgeTimer:ReturnType<typeof setInterval>|undefined;
  if(!isReadOnlyInstance())httpServer.once('listening',()=>{
    recoverMyAgentRuns();startTelegramChannels();
    const bridgeFailed=backgroundFailure('Bridge sync');
    const run=()=>import('./bridges/api.ts').then(({bridges})=>bridges.tick()).catch(bridgeFailed);
    bridgeTimer=setInterval(run,5000);bridgeTimer.unref();
  });

  // Idempotent: shutdownHttpServer and the 'close' event may both run it.
  const stopWork=()=>{
    stopConsentTicketGc();
    if(bridgeTimer)clearInterval(bridgeTimer);
    stopTelegramChannels();return stopMyAgents().catch(()=>logger.error('Agent process termination was not confirmed during shutdown'));
  };
  stopBackgroundWork.set(httpServer,stopWork);
  httpServer.on("close", () => {void stopWork();});

  httpServer.listen(env.PORT, env.HOST, () => {
    const addr = httpServer.address();
    const boundPort =
      addr && typeof addr === "object" ? addr.port : env.PORT;
    logger.info(`Qoopia ${PRODUCT_VERSION} listening on http://${env.HOST}:${boundPort}`);
    if (env.HOST !== "127.0.0.1" && env.HOST !== "::1" && env.HOST !== "localhost") {
      logger.warn(
        `QOOPIA_HOST=${env.HOST} — server is reachable beyond loopback. ` +
          `Ensure firewall/tunnel ACLs are in place; OAuth + Bearer endpoints assume trusted network.`,
      );
    }
  });

  return httpServer;
}

/**
 * Per-route rate-limit guard. Returns true если лимит превышен и 429 уже
 * отправлен — вызывающий должен сразу return.
 */
function rateLimit429(
  limiter: RateLimiter,
  scope: string,
  clientIp: string,
  res: ServerResponse,
): boolean {
  if (limiter.allow(clientIp)) return false;
  audit({ event: "rate_limit_trigger", result: "deny", ip: clientIp, scope });
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(limiter.retryAfterSec(clientIp)),
  });
  res.end(JSON.stringify({ error: "too_many_requests", scope }));
  return true;
}

async function handleRequest(req: NodeReqWithBody, res: ServerResponse) {
  // Claude.ai adds a trailing slash to connector URLs (19facaa). Canonicalize the connection paths once,
  // so MCP, its 401 resource_metadata and discovery all see the connection instead of the general flow.
  if (req.url && CONNECTION_SLASH.test(req.url)) req.url = req.url.replace(/\/(?=\?|$)/, "");
  const rawUrl = req.url || "/";
  // Route by pathname, not the full URL. Browser OAuth consent bounces through
  // /dashboard?next=...; matching against req.url made that valid dashboard
  // URL fall through to {error:"not_found"}.
  const url = requestPath(req);
  const method = (req.method || "GET").toUpperCase();
  // HEAD is answered like GET (the runtime drops the body) only on routes that are plain reads;
  // OAuth's state-changing GETs stay GET-only.
  const read = method === "GET" || method === "HEAD";
  const clientIp = getClientIp(req);
  if(read){
    const shell=webAppAsset(url);
    if(shell){res.writeHead(200,{'content-type':shell.type,'cache-control':'no-cache','service-worker-allowed':'/',...securityHeaders(req)});return res.end(method==='HEAD'?undefined:shell.body);}
    const asset=brandAsset(url);
    if(asset){
      // dashboard.html names its assets ?v=<content revision>: that exact URL never changes, so it is
      // cached for a year. Unversioned and stale-revision URLs revalidate.
      const current=!!dashboardVersion&&new URLSearchParams(rawUrl.split('?')[1]??'').get('v')===dashboardVersion;
      res.writeHead(200,{'content-type':asset.type,'cache-control':current?'public, max-age=31536000, immutable':'no-cache',...securityHeaders(req)});
      return res.end(method==='HEAD'?undefined:asset.body);
    }
  }


  // --- Global safety-net rate limit (1000 req/min per IP) ---
  // Per-route limiters (mcp/ingest/dashboard/auth) срабатывают в своих хэндлерах.
  if (!globalLimiter.allow(clientIp)) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(globalLimiter.retryAfterSec(clientIp)),
    });
    res.end(JSON.stringify({ error: "too_many_requests", scope: "global" }));
    return;
  }

  // CORS preflight
  if (method === "OPTIONS") {
    const origin = getAllowedOrigin(req);
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, idempotency-key, if-match, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name",
      "access-control-max-age": "86400",
    };
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (process.env.QOOPIA_STANDALONE === 'true') {
    const host = `127.0.0.1:${env.PORT}`;
    if (req.headers.host !== host) return json(res,403,{error:'Host refused'},req);
  }
  // One per-IP limit for every dashboard route, counted once, early-dispatched routes included.
  if (url.startsWith("/api/dashboard") && rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
  // Every dashboard API answer is session-bound; a route that sets its own cache-control still wins.
  if (url.startsWith("/api/dashboard")) res.setHeader("cache-control", "no-store");
  if (method === 'GET' && url.startsWith('/api/dashboard/')) renewLocalOwnerSession(req,res);
  if(url==='/api/dashboard/profile'){
    const auth=checkDashboardAuth(req);
    if(!auth||auth.source!=='cookie')return json(res,401,{error:'Sign in to your dashboard'},req);
    if(method!=='GET')return json(res,405,{error:'Read only'},req);
    try{
      const root=ownerIdentityRoot();
      if(root===undefined)return json(res,200,{email:null},req);
      const identity=ownerIdentity(root);
      return json(res,200,{email:identity?.ownerId===auth.agent_id?identity.email:null,service_owner:!!serviceOwnerEmail(req)},req);
    }catch{return json(res,200,{email:null},req);}
  }
  if(url==='/api/dashboard/service-owner')return handleServiceOwner(req,res);
  if(url==='/api/dashboard/identity'||url.startsWith('/api/dashboard/identity/')){
      if(!ownerIdentityEnabled())return json(res,404,{error:'Owner email login is not configured'},req);
      const route=url.slice('/api/dashboard/identity'.length);
      // Each start spends the broker's sign-in allowance; polling (every 2.5 s) is not limited here.
      if(route==='/start'&&rateLimit429(authLimiter,'auth',clientIp,res))return;
      if(isReadOnlyInstance()||!ownerIdentityRequestAllowed(req,method!=='GET'||route!==''))return json(res,403,{error:'Owner login origin refused'},req);
      if(method!=='GET'||route!==''){
        if(method!=='POST'||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{error:'Same-origin action required'},req);
      }
      try{
        const identityRoot=ownerIdentityRoot();
        if(identityRoot===undefined)return json(res,503,{error:'Installed Qoopia is required'},req);
        if(process.env.QOOPIA_STANDALONE!=='true'&&!ownerIdentity(identityRoot))return json(res,503,{error:'Server owner identity is not provisioned'},req);
        const body=method==='POST'?JSON.parse((await readBodyLimited(req,2048)).toString()):{};
        if(!body||typeof body!=='object'||Array.isArray(body))return json(res,400,{error:'Invalid request'},req);
        identityHandler??=localIdentityLogin(identityRoot,db);
        return await identityHandler(req,res,route,body);
      }catch{return json(res,400,{error:'Invalid sign-in request'},req);}
  }
  if(url==='/api/dashboard/my-agent'||url==='/api/dashboard/my-agent/file') {
    const auth=ownerSession(req,res);if(!auth)return;
    try {
      if(url.endsWith('/file')){
        if(method!=='GET')return methodNotAllowed(res,'GET',req,{error_description:'Read only'});
        const artifact=readAgentArtifact(auth.agent_id,new URL(rawUrl,'http://local').searchParams.get('path')??'');
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(artifact.bytes.length),'content-disposition':attachmentDisposition(artifact.name),'x-content-type-options':'nosniff','content-security-policy':"sandbox; default-src 'none'"});return res.end(artifact.bytes);
      }
      if(method==='GET'){const query=new URL(rawUrl,'http://local').searchParams;return json(res,200,{...myAgentState(auth.agent_id,query.get('conversation')??undefined,{runBefore:query.get('runBefore')??undefined,conversationOffset:Number(query.get('conversationOffset')??0),includeFiles:query.get('files')!=='0',runLimit:query.has('runs')?Number(query.get('runs')):undefined}),telegram_setup:telegramState(auth.agent_id)},req);}
      const body=await ownerPost(req,res,auth,32*1024);if(body===undefined)return;
      const result=typeof body?.action==='string'&&body.action.startsWith('telegram-')?await telegramAction(auth.agent_id,body):await submitMyAgentAction(auth.agent_id,body);
      return json(res,'accepted' in result&&result.accepted?202:200,result,req);
    }catch(error){return ownerFailure(req,res,error,{error_description:error instanceof QoopiaError?error.message:'Agent action failed. Check your connection and try again.'});}
  }
  if(url==='/api/dashboard/bridges') {
    const auth=ownerSession(req,res);if(!auth)return;
    const {bridgeState,bridgeAction}=await import('./bridges/api.ts');
    try {
      if(method==='GET')return json(res,200,bridgeState(auth.agent_id),req);
      const body=await ownerPost(req,res,auth,2*1024*1024);if(body===undefined)return;
      return json(res,200,await bridgeAction(auth.agent_id,body),req);
    } catch(error){return ownerFailure(req,res,error,
      {error_description:error instanceof QoopiaError?error.message:'Bridge action failed. Keep your invitation or draft and try again.'});}
  }
  if(url==='/api/dashboard/memory'||url==='/api/dashboard/connections'||url==='/api/dashboard/connection-setup') {
    const auth=ownerSession(req,res);if(!auth)return;
    const {memorySetupState,submitMemorySetupAction}=await import('./services/memory-setup.ts');
    try {
      if(url==='/api/dashboard/connection-setup'){
        const {managedNetworkAction,submitManagedNetworkAction}=await import('./delivery/managed-transport.ts');
        if(method==='GET')return json(res,200,{...connectionAction(auth.agent_id,{action:'status'}),network:await managedNetworkAction(auth.agent_id,{action:'network-status'})},req);
        const input=await ownerPost(req,res,auth,4096,{code:'FORBIDDEN',state:'error'});if(input===undefined)return;
        const result=typeof input?.action==='string'&&input.action.startsWith('network-')?await submitManagedNetworkAction(auth.agent_id,input):await connectionAction(auth.agent_id,input);
        return json(res,'accepted' in result&&result.accepted?202:200,result,req);
      }
      if(url==='/api/dashboard/connections')return method==='GET'?json(res,200,browserConnectionState(auth.agent_id),req):methodNotAllowed(res,'GET',req,{error_description:'Read only'});
      if(method==='GET')return json(res,200,memorySetupState(auth.agent_id),req);
      const body=await ownerPost(req,res,auth,12*1024);if(body===undefined)return;
      const result=await submitMemorySetupAction(auth.agent_id,body);
      return json(res,'accepted' in result&&result.accepted?202:200,result,req);
    } catch(error){return ownerFailure(req,res,error,
      {state:'error',code:error instanceof QoopiaError?error.code:'INVALID_INPUT',error_description:error instanceof QoopiaError?error.message:'Setup failed; check the selected action',
        ...(error instanceof QoopiaError&&typeof error.details?.next_action==='string'?{next_action:error.details.next_action}:{})});}
  }

  if (process.env.QOOPIA_STANDALONE === 'true') {
    const host = `127.0.0.1:${env.PORT}`;
    if (url === '/local-login' && method === 'GET') {
      return serveDashboard(req,res);
    }
    if (url === '/api/dashboard/local-login') {
      if (method !== 'POST' || req.headers.origin !== `http://${host}`) return json(res,403,{error:'Same-origin POST required'},req);
      let code: string;try {code=parseLocalLoginBody(await readBodyLimited(req,1024),req.headers['content-type']);}catch{return json(res,400,{error:'Invalid login request'},req);}
      const ownerId=consumeLocalLogin(code);
      if(!ownerId)return json(res,401,{error:'Login code expired or invalid'},req);
      const form=req.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase()==='application/x-www-form-urlencoded';
      localOwnerLoginHandler(req,res,ownerId,form?'/dashboard':undefined);return;
    }
    if(url==='/api/dashboard/workspace') {
      const auth=checkDashboardAuth(req);
      if(!auth||auth.source!=='cookie')return json(res,401,{error_description:'Sign in as the local owner'},req);
      if(isReadOnlyInstance()||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''))return json(res,403,{error_description:'Local canonical installation required'},req);
      const {workspaceState,workspaceAction,workspaceError}=await import('./delivery/workspace.ts');
      try {
        if(method==='GET')return json(res,200,workspaceState(auth.agent_id),req);
        if(method!=='POST'||req.headers.origin!==`http://${host}`||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{error_description:'Same-origin action required'},req);
        const body=JSON.parse((await readBodyLimited(req,96*1024)).toString());
        return json(res,200,await workspaceAction(auth.agent_id,body),req);
      }catch(error){return ownerFailure(req,res,error,workspaceError(error));}
    }
  }

  if (url.startsWith("/api/dashboard/authority/")) {
    const dash = checkDashboardAuth(req);
    if (!dash) return json(res,401,{error:{code:"UNAUTHENTICATED",message:"Sign in to the dashboard"}},req);
    if (!read && (!dashboardOriginAllowed(req) || req.headers["x-qoopia-csrf"] !== "1")) {
      return json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin dashboard mutation required"}},req);
    }
    const body = read ? undefined : await readBodyLimited(req,4*1024*1024);
    const headers = new Headers();
    for (const [name,value] of Object.entries(req.headers)) if(typeof value === "string") headers.set(name,value);
    const auth: AuthContext = {workspace_id:dash.workspace_id,agent_id:dash.agent_id,agent_name:"dashboard session",type:dash.type,
      source:dash.source === "cookie" ? "api-key" : dash.source,granted_scope:dash.granted_scope};
    const response = await handleAuthorityRequest(new Request(`http://local${rawUrl.replace("/api/dashboard/authority/","/api/v1/")}`,{method:read?"GET":method,headers,body}),undefined,auth);
    res.writeHead(response.status,{...Object.fromEntries(response.headers),"cache-control":"no-store","x-content-type-options":"nosniff"});res.end(await response.text());return;
  }
  if (url.startsWith("/api/v1/")) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    // Authenticate from headers first: an anonymous caller gets its 401 without us buffering 4 MB.
    // Pairing redemption is the one anonymous write; its handler refuses more than 1 KiB.
    const auth = authenticate(new Request(`http://local${rawUrl}`, { headers }));
    const redeem = url === "/api/v1/agent-pairings/redeem";
    const body = read || (!auth && !redeem) ? undefined : await readBodyLimited(req, redeem ? 4096 : 4 * 1024 * 1024);
    const response = await handleAuthorityRequest(new Request(`http://local${rawUrl}`, { method: read ? "GET" : method, headers, body }), undefined, auth);
    // Authenticated reads and the pairing redemption (a new API key) must not be cached or sniffed.
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(await response.text());
    return;
  }

  // --- Health ---
  if (url === "/health") {
    if (!read) return methodNotAllowed(res, "GET, HEAD", req);
    const release = getVerifiedReleaseBaseline();
    const schemaVersion = readSchemaVersion(db);
    const featureFlags = getV4FeatureFlags();
    const storage = storageDegradation();
    return json(res, 200, {
      status: storage.degraded ? "degraded" : "ok",
      version: PRODUCT_VERSION,
      release_sha: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      schema_version: schemaVersion,
      // Lets an operator see instruction drift across a fleet without opening
      // a session on every agent.
      protocol_kit_revision: AGENT_KIT_REVISION,
      feature_flags: featureFlags,
      build_commit: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      server_role: env.SERVER_ROLE,
      instance_id: env.INSTANCE_ID,
      writes_enabled: !isReadOnlyInstance() && !storage.degraded,
      checks: { storage: storage.degraded ? "degraded" : "ok" },
      embeddings: embeddingHealth(),
      ...(storage.degraded ? { degradation: storage } : {}),
      uptime: Math.round(process.uptime()),
    }, req);
  }

  if (url === "/ready") {
    if (!read) return methodNotAllowed(res, "GET, HEAD", req);
    const release = getVerifiedReleaseBaseline();
    const readiness = evaluateReadiness(db, getPendingMigrations, { latestShippedMigration, ...writeReadiness });
    return json(res, readiness.ready ? 200 : 503, {
      status: readiness.ready ? "ready" : "not_ready",
      version: PRODUCT_VERSION,
      release_sha: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      build_commit: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      schema_version: readiness.schema_version,
      // Lets an operator see instruction drift across a fleet without opening
      // a session on every agent.
      protocol_kit_revision: AGENT_KIT_REVISION,
      feature_flags: getV4FeatureFlags(),
      server_role: env.SERVER_ROLE,
      instance_id: env.INSTANCE_ID,
      writes_enabled: !isReadOnlyInstance() && !storageDegradation().degraded && (readiness.checks.db_write ?? "ok") === "ok",
      checks: readiness.checks,
      ...(storageDegradation().degraded ? { degradation: storageDegradation() } : {}),
    }, req);
  }

  if (url === "/") {
    if (!read) return methodNotAllowed(res, "GET, HEAD", req);
    return text(
      res,
      200,
      `Qoopia ${PRODUCT_VERSION} MCP server\nMCP endpoint: ${env.PUBLIC_URL}/mcp\nHealth: ${env.PUBLIC_URL}/health\nReadiness: ${env.PUBLIC_URL}/ready\nDashboard: ${env.PUBLIC_URL}/dashboard\n`,
      req,
    );
  }

  // A legacy instance remains available as a read-only export. MCP reads use
  // POST and are guarded by per-tool risk checks; all other HTTP mutations are
  // rejected before they can reach OAuth, ingest, dashboard, or file handlers.
  // url is the pathname (no query). /mcp/ is accepted because some UI clients
  // add a trailing slash; /mcp/c/<id> is a connection-scoped MCP URL.
  const isMcp = url === "/mcp" || url === "/mcp/" || /^\/mcp\/c\/[a-f0-9-]{36}$/.test(url);
  // Exact paths, shared by the read-only guard below and the routes, so the two cannot drift apart.
  const isAuthorize = url === "/oauth/authorize" || url === "/oauth/authorize/";
  const isFinalize = url === "/oauth/authorize/finalize" || url === "/oauth/authorize/finalize/";
  if (
    isReadOnlyInstance() &&
    !isMcp &&
    method !== "GET" &&
    method !== "HEAD"
  ) {
    return json(
      res,
      503,
      {
        error: "read_only_instance",
        server_role: env.SERVER_ROLE,
        instance_id: env.INSTANCE_ID,
      },
      req,
    );
  }

  // These GET routes intentionally transition OAuth state on a canonical
  // instance. They are not reads and therefore cannot be served by a legacy
  // export even though their HTTP method is GET.
  if (
    isReadOnlyInstance() &&
    method === "GET" &&
    (isAuthorize || url === "/api/dashboard/oauth-consent")
  ) {
    return json(
      res,
      503,
      {
        error: "read_only_instance",
        error_description: "OAuth state transitions are disabled on a legacy-readonly instance",
        server_role: env.SERVER_ROLE,
        instance_id: env.INSTANCE_ID,
      },
      req,
    );
  }

  // --- Dashboard ---
  if(['/connections-guide-en.html','/connections-guide-ru.html'].includes(url)&&read){
    return sendHtml(res,200,readFileSync(assetPath('src/public'+url),'utf8'),req);
  }
  if (url === "/dashboard") {
    if (!read) return methodNotAllowed(res, "GET, HEAD", req);
    return serveDashboard(req, res);
  }

  // --- OAuth discovery ---
  if (url === "/.well-known/oauth-authorization-server" || url.startsWith("/.well-known/oauth-authorization-server/")) {
    // Some OAuth clients derive RFC 8414 metadata from the protected resource
    // path and request /.well-known/oauth-authorization-server/mcp. The issuer
    // is still the host root, so serve the same metadata instead of 404.
    // A connection's metadata answers at its issuer path (/oauth/c/<id>) and, for clients that insert
    // the MCP resource path instead (the SDK's discoverOAuthMetadata(serverUrl)), at /mcp/c/<id>.
    if (!read) return methodNotAllowed(res, "GET, HEAD", req);
    const connection=/^\/\.well-known\/oauth-authorization-server\/(?:oauth|mcp)\/c\/([a-f0-9-]{36})$/.exec(url)?.[1];
    if(connection)publicConnection(connection);
    return json(res, 200, wellKnownAuthorizationServer(connection), req);
  }
  if (url === "/.well-known/oauth-protected-resource" || url.startsWith("/.well-known/oauth-protected-resource/")) {
    if (!read) return methodNotAllowed(res, "GET, HEAD", req);
    const connection=/^\/\.well-known\/oauth-protected-resource\/mcp\/c\/([a-f0-9-]{36})$/.exec(url)?.[1];
    if(connection)publicConnection(connection);
    return json(res, 200, wellKnownProtectedResource(connection), req);
  }

  // --- OAuth endpoints (stricter: 20 req/min per IP) ---
  if(/^\/oauth\/consent(?:\/(?:start|check|approve|deny))?$/.test(url)){
    if(rateLimit429(authLimiter,'auth',clientIp,res))return;
    if(isReadOnlyInstance())return json(res,403,{error:'Read-only installation'},req);
    const root=ownerIdentityRoot();if(!root)return json(res,503,{error:'Owner account setup required'},req);
    if(connectionConsentHandler?.root!==root)connectionConsentHandler={root,handler:remoteConnectionConsent(root,db)};
    const body=method==='POST'?await readBodyLimited(req,2048):undefined;
    // The sign-in service binds the confirmation to the browser's network. Behind the tunnel edge clientIp
    // is the rate-limit key `edge:<address>`; send the address itself, or the link never counts.
    const browserIp=clientIp.startsWith('edge:')?clientIp.slice(5).replace(/^unknown$/,''):clientIp;
    const response=await connectionConsentHandler.handler(nodeReqToFetchRequest(req,body),browserIp);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  // ADR-017: /oauth/authorize is now a thin redirect target. It validates
  // params + client + redirect_uri, creates a server-side consent_ticket,
  // and 302s to the dashboard-scoped consent UI. The /oauth/* surface
  // never reads the dashboard cookie (ADR-015 §"the cookie is never
  // attached outside dashboard routes" preserved).
  // Retired (F-076): approve redirects straight to the client; stale links get 400.
  if (isFinalize && method === "GET") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    return handleAuthorizeFinalize(req, res);
  }
  if (isAuthorize && method === "GET") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    return handleAuthorizeRedirect(req, res, clientIp);
  }
  if (isAuthorize || isFinalize) {
    // ADR-017: POST /oauth/authorize is gone. Approval lives on the
    // dashboard surface. Explicitly 405 so a stale Claude.ai client or a
    // crawler hitting the old path gets a deterministic error rather than
    // a 404. HEAD is refused too: these GETs change OAuth state.
    return methodNotAllowed(res, "GET", req, { error: "method_not_allowed" });
  }
  if ((url === "/oauth/token" || url === "/oauth/token/") && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    const body = await readBody(req);
    return handleToken(req, body, res);
  }
  if ((url === "/oauth/register" || url === "/oauth/register/") && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    const body = await readBody(req);
    const fetchReq = nodeReqToFetchRequest(req, body);
    const auth = authenticate(fetchReq);
    if (!auth) {
      if (fetchReq.headers.get("authorization")) {
        audit({ event: "auth_failure", result: "deny", ip: clientIp, scope: "/oauth/register", detail: "invalid Authorization header" });
        return json(res, 401, {
          error: "unauthorized",
          error_description:
            "Bearer api_key required (steward or workspace owner).",
        });
      }
      const selectedConnection=new URL(req.url!,env.PUBLIC_URL).searchParams.get("connection");
      let publicDcr: ReturnType<typeof resolveTrustedUnauthenticatedDcrAuth>;
      try {
        const redirectUris = parseJsonObject(body)?.redirect_uris; // handleRegister answers bad JSON
        publicDcr = selectedConnection ? {auth:connectionRegistrationAuth(selectedConnection,redirectUris),detail:"owner-provisioned connection registration"} : resolveTrustedUnauthenticatedDcrAuth(body);
      } catch (err) {
        if (!(err instanceof QoopiaError)) throw err;
        // F-130: an unknown connection, a foreign callback or a full connection is the caller's error.
        audit({ event: "oauth_register", result: "deny", ip: clientIp, scope: "/oauth/register", detail: `connection registration refused: ${err.code}` });
        return json(res, err.code === "RATE_LIMITED" ? 429 : 400, {
          error: err.code === "RATE_LIMITED" ? "too_many_requests" : err.code === "INVALID_INPUT" ? "invalid_redirect_uri" : "invalid_request",
          error_description: err.message,
        });
      }
      if (publicDcr) {
        audit({
          event: "oauth_register",
          result: "allow",
          ip: clientIp,
          workspace_id: publicDcr.auth.workspace_id,
          agent_id: publicDcr.auth.agent_id,
          detail: publicDcr.detail,
        });
        return handleRegister(body, res, publicDcr.auth);
      }
      audit({ event: "auth_failure", result: "deny", ip: clientIp, scope: "/oauth/register" });
      return json(res, 401, {
        error: "unauthorized",
        error_description:
          "Bearer api_key required (steward or workspace owner).",
      });
    }
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
          detail: `agent type=${auth.type} cannot register OAuth clients`,
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
    });
    return handleRegister(body, res, auth);
  }
  if (url === "/oauth/register" || url === "/oauth/register/" || url === "/oauth/token" || url === "/oauth/token/") {
    return methodNotAllowed(res, "POST", req);
  }
  if ((url === "/oauth/revoke" || url === "/oauth/revoke/") && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    const body = await readBody(req);
    return handleRevoke(req, body, res, clientIp);
  }
  if (url === "/oauth/revoke" || url === "/oauth/revoke/" || url === "/memory/continuity" || url === "/ingest/session") {
    if (method !== "POST") return methodNotAllowed(res, "POST", req);
  }
  if (url === "/ingest/allowlist" && method !== "GET") return methodNotAllowed(res, "GET", req);

  if(url==='/memory/continuity'&&method==='POST') {
    res.setHeader('cache-control','no-store');
    if(rateLimit429(ingestLimiter,'continuity',clientIp,res))return;
    const auth=authenticate(nodeReqToFetchRequest(req));
    if(!auth)return json(res,401,{error:'unauthenticated'},req);
    try {
      const {currentToolAuth}=await import('./auth/policy.ts');
      const {continuityEvent}=await import('./services/continuity.ts');
      const body=JSON.parse((await readBodyLimited(req,CONTINUITY_MAX_BODY_BYTES)).toString());
      currentToolAuth(db,auth,'write-low');
      return json(res,200,continuityEvent(auth.workspace_id,auth.agent_id,body),req);
    }catch(error){if(error instanceof RequestBodyError)throw error;return json(res,error instanceof QoopiaError&&error.code==='NOT_FOUND'?404:400,{error:'Continuity request refused'},req);}
  }

  // --- Ingest endpoints (ingest-daemon only, 500 req/min per IP) ---
  if (url === "/ingest/allowlist" && method === "GET") {
    if (rateLimit429(ingestLimiter, "ingest", clientIp, res)) return;
    const fetchReq = nodeReqToFetchRequest(req);
    const auth = authenticate(fetchReq);
    if (!auth || auth.type !== "ingest-daemon") {
      audit({ event: "ingest_forbidden", result: "deny", ip: clientIp, scope: "/ingest/allowlist", detail: auth ? `wrong type: ${auth.type}` : "no auth" });
      return json(res, 403, { error: "forbidden", error_description: "ingest-daemon credentials required" }, req);
    }
    // Hard-isolation: каждый tailer получает allowlist только своего workspace.
    return json(res, 200, getAllowlist(auth.workspace_id), req);
  }

  if (url === "/ingest/session" && method === "POST") {
    if (rateLimit429(ingestLimiter, "ingest", clientIp, res)) return;
    const auth = authenticate(nodeReqToFetchRequest(req));
    if (!auth || auth.type !== "ingest-daemon") {
      audit({ event: "ingest_forbidden", result: "deny", ip: clientIp, scope: "/ingest/session", detail: auth ? `wrong type: ${auth.type}` : "no auth" });
      return json(res, 403, { error: "forbidden", error_description: "ingest-daemon credentials required" }, req);
    }
    const rawBody = await readBody(req);
    let payload: {
      attributed_agent_id?: string;
      session_id?: string;
      uuid?: string;
      role?: string;
      content?: string;
      timestamp?: string;
      cwd?: string;
      metadata?: Record<string, unknown>;
    };
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return json(res, 400, { error: "invalid_json" }, req);
    }

    const { attributed_agent_id, session_id, uuid, role, content } = payload;
    if (!attributed_agent_id || !session_id || !uuid || !role || !content) {
      return json(res, 400, { error: "missing_fields", required: ["attributed_agent_id", "session_id", "uuid", "role", "content"] }, req);
    }
    if (role !== "user" && role !== "assistant") {
      return json(res, 400, { error: "invalid_role", allowed: ["user", "assistant"] }, req);
    }

    // Resolve the target agent's workspace
    const { db: dbConn } = await import("./db/connection.ts");
    const targetAgent = dbConn
      .prepare(`SELECT workspace_id FROM agents WHERE id = ? AND active = 1`)
      .get(attributed_agent_id) as { workspace_id: string } | undefined;
    if (!targetAgent) {
      return json(res, 404, { error: "agent_not_found", agent_id: attributed_agent_id }, req);
    }

    // Hard-isolation guard: ingest-daemon token привязан к своему workspace,
    // запись в чужой workspace запрещена даже если attacker угадал чужой agent ULID.
    if (targetAgent.workspace_id !== auth.workspace_id) {
      audit({
        event: "workspace_mismatch",
        result: "deny",
        ip: clientIp,
        workspace_id: auth.workspace_id,
        agent_id: attributed_agent_id,
        detail: `caller workspace ${auth.workspace_id} tried to write to agent's workspace ${targetAgent.workspace_id}`,
      });
      return json(res, 403, { error: "workspace_mismatch", error_description: "ingest token workspace does not match target agent workspace" }, req);
    }

    try {
      const result = saveMessage({
        workspace_id: targetAgent.workspace_id,
        agent_id: attributed_agent_id,
        session_id,
        role: role as "user" | "assistant",
        content,
        ingest_uuid: uuid,
        capture: "ingest",
        metadata: { ingest_cwd: payload.cwd ?? "", ingest_ts: payload.timestamp ?? "", ...payload.metadata },
      });
      return json(res, 200, result, req);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // The id is held by another agent or workspace (F-091: refused as NOT_FOUND, never named).
      if (e.code === "NOT_FOUND") return json(res, 409, { error: "session_conflict", detail: e.message }, req);
      if (e.code === "INVALID_INPUT") return json(res, 400, { error: "invalid_input", detail: e.message }, req);
      // Acknowledged, not stored: the tailer advances its cursor on 2xx, so material from a
      // manual period is dropped here instead of piling up and being backfilled on auto.
      if (e.code === "APPROVAL_REQUIRED") return json(res, 200, { skipped: "memory_mode_manual" }, req);
      throw err;
    }
  }

  // --- Dashboard-scoped OAuth consent bridge (ADR-017) ---
  // These endpoints intentionally live under /api/dashboard so they pick up
  // the qoopia_dash cookie's Path scope. They are intercepted BEFORE
  // handleDashboardApi() because that dispatcher would 404 unknown paths
  // and is not aware of the OAuth-bridge ones.
  if (url === "/api/dashboard/oauth-consent" && method === "GET") {
    return handleDashboardOAuthConsentGet(req, res);
  }
  if (url === "/api/dashboard/oauth-consent/approve" && method === "POST") {
    const body = await readBody(req);
    return handleDashboardOAuthConsentApprove(req, body, res, clientIp);
  }
  if (url === "/api/dashboard/oauth-consent/deny" && method === "POST") {
    const body = await readBody(req);
    return handleDashboardOAuthConsentDeny(req, body, res, clientIp);
  }
  if (url === "/api/dashboard/oauth/clients" && method === "POST") {
    const body = await readBody(req);
    return handleDashboardRegisterClient(req, body, res, clientIp);
  }

  // --- Dashboard file upload (POST) + delete (DELETE) — owner-only, before GET gate ---
  if (url === "/api/dashboard/files" && method === "POST") {
    return handleFileUpload(req, res);
  }
  {
    const fm = url.match(/^\/api\/dashboard\/files\/([^/]+)$/);
    if (fm && method === "DELETE") {
      return handleFileDelete(req, res, decodeURIComponent(fm[1]!));
    }
  }

  // --- Dashboard API (rate-limited with every dashboard route above) ---
  if (url.startsWith("/api/dashboard") && handleDashboardApi(req, res)) return;

  // --- MCP endpoint (300 req/min per IP) ---
  if (isMcp) {
    if (rateLimit429(mcpLimiter, "mcp", clientIp, res)) return;
    return handleMcp(req, res);
  }

  return json(res, 404, { error: "not_found" }, req);
}
