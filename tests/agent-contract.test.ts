import {beforeAll,expect,test} from 'bun:test';
import type {McpServer} from '@modelcontextprotocol/server';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {registerTools,normalizeAgentProfile,toolNames} from '../src/mcp/tools.ts';
import {registerBridgeTools} from '../src/bridges/api.ts';
import {bootstrapToolAllowed} from '../src/auth/policy.ts';
import {authorityOperations,registerAuthorityTools,effectiveAuthority,agentCoverage} from '../src/api/authority.ts';
import {agentContractFor,grantedTools} from '../src/api/agent-contract.ts';
import {agentMemoryStatus,noteAgentWork} from '../src/services/memory-policy.ts';
import fs from 'node:fs';
import path from 'node:path';
import {continuityEvent} from '../src/services/continuity.ts';
import {saveMessage,saveTurn} from '../src/services/sessions.ts';
import {memoryClientConnectionPath} from '../src/services/memory-model.ts';
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
  registerTools(recorder,()=>auth,'full',{isSteward:auth.type==='steward'||auth.type==='owner',bootstrapProfile:bootstrap,agentToolProfile:normalizeAgentProfile(auth.tool_profile,auth.agent_name),grantedScope:auth.granted_scope});
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
  expect(advertised(authOf(agents.steward!))).toContain('connection_prepare');
  expect(advertised(authOf(agents.standard!))).not.toContain('connection_prepare');
});

test('F-256: owner-only memory tools reach only the owner; a read-scoped steward keeps memory_policy_list',()=>{
  const ownerOnly=['memory_policy_set','memory_save_list','memory_save_decide'];
  const steward=authOf(agents.steward!),owner=authOf(agents.owner!),readSteward:AuthContext={...steward,granted_scope:['mcp:read']};
  for(const name of ownerOnly){
    expect([name,advertised(steward).includes(name),grantedTools(db,steward,authorityOperations).includes(name)]).toEqual([name,false,false]);
    expect([name,advertised(owner).includes(name),grantedTools(db,owner,authorityOperations).includes(name)]).toEqual([name,true,true]);
  }
  expect(advertised(readSteward)).toContain('memory_policy_list');
  expect(grantedTools(db,readSteward,authorityOperations)).toContain('memory_policy_list');
  expect(grantedTools(db,readSteward,authorityOperations).sort()).toEqual(advertised(readSteward));
});

test('every registered tool belongs to a named mechanism',()=>{
  expect(agentContractFor(db,workspace,owner,authorityOperations)!.mechanisms.find(m=>m.id==='other')).toBeUndefined();
});

test('each mechanism reports one of five states with a reason and an action',()=>{
  const of=(id:string)=>Object.fromEntries(agentContractFor(db,workspace,id,authorityOperations)!.mechanisms.map(m=>[m.id,m]));
  const standard=of(agents.standard!),reader=of(agents.reader!);
  expect(standard['memory.notes']).toMatchObject({status:'available',reason:null});
  expect(standard.management).toMatchObject({status:'forbidden',tools:[],action:'Ask the steward or the owner to do it.'});
  // A memory worker's connection profile includes AgentComm: it may message agents of its workspace.
  const worker=of(agents.worker!);
  expect(worker.agentcomm).toMatchObject({status:'available',reason:null});
  expect(worker.agentcomm!.tools).toEqual(expect.arrayContaining(['agent_send','agent_inbox','agent_reply','agent_status']));
  expect(of(agents.steward!).management!.tools).toContain('memory_policy_list');
  expect(of(agents.steward!).management!.tools).not.toContain('memory_policy_set');
  expect(of(owner).management!.tools).toContain('memory_policy_set');
  expect(reader['memory.notes']!.tools).toContain('recall');expect(reader['memory.notes']!.withheld).toContain('note_create');
  expect(standard.bridges).toMatchObject({status:'needs_setup'});
  if(process.env.QOOPIA_ENTITY_PAGES!=='true')expect(standard.knowledge).toMatchObject({status:'needs_setup'});
  // A full catalogue is not admin for everyone: nothing owner-only leaks into a standard agent's tools.
  expect(Object.values(standard).flatMap(m=>m.tools).filter(name=>/^(memory_policy|memory_save|agent_onboard|principal_revoke)/.test(name))).toEqual([]);
});

