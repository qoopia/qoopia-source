import {beforeAll,afterAll,expect,test} from 'bun:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {createAgent} from '../src/admin/agents.ts';
import {adminTools} from '../src/mcp/admin-tools.ts';
import {connectionAction,connectionRegistrationAuth,observeClientProtocol} from '../src/services/client-connections.ts';
import {registerClient} from '../src/auth/oauth.ts';
import {browserConnectionState} from '../src/services/browser-connections.ts';
import {startHttpServer} from '../src/http.ts';
import {env} from '../src/utils/env.ts';
import {authLimiter,dashboardLimiter} from '../src/utils/rate-limit.ts';
import {authenticate} from '../src/auth/middleware.ts';
import {discoverOAuthMetadata} from '@modelcontextprotocol/sdk/client/auth.js';
import {mcpEdgeRoute} from '../src/delivery/mcp-edge.ts';
let owner:ReturnType<typeof bootstrapOwner>,other:ReturnType<typeof bootstrapOwner>,server:ReturnType<typeof startHttpServer>,base:string;
let saved:{public:string;issuer:string;origins:string[]};
beforeAll(async()=>{
  runMigrations();
  owner=bootstrapOwner(db,'Connection owner',undefined,createWorkspace({name:'Connection isolation',slug:'connection-isolation'}).id);
  other=bootstrapOwner(db,'Other connection owner',undefined,createWorkspace({name:'Connection isolation 2',slug:'connection-isolation-2'}).id);
  server=startHttpServer();await new Promise<void>(r=>server.listening?r():server.once('listening',r));base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  saved={public:env.PUBLIC_URL,issuer:env.OAUTH_ISSUER,origins:env.DASHBOARD_ALLOWED_ORIGINS};env.PUBLIC_URL=base;env.OAUTH_ISSUER=base;env.DASHBOARD_ALLOWED_ORIGINS=[base];
});
afterAll(async()=>{env.PUBLIC_URL=saved.public;env.OAUTH_ISSUER=saved.issuer;env.DASHBOARD_ALLOWED_ORIGINS=saved.origins;
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
function apply(who=owner,mode:'read'|'read_write'='read_write',key=randomBytes(8).toString('hex')) {
  return (connectionAction(who.agent_id,{action:'apply',surface:'codex',access_mode:mode,request_key:key}) as any).connection;
}
async function authorize(connection:any,who=owner,deny=false,omit:{scope?:boolean;resource?:boolean}={}) {
  authLimiter.resetForTests();dashboardLimiter.resetForTests();
  const unauthorized=await fetch(connection.mcp_url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  expect(unauthorized.status).toBe(401);
  const metadataUrl=unauthorized.headers.get('www-authenticate')!.match(/resource_metadata="([^"]+)"/)![1]!;
  const metadata=await (await fetch(metadataUrl)).json() as any;expect(metadata.resource).toBe(connection.mcp_url);
  const issuer=new URL(metadata.authorization_servers[0]);
  const discovery=await (await fetch(issuer.origin+'/.well-known/oauth-authorization-server'+issuer.pathname)).json() as any;
  expect(discovery.issuer).toBe(issuer.href);expect(discovery.scopes_supported).not.toContain('mcp:admin');
  const callback='http://127.0.0.1:19191/callback';
  const registration=await fetch(discovery.registration_endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Synthetic Codex',redirect_uris:[callback],token_endpoint_auth_method:'none'})});
  expect(registration.status).toBe(201);const client=await registration.json() as any;
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const url=new URL(discovery.authorization_endpoint);for(const [key,value] of Object.entries({client_id:client.client_id,redirect_uri:callback,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',...omit.scope?{}:{scope:discovery.scopes_supported.join(' ')},...omit.resource?{}:{resource:connection.mcp_url}}))url.searchParams.set(key,value as string);
  const started=await fetch(url,{redirect:'manual'});expect(started.status).toBe(302);
  const consentUrl=started.headers.get('location')!,ticket=new URL(consentUrl).searchParams.get('ticket')!;
  const login=await fetch(base+'/api/dashboard/login',{method:'POST',headers:{authorization:'Bearer '+who.api_key,origin:base}});
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const consent=await fetch(consentUrl,{headers:{cookie}});expect(consent.status).toBe(200);
  const nonce=(await consent.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
  if(deny){
    const denied=await fetch(base+'/api/dashboard/oauth-consent/deny',{method:'POST',redirect:'manual',headers:{cookie,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,nonce})});
    expect(denied.status).toBe(302);const response=new URL(denied.headers.get('location')!);
    expect(response.searchParams.get('error')).toBe('access_denied');expect(response.searchParams.get('iss')).toBe(issuer.href);
    expect(response.searchParams.has('code')).toBe(false);return {} as any;
  }
  const approved=await fetch(base+'/api/dashboard/oauth-consent/approve',{method:'POST',redirect:'manual',headers:{cookie,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,nonce})});expect(approved.status).toBe(302);
  const callbackUrl=new URL(approved.headers.get('location')!);expect(callbackUrl.origin+callbackUrl.pathname).toBe(callback);expect(callbackUrl.searchParams.get('iss')).toBe(issuer.href);
  const code=callbackUrl.searchParams.get('code')!;
  const form={client_id:client.client_id,code,code_verifier:verifier,redirect_uri:callback,grant_type:'authorization_code'};
  const wrong=await fetch(discovery.token_endpoint,{method:'POST',body:new URLSearchParams({...form,resource:base+'/mcp'})});expect(wrong.status).toBe(400);
  const token=await fetch(discovery.token_endpoint,{method:'POST',body:new URLSearchParams(omit.resource?form:{...form,resource:connection.mcp_url})});expect(token.status).toBe(200);
  return {...await token.json() as any,client_id:client.client_id};
}
async function call(connection:any,token:string,name:string,args:any) {
  const res=await fetch(connection.mcp_url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const body=await res.text();const line=body.split('\n').find(x=>x.startsWith('data: '));return {status:res.status,data:JSON.parse(line?line.slice(6):body)};
}
test('selection is idempotent, isolated and never reports configuration as a client call',()=>{
  const first=apply(owner,'read','repeat');expect(first.last_seen).toBeNull();expect(first.state).toBe('requires_user_action');expect(apply(owner,'read','repeat').id).toBe(first.id);
  // Without an installed layout the client file is offered for another computer.
  expect(first.client_config).toBe('download_file');
  expect((connectionAction(owner.agent_id,{action:'client-plan',id:first.id}) as any).code).toBe('CLIENT_COMPUTER_REQUIRED');
  // A loopback address in a file for another computer would reach that computer itself.
  const exported=connectionAction(owner.agent_id,{action:'client-export',id:first.id}) as any;
  expect(exported.code).toBe('CLIENT_EXPORT_LOCAL_ONLY');expect(exported.binding).toBeUndefined();expect(exported.next_action).toContain('"transport":"remote"');
  expect(()=>apply(owner,'read_write','repeat')).toThrow('Request key');
  expect(()=>connectionAction(other.agent_id,{action:'resume',id:first.id})).toThrow('Connection unavailable');
  expect(JSON.stringify(connectionAction(owner.agent_id,{action:'status'}))).not.toMatch(/q_[A-Za-z0-9_-]{20}/);
});
test('Muse Code and cloud Grok Bot get distinct HTTPS addresses and remain unverified',()=>{
  env.PUBLIC_URL='https://fixture.example';
  try{for(const surface of ['muse_code','muse_app','grok_bot'] as const){
    const connection=(connectionAction(owner.agent_id,{action:'apply',surface,access_mode:'read',request_key:'new-'+surface}) as any).connection;
    expect(connection.surface).toBe(surface);
    expect(connection.client_config).toBeNull();
    expect(connection.state).toBe('requires_user_action');
    expect(connection.mcp_url).toMatch(/^https:\/\/fixture\.example\/mcp\/c\//);
    expect((connectionAction(owner.agent_id,{action:'verify',id:connection.id}) as any).code).toBe('CLIENT_CALL_REQUIRED');
    expect((connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0].state).toBe('requires_user_action');
  }}finally{env.PUBLIC_URL=base;}
});
// Claude Code's SDK names a scope only when the metadata advertises one; ours does not, so a read
// connection must default to mcp:read instead of reading "" as an unknown scope (invalid_scope).
test('a read connection connects a client that requests no scope',async()=>{
  const connection=apply(owner,'read'),token=await authorize(connection,owner,false,{scope:true});
  expect(token.scope).toBe('mcp:read');
  expect(authenticate(new Request(connection.mcp_url,{headers:{authorization:'Bearer '+token.access_token}}))?.workspace_id).toBe(owner.workspace_id);
});
// A client that relies on the advertised ?connection= authorization endpoint and names no resource at
// the token endpoint gets the audience the owner consented to (RFC 8707 §2.2); naming another stays refused.
test('a client that names no resource gets the consented audience on code exchange and refresh',async()=>{
  const connection=apply(),token=await authorize(connection,owner,false,{resource:true});
  expect(authenticate(new Request(connection.mcp_url,{headers:{authorization:'Bearer '+token.access_token}}))?.workspace_id).toBe(owner.workspace_id);
  const refreshed=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client_id,refresh_token:token.refresh_token})});
  expect(refreshed.status).toBe(200);const next=await refreshed.json() as any;
  expect(authenticate(new Request(connection.mcp_url,{headers:{authorization:'Bearer '+next.access_token}}))?.workspace_id).toBe(owner.workspace_id);
  expect(authenticate(new Request(base+'/mcp',{headers:{authorization:'Bearer '+next.access_token}}))).toBeNull();
  const moved=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client_id,refresh_token:next.refresh_token,resource:base+'/mcp'})});
  expect(moved.status).toBe(400);expect((await moved.json() as any).error).toBe('invalid_target');
});
// RFC 8414 path insertion of the resource path: a client that derives the metadata URL from the MCP URL
// (the SDK's discoverOAuthMetadata(serverUrl)) asks /.well-known/oauth-authorization-server/mcp/c/<id>.
// The generic metadata it used to get sent it to the generic /oauth/register, which refuses its callback.
test('path-derived authorization server metadata of a connection is that connection’s, on the server and the edge',async()=>{
  const connection=apply(),id=connection.id;
  const metadata=await discoverOAuthMetadata(connection.mcp_url);
  expect(metadata?.issuer).toBe(base+'/oauth/c/'+id);
  expect(metadata?.registration_endpoint).toBe(base+'/oauth/register?connection='+id);
  expect(metadata?.authorization_endpoint).toBe(base+'/oauth/authorize?connection='+id);
  expect(mcpEdgeRoute('/.well-known/oauth-authorization-server/mcp/c/'+id,'GET')).toBe('allowed');
  expect(mcpEdgeRoute('/.well-known/oauth-authorization-server/mcp/c/'+id,'POST')).toBe('method_not_allowed');
  connectionAction(owner.agent_id,{action:'disconnect',id});
  expect((await fetch(base+'/.well-known/oauth-authorization-server/mcp/c/'+id)).status).toBe(404);
});
// Every failed connect attempt registers again. Twenty dead registrations used to block the connection for
// good ("registration limit reached"); unused ones past a consent's lifetime are now reclaimed, live ones never.
test('dead client registrations are reclaimed at the limit; fresh and used ones still count',()=>{
  const connection=apply(),callback=['http://127.0.0.1:19191/callback'];
  const register=()=>registerClient({client_name:'Retrying Codex',redirect_uris:callback},connectionRegistrationAuth(connection.id,callback));
  const clients=Array.from({length:20},register);
  expect(()=>connectionRegistrationAuth(connection.id,callback)).toThrow('registration limit');
  const agent=(db.query('SELECT agent_id FROM client_connections WHERE id=?').get(connection.id) as {agent_id:string}).agent_id;
  db.query("UPDATE oauth_clients SET created_at='2000-01-01T00:00:00Z' WHERE agent_id=?").run(agent);
  db.query(`INSERT INTO oauth_tokens(token_hash,client_id,agent_id,workspace_id,token_type,granted_scope,expires_at,revoked,created_at)
    VALUES(?,?,?,?,'refresh','mcp:read','2999-01-01T00:00:00Z',0,'2000-01-01T00:00:00Z')`).run(randomBytes(16).toString('hex'),clients[0]!.client_id,agent,owner.workspace_id);
  const fresh=register();
  const left=(db.query('SELECT id FROM oauth_clients WHERE agent_id=?').all(agent) as {id:string}[]).map(r=>r.id).sort();
  expect(left).toEqual([clients[0]!.client_id,fresh.client_id].sort());
  for(let i=0;i<18;i++)register();
  expect(()=>connectionRegistrationAuth(connection.id,callback)).toThrow('registration limit');
});
// A client that revokes its own grant (sign-out, removed connector) can no longer call. The card used to keep
// saying ready / "Use this connection"; it now asks for a new sign-in until the client holds a grant again.
test('a verified connection whose client revoked its grant asks for a new sign-in',async()=>{
  const connection=apply(),token=await authorize(connection);
  expect((await call(connection,token.access_token,'qoopia_protocol',{})).data.result.isError).not.toBe(true);
  const ready=(connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0];
  expect(ready.state).toBe('ready');
  const agent=(db.query('SELECT agent_id FROM client_connections WHERE id=?').get(connection.id) as {agent_id:string}).agent_id;
  expect(browserConnectionState(owner.agent_id).apps.find(a=>a.id===connection.id)?.authorized).toBe(1);
  expect((await fetch(base+'/oauth/revoke',{method:'POST',body:new URLSearchParams({token:token.refresh_token,client_id:token.client_id})})).status).toBe(200);
  const stale=(connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0];
  expect(stale).toMatchObject({state:'requires_user_action',code:'CLIENT_REAUTHORIZATION_REQUIRED',authorized:false});
  expect(stale.next_action).toContain('Sign in to this same connection address again');
  expect(browserConnectionState(owner.agent_id).apps.find(a=>a.agent_id===agent)?.authorized).toBe(0);
  const again=await authorize(connection);
  expect((connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0].state).toBe('ready');
  expect(again.access_token).toBeString();
});
test('declining local OAuth includes the pinned issuer without issuing a code',async()=>{await authorize(apply(),owner,true);});
test('automatic protocol proof rejects fabricated bindings and works with read-only OAuth without granting writes',async()=>{
  const connection=apply(owner,'read'),token=await authorize(connection);
  const auth=authenticate(new Request(connection.mcp_url,{headers:{authorization:'Bearer '+token.access_token}}))!;
  expect(()=>observeClientProtocol({...auth,source:'api-key'})).toThrow('Use the client OAuth connection');
  expect(()=>observeClientProtocol({...auth,oauth_client_id:'unregistered-client'})).toThrow('OAuth client does not belong');
  expect(()=>observeClientProtocol({...auth,granted_scope:[]})).toThrow('Current scope');
  expect((await call(connection,token.access_token,'qoopia_protocol',{section:'invalid'})).data.result.isError).toBe(true);
  expect((connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection.state).toBe('requires_user_action');
  const priorRole=env.SERVER_ROLE;env.SERVER_ROLE='legacy-readonly';
  try{observeClientProtocol(auth);expect((db.query('SELECT state FROM client_connections WHERE id=?').get(connection.id) as any).state).toBe('awaiting_client');}
  finally{env.SERVER_ROLE=priorRole;}
  const legacy=connectionAction(owner.agent_id,{action:'verify',id:connection.id}) as any;
  expect((await call(connection,token.access_token,'qoopia_protocol',{})).data.result.isError).not.toBe(true);
  expect((connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection.state).toBe('ready');
  // An older client's outstanding challenge still works after the automatic first call.
  expect((await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge:legacy.prompt.match(/challenge "([^"]+)"/)[1]})).data.result.isError).not.toBe(true);
  expect((await call(connection,token.access_token,'note_create',{text:'Must not save',type:'memory',idempotency_key:'readonly-proof-denied'})).data.result.isError).toBe(true);
  connectionAction(owner.agent_id,{action:'disconnect',id:connection.id});
  expect(()=>observeClientProtocol(auth)).toThrow();
});
test('OAuth discovery, audience binding, real MCP proof, cross-connection denial and revocation',async()=>{
  const connection=apply(),otherConnection=apply(other),token=await authorize(connection);
  const advertised=await fetch(connection.mcp_url,{method:'POST',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});
  const advertisedBody=await advertised.text(),advertisedLine=advertisedBody.split('\n').find(x=>x.startsWith('data: '));
  const advertisedTools=JSON.parse(advertisedLine?advertisedLine.slice(6):advertisedBody).result.tools as {name:string;annotations:Record<string,boolean>;inputSchema:{required:string[]}}[];
  expect(advertisedTools.find(t=>t.name==='note_get')?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
  expect(advertisedTools.find(t=>t.name==='note_create')?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  expect(advertisedTools.find(t=>t.name==='note_create')?.inputSchema.required).toContain('idempotency_key');
  expect(advertisedTools.find(t=>t.name==='connection_verify')?.annotations).toEqual({readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false});
  expect(advertisedTools.some(t=>t.name==='note_update'||t.name==='note_delete')).toBe(false);
  expect(authenticate(new Request(connection.mcp_url,{headers:{authorization:'Bearer '+token.access_token}}))?.workspace_id).toBe(owner.workspace_id);
  expect(authenticate(new Request(base+'/mcp',{headers:{authorization:'Bearer '+token.access_token}}))).toBeNull();
  const beforeProtocol=(connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection;
  expect(beforeProtocol.authorized).toBe(true);expect(beforeProtocol.state).toBe('requires_user_action');expect(beforeProtocol.verified_at).toBeNull();
  expect((await call(connection,token.access_token,'qoopia_protocol',{})).data.result.isError).not.toBe(true);
  const awaiting=(connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection;
  expect(awaiting.last_seen).toBeString();expect(awaiting.state).toBe('ready');
  expect(awaiting.verified_at).toBeString();expect(awaiting.evidence).toBe('authenticated_mcp_call');
  expect((connectionAction(other.agent_id,{action:'resume',id:otherConnection.id}) as any).connection.state).toBe('requires_user_action');
  expect((await call(connection,token.access_token,'qoopia_protocol',{})).data.result.isError).not.toBe(true);
  expect((connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection.verified_at).toBe(awaiting.verified_at);
  const proof=connectionAction(owner.agent_id,{action:'verify',id:connection.id}) as any;
  const challenge=proof.prompt.match(/challenge "([^"]+)"/)[1];
  expect((await call(otherConnection,token.access_token,'connection_verify',{connection_id:connection.id,challenge})).status).toBe(401);
  const verified=await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge});
  expect(verified.status).toBe(200);expect(verified.data.result.isError).not.toBe(true);
  expect(JSON.parse(verified.data.result.content[0].text).verified).toBe(true);
  expect((connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0].state).toBe('ready');
  const beforeReplay=db.query('SELECT state,verified_at,challenge_hash,oauth_client_id FROM client_connections WHERE id=?').get(connection.id);
  const replay=await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge});
  expect(replay.data.result.isError).toBe(true);
  expect(replay.data.result.content[0].text).toContain('VERIFICATION_ALREADY_COMPLETED');
  expect(replay.data.result.content[0].text).toContain('does not undo the earlier result');
  expect(db.query('SELECT state,verified_at,challenge_hash,oauth_client_id FROM client_connections WHERE id=?').get(connection.id)).toEqual(beforeReplay);
  const freshProof=connectionAction(owner.agent_id,{action:'verify',id:connection.id}) as any;
  const oldChallenge=await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge});
  expect(oldChallenge.data.result.isError).toBe(true);
  expect(oldChallenge.data.result.content[0].text).toStartWith('VERIFICATION_REFUSED:');
  const freshChallenge=freshProof.prompt.match(/challenge "([^"]+)"/)[1];
  expect((await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge:freshChallenge})).data.result.isError).not.toBe(true);
  const writeArgs={text:'Synthetic isolated connection test',type:'memory',idempotency_key:'connection-note'};
  const note=await call(connection,token.access_token,'note_create',writeArgs);
  expect(note.data.result.isError).not.toBe(true);
  const savedNote=JSON.parse(note.data.result.content[0].text);
  const repeated=await call(connection,token.access_token,'note_create',writeArgs);
  expect(JSON.parse(repeated.data.result.content[0].text).id).toBe(savedNote.id);
  const changed=await call(connection,token.access_token,'note_create',{...writeArgs,text:'Changed payload'});
  expect(changed.data.result.isError).toBe(true);
  const read=await call(connection,token.access_token,'note_get',{id:savedNote.id});
  expect(JSON.stringify(read.data.result)).toContain('Synthetic isolated connection test');
  const renewed=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client_id,refresh_token:token.refresh_token,resource:connection.mcp_url})});expect(renewed.status).toBe(200);
  const replacement=await renewed.json() as any;
  connectionAction(owner.agent_id,{action:'disconnect',id:connection.id});
  expect((await call(connection,replacement.access_token,'recall',{query:'synthetic'})).status).toBe(401);
  expect((await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client_id,refresh_token:replacement.refresh_token,resource:connection.mcp_url})})).status).toBe(400);
  expect((connectionAction(owner.agent_id,{action:'disconnect',id:connection.id}) as any).code).toBe('DISCONNECTED');
  expect((connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0].last_seen).toBeNull();
});

