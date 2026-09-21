import {beforeAll,expect,test} from 'bun:test';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {registerTools,normalizeAgentProfile,toolNames} from '../src/mcp/tools.ts';
import {registerBridgeTools} from '../src/bridges/api.ts';
import {bootstrapToolAllowed} from '../src/auth/policy.ts';
import {authorityOperations,registerAuthorityTools,effectiveAuthority,agentCoverage} from '../src/api/authority.ts';
import {agentContractFor,grantedTools} from '../src/api/agent-contract.ts';
import {continuityEvent} from '../src/services/continuity.ts';
import {setMemoryPolicy} from '../src/services/memory-policy.ts';
import type {AuthContext} from '../src/auth/middleware.ts';

let workspace:string,owner:string;const agents:Record<string,string>={};
beforeAll(()=>{
  runMigrations();
  const ws=createWorkspace({name:'Agent contract check',slug:'agent-contract-check'});workspace=ws.id;
  owner=createAgent({name:'contract-owner',workspaceSlug:ws.slug,type:'owner'}).id;
  agents.owner=owner;
  agents.steward=createAgent({name:'contract-steward',workspaceSlug:ws.slug,type:'steward'}).id;
  agents.standard=createAgent({name:'contract-standard',workspaceSlug:ws.slug}).id;
  agents.reader=createAgent({name:'contract-reader',workspaceSlug:ws.slug}).id;
  agents.worker=createAgent({name:'contract-memory-worker',workspaceSlug:ws.slug}).id;
  db.query("UPDATE agents SET tool_profile='read-only' WHERE id=?").run(agents.reader!);
  db.query("UPDATE agents SET authority_profile='memory-worker',legacy_skill_access=0 WHERE id=?").run(agents.worker!);
});
const authOf=(id:string):AuthContext=>{
  const row=db.query('SELECT id,name,type,tool_profile,authority_profile,legacy_skill_access FROM agents WHERE id=?').get(id) as any;
  return {agent_id:row.id,agent_name:row.name,workspace_id:workspace,type:row.type,source:'api-key',tool_profile:row.tool_profile,authority_profile:row.authority_profile,legacy_skill_access:row.legacy_skill_access};
};
/** The names a real connection of this agent is offered, recorded from the production registrars. */
function advertised(auth:AuthContext) {
  const names:string[]=[],recorder={registerTool(name:string){names.push(name);return {};},tool(name:string){names.push(name);return {};}} as unknown as McpServer;
  const bootstrap=auth.legacy_skill_access===1?undefined:auth.authority_profile;
  registerTools(recorder,()=>auth,'full',{isSteward:auth.type==='steward'||auth.type==='owner',bootstrapProfile:bootstrap,agentToolProfile:normalizeAgentProfile(auth.tool_profile,auth.agent_name)});
  registerAuthorityTools(recorder,()=>auth,new Set(toolNames('full').filter(name=>bootstrapToolAllowed(name,bootstrap))));
  registerBridgeTools(recorder,()=>auth);
  return names.filter(name=>name!=='qoopia_capabilities').sort();
}

test('the contract lists exactly the tools a real connection is offered, for every kind of agent',()=>{
  for(const [kind,id] of Object.entries(agents)) {
    const auth=authOf(id);
    expect([kind,grantedTools(db,auth,authorityOperations).sort()]).toEqual([kind,advertised(auth)]);
  }
  expect(advertised(authOf(agents.reader!))).not.toContain('note_create');
  expect(advertised(authOf(agents.steward!))).toContain('memory_policy_list');
});

test('every registered tool belongs to a named mechanism',()=>{
  expect(agentContractFor(db,workspace,owner,authorityOperations)!.mechanisms.find(m=>m.id==='other')).toBeUndefined();
});

