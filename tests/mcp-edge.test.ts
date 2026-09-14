import {expect, test} from 'bun:test';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {mcpEdgeRoute, startMcpEdge} from '../src/delivery/mcp-edge.ts';

const ready = async (server: http.Server) => {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: http.Server) => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
};
function request(port: number, url: string, options: {method?: string; body?: string; headers?: Record<string,string>} = {}) {
  return new Promise<{status: number; body: string; headers: http.IncomingHttpHeaders}>((resolve, reject) => {
    const req = http.request({hostname:'127.0.0.1', port, path:url, method:options.method ?? 'GET',
      headers:{host:'synthetic.example', ...options.headers}}, res => {
      let body=''; res.on('data', data => body += data); res.on('end', () => resolve({status:res.statusCode!, body, headers:res.headers}));
    }); req.on('error',reject); req.end(options.body);
  });
}
test('edge rejects admin routes, path normalization tricks, and unsupported methods', () => {
  for (const url of ['/dashboard','/api/dashboard/login','/health','/ready','/mcp/','/x/../mcp','/%6dcp','//mcp','/mcp%2f..%2fdashboard'])
    expect(mcpEdgeRoute(url,'GET')).toBe('not_found');
  for(const asset of ['/brand/base.css','/brand/tokens.css','/brand/IBMPlexSans.ttf','/brand/MarckScript-Regular.ttf','/brand/logo/qoopia-mark.svg','/brand/logo/qoopia-favicon.svg']){expect(mcpEdgeRoute(asset,'GET')).toBe('allowed');expect(mcpEdgeRoute(asset,'POST')).toBe('method_not_allowed');}
  for(const asset of ['/brand/i18n.js','/brand/../identity/broker.ts','/brand/%2e%2e/identity/broker.ts','/brand/email-lockup.png'])expect(mcpEdgeRoute(asset,'GET')).toBe('not_found');
  expect(mcpEdgeRoute('/oauth/token','GET')).toBe('method_not_allowed');
  expect(mcpEdgeRoute('/mcp?profile=full','POST')).toBe('allowed');
});
test('edge preserves local authorization, strips identity/cookie headers, and never exposes admin redirects', async () => {
  let seen: http.IncomingHttpHeaders | undefined; let calls=0;
  const upstream=http.createServer((req,res) => {
    calls++; seen=req.headers;
    if(req.url==='/oauth/authorize') {res.writeHead(302,{location:'/api/dashboard/oauth-consent?ticket=synthetic'});res.end();return;}
    res.writeHead(401,{'www-authenticate':'Bearer resource_metadata="https://synthetic.example/.well-known/oauth-protected-resource"',
      'set-cookie':'owner=private','x-debug-secret':'private'});res.end('{"error":"unauthorized"}');
  }).listen(0,'127.0.0.1');
  const edge=startMcpEdge({publicOrigin:'https://synthetic.example',upstreamPort:await ready(upstream)}), port=await ready(edge);
  try {
    const response=await request(port,'/mcp',{method:'POST',body:'{}',headers:{authorization:'Bearer synthetic',cookie:'owner=private','x-qoopia-owner':'forged','x-forwarded-for':'forged'}});
    expect(response.status).toBe(401);expect(response.headers['www-authenticate']).toContain('synthetic.example');
    expect(seen?.authorization).toBe('Bearer synthetic');expect(seen?.cookie).toBeUndefined();expect(seen?.['x-qoopia-owner']).toBeUndefined();
    expect(seen?.['x-forwarded-for']).toBeUndefined();expect(seen?.host).toBe('127.0.0.1:'+await ready(upstream));
    expect(response.headers['set-cookie']).toBeUndefined();expect(response.headers['x-debug-secret']).toBeUndefined();
    expect((await request(port,'/dashboard')).status).toBe(404);
    expect((await request(port,'/mcp',{headers:{host:'attacker.example'}})).status).toBe(403);
    expect(calls).toBe(1);
    expect((await request(port,'/oauth/authorize')).body).toContain('REMOTE_CONSENT_REQUIRED');
  } finally {await close(edge);await close(upstream);}
});
test('offline installation is a service error; interrupted writes are never retried',async () => {
  let calls=0;
  const upstream=http.createServer((req)=>{calls++;req.socket.destroy();}).listen(0,'127.0.0.1');
  const port=await ready(upstream),edge=startMcpEdge({publicOrigin:'https://synthetic.example',upstreamPort:port});
  try {
    const r=await request(await ready(edge),'/mcp',{method:'POST',body:'{"method":"tools/call"}'});
    expect(r.status).toBe(503);expect(calls).toBe(1);expect(JSON.parse(r.body).retry).toBe('client_decision');
    await close(upstream);
    expect((await request(await ready(edge),'/mcp')).status).toBe(503);
  }finally{await close(edge);if(upstream.listening)await close(upstream);}
});
test('edge enforces bounded body and deadline',async () => {
  let calls=0;
  const upstream=http.createServer(()=>{calls++;}).listen(0,'127.0.0.1');
  const edge=startMcpEdge({publicOrigin:'https://synthetic.example',upstreamPort:await ready(upstream),timeoutMs:100,maxBodyBytes:8});
  try {
    const port=await ready(edge);
    expect((await request(port,'/mcp',{method:'POST',body:'123456789',headers:{'content-length':'9'}})).status).toBe(413);
    expect(calls).toBe(0);expect((await request(port,'/mcp')).status).toBe(504);expect(calls).toBe(1);
  }finally{await close(edge);await close(upstream);}
});

test('only dedicated consent cookies cross the auth edge, with frame/CSRF protection preserved',async()=>{
  const flow='__Secure-qoopia_consent_'+ 'a'.repeat(16)+'='+'b'.repeat(43),login='__Secure-qoopia_consent_login='+'c'.repeat(43);
  const suffix='; HttpOnly; Secure; SameSite=Strict; Path=/oauth/consent; Max-Age=600';
  let seen='';const upstream=http.createServer((req,res)=>{
    seen=req.headers.cookie??'';res.writeHead(200,{'content-type':'text/html','set-cookie':[flow+suffix,login+suffix,
      flow+'; Domain=example'+suffix,'qoopia_dash=private; HttpOnly; Path=/'],'content-security-policy':"frame-ancestors 'none'",'x-frame-options':'DENY'});res.end('Consent');
  }).listen(0,'127.0.0.1');
  const edge=startMcpEdge({publicOrigin:'https://synthetic.example',upstreamPort:await ready(upstream)});
  try{
    const response=await request(await ready(edge),'/oauth/consent?ticket=test',{headers:{cookie:'qoopia_dash=private; '+flow+'; '+login}});
    expect(seen).toBe(flow+'; '+login);expect(response.headers['set-cookie']).toEqual([flow+suffix,login+suffix]);
    expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'");expect(response.headers['x-frame-options']).toBe('DENY');
    const mcp=await request(await ready(edge),'/mcp',{headers:{cookie:flow+'; '+login}});expect(seen).toBe('');expect(mcp.headers['set-cookie']).toBeUndefined();
    expect((await request(await ready(edge),'/api/dashboard/identity')).status).toBe(404);
  }finally{await close(edge);await close(upstream);}
});