test('existing discovery, authorization, calls and refresh retain their audience after managed transport changes the default origin',async()=>{
  const connection=apply(owner,'read'),token=await authorize(connection);
  env.PUBLIC_URL='https://new-device.example';
  try{
    expect(apply(owner,'read','after-origin-change').mcp_url).toStartWith(env.PUBLIC_URL);
    expect((connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection.mcp_url).toBe(connection.mcp_url);
    expect(authenticate(new Request(connection.mcp_url,{headers:{authorization:'Bearer '+token.access_token}}))?.connection_id).toBe(connection.id);
    const rebound=new URL(connection.mcp_url);rebound.hostname='foreign.example';
    const denied=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client_id,refresh_token:token.refresh_token,resource:rebound.href})});
    expect(denied.status).toBe(400);
    const refreshed=await fetch(base+'/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:token.client_id,refresh_token:token.refresh_token,resource:connection.mcp_url})});
    expect(refreshed.status).toBe(200);
    const access=(await refreshed.json() as any).access_token;
    expect((await call(connection,access,'recall',{query:'synthetic'})).status).toBe(200);
    // A fresh vendor registration on the old connection also retains all original endpoint URLs.
    const second=await authorize(connection);expect((await call(connection,second.access_token,'recall',{query:'synthetic'})).status).toBe(200);
  }finally{env.PUBLIC_URL=base;}
});


