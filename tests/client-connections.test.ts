import {beforeAll,afterAll,expect,test} from 'bun:test';
import {createHash,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {connectionAction} from '../src/services/client-connections.ts';
import {startHttpServer} from '../src/http.ts';
import {env} from '../src/utils/env.ts';
import {authLimiter,dashboardLimiter} from '../src/utils/rate-limit.ts';
import {authenticate} from '../src/auth/middleware.ts';
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
async function authorize(connection:any,who=owner,deny=false) {
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
  const url=new URL(discovery.authorization_endpoint);for(const [key,value] of Object.entries({client_id:client.client_id,redirect_uri:callback,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:discovery.scopes_supported.join(' '),resource:connection.mcp_url}))url.searchParams.set(key,value as string);
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
  expect((await fetch(base+'/api/dashboard/oauth-consent/approve',{method:'POST',redirect:'manual',headers:{cookie,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,nonce})})).status).toBe(302);
  const finalized=await fetch(base+'/oauth/authorize/finalize?ticket='+ticket,{redirect:'manual'});expect(finalized.status).toBe(302);
  const callbackUrl=new URL(finalized.headers.get('location')!);expect(callbackUrl.searchParams.get('iss')).toBe(issuer.href);
  const code=callbackUrl.searchParams.get('code')!;
  const form={client_id:client.client_id,code,code_verifier:verifier,redirect_uri:callback,grant_type:'authorization_code'};
  const wrong=await fetch(discovery.token_endpoint,{method:'POST',body:new URLSearchParams({...form,resource:base+'/mcp'})});expect(wrong.status).toBe(400);
  const token=await fetch(discovery.token_endpoint,{method:'POST',body:new URLSearchParams({...form,resource:connection.mcp_url})});expect(token.status).toBe(200);
  return {...await token.json() as any,client_id:client.client_id};
}
async function call(connection:any,token:string,name:string,args:any) {
  const res=await fetch(connection.mcp_url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const body=await res.text();const line=body.split('\n').find(x=>x.startsWith('data: '));return {status:res.status,data:JSON.parse(line?line.slice(6):body)};
}
test('selection is idempotent, isolated and never reports configuration as a client call',()=>{
  const first=apply(owner,'read','repeat');expect(first.state).toBe('requires_user_action');expect(apply(owner,'read','repeat').id).toBe(first.id);
  expect(()=>apply(owner,'read_write','repeat')).toThrow('Request key');
  expect(()=>connectionAction(other.agent_id,{action:'resume',id:first.id})).toThrow('Connection unavailable');
  expect(JSON.stringify(connectionAction(owner.agent_id,{action:'status'}))).not.toMatch(/q_[A-Za-z0-9_-]{20}/);
});
test('declining local OAuth includes the pinned issuer without issuing a code',async()=>{await authorize(apply(),owner,true);});
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
  expect((connectionAction(owner.agent_id,{action:'resume',id:connection.id}) as any).connection.state).toBe('requires_user_action');
  const proof=connectionAction(owner.agent_id,{action:'verify',id:connection.id}) as any;
  const challenge=proof.prompt.match(/challenge "([^"]+)"/)[1];
  expect((await call(otherConnection,token.access_token,'connection_verify',{connection_id:connection.id,challenge})).status).toBe(401);
  const verified=await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge});
  expect(verified.status).toBe(200);expect(verified.data.result.isError).not.toBe(true);
  expect(JSON.parse(verified.data.result.content[0].text).verified).toBe(true);
  expect((connectionAction(owner.agent_id,{action:'status',id:connection.id}) as any).connections[0].state).toBe('ready');
  expect((await call(connection,token.access_token,'connection_verify',{connection_id:connection.id,challenge})).data.result.isError).toBe(true);
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
