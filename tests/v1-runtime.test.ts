import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loopFixture, accepted, assigned } from './helpers/p2-fixtures.ts';
import { bindManagedRoot, nativeLaunch } from '../src/skills/adapter.ts';
import { bindNativeConnection, publishNativeConnection, refreshNativeConnection } from '../src/skills/connection.ts';
import { principalAuth } from './helpers/p1-fixtures.ts';
import { agentTaskSchema, runAgentTask, nativeTaskFailure, type NativeTaskExecutor } from '../src/skills/agent-task.ts';
import { hash } from '../src/delivery/files.ts';

function history(database: ReturnType<typeof loopFixture>['database'], session:string) {
  return database.query('SELECT role,content FROM session_messages WHERE session_id=? ORDER BY id').all(session) as {role:string;content:string}[];
}

function fixture(withSkill=true) {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v1-agent-task-')));
  const managed = path.join(outer, 'managed');
  const install = path.join(outer, 'installed');
  const configDir = path.join(outer, 'connection');
  for (const directory of [managed, install, configDir]) fs.mkdirSync(directory, { mode: 0o700 });
  const f = loopFixture('claude_code');
  if (withSkill) assigned(f, accepted(f));
  bindManagedRoot(f.database, f.auth, f.runtimeId, managed);

  const current = { format:'qoopia-installation/1', generation:'generation-'+randomUUID(), bundle:'a'.repeat(64),
    bundle_digest:'a'.repeat(64), instance:(f.database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id, port:43737 };
  fs.writeFileSync(path.join(install, 'current.json'), JSON.stringify(current), { mode:0o600 });
  const bearer = 'q_' + 'x'.repeat(43);
  f.database.query('UPDATE agents SET api_key_hash=? WHERE id=?').run(hash(bearer), f.target.data.agent_id);
  const target = f.database.query('SELECT * FROM agents WHERE id=?').get(f.target.data.agent_id) as {
    id:string; workspace_id:string; policy_epoch:number; session_version:number;
  };
  const config = path.join(configDir, 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({mcpServers:{qoopia:{type:'http',url:`http://127.0.0.1:${current.port}/mcp`,headers:{Authorization:'Bearer '+bearer}}}}), { mode:0o600 });
  const connection = publishNativeConnection(f.database, { installation:{root:install,instance:current.instance,bundle:current.bundle,generation:current.generation,port:current.port},
    runtime_kind:'claude_code',runtime_id:f.runtimeId,workspace_id:f.auth.workspace_id,agent_id:target.id,
    agent_epoch:target.policy_epoch,agent_session:target.session_version,owner_id:f.auth.agent_id,
    owner_epoch:f.auth.policy_epoch!,owner_session:f.auth.session_version!,config });
  const native = { auth_mode:'subscription-store' as const, model:'claude-opus-5', effort:'high' as const,
    login_backend:'config-dir' as const, login_store:configDir, connection };
  return { ...f, outer, managed, connection, native, cleanup:()=>{f.database.close();fs.rmSync(outer,{recursive:true,force:true});} };
}

function response(text:string) {
  const session = randomUUID();
  return [
    {type:'system',subtype:'init',session_id:session},
    {type:'assistant',session_id:session,parent_tool_use_id:null,message:{type:'message',role:'assistant',model:'claude-opus-5',content:[{type:'text',text}]}},
    {type:'result',subtype:'success',is_error:false,session_id:session,modelUsage:{'claude-opus-5':{}}},
  ].map(value=>JSON.stringify(value)).join('\n');
}

test('a freshly signed-in owner can reconnect unchanged agents; stale owner sessions and revoked grants still refuse',()=>{
  const f=fixture(false),expected={runtime_id:f.runtimeId,runtime_kind:'claude_code' as const,workspace_id:f.auth.workspace_id};
  try{
    f.database.query('UPDATE agents SET session_version=session_version+1 WHERE id=?').run(f.auth.agent_id);
    expect(()=>bindNativeConnection(f.database,f.connection,expected)).toThrow('Native connection changed');
    expect(()=>refreshNativeConnection(f.database,f.connection,expected,f.auth)).toThrow('Native connection changed');
    const owner=principalAuth(f.database,f.auth.agent_id),ref=refreshNativeConnection(f.database,f.connection,expected,owner);
    expect(bindNativeConnection(f.database,ref,expected).reference.agent_id).toBe(f.connection.agent_id);
    f.database.query('UPDATE agents SET policy_epoch=policy_epoch+1 WHERE id=?').run(f.target.data.agent_id);
    expect(()=>refreshNativeConnection(f.database,ref,expected,owner)).toThrow('Native connection changed');
  }finally{f.cleanup();}
});

test('V1 task input boundary is strict and bounded', () => {
  const connection={path:'/receipt',sha256:'a'.repeat(64),instance:'instance',workspace_id:'workspace',runtime_id:'runtime',agent_id:'agent'};
  const native={auth_mode:'subscription-store',model:'claude-opus-5',effort:'high',connection};
  expect(agentTaskSchema.safeParse({runtime_id:'runtime',session:'session',task:'task',native,extra:true}).success).toBe(false);
  expect(agentTaskSchema.safeParse({runtime_id:'runtime',session:' ',task:'task',native}).success).toBe(false);
  expect(agentTaskSchema.safeParse({runtime_id:'runtime',session:'session',task:'x'.repeat(20_001),native}).success).toBe(false);
});

test('native provider failures give an actionable reason without echoing arbitrary provider content',()=>{
  expect(nativeTaskFailure('{"api_error_status":401,"result":"private provider detail"}')).toContain('Sign in again');
  expect(nativeTaskFailure('{"api_error_status":429}')).toContain('usage limit');
  expect(nativeTaskFailure('arbitrary stderr')).not.toContain('arbitrary stderr');
});

test('V1 ordinary task with no assigned skills preserves useful output for the next session', async () => {
  const f=fixture(false);const prompts:string[]=[];
  const executor:NativeTaskExecutor=async launch=>{prompts.push(launch.args.at(-1)!);return {exit_code:0,stdout:response(prompts.length===1?'First useful answer':'Remembered answer'),stderr:''};};
  try {
    const first=await runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'First task',task:'Give a useful answer.',native:f.native},{PATH:'/no-native'},executor);
    expect(first.status).toBe('completed');expect(first.run_ids).toEqual([]);expect(first.skills).toEqual([]);
    expect(first.task_authorization_id).toBeString();
    expect(f.database.query('SELECT count(*) n FROM session_loadout_entries WHERE loadout_id=?').get(first.loadout_id)).toEqual({n:0});
    expect(f.database.query('SELECT count(*) n FROM skill_runs WHERE loadout_id=?').get(first.loadout_id)).toEqual({n:0});
    expect(f.database.query("SELECT count(*) n FROM authority_commands WHERE operation='runtime_claim'").get()).toEqual({n:0});
    const second=await runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'First task',task:'Use what you remember.',native:f.native},{PATH:'/no-native'},executor);
    expect(second.session_id).toBe(first.session_id);expect(second.output).toBe('Remembered answer');
    expect(prompts[1]).toContain('Give a useful answer.');expect(prompts[1]).toContain('First useful answer');
    expect(history(f.database,first.session_id).map(message=>[message.role,message.content])).toEqual([
      ['user','Give a useful answer.'],['assistant','First useful answer'],['user','Use what you remember.'],['assistant','Remembered answer']]);
    expect(f.database.query("SELECT count(*) n FROM authority_commands WHERE operation='agent_task_authorize'").get()).toEqual({n:2});
  } finally { f.cleanup(); }
});