test('steward prepares a scoped review link; owner labels Muse without changing OAuth, proof or memory',()=>{
  const steward=createAgent({name:'Preparation steward',workspaceSlug:'connection-isolation',type:'steward'});
  const standard=createAgent({name:'Preparation standard',workspaceSlug:'connection-isolation'});
  const prepare=adminTools.find(t=>t.name==='connection_prepare')!;
  const auth={agent_id:steward.id,workspace_id:owner.workspace_id,agent_name:steward.name,type:'steward',source:'api-key' as const};
  const selection={surface:'muse_app',agent_name:'FIBI',access_mode:'read_write'};
  const count=()=>JSON.stringify(db.query('SELECT (SELECT count(*) FROM agents) agents,(SELECT count(*) FROM client_connections) connections,(SELECT count(*) FROM oauth_tokens) tokens').get());
  const before=count();const proposal=prepare.handler(selection,auth) as any;
  expect(proposal.changes_applied).toBe(false);expect(proposal.connection).toBeNull();expect(count()).toBe(before);
  expect(new URL(proposal.owner_url).searchParams.get('workspace')).toBe(owner.workspace_id);
  expect(new URL(proposal.owner_url).searchParams.get('agent')).toBe('FIBI');
  // A tunnel install's PUBLIC_URL is the tunnel origin, which publishes no dashboard: the link stays on loopback.
  const priorStandalone=process.env.QOOPIA_STANDALONE;process.env.QOOPIA_STANDALONE='true';env.PUBLIC_URL='https://c-tunnel.example';
  try{expect(new URL((prepare.handler(selection,auth) as any).owner_url).origin).toBe('http://127.0.0.1:'+env.PORT);}
  finally{if(priorStandalone===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=priorStandalone;env.PUBLIC_URL=base;}
  expect(()=>prepare.handler(selection,{...auth,agent_id:standard.id})).toThrow('steward');
  // A case-only variant of an existing agent's name is that agent: apply would refuse it as a duplicate.
  expect(()=>prepare.handler({...selection,agent_name:'preparation STANDARD'},auth)).toThrow('already has access');
  expect(()=>prepare.handler({...selection,agent_name:'<script>'},auth)).toThrow();
  expect(()=>connectionAction(steward.id,{action:'apply',...selection,request_key:'steward-denied'})).toThrow();
  env.PUBLIC_URL='https://fixture.example';
  try{
    const input={action:'apply',surface:'muse_code',agent_name:'Original Muse',access_mode:'read_write',request_key:'named-muse'};
    const c=(connectionAction(owner.agent_id,input) as any).connection;
    expect((connectionAction(owner.agent_id,input) as any).connection.id).toBe(c.id);
    expect(()=>connectionAction(owner.agent_id,{...input,agent_name:'Another Muse'})).toThrow('Request key');
    expect(()=>connectionAction(other.agent_id,{action:'label',id:c.id,agent_name:'FIBI'})).toThrow('unavailable');
    expect(()=>prepare.handler({...selection,connection_id:c.id},{...auth,workspace_id:other.workspace_id})).toThrow();
    const row=db.query('SELECT * FROM client_connections WHERE id=?').get(c.id) as any;
    db.query("UPDATE client_connections SET state='verified',verified_at='2026-09-30T03:36:43Z' WHERE id=?").run(c.id); // synthetic proof fixture only
    // The verified client still holds a grant; without one the card asks for a new sign-in instead of ready.
    const museClient=registerClient({client_name:'Muse',redirect_uris:['https://muse.example/callback']},connectionRegistrationAuth(c.id,['https://muse.example/callback']));
    db.query(`INSERT INTO oauth_tokens(token_hash,client_id,agent_id,workspace_id,token_type,granted_scope,expires_at,revoked,created_at)
      VALUES(?,?,?,?,'refresh','mcp:read mcp:write','2999-01-01T00:00:00Z',0,'2026-09-30T03:36:43Z')`).run(randomBytes(16).toString('hex'),museClient.client_id,row.agent_id,owner.workspace_id);
    const identity=db.query('SELECT * FROM agents WHERE id=?').get(row.agent_id) as any;
    const reused=prepare.handler({...selection,connection_id:c.id},auth) as any;
    expect(reused.connection.id).toBe(c.id);expect(()=>prepare.handler({...selection,connection_id:c.id,access_mode:'read'},auth)).toThrow('different application or access');expect(reused.connection.mcp_url).toBe(c.mcp_url);
    const labelled=(connectionAction(owner.agent_id,{action:'label',id:c.id,agent_name:'FIBI',surface:'muse_app'}) as any).connection;
    expect(labelled).toMatchObject({id:c.id,agent_name:'FIBI',surface:'muse_app',state:'ready',mcp_url:c.mcp_url,verified_at:'2026-09-30T03:36:43Z'});
    const after=db.query('SELECT * FROM agents WHERE id=?').get(row.agent_id) as any;
    expect({...after,name:identity.name}).toEqual(identity);
    const reusedByName=prepare.handler(selection,auth) as any;expect(reusedByName.connection.id).toBe(c.id);
    expect(()=>connectionAction(owner.agent_id,{...input,request_key:'would-duplicate',surface:'muse_app',agent_name:'FIBI'})).toThrow('already exists');
    expect(()=>connectionAction(owner.agent_id,{action:'label',id:c.id,agent_name:standard.name})).toThrow('already uses');
    const native=apply();expect(()=>connectionAction(owner.agent_id,{action:'label',id:native.id,agent_name:'Not Muse',surface:'muse_app'})).toThrow('Only Muse');
    db.query("UPDATE agents SET type='standard' WHERE id=?").run(steward.id);
    expect(()=>prepare.handler(selection,auth)).toThrow('steward');
  }finally{env.PUBLIC_URL=base;}
});

test('a connection-bound token is refused outside its own MCP endpoint (F-131)',async()=>{
  const connection=apply(),token=await authorize(connection),headers={authorization:'Bearer '+token.access_token};
  expect((await fetch(base+'/api/dashboard/files',{headers})).status).toBe(401);
  for(const url of [base+'/api/v1/capabilities',base+'/memory/continuity','http://local/'])expect(authenticate(new Request(url,{headers}))).toBeNull();
  expect((await call(connection,token.access_token,'qoopia_protocol',{})).status).toBe(200);
});

test('owner-connection registration keeps the surface callback and answers refusals as client errors (F-130)',async()=>{
  const register=(id:string,redirect_uris:unknown)=>{authLimiter.resetForTests();
    return fetch(base+'/oauth/register?connection='+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'ChatGPT',redirect_uris})});};
  env.PUBLIC_URL='https://fixture.example';
  let chatgpt:any,muse:any;
  try{
    chatgpt=(connectionAction(owner.agent_id,{action:'apply',surface:'chatgpt_web',access_mode:'read',request_key:randomUUID()}) as any).connection;
    muse=(connectionAction(owner.agent_id,{action:'apply',surface:'muse_app',access_mode:'read',request_key:randomUUID()}) as any).connection;
  }finally{env.PUBLIC_URL=base;}
  const evil=await register(chatgpt.id,['https://evil.example/cb']);
  expect(evil.status).toBe(400);expect((await evil.json() as any).error).toBe('invalid_redirect_uri');
  expect((await register(chatgpt.id,['https://chatgpt.com/connector_platform_oauth_redirect'])).status).toBe(201);
  const codex=apply();
  expect((await register(codex.id,['https://evil.example/cb'])).status).toBe(400);
  for(const uri of ['https://muse.example/cb#x','https://user:pw@muse.example/cb'])expect((await register(muse.id,[uri])).status).toBe(400);
  for(const id of ['not-a-uuid',randomUUID()])expect((await register(id,['https://chatgpt.com/cb'])).status).toBe(400);
  const agent=db.query('SELECT agent_id FROM client_connections WHERE id=?').get(muse.id) as {agent_id:string};
  while((db.query('SELECT count(*) n FROM oauth_clients WHERE agent_id=?').get(agent.agent_id) as {n:number}).n<20)
    expect((await register(muse.id,['https://muse.example/cb'])).status).toBe(201);
  expect((await register(muse.id,['https://muse.example/cb'])).status).toBe(429);
});