test('automatic capture is reported as it really is, not as it is wished',()=>{
  const state=()=>agentContractFor(db,workspace,agents.standard!,authorityOperations)!.mechanisms.find(m=>m.id==='memory.continuity')!;
  // Without hooks Autosave is the agent's own part: available, with the instruction to save each turn.
  expect(state()).toMatchObject({status:'available',tools:['session_save']});expect(state().action).toContain('session_save');
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-00000000c0de',?,?,?,'chatgpt_web','read_write','contract-test','verified','x','2999-01-01','2026-01-01')`).run(workspace,owner,agents.standard!);
  expect(state()).toMatchObject({status:'available'});expect(state().action).toContain('session_save');
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

test('a linked runtime agent reads the capture of its separate memory agent, and hooks that stopped delivering are faulty',()=>{
  const linked=createAgent({name:'contract-claude-code',workspaceSlug:'agent-contract-check'}).id;
  const memory=createAgent({name:'Qoopia Claude memory',workspaceSlug:'agent-contract-check'}).id;
  const state=(id:string)=>agentContractFor(db,workspace,id,authorityOperations)!.mechanisms.find(m=>m.id==='memory.continuity')!;
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-00000000c1de',?,?,?,'claude_code','read_write','contract-linked','verified','x','2999-01-01','2026-01-01')`).run(workspace,owner,linked);
  expect(state(linked)).toMatchObject({status:'needs_setup'});
  expect(state(linked).action).toContain('separate memory agent');expect(state(linked).action).not.toContain('identity and provider stay');
  // Another agent with Claude Code sessions is not this runtime's memory client; memory settings name it.
  expect(state(linked)).toMatchObject({status:'needs_setup'});
  const file=memoryClientConnectionPath(workspace,'claude_code');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify({format:'qoopia-memory-connection/1',agent_id:memory,runtime:'claude_code'}),{mode:0o600});
  continuityEvent(workspace,memory,{session_id:'claude_code:served',project:'/served',runtime:'claude_code',event:'progress',messages:[{id:'s1',role:'user',content:'Синтетическое сообщение.'}]});
  expect(state(linked)).toMatchObject({status:'available',served_by:'Qoopia Claude memory',reason:'Sessions of this runtime are captured and restored by its separate Qoopia memory agent.'});
  const at=(ms:number)=>new Date(Date.now()-ms).toISOString();
  // One instant for both: a session created a millisecond after the last capture reads as hooks still registering.
  const captured=at(3*3600_000);
  db.query('UPDATE session_messages SET created_at=? WHERE agent_id=?').run(captured,memory);
  db.query('UPDATE sessions SET created_at=? WHERE agent_id=?').run(captured,memory);
  // Idle since its last capture: nothing is wrong.
  db.query('UPDATE agents SET last_seen=? WHERE id=?').run(at(3*3600_000-60_000),memory);
  expect(state(memory)).toMatchObject({status:'available'});
  // Requests that are not conversation work keep last_seen fresh but prove nothing: inbox polling, pings.
  db.query('UPDATE agents SET last_seen=? WHERE id=?').run(at(60_000),memory);
  noteAgentWork(memory,'agent_inbox');
  expect(state(memory)).toMatchObject({status:'available'});
  // Still working two hours after its hooks last delivered: capture stopped.
  noteAgentWork(memory,'recall');
  expect(state(memory)).toMatchObject({status:'faulty'});expect(state(memory).action).toContain('qoopia doctor');
  expect(state(linked)).toMatchObject({status:'faulty',served_by:'Qoopia Claude memory'});
  // Hooks that still register sessions run; a transcript the runtime never writes (claude -p
  // --no-session-persistence) has nothing to deliver, and doctor on that computer reports the rest.
  continuityEvent(workspace,memory,{session_id:'claude_code:no-transcript',project:'/served',runtime:'claude_code',event:'start',messages:[]});
  expect(state(memory)).toMatchObject({status:'available'});
});

test('an agent without hooks whose last save is old is not shown as saving automatically',()=>{
  const bot=createAgent({name:'contract-chat-client',workspaceSlug:'agent-contract-check'}).id;
  // A one-off or scheduled save (LIA's daily task) is not autosave, however fresh.
  saveMessage({workspace_id:workspace,agent_id:bot,session_id:'contract-explicit-save',role:'assistant',content:'Синтетика.'});
  expect(agentMemoryStatus(workspace,bot).state).toBe('waiting');
  saveTurn({workspace_id:workspace,agent_id:bot,user:'Синтетика?',assistant:'Синтетика.'});
  expect(agentMemoryStatus(workspace,bot).state).not.toBe('waiting');
  db.query('UPDATE sessions SET last_active=? WHERE agent_id=?').run(new Date(Date.now()-30*86400_000).toISOString(),bot);
  expect(agentMemoryStatus(workspace,bot).state).toBe('waiting');
});

test('a memory client linked in settings that has not delivered yet is waiting for setup, not a model error',()=>{
  const linked=createAgent({name:'contract-codex',workspaceSlug:'agent-contract-check'}).id;
  const memory=createAgent({name:'Qoopia Codex memory',workspaceSlug:'agent-contract-check'}).id;
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-0000000c0d3e',?,?,?,'codex','read_write','contract-linked-codex','verified','x','2999-01-01','2026-01-01')`).run(workspace,owner,linked);
  const file=memoryClientConnectionPath(workspace,'codex');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify({format:'qoopia-memory-connection/1',agent_id:memory,runtime:'codex'}),{mode:0o600});
  const continuity=agentContractFor(db,workspace,linked,authorityOperations)!.mechanisms.find(m=>m.id==='memory.continuity')!;
  expect(continuity).toMatchObject({status:'needs_setup',served_by:'Qoopia Codex memory'});
  expect(continuity.reason).not.toContain('memory model reported an error');
});