test('V1 no-skill Claude launch disables every built-in tool and Codex fails closed', async () => {
  const f=fixture(false);let claudeArgs:string[]=[];
  try {
    await runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Chat only',task:'Answer without tools.',native:f.native},{PATH:'/no-native'},
      async launch=>{claudeArgs=launch.args;return {exit_code:0,stdout:response('Tool-less answer'),stderr:''};});
    const tools=claudeArgs.indexOf('--tools');
    expect(claudeArgs.slice(tools,tools+2)).toEqual(['--tools','']);
    expect(claudeArgs).not.toContain('Read,Write,Edit,Bash,Skill');
    expect(()=>nativeLaunch('codex',f.managed,'Answer without tools.',{auth_mode:'api-key',model:'gpt-6-astra',effort:'high'},
      {CODEX_API_KEY:'fixture-api'},f.managed,undefined,'none')).toThrow('tool-less');
  } finally { f.cleanup(); }
});

test('V1 general task uses frozen loadout and persists output for a later native session', async () => {
  const f=fixture(); const prompts:string[]=[];
  const executor:NativeTaskExecutor=async launch=>{
    expect(launch.options.task_write_directory).toMatch(/\/task-[a-f0-9-]+$/);
    const settings=JSON.parse(launch.args[launch.args.indexOf('--settings')+1]!);
    expect(settings.permissions.allow).toContain(`Edit(/${launch.options.task_write_directory}/**)`);
    expect(launch.args.at(-1)).toContain(launch.options.task_write_directory!);
    fs.writeFileSync(path.join(launch.options.task_write_directory!,'handoff.md'),'Managed result.');
    const skillPath=path.join(launch.cwd,'.claude/skills/csv-summary/SKILL.md');
    prompts.push(launch.args.at(-1)!);
    const events=response(prompts.length===1?'First useful answer':'Continued answer').split('\n').map(line=>JSON.parse(line)),assistant=events[1];
    events.splice(1,0,{...assistant,message:{...assistant.message,content:[{type:'tool_use',name:'Read',id:'read-skill',input:{file_path:skillPath}}]}},
      {type:'user',session_id:assistant.session_id,message:{content:[{type:'tool_result',tool_use_id:'read-skill',content:fs.readFileSync(skillPath,'utf8')}]}});
    return {exit_code:0,stdout:events.map(e=>JSON.stringify(e)).join('\n'),stderr:''};
  };
  try {
    const first=await runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Quarterly plan',task:'Draft the first useful plan.',native:f.native},{PATH:'/no-native'},executor);
    expect(first.status).toBe('completed');expect(first.output).toBe('First useful answer');expect(first.model_status).toBe('verified');
    expect(f.database.query('SELECT count(*) n FROM skill_runs WHERE loadout_id=?').get(first.loadout_id)).toEqual({n:1});
    expect(f.database.query("SELECT count(*) n FROM runtime_observations WHERE loadout_id=? AND kind='observed_execution'").get(first.loadout_id)).toEqual({n:1});
    expect(fs.readFileSync(first.output_file,'utf8')).toBe('First useful answer\n');
    const second=await runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Quarterly plan',task:'Continue with risks.',native:f.native},{PATH:'/no-native'},executor);
    expect(second.session_id).toBe(first.session_id);expect(second.output).toBe('Continued answer');
    expect(prompts[1]).toContain('Draft the first useful plan.');expect(prompts[1]).toContain('First useful answer');
    const messages=history(f.database,first.session_id);
    expect(messages.map(message=>[message.role,message.content])).toEqual([
      ['user','Draft the first useful plan.'],['assistant','First useful answer'],['user','Continue with risks.'],['assistant','Continued answer']]);
    expect(f.database.query('SELECT count(*) n FROM session_loadouts WHERE qoopia_session_id=?').get(first.session_id)).toEqual({n:2});
  } finally { f.cleanup(); }
});

