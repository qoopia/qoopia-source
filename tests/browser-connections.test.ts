import {beforeAll,afterAll,expect,test} from 'bun:test';
import {createHash,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createAgent} from '../src/admin/agents.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {authenticate} from '../src/auth/middleware.ts';
import {browserAgent,browserConnectionState} from '../src/services/browser-connections.ts';
import {connectionAction} from '../src/services/client-connections.ts';
import {startHttpServer} from '../src/http.ts';
import {env} from '../src/utils/env.ts';
import {authLimiter,dashboardLimiter} from '../src/utils/rate-limit.ts';

let owner:ReturnType<typeof bootstrapOwner>,second:ReturnType<typeof bootstrapOwner>,server:ReturnType<typeof startHttpServer>,base:string;
let oldOrigins:string[];
let priorOwners: Record<string,string|number|null>[]=[];
beforeAll(async()=>{
  runMigrations();
  // The full suite shares a database. This fixture models a fresh (or pre-V1) installation.
  priorOwners=db.query("SELECT o.* FROM workspace_owners o JOIN agents a ON a.id=o.actor_id WHERE a.active=1 AND a.principal_kind='human' AND a.authority_profile='owner'").all() as typeof priorOwners;
  for(const row of priorOwners)db.query('DELETE FROM workspace_owners WHERE id=?').run(row.id!);const workspace=createWorkspace({name:'Browser onboarding',slug:'browser-onboarding'});
  owner=bootstrapOwner(db,'Browser owner',undefined,workspace.id);
  server=startHttpServer();await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  base='http://127.0.0.1:'+(server.address() as AddressInfo).port;oldOrigins=env.DASHBOARD_ALLOWED_ORIGINS;env.DASHBOARD_ALLOWED_ORIGINS=[base];
});
afterAll(async()=>{
  db.query('DELETE FROM workspace_owners WHERE actor_id IN (?,?)').run(owner.agent_id,second?.agent_id??'');
  for(const row of priorOwners)db.query('INSERT INTO workspace_owners ('+Object.keys(row).join(',')+') VALUES ('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
  db.query('UPDATE agents SET active=0 WHERE id=?').run(owner.agent_id);
  if(second)db.query('UPDATE agents SET active=0 WHERE id=?').run(second.agent_id);
  env.DASHBOARD_ALLOWED_ORIGINS=oldOrigins;
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
});

test('fresh browser connectors require consent and human approval yields agent-scoped tokens',async()=>{
  for(const [name,callback] of [['GPT','https://chatgpt.com/aip/g-actions/oauth/callback'],['Claude','https://claude.ai/api/mcp/auth_callback']]) {
    authLimiter.resetForTests();dashboardLimiter.resetForTests();
    const response=await fetch(base+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:name,redirect_uris:[callback],token_endpoint_auth_method:'none'})});
    expect(response.status).toBe(201);const client=await response.json() as {client_id:string};
    const agent=browserAgent(name as 'GPT'|'Claude')!;expect(agent.workspace_id).toBe(owner.workspace_id);expect(agent.type).toBe('standard');expect(agent.tool_profile).toBe('no-destructive');
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
    const authorize=await fetch(base+'/oauth/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:callback!,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'mcp:read mcp:write'}),{redirect:'manual'});
    const consentPath=new URL(authorize.headers.get('location')!,base);expect(consentPath.pathname).toBe('/api/dashboard/oauth-consent');
    const ticket=consentPath.searchParams.get('ticket')!;
    const anonymous=await fetch(base+consentPath.pathname+consentPath.search,{redirect:'manual'});expect(anonymous.status).toBe(302);expect(anonymous.headers.get('location')).toStartWith('/dashboard?next=');
    const premature=await fetch(base+'/oauth/authorize/finalize?ticket='+ticket,{redirect:'manual'});expect(premature.status).toBe(400);
    const login=await fetch(base+'/api/dashboard/login',{method:'POST',headers:{authorization:'Bearer '+owner.api_key,origin:base}});expect(login.status).toBe(200);
    const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const consent=await fetch(base+consentPath.pathname+consentPath.search,{headers:{cookie}});expect(consent.status).toBe(200);
    const nonce=(await consent.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
    const approval=await fetch(base+'/api/dashboard/oauth-consent/approve',{method:'POST',redirect:'manual',headers:{cookie,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,nonce})});expect(approval.status).toBe(302);
    const finalized=await fetch(base+'/oauth/authorize/finalize?ticket='+ticket,{redirect:'manual'});expect(finalized.status).toBe(302);
    const code=new URL(finalized.headers.get('location')!).searchParams.get('code')!;
    const token=await fetch(base+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,code,code_verifier:verifier,redirect_uri:callback!,grant_type:'authorization_code'})});expect(token.status).toBe(200);
    const result=await token.json() as {access_token:string};const identity=authenticate(new Request(base+'/mcp',{headers:{authorization:'Bearer '+result.access_token}}))!;
    expect(identity.agent_id).toBe(agent.id);expect(identity.agent_id).not.toBe(owner.agent_id);expect(identity.type).toBe('standard');expect(identity.workspace_id).toBe(owner.workspace_id);
  }
  // Legacy consent could grant a registrar's client through a different local agent.
  const delegate=createAgent({name:'Legacy delegate',workspaceSlug:'browser-onboarding'});
  db.query("UPDATE oauth_tokens SET agent_id=? WHERE client_id IN (SELECT c.id FROM oauth_clients c JOIN agents a ON a.id=c.agent_id WHERE a.workspace_id=? AND a.name='Claude')").run(delegate.id,owner.workspace_id);
  const state=browserConnectionState(owner.agent_id);expect((state.clients as {name:string;active_grants:number}[]).find(c=>c.name==='Claude')!.active_grants).toBeGreaterThan(0);expect(state.clients.length).toBe(2);expect(JSON.stringify(state)).not.toMatch(/q_[A-Za-z0-9_-]{20}/);
});

