/** Isolated, synthetic server for third-party MCP/OAuth conformance tools (MCPJam, MCP Inspector,
 * @modelcontextprotocol/conformance). A throw-away root under --out; never installed data, never
 * production, never the login broker. See docs/qa/mcp-oauth-conformance.md.
 *
 *   bun scripts/mcp-conformance-fixture.ts --out ABS_NEW_DIR [--tls|--edge] [-- COMMAND ARGS...]
 *
 * Without a command it prints the session and serves until interrupted. With one it runs the
 * command once (HOME is the throw-away root) and exits with its status. Placeholders in the
 * command: {MCP} root MCP URL, {CONN} per-connection MCP URL, {AUTHED_MCP} a loopback proxy that
 * adds a valid agent bearer (for tools without an auth option), {OUT} the --out directory.
 *
 * Owner consent is required by design. The harness answers it like the owner on this computer:
 * any authorization URL the command prints is driven through the real /oauth/authorize, the real
 * dashboard consent page and the real approve endpoint with the synthetic owner's own key. This
 * lives only here; the server has no auto-consent mode.
 *
 * Default: plain loopback HTTP. --tls and --edge give the public side an HTTPS origin, which
 * strict RFC 9728 clients require: a TLS terminator with a throw-away CA, reached through a
 * loopback CONNECT proxy that admits only that name (Node: NODE_USE_ENV_PROXY=1, set for the
 * command). --tls terminates straight into the server at https://qoopia-direct.test; --edge goes
 * through the real in-process tunnel edge (startMcpEdge) at https://qoopia-edge.test.
 */
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import http from 'node:http';
import https from 'node:https';import tls from 'node:tls';import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';import {once} from 'node:events';

const args=process.argv.slice(2),dash=args.indexOf('--'),own=dash<0?args:args.slice(0,dash),command=dash<0?[]:args.slice(dash+1);
const out=own[own.indexOf('--out')+1],edgeMode=own.includes('--edge'),tlsMode=edgeMode||own.includes('--tls');
if(!own.includes('--out')||!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Use --out ABSOLUTE_NEW_DIRECTORY');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const root=path.join(out,'server'),home=path.join(out,'home');
for(const dir of [root,home])fs.mkdirSync(dir,{recursive:true,mode:0o700});
const freePort=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;};
const port=await freePort(),local='http://127.0.0.1:'+port;
const EDGE_HOST=edgeMode?'qoopia-edge.test':'qoopia-direct.test',publicOrigin=tlsMode?'https://'+EDGE_HOST:local;
Object.assign(process.env,{QOOPIA_ADMIN_SECRET:randomBytes(32).toString('hex'),NODE_ENV:'test',QOOPIA_SERVER_ROLE:'canonical',
  QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups'),
  QOOPIA_PORT:String(port),QOOPIA_PUBLIC_URL:publicOrigin,QOOPIA_DASHBOARD_ALLOWED_ORIGINS:local,QOOPIA_LOG_LEVEL:'error',
  QOOPIA_SESSION_SECRET:randomBytes(32).toString('hex'),QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:'ollama',
  // direct/--edge: the Mac/Linux standalone shape (Host must be 127.0.0.1:PORT; the edge rewrites it).
  // --tls: the server-deployment shape behind a reverse proxy (no standalone Host pin).
  ...(edgeMode||!tlsMode?{QOOPIA_STANDALONE:'true',QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root,logs:path.join(root,'logs')})}:{})});
const {runMigrations}=await import('../src/db/migrate.ts');runMigrations();
const {db}=await import('../src/db/connection.ts'),{createWorkspace}=await import('../src/admin/workspaces.ts');
const {createAgent}=await import('../src/admin/agents.ts'),{bootstrapOwner}=await import('../src/auth/pairings.ts');
const {connectionAction}=await import('../src/services/client-connections.ts');
const ws=createWorkspace({name:'MCP conformance — synthetic only',slug:'conformance-'+randomUUID().slice(0,8)});
const owner=bootstrapOwner(db,'Synthetic conformance owner',undefined,ws.id);
const agent=createAgent({name:'conformance-agent',workspaceSlug:ws.slug});
const {startHttpServer}=await import('../src/http.ts');
const server=startHttpServer();if(!server.listening)await once(server,'listening');
const connection=(connectionAction(owner.agent_id,{action:'apply',surface:'codex',access_mode:'read_write',request_key:randomUUID(),
  transport:tlsMode?'remote':'local'}) as {connection:{id:string;mcp_url:string}}).connection;
const closers:Array<()=>void>=[()=>{server.closeAllConnections();server.close();}];

