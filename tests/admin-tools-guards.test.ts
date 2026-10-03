import {beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {registerClient} from '../src/auth/oauth.ts';
import {sha256Hex} from '../src/auth/api-keys.ts';
import {adminTools} from '../src/mcp/admin-tools.ts';
import type {AuthContext} from '../src/auth/middleware.ts';

type Agent=ReturnType<typeof createAgent>;
let ws:{id:string;slug:string},owner:Agent,steward:Agent,standard:Agent,bystander:Agent,foreign:Agent;
const tool=(name:string)=>adminTools.find(t=>t.name===name)!;
const as=(a:Agent,type:string):AuthContext=>({agent_id:a.id,agent_name:a.name,workspace_id:a.workspace_id,type,source:'api-key',tool_profile:'full'});
const active=(a:Agent)=>(db.query('SELECT active FROM agents WHERE id=?').get(a.id) as {active:number}).active;
function token(a:Agent){
  const client=registerClient({client_name:'guard-'+randomUUID(),redirect_uris:['https://example.com/cb'],token_endpoint_auth_method:'none'},as(a,'standard'));
  const hash=sha256Hex('qa_guard_'+randomUUID());
  db.query(`INSERT INTO oauth_tokens (token_hash,client_id,agent_id,workspace_id,token_type,expires_at,revoked,created_at)
    VALUES (?,?,?,?,'access',?,0,?)`).run(hash,client.client_id,a.id,a.workspace_id,new Date(Date.now()+60_000).toISOString(),new Date().toISOString());
  return ()=>(db.query('SELECT revoked FROM oauth_tokens WHERE token_hash=?').get(hash) as {revoked:number}).revoked;
}
beforeAll(()=>{
  runMigrations();
  const slug='admin-guards-'+randomUUID();ws={id:createWorkspace({name:'Admin guards',slug}).id,slug};
  owner=createAgent({name:'guard-owner',workspaceSlug:slug,type:'owner'});
  steward=createAgent({name:'guard-steward',workspaceSlug:slug,type:'steward'});
  standard=createAgent({name:'guard-standard',workspaceSlug:slug});
  bystander=createAgent({name:'guard-bystander',workspaceSlug:slug});
  const other='admin-guards-other-'+randomUUID();createWorkspace({name:'Admin guards other',slug:other});
  foreign=createAgent({name:'guard-foreign',workspaceSlug:other});
});

test('standard callers cannot use agent_onboard, agent_list or agent_deactivate',()=>{
  for(const [name,args] of [['agent_onboard',{name:'guard-sneaky'}],['agent_list',{}],['agent_deactivate',{name:'guard-bystander'}]] as const)
    expect(()=>tool(name).handler(args,as(standard,'standard'))).toThrow('requires steward or owner');
  expect(db.query('SELECT 1 FROM agents WHERE name=?').get('guard-sneaky')).toBeNull();
  expect(active(bystander)).toBe(1);
});

test('steward cannot deactivate an owner',()=>{
  expect(()=>tool('agent_deactivate').handler({name:'guard-owner'},as(steward,'steward'))).toThrow('Only an owner may deactivate an owner.');
  expect(active(owner)).toBe(1);
});

test('steward cannot deactivate itself',()=>{
  expect(()=>tool('agent_deactivate').handler({name:'guard-steward'},as(steward,'steward'))).toThrow('cannot deactivate itself');
  expect(active(steward)).toBe(1);
});

test('agent_deactivate cannot reach an agent in another workspace',()=>{
  expect(()=>tool('agent_deactivate').handler({name:'guard-foreign'},as(steward,'steward'))).toThrow('not found');
  expect(active(foreign)).toBe(1);
});

test('agent_onboard always creates a standard agent, even for an owner caller',()=>{
  const created=tool('agent_onboard').handler({name:'guard-onboarded'},as(owner,'owner')) as {agent_id:string;api_key:string};
  const row=db.query('SELECT type,active,workspace_id,api_key_hash FROM agents WHERE id=?').get(created.agent_id) as {type:string;active:number;workspace_id:string;api_key_hash:string};
  expect(row).toEqual({type:'standard',active:1,workspace_id:ws.id,api_key_hash:sha256Hex(created.api_key)});
});

test('agent_list returns only the caller workspace',()=>{
  const listed=tool('agent_list').handler({},as(steward,'steward')) as {agents:{name:string;workspace:string}[];total:number};
  expect(listed.agents.map(a=>a.name).sort()).toEqual(['guard-bystander','guard-onboarded','guard-owner','guard-standard','guard-steward']);
  expect(new Set(listed.agents.map(a=>a.workspace))).toEqual(new Set([ws.slug]));
});

test('steward deactivates a standard agent and revokes only its OAuth tokens',()=>{
  const target=token(standard),other=token(bystander);
  expect(tool('agent_deactivate').handler({name:'guard-standard'},as(steward,'steward'))).toEqual({deactivated:true,agent_name:'guard-standard',tokens_revoked:1});
  expect(active(standard)).toBe(0);expect(target()).toBe(1);
  expect(active(bystander)).toBe(1);expect(other()).toBe(0);
});

test('agent_onboard bootstrap notes carry the same temporal columns as any note_create',()=>{
  // The note-write clock is per workspace (F-339): other files' notes do not move it.
  const before=(db.query('SELECT COALESCE(MAX(updated_at_ms),0) AS ms FROM notes WHERE workspace_id=?').get(steward.workspace_id) as {ms:number}).ms;
  const created=tool('agent_onboard').handler({name:'guard-bootstrapped',role:'general'},as(steward,'steward')) as {agent_id:string;bootstrap_notes_created:number};
  const rows=db.query('SELECT created_at,created_at_ms,valid_from_ms,updated_at_ms FROM notes WHERE agent_id=?').all(created.agent_id) as
    {created_at:string;created_at_ms:number|null;valid_from_ms:number|null;updated_at_ms:number}[];
  expect(rows.length).toBe(created.bootstrap_notes_created);
  expect(rows.length).toBeGreaterThan(0);
  for(const row of rows){
    expect(row.created_at).toMatch(/\.\d{3}Z$/);
    expect(row.created_at_ms).toBe(Date.parse(row.created_at));
    expect(row.valid_from_ms).toBe(row.created_at_ms);
    expect(row.updated_at_ms).toBeGreaterThan(before);
  }
});