test('plan for a cloud client without external access says so and names network-plan; apply refuses with that next_action [F-299]',async()=>{
  const selection={surface:'chatgpt_web',access_mode:'read',request_key:'cloud-without-external-access'};
  const plan=connectionAction(owner.agent_id,{action:'plan',...selection}) as any;
  expect(plan.code).toBe('EXTERNAL_ACCESS_REQUIRED');expect(plan.next_action).toContain('network-plan');
  expect((connectionAction(owner.agent_id,{action:'plan',surface:'codex',access_mode:'read',request_key:'local-plan'}) as any).code).toBe('APPLY_REQUIRED');
  dashboardLimiter.resetForTests();
  const login=await fetch(base+'/api/dashboard/login',{method:'POST',headers:{authorization:'Bearer '+owner.api_key,origin:base}});
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const applied=await fetch(base+'/api/dashboard/connection-setup',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify({action:'apply',...selection})});
  expect(applied.status).toBe(400);
  expect(await applied.json()).toMatchObject({state:'error',code:'NOT_READY',next_action:plan.next_action});
});
test('a refused client profile tells the owner why instead of the generic setup failure',async()=>{
  const fs=await import('node:fs'),{QoopiaError}=await import('../src/utils/errors.ts');
  const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-client-refusal-')),saved=process.env.QOOPIA_STANDALONE_LAYOUT;
  try {
    process.env.QOOPIA_STANDALONE_LAYOUT=JSON.stringify({root,logs:root+'/logs'});
    // e.g. a home directory created 0775 under umask 002
    const profile=root+'/shared-profile';fs.mkdirSync(profile);fs.chmodSync(profile,0o775);
    let error:unknown;try{connectionAction(owner.agent_id,{action:'client-plan',id:apply().id,config_directory:profile});}catch(e){error=e;}
    expect(error).toBeInstanceOf(QoopiaError);expect((error as Error).message).toContain('not writable by other users');
  } finally {if(saved===undefined)delete process.env.QOOPIA_STANDALONE_LAYOUT;else process.env.QOOPIA_STANDALONE_LAYOUT=saved;fs.rmSync(root,{recursive:true,force:true});}
});
test('on an installation a remote Claude Code/Codex connection is offered as a file for the other computer; a local one is set up here',async()=>{
  const fs=await import('node:fs');
  const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-client-remote-')),saved=process.env.QOOPIA_STANDALONE_LAYOUT,url=env.PUBLIC_URL;
  try {
    process.env.QOOPIA_STANDALONE_LAYOUT=JSON.stringify({root,logs:root+'/logs'});
    expect(apply().client_config).toBe('on_this_computer');
    env.PUBLIC_URL='https://c-fixture.qoopia.ai';
    const remote=(connectionAction(owner.agent_id,{action:'apply',surface:'claude_code',access_mode:'read',request_key:'remote-laptop',transport:'remote'}) as any).connection;
    expect(remote.mcp_url).toStartWith('https://c-fixture.qoopia.ai/');expect(remote.client_config).toBe('download_file');
    expect((connectionAction(owner.agent_id,{action:'client-export',id:remote.id}) as any).binding.mcp_url).toBe(remote.mcp_url);
  } finally {env.PUBLIC_URL=url;if(saved===undefined)delete process.env.QOOPIA_STANDALONE_LAYOUT;else process.env.QOOPIA_STANDALONE_LAYOUT=saved;fs.rmSync(root,{recursive:true,force:true});}
});