// --tls/--edge: throw-away CA + leaf for EDGE_HOST, TLS terminator -> [real edge ->] server, CONNECT proxy -> terminator.
let ca:Buffer|undefined,tlsPort=0,proxyUrl='';
if(tlsMode){
  const pki=path.join(root,'pki');fs.mkdirSync(pki,{mode:0o700});const p=(f:string)=>path.join(pki,f);
  const ssl=(...a:string[])=>execFileSync('openssl',a,{stdio:'ignore'});
  ssl('req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Qoopia conformance throw-away CA','-keyout',p('ca.key'),'-out',p('ca.pem'));
  ssl('req','-newkey','rsa:2048','-nodes','-subj','/CN='+EDGE_HOST,'-keyout',p('leaf.key'),'-out',p('leaf.csr'));
  fs.writeFileSync(p('ext'),`subjectAltName=DNS:${EDGE_HOST}\nextendedKeyUsage=serverAuth\n`);
  ssl('x509','-req','-in',p('leaf.csr'),'-CA',p('ca.pem'),'-CAkey',p('ca.key'),'-CAcreateserial','-days','2','-extfile',p('ext'),'-out',p('leaf.pem'));
  ca=fs.readFileSync(p('ca.pem'));
  const {startMcpEdge}=await import('../src/delivery/mcp-edge.ts');
  const edge=edgeMode?startMcpEdge({publicOrigin,upstreamPort:port}):undefined;if(edge&&!edge.listening)await once(edge,'listening');
  const target=edge?(edge.address() as net.AddressInfo).port:port;
  const terminator=tls.createServer({key:fs.readFileSync(p('leaf.key')),cert:fs.readFileSync(p('leaf.pem'))},s=>{const u=net.connect(target,'127.0.0.1');s.pipe(u).pipe(s);s.on('error',()=>u.destroy());u.on('error',()=>s.destroy());});
  terminator.listen(0,'127.0.0.1');await once(terminator,'listening');tlsPort=(terminator.address() as net.AddressInfo).port;
  const proxy=http.createServer((_q,r)=>{r.writeHead(403);r.end();});
  proxy.on('connect',(req,socket,head)=>{
    // Only the synthetic edge name: nothing else leaves through this proxy.
    if(req.url!==EDGE_HOST+':443'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const u=net.connect(tlsPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');u.write(head);socket.pipe(u).pipe(socket);});
    u.on('error',()=>socket.destroy());socket.on('error',()=>u.destroy());
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');proxyUrl='http://127.0.0.1:'+(proxy.address() as net.AddressInfo).port;
  fs.writeFileSync(path.join(out,'ca.pem'),ca);
  closers.push(()=>{edge?.close();terminator.close();proxy.close();});
}

// {AUTHED_MCP}: forwards to the direct server and adds the agent bearer. A Host naming this proxy becomes
// the server's own; any other Host and every Origin pass unchanged, so DNS-rebinding checks still see them.
const authed=http.createServer((req,res)=>{
  const headers={...req.headers};if(!headers.authorization)headers.authorization='Bearer '+agent.api_key;
  const self=(authed.address() as net.AddressInfo).port;
  if(headers.host==='127.0.0.1:'+self||headers.host==='localhost:'+self)headers.host='127.0.0.1:'+port;
  const up=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});
  up.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(up);
});
authed.listen(0,'127.0.0.1');await once(authed,'listening');
const authedMcp='http://127.0.0.1:'+(authed.address() as net.AddressInfo).port+'/mcp';
closers.push(()=>{authed.closeAllConnections();authed.close();});

type Reply={status:number;location?:string;body:string};
/** One request without following redirects; the public edge name goes through the TLS terminator. */
function request(url:string,init:{method?:string;headers?:Record<string,string>;body?:string}={}):Promise<Reply>{
  const u=new URL(url),viaEdge=tlsMode&&u.hostname===EDGE_HOST;
  return new Promise((resolve,reject)=>{
    const opts={host:'127.0.0.1',port:viaEdge?tlsPort:Number(u.port||80),path:u.pathname+u.search,method:init.method??'GET',
      headers:{host:u.host,...init.headers},...(viaEdge?{servername:EDGE_HOST,ca}:{})};
    const r=(viaEdge?https:http).request(opts,res=>{let body='';res.on('data',c=>{body+=c;});res.on('end',()=>resolve({status:res.statusCode??0,location:res.headers.location,body}));});
    r.on('error',reject);r.end(init.body);
  });
}
const approved=new Set<string>();
/** The owner on this computer approves one authorization request through the real endpoints. */
async function approve(authorizeUrl:string){
  if(approved.has(authorizeUrl))return;approved.add(authorizeUrl);
  const step=(name:string,r:Reply,want:number)=>{if(r.status!==want)throw Error(`consent ${name}: HTTP ${r.status} ${r.body.slice(0,300)}`);return r;};
  const auth={authorization:'Bearer '+owner.api_key};
  const start=step('authorize',await request(authorizeUrl),302);
  const consentUrl=new URL(start.location!,authorizeUrl);
  if(![local,publicOrigin].includes(consentUrl.origin)||consentUrl.pathname!=='/api/dashboard/oauth-consent')throw Error('consent: unexpected redirect to '+consentUrl.origin+consentUrl.pathname);
  const page=step('page',await request(consentUrl.href,{headers:auth}),200).body;
  const form=/action="\/api\/dashboard\/oauth-consent\/approve">\s*<input type="hidden" name="ticket" value="([^"]+)">\s*<input type="hidden" name="nonce" value="([^"]+)">/.exec(page);
  if(!form)throw Error('consent: approve form not found');
  const done=step('approve',await request(consentUrl.origin+'/api/dashboard/oauth-consent/approve',{method:'POST',
    headers:{...auth,origin:consentUrl.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket:form[1]!,nonce:form[2]!}).toString()}),302);
  await request(done.location!); // The command's own loopback callback receives the code.
  console.error('[fixture] owner consent approved');
}

const session={fixture:'qoopia-mcp-conformance/1',mode:edgeMode?'edge':tlsMode?'tls':'direct',public_origin:publicOrigin,local_origin:local,
  mcp_url:publicOrigin+'/mcp',connection_mcp_url:connection.mcp_url,connection_id:connection.id,authed_mcp_url:authedMcp,
  ...(tlsMode?{proxy:proxyUrl,ca_file:path.join(out,'ca.pem')}:{})};
fs.writeFileSync(path.join(out,'session.json'),JSON.stringify(session,null,2),{mode:0o600});
// Synthetic keys for manual use; they die with --out.
fs.writeFileSync(path.join(out,'secrets.json'),JSON.stringify({owner_key:owner.api_key,agent_key:agent.api_key},null,2),{mode:0o600});
const stop=(code:number)=>{for(const close of closers)close();db.close();process.exit(code);};

if(!command.length){
  console.log(JSON.stringify(session));
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>stop(0));
}else{
  const fill=(s:string)=>s.replaceAll('{MCP}',session.mcp_url).replaceAll('{CONN}',session.connection_mcp_url).replaceAll('{AUTHED_MCP}',authedMcp).replaceAll('{OUT}',out);
  // Browser launchers are no-ops: a tool that "opens" the consent URL only prints it, and the harness answers it.
  const bin=path.join(home,'bin');fs.mkdirSync(bin);
  for(const name of ['open','xdg-open'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const child=spawn(command[0]!,command.slice(1).map(fill),{stdio:['ignore','pipe','pipe'],env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),
    XDG_DATA_HOME:path.join(home,'.local/share'),PATH:bin+':'+process.env.PATH,MCP_AUTO_OPEN_ENABLED:'true',BROWSER:'true',NO_COLOR:'1',MCP_INSPECTOR_SECRET_STORE:'file',
    ...(tlsMode?{NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:proxyUrl,HTTP_PROXY:proxyUrl,NO_PROXY:'127.0.0.1,localhost,::1',NODE_EXTRA_CA_CERTS:path.join(out,'ca.pem')}:{})}});
  const authorize=/https?:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/g;
  const redact=(s:string)=>s.replace(/("?(?:access_token|refresh_token|client_secret|id_token)"?\s*[:=]\s*"?)[A-Za-z0-9._~+/-]{8,}/g,'$1[REDACTED]')
    .replace(/([?&]code=)[A-Za-z0-9._~%-]{8,}/g,'$1[REDACTED]').replace(/Bearer [A-Za-z0-9._~+/-]{8,}/g,'Bearer [REDACTED]');
  for(const [stream,sink] of [[child.stdout,process.stdout],[child.stderr,process.stderr]] as const){
    let pending='';
    stream.on('data',chunk=>{
      pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines){
        sink.write(redact(line)+'\n');
        for(const url of line.match(authorize)??[])approve(url).catch(error=>console.error('[fixture] '+(error as Error).message));
      }
    });
    stream.on('end',()=>{if(pending)sink.write(redact(pending)+'\n');});
  }
  const [code]=await once(child,'exit') as [number|null];
  stop(code??1);
}