test('each mechanism reports one of five states with a reason and an action',()=>{
  const of=(id:string)=>Object.fromEntries(agentContractFor(db,workspace,id,authorityOperations)!.mechanisms.map(m=>[m.id,m]));
  const standard=of(agents.standard!),reader=of(agents.reader!);
  expect(standard['memory.notes']).toMatchObject({status:'available',reason:null});
  expect(standard.management).toMatchObject({status:'forbidden',tools:[]});expect(standard.management!.action).toBeString();
  expect(of(agents.steward!).management!.tools).toContain('memory_policy_set');
  expect(reader['memory.notes']!.tools).toContain('recall');expect(reader['memory.notes']!.withheld).toContain('note_create');
  expect(standard.bridges).toMatchObject({status:'needs_setup'});
  if(process.env.QOOPIA_ENTITY_PAGES!=='true')expect(standard.knowledge).toMatchObject({status:'needs_setup'});
  // A full catalogue is not admin for everyone: nothing owner-only leaks into a standard agent's tools.
  expect(Object.values(standard).flatMap(m=>m.tools).filter(name=>/^(memory_policy|memory_save|agent_onboard|principal_revoke)/.test(name))).toEqual([]);
});

test('automatic capture is reported as it really is, not as it is wished',()=>{
  const state=()=>agentContractFor(db,workspace,agents.standard!,authorityOperations)!.mechanisms.find(m=>m.id==='memory.continuity')!;
  expect(state()).toMatchObject({status:'needs_setup'});
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-00000000c0de',?,?,?,'chatgpt_web','read_write','contract-test','verified','x','2999-01-01','2026-01-01')`).run(workspace,owner,agents.standard!);
  expect(state()).toMatchObject({status:'client_unsupported'});expect(state().action).toContain('note_create');
  continuityEvent(workspace,agents.standard!,{session_id:'claude_code:contract',project:'/contract',runtime:'claude_code',event:'progress',messages:[{id:'c1',role:'user',content:'Синтетическое сообщение.'}]});
  expect(state()).toMatchObject({status:'available',reason:null});
  setMemoryPolicy({workspace_id:workspace,agent_id:agents.standard!,mode:'manual',actor_id:owner});
  expect(state()).toMatchObject({status:'forbidden'});
  db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_error','MODEL_QUOTA') WHERE id='claude_code:contract'").run();
  setMemoryPolicy({workspace_id:workspace,agent_id:agents.standard!,mode:'auto',actor_id:owner});
  expect(state()).toMatchObject({status:'faulty'});expect(state().action).toContain('signs in');
});

test('the agent, the steward overview and the capabilities call read one contract; live status stays out of the digest',()=>{
  const self=effectiveAuthority(authOf(agents.standard!)) as any;
  expect(self.contract).toBe('qoopia-agent-contract/1');expect(self.protocol.revision).toBeGreaterThanOrEqual(2);
  expect(self.mechanisms).toEqual(agentContractFor(db,workspace,agents.standard!,authorityOperations)!.mechanisms);
  expect((agentCoverage(authOf(agents.steward!),'contract-standard') as any).mechanisms).toEqual(self.mechanisms);
  const all=(agentCoverage(authOf(agents.steward!),'all') as any).agents;
  expect(all.find((a:any)=>a.agent_id===agents.standard).coverage['memory.continuity']).toBe('faulty');
  expect(()=>agentCoverage(authOf(agents.standard!),agents.steward!)).toThrow('Only the steward or the owner');
  db.query("UPDATE sessions SET metadata=json_remove(metadata,'$.continuity_error') WHERE id='claude_code:contract'").run();
  expect((effectiveAuthority(authOf(agents.standard!)) as any).config_digest).toBe(self.config_digest);
});

test('every sentence the contract can show has a Russian translation',async()=>{
  const ru=await Bun.file(new URL('../src/public/brand/i18n.ru.json',import.meta.url)).json() as Record<string,string>;
  const source=await Bun.file(new URL('../src/api/agent-contract.ts',import.meta.url)).text();
  const sentences=[...source.matchAll(/(?:title|reason|action):\s*(?:[^'`\n]*\?)?\s*'((?:[^'\\]|\\.)+)'/g),...source.matchAll(/\?'((?:[^'\\]|\\.){12,})'\s*:\s*'((?:[^'\\]|\\.){12,})'/g)].flatMap(m=>m.slice(1)).map(text=>text.replace(/\\'/g,"'"));
  expect(sentences.length).toBeGreaterThan(20);
  for(const text of sentences)expect(ru[text],text).toBeString();
});
