import { connectionAction, connectionRegistrationAuth } from "./services/client-connections.ts";
import { publicConnection } from "./services/connection-identity.ts";
import { brandAsset } from './brand.ts';
import {webAppAsset} from './http/web-app.ts';
import { browserConnectionState } from './services/browser-connections.ts';
import { localOwnerLoginHandler, renewLocalOwnerSession, ownerIdentityEnabled, ownerIdentityRequestAllowed } from "./dashboard-api.ts";
import { consumeLocalLogin, parseLocalLoginBody } from "./delivery/local-login.ts";
import { localIdentityLogin, ownerIdentity } from "./identity/local.ts";
import { remoteConnectionConsent } from './identity/connection-consent.ts';
import { assetPath } from "./utils/assets.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
let identityHandler: ReturnType<typeof localIdentityLogin> | undefined;
let connectionConsentHandler:{root:string;handler:ReturnType<typeof remoteConnectionConsent>}|undefined;
import {
  handleDashboardApi,
  checkDashboardAuth,
  originAllowed as dashboardOriginAllowed,
} from "./dashboard-api.ts";
import { authenticate, type AuthContext } from "./auth/middleware.ts";
import { getAllowlist } from "./admin/claude-agents.ts";
import { saveMessage } from "./services/sessions.ts";
import { fileUpload, fileDelete } from "./services/files.ts";
import {
  wellKnownAuthorizationServer,
  wellKnownProtectedResource,
  assertCanRegisterOAuth,
} from "./auth/oauth.ts";
import { QoopiaError } from "./utils/errors.ts";
import { myAgentState, submitMyAgentAction, readAgentArtifact, recoverMyAgentRuns, stopMyAgents } from './services/my-agent.ts';
import { telegramState, telegramAction, startTelegramChannels, stopTelegramChannels } from './services/my-agent-telegram.ts';
import { db } from "./db/connection.ts";
import { getPendingMigrations } from "./db/migrate.ts";
import { env } from "./utils/env.ts";
import { logger } from "./utils/logger.ts";
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
import { handleAuthorityRequest } from "./api/authority.ts";
import { MAX_BODY_BYTES, MAX_UPLOAD_BYTES, getAllowedOrigin, getClientIp, json, nodeReqToFetchRequest, readBody, readBodyLimited, securityHeaders, sendHtml, text } from "./http/respond.ts";
import { serveDashboard } from "./http/dashboard-static.ts";
import { handleMcp } from "./http/mcp-route.ts";
import {
  connectionIdentityRoot,
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
export { getCurrentAuth } from "./http/mcp-route.ts";
import {
  evaluateReadiness,
  getV4FeatureFlags,
  readSchemaVersion,
} from "./utils/health-metadata.ts";
import { storageDegradation } from "./utils/storage-degradation.ts";

/**
 * Single Node http server hosts:
 *  - /mcp                                (Streamable HTTP MCP, stateless mode)
 *  - /health                             (health check)
 *  - /ready                              (readiness check)
 *  - /.well-known/oauth-authorization-server
 *  - /.well-known/oauth-protected-resource
 *  - /oauth/authorize                    (PKCE code flow)
 *  - /oauth/token
 *  - /oauth/revoke
 *
 * We use node:http (via Bun's Node compat) because the MCP SDK's
 * StreamableHTTPServerTransport is built around IncomingMessage/ServerResponse.
 * This keeps the transport layer tiny — we don't reimplement Streamable HTTP.
 */

interface NodeReqWithBody extends IncomingMessage {
  _body?: Buffer;
}

// ---------- Dashboard file upload / delete (owner-only) ----------
async function handleFileUpload(req: IncomingMessage, res: ServerResponse) {
  const auth = checkDashboardAuth(req);
  if (!auth) return json(res, 401, { error: "unauthorized" }, req);
  if (!(auth.type === "owner" || auth.type === "steward"))
    return json(res, 403, { error: "forbidden", detail: "owner only" }, req);
  if (!dashboardOriginAllowed(req)) return json(res, 403, { error: "forbidden_origin" }, req);
  let body: Buffer;
  try {
    body = await readBodyLimited(req, MAX_UPLOAD_BYTES);
  } catch {
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
  const uploaded = [];
  for (const file of entries) {
    const buf = Buffer.from(await file.arrayBuffer());
    uploaded.push(
      await fileUpload({
        workspace_id: auth.workspace_id,
        owner_agent_id: auth.agent_id,
        uploaded_by_agent_id: auth.agent_id,
        folder,
        filename: file.name || "file",
        mime: file.type || "application/octet-stream",
        bytes: buf,
      }),
    );
  }
  return json(res, 200, { uploaded }, req);
}

async function handleFileDelete(req: IncomingMessage, res: ServerResponse, id: string) {
  const auth = checkDashboardAuth(req);
  if (!auth) return json(res, 401, { error: "unauthorized" }, req);
  if (!(auth.type === "owner" || auth.type === "steward"))
    return json(res, 403, { error: "forbidden" }, req);
  if (!dashboardOriginAllowed(req)) return json(res, 403, { error: "forbidden_origin" }, req);
  try {
    return json(res, 200, fileDelete({ workspace_id: auth.workspace_id, id, agent_id: auth.agent_id }), req);
  } catch (e) {
    const er = e as { code?: string };
    if (er.code === "NOT_FOUND") return json(res, 404, { error: "not_found" }, req);
    throw e;
  }
}

/**
 * QRERUN-001: refuse to start the HTTP server if /oauth/authorize is reachable
 * but env.ADMIN_SECRET is empty. Without this gate the consent POST handler
 * has no owner-proof to verify, and the previous loopback-fallback was unsafe
 * behind tunnels (cloudflared etc. always present as 127.0.0.1).
 *
 * Throws so launchd surfaces the failure in stderr and the install runbook
 * can prompt the operator to set QOOPIA_ADMIN_SECRET.
 */
export function assertOAuthReady(): void {
  if (env.ADMIN_SECRET) return;
  const msg =
    "QOOPIA_ADMIN_SECRET is not set. /oauth/authorize cannot start without it " +
    "(QRERUN-001 fail-closed). Generate one and add it to your launchd plist " +
    "or shell env: `openssl rand -base64 32`.";
  logger.error(msg);
  throw new Error(msg);
}

export function startHttpServer() {
  assertOAuthReady();
  startConsentTicketGc();
  const httpServer = createServer(async (req, res) => {
    try {
      await handleRequest(req as NodeReqWithBody, res);
    } catch (err) {
      const msg = (err as Error).message || "";
      if (!res.headersSent) {
        if (msg === "payload_too_large") {
          json(res, 413, { error: "payload_too_large", max_bytes: MAX_BODY_BYTES });
        } else {
          logger.error("Request handler failed", { error: String(err) });
          json(res, 500, { error: "internal_error" });
        }
      }
    }
  });

  let bridgeTimer:ReturnType<typeof setInterval>|undefined;
  if(!isReadOnlyInstance())httpServer.once('listening',()=>{
    recoverMyAgentRuns();startTelegramChannels();
    const run=()=>import('./bridges/api.ts').then(({bridges})=>bridges.tick()).catch(()=>{});
    bridgeTimer=setInterval(run,5000);bridgeTimer.unref();
  });

  httpServer.on("close", () => {
    stopConsentTicketGc();
    if(bridgeTimer)clearInterval(bridgeTimer);
    stopTelegramChannels();void stopMyAgents().catch(()=>logger.error('Agent process termination was not confirmed during shutdown'));
  });

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
  const rawUrl = req.url || "/";
  // Route by pathname, not the full URL. Browser OAuth consent bounces through
  // /dashboard?next=...; matching against req.url made that valid dashboard
  // URL fall through to {error:"not_found"}.
  let url = rawUrl;
  try {
    url = new URL(rawUrl, "http://local").pathname;
  } catch {
    url = rawUrl.split("?", 1)[0] || "/";
  }
  const method = (req.method || "GET").toUpperCase();
  const clientIp = getClientIp(req);
  if(method === 'GET' || method === 'HEAD'){
    const shell=webAppAsset(url);
    if(shell){res.writeHead(200,{'content-type':shell.type,'cache-control':'no-cache','x-content-type-options':'nosniff','service-worker-allowed':'/'});return res.end(method==='HEAD'?undefined:shell.body);}
    const asset=brandAsset(url);
    if(asset){res.writeHead(200,{'content-type':asset.type,'cache-control':'no-cache',...securityHeaders(req)});return res.end(method==='HEAD'?undefined:asset.body);}
  }


  // CORS preflight
  if (method === "OPTIONS") {
    const origin = getAllowedOrigin(req);
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, idempotency-key, if-match, mcp-session-id, mcp-protocol-version",
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

  if (process.env.QOOPIA_STANDALONE === 'true') {
    const host = `127.0.0.1:${env.PORT}`;
    if (req.headers.host !== host) return json(res,403,{error:'Host refused'},req);
  }
  if (method === 'GET' && url.startsWith('/api/dashboard/')) renewLocalOwnerSession(req,res);
  if(url==='/api/dashboard/profile'){
    const auth=checkDashboardAuth(req);
    if(!auth||auth.source!=='cookie')return json(res,401,{error:'Sign in to your dashboard'},req);
    if(method!=='GET')return json(res,405,{error:'Read only'},req);
    try{
      const root=process.env.QOOPIA_STANDALONE==='true'?JSON.parse(process.env.QOOPIA_STANDALONE_LAYOUT!).root:env.ROOT_DIR;
      const identity=ownerIdentity(root);
      return json(res,200,{email:identity?.ownerId===auth.agent_id?identity.email:null},req);
    }catch{return json(res,200,{email:null},req);}
  }
  if(url==='/api/dashboard/identity'||url.startsWith('/api/dashboard/identity/')){
      if(!ownerIdentityEnabled())return json(res,404,{error:'Owner email login is not configured'},req);
      const route=url.slice('/api/dashboard/identity'.length);
      if(isReadOnlyInstance()||!ownerIdentityRequestAllowed(req,method!=='GET'||route!==''))return json(res,403,{error:'Owner login origin refused'},req);
      if(method!=='GET'||route!==''){
        if(method!=='POST'||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{error:'Same-origin action required'},req);
      }
      try{
        const standalone=process.env.QOOPIA_STANDALONE==='true';
        if(standalone&&!process.env.QOOPIA_STANDALONE_LAYOUT)return json(res,503,{error:'Installed Qoopia is required'},req);
        const identityRoot=standalone?JSON.parse(process.env.QOOPIA_STANDALONE_LAYOUT!).root:env.ROOT_DIR;
        if(!standalone&&!ownerIdentity(identityRoot))return json(res,503,{error:'Server owner identity is not provisioned'},req);
        const body=method==='POST'?JSON.parse((await readBodyLimited(req,2048)).toString()):{};
        if(!body||typeof body!=='object'||Array.isArray(body))return json(res,400,{error:'Invalid request'},req);
        identityHandler??=localIdentityLogin(identityRoot,db);
        return await identityHandler(req,res,route,body);
      }catch{return json(res,400,{error:'Invalid sign-in request'},req);}
  }
  if(url==='/api/dashboard/my-agent'||url==='/api/dashboard/my-agent/file') {
    res.setHeader('cache-control','no-store');
    const auth=checkDashboardAuth(req);
    if(!auth||auth.source!=='cookie')return json(res,401,{error_description:'Sign in as owner'},req);
    if(isReadOnlyInstance())return json(res,403,{error_description:'Canonical workspace required'},req);
    try {
      if(url.endsWith('/file')){
        if(method!=='GET')return json(res,405,{error_description:'Read only'},req);
        const artifact=readAgentArtifact(auth.agent_id,new URL(rawUrl,'http://local').searchParams.get('path')??'');
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(artifact.bytes.length),'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(artifact.name),'x-content-type-options':'nosniff','content-security-policy':"sandbox; default-src 'none'"});return res.end(artifact.bytes);
      }
      if(method==='GET'){const query=new URL(rawUrl,'http://local').searchParams;return json(res,200,{...myAgentState(auth.agent_id,query.get('conversation')??undefined,{runBefore:query.get('runBefore')??undefined,conversationOffset:Number(query.get('conversationOffset')??0)}),telegram_setup:telegramState(auth.agent_id)},req);}
      if(method!=='POST'||!dashboardOriginAllowed(req)||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{error_description:'Same-origin action required'},req);
      const body=JSON.parse((await readBodyLimited(req,32*1024)).toString());
      const result=typeof body?.action==='string'&&body.action.startsWith('telegram-')?await telegramAction(auth.agent_id,body):await submitMyAgentAction(auth.agent_id,body);
      return json(res,'accepted' in result&&result.accepted?202:200,result,req);
    }catch(error){return json(res,error instanceof QoopiaError&&error.code==='FORBIDDEN'?403:400,{error_description:error instanceof QoopiaError?error.message:'Agent action failed. Check your connection and try again.'},req);}
  }
  if(url==='/api/dashboard/bridges') {
    res.setHeader('cache-control','no-store');
    const auth=checkDashboardAuth(req);
    if(!auth||auth.source!=='cookie')return json(res,401,{error_description:'Sign in as owner'},req);
    if(isReadOnlyInstance())return json(res,403,{error_description:'Canonical workspace required'},req);
    const {bridgeState,bridgeAction}=await import('./bridges/api.ts');
    try {
      if(method==='GET')return json(res,200,bridgeState(auth.agent_id),req);
      if(method!=='POST'||!dashboardOriginAllowed(req)||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{error_description:'Same-origin action required'},req);
      const body=JSON.parse((await readBodyLimited(req,2*1024*1024)).toString());
      return json(res,200,await bridgeAction(auth.agent_id,body),req);
    } catch(error){return json(res,error instanceof QoopiaError&&error.code==='FORBIDDEN'?403:400,
      {error_description:error instanceof QoopiaError?error.message:'Bridge action failed. Keep your invitation or draft and try again.'},req);}
  }
  if(url==='/api/dashboard/memory'||url==='/api/dashboard/connections'||url==='/api/dashboard/connection-setup') {
    res.setHeader('cache-control','no-store');
    const auth=checkDashboardAuth(req);
    if(!auth||auth.source!=='cookie')return json(res,401,{error_description:'Sign in as owner'},req);
    if(isReadOnlyInstance())return json(res,403,{error_description:'Canonical workspace required'},req);
    const {memorySetupState,submitMemorySetupAction}=await import('./services/memory-setup.ts');
    try {
      if(url==='/api/dashboard/connection-setup'){
        const {managedNetworkAction,submitManagedNetworkAction}=await import('./delivery/managed-transport.ts');
        if(method==='GET')return json(res,200,{...connectionAction(auth.agent_id,{action:'status'}),network:await managedNetworkAction(auth.agent_id,{action:'network-status'})},req);
        if(method!=='POST'||!dashboardOriginAllowed(req)||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{code:'FORBIDDEN',state:'error'},req);
        const input=JSON.parse((await readBodyLimited(req,4096)).toString());
        const result=typeof input?.action==='string'&&input.action.startsWith('network-')?await submitManagedNetworkAction(auth.agent_id,input):await connectionAction(auth.agent_id,input);
        return json(res,'accepted' in result&&result.accepted?202:200,result,req);
      }
      if(url==='/api/dashboard/connections')return json(res,method==='GET'?200:405,method==='GET'?browserConnectionState(auth.agent_id):{error_description:'Read only'},req);
      if(method==='GET')return json(res,200,memorySetupState(auth.agent_id),req);
      if(method!=='POST'||!dashboardOriginAllowed(req)||req.headers['x-qoopia-csrf']!=='1')return json(res,403,{error_description:'Same-origin action required'},req);
      const body=JSON.parse((await readBodyLimited(req,12*1024)).toString());
      const result=await submitMemorySetupAction(auth.agent_id,body);
      return json(res,'accepted' in result&&result.accepted?202:200,result,req);
    } catch(error){return json(res,error instanceof QoopiaError&&error.code==='FORBIDDEN'?403:400,
      {state:'error',code:error instanceof QoopiaError?error.code:'INVALID_INPUT',error_description:error instanceof QoopiaError?error.message:'Setup failed; check the selected action'},req);}
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
      localOwnerLoginHandler(req,res,ownerId);return;
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
      }catch(error){return json(res,error instanceof QoopiaError&&error.code==='FORBIDDEN'?403:400,workspaceError(error),req);}
    }
  }

  if (url.startsWith("/api/dashboard/authority/")) {
    const dash = checkDashboardAuth(req);
    if (!dash) return json(res,401,{error:{code:"UNAUTHENTICATED",message:"Sign in to the dashboard"}},req);
    if (method !== "GET" && (!dashboardOriginAllowed(req) || req.headers["x-qoopia-csrf"] !== "1")) {
      return json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin dashboard mutation required"}},req);
    }
    const body = method === "GET" ? undefined : await readBodyLimited(req,4*1024*1024);
    const headers = new Headers();
    for (const [name,value] of Object.entries(req.headers)) if(typeof value === "string") headers.set(name,value);
    const auth: AuthContext = {workspace_id:dash.workspace_id,agent_id:dash.agent_id,agent_name:"dashboard session",type:dash.type,
      source:dash.source === "cookie" ? "api-key" : dash.source,granted_scope:dash.granted_scope};
    const response = await handleAuthorityRequest(new Request(`http://local${rawUrl.replace("/api/dashboard/authority/","/api/v1/")}`,{method,headers,body}),undefined,auth);
    res.writeHead(response.status,{...Object.fromEntries(response.headers),"cache-control":"no-store"});res.end(await response.text());return;
  }
  if (url.startsWith("/api/v1/")) {
    const body = method === "GET" ? undefined : await readBodyLimited(req, 4 * 1024 * 1024);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const response = await handleAuthorityRequest(new Request(`http://local${rawUrl}`, { method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
    return;
  }

  // --- Health ---
  if (url === "/health") {
    const release = getVerifiedReleaseBaseline();
    const schemaVersion = readSchemaVersion(db);
    const featureFlags = getV4FeatureFlags();
    const storage = storageDegradation();
    return json(res, 200, {
      status: storage.degraded ? "degraded" : "ok",
      version: PRODUCT_VERSION,
      release_sha: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      schema_version: schemaVersion,
      feature_flags: featureFlags,
      build_commit: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      server_role: env.SERVER_ROLE,
      instance_id: env.INSTANCE_ID,
      writes_enabled: !isReadOnlyInstance() && !storage.degraded,
      checks: { storage: storage.degraded ? "degraded" : "ok" },
      ...(storage.degraded ? { degradation: storage } : {}),
      uptime: Math.round(process.uptime()),
    }, req);
  }

  if (url === "/ready" && method === "GET") {
    const release = getVerifiedReleaseBaseline();
    const readiness = evaluateReadiness(db, getPendingMigrations);
    return json(res, readiness.ready ? 200 : 503, {
      status: readiness.ready ? "ready" : "not_ready",
      version: PRODUCT_VERSION,
      release_sha: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      build_commit: release?.commitSha ?? process.env.QOOPIA_EXPECTED_RELEASE_SHA ?? null,
      schema_version: readiness.schema_version,
      feature_flags: getV4FeatureFlags(),
      server_role: env.SERVER_ROLE,
      instance_id: env.INSTANCE_ID,
      writes_enabled: !isReadOnlyInstance() && !storageDegradation().degraded,
      checks: readiness.checks,
      ...(storageDegradation().degraded ? { degradation: storageDegradation() } : {}),
    }, req);
  }

  if (url === "/") {
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
  const isMcp =
    url === "/mcp" ||
    url === "/mcp/" ||
    url.startsWith("/mcp?") ||
    url.startsWith("/mcp/?");
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
    (url === "/oauth/authorize" ||
      url.startsWith("/oauth/authorize?") ||
      url === "/oauth/authorize/finalize" ||
      url.startsWith("/oauth/authorize/finalize?") ||
      url === "/api/dashboard/oauth-consent" ||
      url.startsWith("/api/dashboard/oauth-consent?"))
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
  if(['/connections-guide-en.html','/connections-guide-ru.html'].includes(url)&&method==='GET'){
    return sendHtml(res,200,readFileSync(assetPath('src/public'+url),'utf8'),req);
  }
  if (url === "/dashboard") {
    return serveDashboard(req, res);
  }

  // --- OAuth discovery ---
  if (url === "/.well-known/oauth-authorization-server" || url.startsWith("/.well-known/oauth-authorization-server/")) {
    // Some OAuth clients derive RFC 8414 metadata from the protected resource
    // path and request /.well-known/oauth-authorization-server/mcp. The issuer
    // is still the host root, so serve the same metadata instead of 404.
    const connection=/^\/\.well-known\/oauth-authorization-server\/oauth\/c\/([a-f0-9-]{36})$/.exec(url)?.[1];
    if(connection)publicConnection(connection);
    return json(res, 200, wellKnownAuthorizationServer(connection), req);
  }
  if (url.startsWith("/.well-known/oauth-protected-resource")) {
    const connection=/^\/\.well-known\/oauth-protected-resource\/mcp\/c\/([a-f0-9-]{36})$/.exec(url)?.[1];
    if(connection)publicConnection(connection);
    return json(res, 200, wellKnownProtectedResource(connection), req);
  }

  // --- OAuth endpoints (stricter: 20 req/min per IP) ---
  if(/^\/oauth\/consent(?:\/(?:start|check|approve|deny))?$/.test(new URL(url,'http://local').pathname)){
    if(rateLimit429(authLimiter,'auth',clientIp,res))return;
    if(isReadOnlyInstance())return json(res,403,{error:'Read-only installation'},req);
    const root=connectionIdentityRoot();if(!root)return json(res,503,{error:'Owner account setup required'},req);
    if(connectionConsentHandler?.root!==root)connectionConsentHandler={root,handler:remoteConnectionConsent(root,db)};
    const body=method==='POST'?await readBodyLimited(req,2048):undefined;
    const response=await connectionConsentHandler.handler(nodeReqToFetchRequest(req,body));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  // ADR-017: /oauth/authorize is now a thin redirect target. It validates
  // params + client + redirect_uri, creates a server-side consent_ticket,
  // and 302s to the dashboard-scoped consent UI. The /oauth/* surface
  // never reads the dashboard cookie (ADR-015 §"the cookie is never
  // attached outside dashboard routes" preserved).
  if (url.startsWith("/oauth/authorize/finalize") && method === "GET") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    return handleAuthorizeFinalize(req, res, clientIp);
  }
  if (url.startsWith("/oauth/authorize") && method === "GET") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    return handleAuthorizeRedirect(req, res, clientIp);
  }
  if ((url === "/oauth/authorize" || url === "/oauth/authorize/") && method === "POST") {
    // ADR-017: POST /oauth/authorize is gone. Approval lives on the
    // dashboard surface. Explicitly 405 so a stale Claude.ai client or a
    // crawler hitting the old path gets a deterministic error rather than
    // a 404.
    res.writeHead(405, { "content-type": "application/json", allow: "GET" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
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
            "Bearer api_key required (steward or claude-privileged scope).",
        });
      }
      const selectedConnection=new URL(req.url!,env.PUBLIC_URL).searchParams.get("connection");
      const publicDcr = selectedConnection ? {auth:connectionRegistrationAuth(selectedConnection),detail:"owner-provisioned connection registration"} : resolveTrustedUnauthenticatedDcrAuth(body);
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
          "Bearer api_key required (steward or claude-privileged scope).",
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
  if (url === "/oauth/register" || url === "/oauth/register/") {
    return json(res, 405, { error: "method_not_allowed", allow: "POST" }, req);
  }
  if ((url === "/oauth/token" || url === "/oauth/token/") && method !== "POST") {
    return json(res, 405, { error: "method_not_allowed", allow: "POST" }, req);
  }
  if ((url === "/oauth/revoke" || url === "/oauth/revoke/") && method === "POST") {
    if (rateLimit429(authLimiter, "auth", clientIp, res)) return;
    const body = await readBody(req);
    return handleRevoke(body, res, clientIp);
  }

  if(url==='/memory/continuity'&&method==='POST') {
    res.setHeader('cache-control','no-store');
    if(rateLimit429(ingestLimiter,'continuity',clientIp,res))return;
    const auth=authenticate(nodeReqToFetchRequest(req));
    if(!auth)return json(res,401,{error:'unauthenticated'},req);
    try {
      const {currentToolAuth}=await import('./auth/policy.ts');
      const {continuityEvent}=await import('./services/continuity.ts');
      const body=JSON.parse((await readBodyLimited(req,512*1024)).toString());
      currentToolAuth(db,auth,'write-low');
      return json(res,200,continuityEvent(auth.workspace_id,auth.agent_id,body),req);
    }catch(error){return json(res,error instanceof QoopiaError&&error.code==='NOT_FOUND'?404:400,{error:'Continuity request refused'},req);}
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
    const rawBody = await readBody(req);
    const fetchReq = nodeReqToFetchRequest(req, rawBody);
    const auth = authenticate(fetchReq);
    if (!auth || auth.type !== "ingest-daemon") {
      audit({ event: "ingest_forbidden", result: "deny", ip: clientIp, scope: "/ingest/session", detail: auth ? `wrong type: ${auth.type}` : "no auth" });
      return json(res, 403, { error: "forbidden", error_description: "ingest-daemon credentials required" }, req);
    }
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
        metadata: { ingest_cwd: payload.cwd ?? "", ingest_ts: payload.timestamp ?? "", ...(payload.metadata ?? {}) },
      });
      return json(res, 200, result, req);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "FORBIDDEN") return json(res, 409, { error: "session_conflict", detail: e.message }, req);
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
  if (url.startsWith("/api/dashboard/oauth-consent") && method === "GET") {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    return handleDashboardOAuthConsentGet(req, res);
  }
  if (url === "/api/dashboard/oauth-consent/approve" && method === "POST") {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    const body = await readBody(req);
    return handleDashboardOAuthConsentApprove(req, body, res, clientIp);
  }
  if (url === "/api/dashboard/oauth-consent/deny" && method === "POST") {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    const body = await readBody(req);
    return handleDashboardOAuthConsentDeny(req, body, res, clientIp);
  }
  if (url === "/api/dashboard/oauth/clients" && method === "POST") {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    const body = await readBody(req);
    return handleDashboardRegisterClient(req, body, res, clientIp);
  }

  // --- Dashboard file upload (POST) + delete (DELETE) — owner-only, before GET gate ---
  if (url === "/api/dashboard/files" && method === "POST") {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    return handleFileUpload(req, res);
  }
  {
    const fm = url.match(/^\/api\/dashboard\/files\/([^/]+)$/);
    if (fm && method === "DELETE") {
      if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
      return handleFileDelete(req, res, decodeURIComponent(fm[1]!));
    }
  }

  // --- Dashboard API (read-only, 200 req/min per IP) ---
  if (url.startsWith("/api/dashboard")) {
    if (rateLimit429(dashboardLimiter, "dashboard", clientIp, res)) return;
    if (handleDashboardApi(req, res)) return;
  }

  // --- MCP endpoint (300 req/min per IP) ---
  // Accept both /mcp and /mcp/ because some UI clients/browser flows
  // normalize connector URLs by adding a trailing slash.
  if (/^\/mcp\/c\/[a-f0-9-]{36}$/.test(url) || url === "/mcp" || url === "/mcp/" || url.startsWith("/mcp?") || url.startsWith("/mcp/?")) {
    if (rateLimit429(mcpLimiter, "mcp", clientIp, res)) return;
    return handleMcp(req, res);
  }

  return json(res, 404, { error: "not_found" }, req);
}