test('V1 failed executor is attempted once, retained as unknown, and never auto-replayed', async () => {
  const f=fixture();let calls=0;
  const executor:NativeTaskExecutor=async()=>{calls++;throw new Error('synthetic executor stopped');};
  try {
    await expect(runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Interrupted',task:'Do not replay me.',native:f.native},{PATH:'/no-native'},executor)).rejects.toThrow('Native task stopped; no automatic replay');
    expect(calls).toBe(1);
    const session=f.database.query("SELECT id FROM sessions WHERE title='Interrupted'").get() as {id:string};
    const messages=history(f.database,session.id);
    expect(messages.map(message=>message.role)).toEqual(['user','system']);
    expect(messages[1]!.content).toContain('unknown');
  } finally { f.cleanup(); }
});

test('V1 authorization refusal rolls back task session state before spawn', async () => {
  const f=fixture();let calls=0;
  const executor:NativeTaskExecutor=async()=>{calls++;return {exit_code:0,stdout:response('must not run'),stderr:''};};
  try {
    f.database.exec(`CREATE TRIGGER refuse_after_readback AFTER INSERT ON runtime_observations BEGIN
      UPDATE skill_assignments SET desired_state='paused' WHERE runtime_id='${f.runtimeId}';
    END`);
    await expect(runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Authorization refused',task:'Must not start.',native:f.native},{PATH:'/no-native'},executor)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(f.database.query("SELECT count(*) n FROM sessions WHERE title='Authorization refused'").get()).toEqual({n:0});
    expect(f.database.query("SELECT count(*) n FROM skill_assignments WHERE runtime_id=? AND desired_state='active'").get(f.runtimeId)).toEqual({n:1});
    const sessionsRoot=path.join(f.managed,'sessions');
    expect(fs.existsSync(sessionsRoot)?fs.readdirSync(sessionsRoot):[]).toEqual([]);
  } finally { f.cleanup(); }
});

test('V1 post-authorization filesystem refusal rolls back all task state before spawn', async () => {
  const f=fixture();let calls=0;
  const executor:NativeTaskExecutor=async()=>{calls++;return {exit_code:0,stdout:response('must not run'),stderr:''};};
  const tables=['sessions','session_loadouts','session_loadout_entries','skill_runs','session_messages','authority_commands','authority_events','memory_event_outbox'];
  const counts=()=>Object.fromEntries(tables.map(table=>[table,(f.database.query(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n]));
  try {
    const before=counts();
    fs.writeFileSync(path.join(f.outer,'CLAUDE.md'),'refuse ancestor customization\n',{mode:0o600});
    await expect(runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Preparation refused',task:'Must not start.',native:f.native},{PATH:'/no-native'},executor)).rejects.toThrow('Ancestor native customization');
    expect(calls).toBe(0);
    expect(counts()).toEqual(before);
    const sessionsRoot=path.join(f.managed,'sessions');
    expect(fs.existsSync(sessionsRoot)?fs.readdirSync(sessionsRoot):[]).toEqual([]);
  } finally { f.cleanup(); }
});

test('V1 task refuses a revoked exact connection before invoking executor', async () => {
  const f=fixture();let calls=0;
  const executor:NativeTaskExecutor=async()=>{calls++;return {exit_code:0,stdout:response('must not run'),stderr:''};};
  try {
    f.database.query('UPDATE agents SET policy_epoch=policy_epoch+1 WHERE id=?').run(f.target.data.agent_id);
    await expect(runAgentTask(f.database,f.reportAuth,{runtime_id:f.runtimeId,session:'Fenced',task:'Must refuse.',native:f.native},{PATH:'/no-native'},executor)).rejects.toThrow('connection changed');
    expect(calls).toBe(0);
    expect(f.database.query("SELECT count(*) n FROM sessions WHERE title='Fenced'").get()).toEqual({n:0});
  } finally { f.cleanup(); }
});
