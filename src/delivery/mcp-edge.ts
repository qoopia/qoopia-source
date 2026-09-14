import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import {pipeline} from 'node:stream';

/** The tunnel targets this loopback listener, never the dashboard listener. */
export interface McpEdgeOptions {
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
  '/brand/MarckScript-Regular.ttf':['GET','HEAD'],
  '/brand/IBMPlexSans.ttf':['GET','HEAD'],
  '/brand/logo/qoopia-mark.svg':['GET','HEAD'],
  '/brand/logo/qoopia-favicon.svg':['GET','HEAD'],
  '/mcp': ['GET', 'POST', 'DELETE', 'OPTIONS'],
  '/.well-known/oauth-protected-resource': ['GET', 'OPTIONS'],
  '/.well-known/oauth-protected-resource/mcp': ['GET', 'OPTIONS'],
  '/.well-known/oauth-authorization-server': ['GET', 'OPTIONS'],
  '/.well-known/oauth-authorization-server/mcp': ['GET', 'OPTIONS'],
  '/oauth/authorize': ['GET'],
  '/oauth/authorize/finalize': ['GET'],
  '/oauth/consent':['GET'],
  '/oauth/consent/start':['POST'],
  '/oauth/consent/check':['POST'],
  '/oauth/consent/approve':['POST'],
  '/oauth/consent/deny':['POST'],
  '/oauth/token': ['POST', 'OPTIONS'],
  '/oauth/register': ['POST', 'OPTIONS'],
  '/oauth/revoke': ['POST', 'OPTIONS'],
};
// Explicit allowlists also remove proxy credentials, cookies and spoofed identity headers.
const requestHeaders = ['authorization', 'accept', 'content-type', 'origin', 'mcp-protocol-version', 'mcp-session-id',
  'last-event-id', 'access-control-request-method', 'access-control-request-headers'];
const responseHeaders = ['content-type', 'www-authenticate', 'mcp-session-id', 'mcp-protocol-version', 'retry-after',
  'allow', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-expose-headers', 'access-control-max-age', 'vary'];
const consentCookie=/^__Secure-qoopia_consent_(?:[a-f0-9]{16}|login)=[A-Za-z0-9_-]{43}$/;

export function mcpEdgeRoute(raw: string, method: string): 'allowed' | 'not_found' | 'method_not_allowed' {
  // Do not let URL normalization turn a forbidden path into an allowed one.
  const pathname = raw.split('?')[0]!;
  const methods = routes[pathname] ?? (/^\/mcp\/c\/[a-f0-9-]{36}$/.test(pathname) ? routes["/mcp"] :
    /^\/\.well-known\/(?:oauth-protected-resource\/mcp|oauth-authorization-server\/oauth)\/c\/[a-f0-9-]{36}$/.test(pathname) ? ["GET","OPTIONS"] : undefined);
  return !methods ? 'not_found' : methods.includes(method) ? 'allowed' : 'method_not_allowed';
}

/** No request/response logging, persistence, redirects, or automatic retries. Auth remains local. */
export function startMcpEdge(options: McpEdgeOptions) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('External MCP requires a plain HTTPS origin');
  if (!Number.isInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65535)
    throw new Error('Invalid loopback upstream port');
  const timeoutMs = options.timeoutMs ?? 65_000, limit = options.maxBodyBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid edge limits');
  const fail = (res: ServerResponse, status: number, code: string) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
    res.end(JSON.stringify({error: code, retry: 'client_decision', memory_preserved: true}));
  };
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (options.available && !options.available()) return fail(res,503,'DEVICE_LEASE_UNAVAILABLE');
    if (req.headers.host !== origin.host) return fail(res, 403, 'HOST_REFUSED');
    const route = mcpEdgeRoute(req.url ?? '', req.method ?? 'GET');
    if (route !== 'allowed') return fail(res, route === 'not_found' ? 404 : 405, route.toUpperCase());
    if (Number(req.headers['content-length'] ?? 0) > limit) return fail(res, 413, 'BODY_TOO_LARGE');
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) { fail(res, 413, 'BODY_TOO_LARGE'); return; }
        chunks.push(Buffer.from(chunk));
      }
    } catch { return fail(res, 400, 'REQUEST_INTERRUPTED'); }
    const headers: http.OutgoingHttpHeaders = {host: `127.0.0.1:${options.upstreamPort}`, 'accept-encoding': 'identity'};
    for (const key of requestHeaders) if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    const consentRoute=(req.url??'').split('?')[0]!.startsWith('/oauth/consent');
    if(consentRoute){
      const cookies=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>consentCookie.test(s));
      if(cookies.length)headers.cookie=cookies.join('; ');
    }
    if (size) headers['content-length'] = size;
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
        for(const name of ['content-security-policy','x-frame-options','x-content-type-options','referrer-policy'])
          if(response.headers[name])res.setHeader(name,response.headers[name]!);
      }
      res.setHeader('cache-control', 'no-store');
      res.statusCode = response.statusCode ?? 502;
      pipeline(response, res, () => { clearTimeout(timer); });
    });
    const timer = setTimeout(() => { fail(res, 504, 'INSTALLATION_TIMEOUT'); upstream.destroy(); }, timeoutMs);
    upstream.on('error', () => { clearTimeout(timer); fail(res, 503, 'INSTALLATION_UNAVAILABLE'); });
    res.once('close', () => { clearTimeout(timer); upstream.destroy(); });
    upstream.end(Buffer.concat(chunks));
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  if(options.socketPath)server.listen(options.socketPath);else server.listen(options.port ?? 0, '127.0.0.1');
  return server;
}
