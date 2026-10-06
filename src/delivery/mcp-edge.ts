import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import {pipeline} from 'node:stream';
import {readRequestBody, repeatsSingletonHeader, RequestBodyError, unreadBody} from '../utils/http-json.ts';
import {isIP} from 'node:net';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {CONTINUITY_MAX_BODY_BYTES, MAX_BODY_BYTES} from '../utils/http-json.ts';

/** The tunnel targets this loopback listener, never the dashboard listener. */
interface McpEdgeOptions {
  publicOrigin: string;
  upstreamPort: number;
  port?: number;
  socketPath?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  available?: () => boolean;
}
const routes: Record<string, readonly string[]> = {
  // Public, static design resources required by the isolated consent page.
  '/brand/base.css':['GET','HEAD'],
  '/brand/tokens.css':['GET','HEAD'],
  '/brand/Manrope.ttf':['GET','HEAD'],
  '/brand/graphite/qoopia-mark-ivory.svg':['GET','HEAD'],
  '/brand/graphite/qoopia-wordmark-ivory.svg':['GET','HEAD'],
  '/brand/graphite/favicon.svg':['GET','HEAD'],
  '/brand/graphite/icon-180.png':['GET','HEAD'],
  '/brand/logo/qoopia-mark.svg':['GET','HEAD'],
  '/brand/logo/qoopia-favicon.svg':['GET','HEAD'],
  '/mcp': ['GET', 'POST', 'DELETE', 'OPTIONS'],
  // The exact alias the local server accepts: Claude.ai connector flows were seen adding the slash (19facaa).
  '/mcp/': ['GET', 'POST', 'DELETE', 'OPTIONS'],
  '/.well-known/oauth-protected-resource': ['GET', 'OPTIONS'],
  '/.well-known/oauth-protected-resource/mcp': ['GET', 'OPTIONS'],
  '/.well-known/oauth-authorization-server': ['GET', 'OPTIONS'],
  '/.well-known/oauth-authorization-server/mcp': ['GET', 'OPTIONS'],
  '/oauth/authorize': ['GET'],
  '/oauth/consent':['GET'],
  '/oauth/consent/start':['POST'],
  '/oauth/consent/check':['POST'],
  '/oauth/consent/approve':['POST'],
  '/oauth/consent/deny':['POST'],
  '/oauth/token': ['POST', 'OPTIONS'],
  '/oauth/register': ['POST', 'OPTIONS'],
  '/oauth/revoke': ['POST', 'OPTIONS'],
  // Session memory hooks of an agent on another computer. Key-authenticated writes only.
  '/memory/continuity': ['POST'],
};
/** Routes that carry no OAuth discovery: a request without a bearer credential never reaches the installation. */
const bearerRequired = new Set(['/memory/continuity']);
const routeBodyLimit: Record<string, number> = {'/memory/continuity': CONTINUITY_MAX_BODY_BYTES};
// Explicit allowlists also remove proxy credentials, cookies and spoofed identity headers.
const requestHeaders = ['authorization', 'accept', 'accept-language', 'content-type', 'origin', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id',
  'last-event-id', 'access-control-request-method', 'access-control-request-headers'];