test('connection overview includes native identities without duplicating managed setup or exposing another workspace',()=>{
  const native=createAgent({name:'Native overview agent',workspaceSlug:'browser-onboarding'});
  const workspace=createWorkspace({name:'Hidden overview workspace',slug:'hidden-overview-workspace'});
  const foreign=createAgent({name:'Foreign overview agent',workspaceSlug:workspace.slug});
  const managed=connectionAction(owner.agent_id,{action:'apply',surface:'codex',access_mode:'read',request_key:'overview-managed'}) as {connection:{id:string}};
  const managedAgent=db.query('SELECT agent_id FROM client_connections WHERE id=?').get(managed.connection.id) as {agent_id:string};
  const state=browserConnectionState(owner.agent_id),agents=state.agents as {id:string;name:string;last_seen:string|null}[];
  expect(agents.some(a=>a.id===native.id)).toBe(true);
  expect(agents.some(a=>[foreign.id,owner.agent_id,managedAgent.agent_id].includes(a.id))).toBe(false);
  expect(state.memory_model.state).toBe('not_connected');
  expect(JSON.stringify(state)).not.toContain(native.api_key);
  expect(Object.keys(agents.find(a=>a.id===native.id)!)).toEqual(['id','name','last_seen']);
});

test('browser discovery does not reactivate a revoked identity or choose between owners',()=>{
  const agent=browserAgent('GPT')!;db.query('UPDATE agents SET active=0 WHERE id=?').run(agent.id);
  expect(browserAgent('GPT')).toBeNull();db.query('UPDATE agents SET active=1 WHERE id=?').run(agent.id);
  const workspace=createWorkspace({name:'Other browser owner',slug:'other-browser-owner'});second=bootstrapOwner(db,'Other owner',undefined,workspace.id);
  expect(browserAgent('GPT')).toBeNull();expect(browserAgent('Claude')).toBeNull();
});