// The upstream's own security headers pass on every route: /brand/* and /oauth/authorize can be HTML/CSS/SVG.
const responseHeaders = ['content-type', 'www-authenticate', 'mcp-session-id', 'mcp-protocol-version', 'retry-after',
  'allow', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-expose-headers', 'access-control-max-age', 'vary',
  'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
const consentCookie=/^__Secure-qoopia_consent_(?:[a-f0-9]{16}|login)=[A-Za-z0-9_-]{43}$/;
// The edge runs inside the server process and reaches it over loopback. This per-process secret
// marks edge traffic so rate limits key on the Cloudflare client address, never on a header a client chose.
const EDGE_CLIENT_HEADER = 'x-qoopia-edge-client', edgeSecret = randomBytes(32).toString('base64url');

/** `edge:<address>` for a request forwarded by this process's edge, otherwise undefined. */
export function edgeClientKey(req: IncomingMessage): string | undefined {
  const value = req.headers[EDGE_CLIENT_HEADER];
  if (typeof value !== 'string') return undefined;
  const [secret = '', address] = value.split(' '), given = Buffer.from(secret), expected = Buffer.from(edgeSecret);
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'edge:' + address : undefined;
}

export function mcpEdgeRoute(raw: string, method: string): 'allowed' | 'not_found' | 'method_not_allowed' {
  // Do not let URL normalization turn a forbidden path into an allowed one.
  const pathname = raw.split('?')[0]!;
  // A connection path may carry Claude.ai's trailing slash; the installation canonicalizes it.
  const methods = routes[pathname] ?? (/^\/mcp\/c\/[a-f0-9-]{36}\/?$/.test(pathname) ? routes["/mcp"] :
    /^\/\.well-known\/(?:oauth-protected-resource\/mcp|oauth-authorization-server\/(?:oauth|mcp))\/c\/[a-f0-9-]{36}\/?$/.test(pathname) ? ["GET","OPTIONS"] : undefined);
  return !methods ? 'not_found' : methods.includes(method) ? 'allowed' : 'method_not_allowed';
}

// A person who opens the tunnel address in a phone browser gets an answer, not a JSON NOT_FOUND:
// this origin publishes only MCP/OAuth, and the dashboard stays on the installation's own computer.
function notADashboard(req: IncomingMessage, res: ServerResponse) {
  const ru = /^\s*ru\b/i.test(req.headers['accept-language'] ?? '');
  const [title, body] = ru
    ? ['Это адрес для AI-клиентов', 'Через него ChatGPT, Claude и другие приложения подключаются к памяти Qoopia (MCP). Дашборда здесь нет: откройте его на компьютере, где работает Qoopia.']
    : ['This address is for AI clients', 'ChatGPT, Claude and other apps use it to connect to Qoopia memory (MCP). It has no dashboard: open the dashboard on the computer where Qoopia runs.'];
  res.writeHead(404, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
  res.end(`<!doctype html><html lang="${ru ? 'ru' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qoopia</title><link rel="stylesheet" href="/brand/base.css"><body class="q-auth"><main><h1>${title}</h1><p>${body}</p></main></html>`);
}

/** No request/response logging, persistence, redirects, or automatic retries. Auth remains local. */
export function startMcpEdge(options: McpEdgeOptions) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('External MCP requires a plain HTTPS origin');
  if (!Number.isInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65535)
    throw new Error('Invalid loopback upstream port');
  const timeoutMs = options.timeoutMs ?? 65_000, limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid edge limits');
  const fail = (res: ServerResponse, status: number, code: string) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
    res.end(JSON.stringify({error: code, retry: 'client_decision', memory_preserved: true}));
  };
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // The public origin is HTTPS-only (checked above), so every reply, refusals included, pins it.
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // A refused or stalled body is not drained, and nothing more is read after a repeated
    // Content-Length/Transfer-Encoding: the socket closes once the reply is out.
    const repeated = repeatsSingletonHeader(req);
    res.once('finish', () => { if (repeated || unreadBody(req)) req.destroy(); });
    if (repeated) return fail(res, 400, 'DUPLICATE_HEADER');
    if (options.available && !options.available()) return fail(res,503,'DEVICE_LEASE_UNAVAILABLE');
    if (req.headers.host !== origin.host) return fail(res, 403, 'HOST_REFUSED');
    const route = mcpEdgeRoute(req.url ?? '', req.method ?? 'GET');
    if (route === 'not_found' && req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '')) return notADashboard(req, res);
    if (route !== 'allowed') return fail(res, route === 'not_found' ? 404 : 405, route.toUpperCase());
    const pathname = (req.url ?? '').split('?')[0]!;
    if (bearerRequired.has(pathname) && !/^Bearer [A-Za-z0-9._~+/=-]+$/.test(req.headers.authorization ?? ''))
      return fail(res, 401, 'AUTHORIZATION_REQUIRED');
    let body: Buffer;
    try { body = await readRequestBody(req, Math.min(limit, routeBodyLimit[pathname] ?? limit), timeoutMs); }
    catch (e) {
      return e instanceof RequestBodyError ? fail(res, e.status, e.status === 413 ? 'BODY_TOO_LARGE' : 'REQUEST_TIMEOUT') : fail(res, 400, 'REQUEST_INTERRUPTED');
    }
    const headers: http.OutgoingHttpHeaders = {host: `127.0.0.1:${options.upstreamPort}`, 'accept-encoding': 'identity'};
    for (const key of requestHeaders) if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    const client = req.headers['cf-connecting-ip'];
    headers[EDGE_CLIENT_HEADER] = edgeSecret + ' ' + (typeof client === 'string' && isIP(client) ? client : 'unknown');
    const consentRoute=(req.url??'').split('?')[0]!.startsWith('/oauth/consent');
    if(consentRoute){
      const cookies=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>consentCookie.test(s));
      if(cookies.length)headers.cookie=cookies.join('; ');
    }
    if (body.length) headers['content-length'] = body.length;
    const upstream = http.request({hostname: '127.0.0.1', port: options.upstreamPort, path: req.url, method: req.method, headers}, response => {
      // A local dashboard URL must not become an accidentally published admin route.
      const location = response.headers.location;
      if (location) {
        let redirect: URL;
        try { redirect = new URL(location, origin); } catch { response.destroy(); return fail(res, 502, 'INVALID_AUTH_REDIRECT'); }
        if (redirect.origin === origin.origin && mcpEdgeRoute(redirect.pathname, 'GET') !== 'allowed') {
          response.destroy(); return fail(res, 503, 'REMOTE_CONSENT_REQUIRED');
        }
        res.setHeader('location', location);
      }
      for (const key of responseHeaders) if (response.headers[key] !== undefined) res.setHeader(key, response.headers[key]!);
      if(consentRoute){
        // Dedicated consent cookies carry no dashboard authority and never leave these auth routes.
        const cookies=(response.headers['set-cookie']??[]).filter(s=>
          /^__Secure-qoopia_consent_(?:[a-f0-9]{16}|login)=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=(?:Strict|Lax); Path=\/oauth\/consent; Max-Age=600$/.test(s));
        if(cookies.length)res.setHeader('set-cookie',cookies);
      }
      res.setHeader('cache-control', 'no-store');
      res.statusCode = response.statusCode ?? 502;
      pipeline(response, res, () => { clearTimeout(timer); });
    });
    const timer = setTimeout(() => { fail(res, 504, 'INSTALLATION_TIMEOUT'); upstream.destroy(); }, timeoutMs);
    upstream.on('error', () => { clearTimeout(timer); fail(res, 503, 'INSTALLATION_UNAVAILABLE'); });
    res.once('close', () => { clearTimeout(timer); upstream.destroy(); });
    upstream.end(body);
  });
  if(options.socketPath)server.listen(options.socketPath);else server.listen(options.port ?? 0, '127.0.0.1');
  return server;
}
