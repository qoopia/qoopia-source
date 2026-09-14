import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loopFixture,accepted,assigned,opened} from './helpers/p2-fixtures.ts';
import {claimProjection,checkClaim,observeRuntime,authorizeRun,recordOutcome,rateSkill,evaluateArtifacts} from '../src/skills/runtime.ts';
import {skillLifecycle,loopView} from '../src/skills/loop.ts';
import {principalAuth} from './helpers/p1-fixtures.ts';
import {digest} from '../src/skills/commands.ts';
import {csvExpected,nativeExecution,nativeMcpEvidence,bindManagedRoot,materializeSession} from '../src/skills/adapter.ts';
const mutation=()=>({expected_revision:0,idempotency_key:randomUUID()});
const evaluator={kind:'json-artifacts/1' as const,objective:'CSV validation and summary',cases:[{name:'summary',path:'summary.json',expected:{overall:25},absent:[]},{name:'refusal',path:'refusal.json',expected:{status:'refused'},absent:['invalid-summary.json']}]};

test('Installed connection authorization is immutable and scoped; remote reporter never opens receipt paths',()=>{
 const f=loopFixture('claude_code'),root=realpathSync(mkdtempSync(join(tmpdir(),'p3-bound-outcome-')));
 try{
  const v=accepted(f);assigned(f,v);const s=opened(f),e=s.entries[0]!;
  bindManagedRoot(f.database,f.auth,f.runtimeId,root);materializeSession(f.database,f.reportAuth,s.id);
  const instance=(f.database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  const connection={path:'/nonexistent-receipt-not-read-by-remote-authority',sha256:digest('synthetic receipt'),instance,
   workspace_id:f.auth.workspace_id,runtime_id:f.runtimeId,agent_id:f.target.data.agent_id};
  const native={auth_mode:'subscription-store',model:'claude-opus-5',effort:'high',login_backend:'config-dir',login_store:'/synthetic-store',connection};
  const a={...mutation(),loadout_id:s.id,entry_id:e.id,version_id:e.version_id,projection_digest:e.projection_digest,
   attempt_id:randomUUID(),evaluator:{...evaluator,native},environment_digest:digest('bound fixture')};
  const run=authorizeRun(f.reportAuth,a,f.database);
  expect(authorizeRun(f.reportAuth,a,f.database)).toEqual(run);
  const subscription={auth_mode:'subscription',model:native.model,effort:native.effort,connection};
  const envRun={...a,...mutation(),attempt_id:randomUUID(),evaluator:{...evaluator,native:subscription}};
  expect(authorizeRun(f.reportAuth,envRun,f.database).data.run_id).toBeDefined();
  expect(()=>authorizeRun(f.reportAuth,{...envRun,...mutation(),evaluator:{...evaluator,native}},f.database)).toThrow('another evaluator/environment');
  expect(()=>authorizeRun(f.reportAuth,{...envRun,...mutation(),attempt_id:randomUUID(),evaluator:{...evaluator,native:{...subscription,auth_mode:'api-key'}}},f.database)).toThrow('subscription');
  for(const change of [{instance:'foreign'},{runtime_id:'foreign'},{agent_id:'foreign'},{workspace_id:'foreign'}])
   expect(()=>authorizeRun(f.reportAuth,{...a,...mutation(),evaluator:{...evaluator,native:{...native,connection:{...connection,...change}}}},f.database)).toThrow('this installed runtime');
  expect(()=>authorizeRun(f.reportAuth,{...a,...mutation(),evaluator:{...evaluator,native:{...native,connection:{...connection,sha256:digest('drift')}}}},f.database)).toThrow('another evaluator/environment');
  const observation=observeRuntime(f.reportAuth,{...mutation(),loadout_id:s.id,entry_id:e.id,version_id:e.version_id,projection_digest:e.projection_digest,
   run_id:run.data.run_id,kind:'observed_execution',event_id:randomUUID(),observed_at_ms:Date.now(),
   evidence:{subtype:'native_event',native_session_ref:'synthetic',trace_digest:digest('synthetic native read only'),
    native_model:{source:'claude_response',models:['claude-opus-5'],complete:true}}},f.database);
  const outcome=recordOutcome(f.reportAuth,{...mutation(),run_id:run.data.run_id,version_id:e.version_id,evidence_class:'verified_outcome',
   execution_observation_id:observation.data.observation_id,outside_writes:'none',artifacts:{'summary.json':'{"overall":25}','refusal.json':'{"status":"refused"}'}},f.database);
  expect(outcome.data.status).toBe('unknown'); // Correct artifacts/model and write audit do not substitute for native MCP.
 }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('Native MCP evidence requires successful selected-server calls/results and independent note identity (synthetic events)',()=>{
 const marker='qoopianativesynthetic',note='synthetic-note';
 const calls=[{tool:'qoopia_capabilities',arguments:{},result:{profile:'memory-worker'}},
  {tool:'note_create',arguments:{text:marker},result:{id:note}},
  {tool:'note_get',arguments:{id:note},result:{id:note,text:marker}},
  {tool:'recall',arguments:{query:marker,deep:false,deep_llm:false},result:{id:note}}];
 const codex=calls.map(c=>JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'qoopia',status:'completed',...c}})).join('\n');
 const claude=calls.flatMap((c,i)=>[{type:'assistant',message:{content:[{type:'tool_use',id:String(i),name:'mcp__qoopia__'+c.tool,input:c.arguments}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:String(i),content:JSON.stringify(c.result)}]}}]).map(e=>JSON.stringify(e)).join('\n');
 expect(nativeMcpEvidence('codex',codex,marker,note).complete).toBe(true);
 expect(nativeMcpEvidence('claude_code',claude,marker,note).complete).toBe(true);
 expect(nativeMcpEvidence('codex',codex,marker,undefined).complete).toBe(false);
 expect(nativeMcpEvidence('codex',codex.replaceAll('"qoopia"','"other"'),marker,note).complete).toBe(false);
 expect(nativeMcpEvidence('codex',codex.replaceAll('"completed"','"failed"'),marker,note).complete).toBe(false);
 expect(nativeMcpEvidence('claude_code','I called all four tools '+marker+' '+note,marker,note).complete).toBe(false);
});

test('T-08/T-17/T-18 synthetic protocol: evaluator, marker refusal, immutable late facts, vote dedupe and current replay',()=>{
 const f=loopFixture();try{
  const v=accepted(f);assigned(f,v);const s=opened(f),e=s.entries[0]!;
  const binding={loadout_id:s.id,entry_id:e.id,version_id:e.version_id,projection_digest:e.projection_digest};
  const args={...binding,...mutation(),attempt_id:'first',evaluator,environment_digest:digest('fixture')};
  expect(()=>authorizeRun(f.reportAuth,args,f.database)).toThrow('read back');
  const claim=claimProjection(f.reportAuth,{loadout_id:s.id,...mutation()},f.database).data;
  const s2=opened(f);expect(()=>checkClaim(f.database,f.reportAuth,{...claim,loadout_id:s2.id})).toThrow();
  expect(()=>observeRuntime(f.reportAuth,{...binding,projection_digest:digest('forged'),...mutation(),kind:'runtime_receipt',event_id:'forged',observed_at_ms:Date.now(),evidence:{subtype:'echo'}},f.database)).toThrow('frozen');
  observeRuntime(f.reportAuth,{...binding,...mutation(),kind:'projection_readback',event_id:'installed',observed_at_ms:Date.now(),evidence:{subtype:'readback',claim}},f.database);
  const run=authorizeRun(f.reportAuth,args,f.database);expect(authorizeRun(f.reportAuth,args,f.database)).toEqual(run);
  const base={run_id:run.data.run_id,version_id:e.version_id,...mutation(),evidence_class:'verified_outcome',artifacts:{'summary.json':'{"overall":25}','refusal.json':'{"status":"refused"}'},outside_writes:'none'};
  expect(()=>recordOutcome(f.reportAuth,base,f.database)).toThrow('not native');
  expect(()=>observeRuntime(f.reportAuth,{...binding,run_id:run.data.run_id,...mutation(),kind:'observed_execution',event_id:'echo',observed_at_ms:Date.now(),evidence:{subtype:'echo'}},f.database)).toThrow('native event');
  // Authenticated synthetic protocol fact ONLY: this is not a live runtime qualification.
  const obs=observeRuntime(f.reportAuth,{...binding,run_id:run.data.run_id,...mutation(),kind:'observed_execution',event_id:'native-fixture',observed_at_ms:Date.now(),evidence:{subtype:'native_event',native_session_ref:'synthetic',trace_digest:digest('synthetic-event')}},f.database);
  const outcome=recordOutcome(f.reportAuth,{...base,execution_observation_id:obs.data.observation_id},f.database);expect(outcome.data.status).toBe('succeeded');
  expect(evaluateArtifacts(evaluator,{'summary.json':'{"overall":25}'},'none').status).toBe('partial');
  expect(evaluateArtifacts(evaluator,base.artifacts,'detected').status).toBe('failed');
  expect(evaluateArtifacts(evaluator,base.artifacts,'unknown').status).toBe('unknown');
  const target=principalAuth(f.database,f.target.data.agent_id),vote={run_id:run.data.run_id,version_id:e.version_id,score:4,reason:'Useful synthetic test',...mutation()};
  for(let n=0;n<100;n++)rateSkill(target,vote,f.database);
  expect(loopView(f.auth,{},f.database).feedback_aggregate.eligible_votes).toBe(1);
  expect(loopView(f.auth,{},f.database).feedback_aggregate.independent_reputation_weight).toBe(0);
  skillLifecycle(f.auth,{version_id:v.version.id,kind:'revoke',reason:'test',...mutation()},f.database);
  expect(()=>authorizeRun(f.reportAuth,args,f.database)).toThrow('revoked');
  const later=recordOutcome(f.reportAuth,{...base,execution_observation_id:obs.data.observation_id,...mutation(),expected_revision:1,supersedes_id:outcome.data.outcome_id,outside_writes:'detected'},f.database);
  expect(later.data.status).toBe('failed');expect(later.data.stale).toBe(true);
  expect(f.database.query('SELECT count(*) n FROM skill_outcomes').get()).toEqual({n:2});
  expect(()=>f.database.run("UPDATE skill_outcomes SET status='succeeded'")).toThrow('immutable');
  expect(f.database.query('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{f.database.close();}
});
test('Native event parser requires successful tool result; CSV decimal sums are exact',()=>{
 const use={type:'assistant',session_id:'native',message:{content:[{type:'tool_use',name:'Read',id:'tool',input:{file_path:'/isolated/SKILL.md'}}]}};
 expect(nativeExecution('claude_code',JSON.stringify(use),'/isolated/SKILL.md').observed).toBe(false);
 const result={type:'user',session_id:'native',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'instructions'}]}};
 expect(nativeExecution('claude_code',[use,result].map(e=>JSON.stringify(e)).join('\n'),'/isolated/SKILL.md').observed).toBe(true);
 expect(csvExpected('category,amount\nA,0.10\nA,0.20\n').overall).toBe(0.3);
 expect(()=>csvExpected('category,amount\nA,NaN')).toThrow();
});

test('Native auth/model/effort binding is immutable; missing or mismatched model cannot be promoted by outside-write audit',()=>{
 const f=loopFixture('claude_code');try{
  assigned(f,accepted(f));const s=opened(f),entry=s.entries[0]!;
  const binding={loadout_id:s.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest};
  const claim=claimProjection(f.reportAuth,{loadout_id:s.id,...mutation()},f.database).data;
  observeRuntime(f.reportAuth,{...binding,...mutation(),kind:'projection_readback',event_id:'model-binding-readback',observed_at_ms:Date.now(),evidence:{subtype:'readback',claim}},f.database);
  const native={auth_mode:'subscription-store',model:'claude-opus-5',effort:'high',login_backend:'config-dir',login_store:'/synthetic/selected'};
  const args={...binding,...mutation(),attempt_id:'bound-model',evaluator:{...evaluator,native},environment_digest:digest(JSON.stringify(native))};
  const run=authorizeRun(f.reportAuth,args,f.database).data;
  for(const change of [{auth_mode:'api-key'},{model:'claude-other'},{effort:'low'},{login_store:'/synthetic/other'},{login_backend:'default-keychain'}]){
   const next={...native,...change};
   expect(()=>authorizeRun(f.reportAuth,{...args,...mutation(),evaluator:{...evaluator,native:next},environment_digest:digest(JSON.stringify(next))},f.database)).toThrow('another evaluator/environment');
  }
  const stored=f.database.query('SELECT evaluator_json,environment_digest FROM skill_runs WHERE id=?').get(run.run_id) as {evaluator_json:string;environment_digest:string};
  expect(JSON.parse(stored.evaluator_json).native).toEqual(native);expect(stored.environment_digest).toBe(args.environment_digest);
  // Synthetic authenticated reporter facts test the evaluator gate, not live CLI execution.
  let previous:string|undefined;
  for(const [index,models,complete,wanted] of [[0,[],false,'unknown'],[1,['claude-other'],true,'failed'],[2,['claude-opus-5'],true,'succeeded']] as const){
   const obs=observeRuntime(f.reportAuth,{...binding,...mutation(),run_id:run.run_id,kind:'observed_execution',event_id:'model-proof-'+index,observed_at_ms:Date.now(),
    evidence:{subtype:'native_event',native_session_ref:'synthetic-model-test',trace_digest:digest('synthetic-'+index),native_model:{source:'claude_response',models:[...models],complete}}},f.database).data;
   const result=recordOutcome(f.reportAuth,{...mutation(),expected_revision:index,...(previous?{supersedes_id:previous}:{}),run_id:run.run_id,version_id:entry.version_id,
    evidence_class:'verified_outcome',execution_observation_id:obs.observation_id,artifacts:{'summary.json':'{"overall":25}','refusal.json':'{"status":"refused"}'},outside_writes:'none'},f.database);
   expect(result.data.status).toBe(wanted);previous=result.data.outcome_id;
  }
  expect(f.database.query('SELECT count(*) n FROM skill_outcomes').get()).toEqual({n:3});
 }finally{f.database.close();}
});

for(const kind of ['codex','claude_code'] as const)test(`${kind} task-write consent and environment are immutable and bound to one attempt; current revoke still fences replay`,()=>{
 const f=loopFixture(kind),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-write-binding-')));
 try{
  const version=accepted(f);assigned(f,version);const s=opened(f),entry=s.entries[0]!;
  bindManagedRoot(f.database,f.auth,f.runtimeId,root);materializeSession(f.database,f.reportAuth,s.id);
  const attempt=randomUUID(),directory=join(root,'sessions',s.id,`task-${attempt}`);
  const native={auth_mode:'subscription',model:kind==='codex'?'gpt-6-astra':'claude-opus-5',effort:'high',task_write_directory:directory};
  const args={...mutation(),loadout_id:s.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest,
   attempt_id:attempt,evaluator:{...evaluator,native},environment_digest:digest(JSON.stringify(native))};
  const first=authorizeRun(f.reportAuth,args,f.database);expect(authorizeRun(f.reportAuth,args,f.database)).toEqual(first);
  const stored=f.database.query('SELECT evaluator_json,environment_digest FROM skill_runs WHERE id=?').get(first.data.run_id) as {evaluator_json:string;environment_digest:string};
  expect(JSON.parse(stored.evaluator_json).native).toEqual(native);expect(stored.environment_digest).toBe(args.environment_digest);
  const {task_write_directory,...defaultNative}=native;
  expect(task_write_directory).toBe(directory);
  expect(()=>authorizeRun(f.reportAuth,{...args,...mutation(),evaluator:{...evaluator,native:defaultNative}},f.database)).toThrow('another evaluator/environment');
  expect(()=>authorizeRun(f.reportAuth,{...args,...mutation(),environment_digest:digest('changed opt-in')},f.database)).toThrow('another evaluator/environment');
  for(const path of [root,join(root,'sessions',s.id),directory+'-sibling',join(root,'sessions',s.id,`task-${randomUUID()}`)])
   expect(()=>authorizeRun(f.reportAuth,{...args,...mutation(),evaluator:{...evaluator,native:{...native,task_write_directory:path}}},f.database)).toThrow('must match this attempt');
  skillLifecycle(f.auth,{version_id:version.version.id,kind:'revoke',reason:'withdraw exact grant',...mutation()},f.database);
  expect(()=>authorizeRun(f.reportAuth,args,f.database)).toThrow('revoked');
 }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});


test('Configured-profile opt-in is immutable; functional artifacts and outside audit never attest Codex model; revoke fences replay',()=>{
 const f=loopFixture('codex');try{
  const version=accepted(f);assigned(f,version);const s=opened(f),entry=s.entries[0]!;
  const binding={loadout_id:s.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest};
  const claim=claimProjection(f.reportAuth,{loadout_id:s.id,...mutation()},f.database).data;
  observeRuntime(f.reportAuth,{...binding,...mutation(),kind:'projection_readback',event_id:'configured-readback',observed_at_ms:Date.now(),evidence:{subtype:'readback',claim}},f.database);
  const native={auth_mode:'subscription-store',model:'gpt-6-astra',effort:'high',login_store:'/synthetic/selected',login_backend:'file',configured_profile_functional:true};
  const args={...binding,...mutation(),attempt_id:'configured',evaluator:{...evaluator,native},environment_digest:digest(JSON.stringify(native))};
  const run=authorizeRun(f.reportAuth,args,f.database).data;
  const {configured_profile_functional,...strict}=native;expect(configured_profile_functional).toBe(true);
  expect(()=>authorizeRun(f.reportAuth,{...args,...mutation(),evaluator:{...evaluator,native:strict}},f.database)).toThrow('another evaluator/environment');
  const outer={mode:'macos-seatbelt-only-bookkeeping/1',outer_root:'/synthetic/outer',profile_digest:digest('synthetic profile'),installation_id:'/synthetic/selected/installation_id',arg0:'/synthetic/selected/tmp/arg0'};
  expect(()=>authorizeRun(f.reportAuth,{...args,...mutation(),evaluator:{...evaluator,native:{...native,outer_seatbelt:outer}}},f.database)).toThrow('another evaluator/environment');
  const outerArgs={...args,...mutation(),attempt_id:'bound-outer',evaluator:{...evaluator,native:{...native,outer_seatbelt:outer}},environment_digest:digest(JSON.stringify(outer))};
  authorizeRun(f.reportAuth,outerArgs,f.database);
  for(const change of [{profile_digest:digest('different')},{arg0:'/synthetic/selected/tmp'},{installation_id:'/synthetic/selected/auth.json'},{outer_root:'/synthetic/other'},{mode:'unconfined'}])
   expect(()=>authorizeRun(f.reportAuth,{...outerArgs,...mutation(),evaluator:{...evaluator,native:{...native,outer_seatbelt:{...outer,...change}}}},f.database)).toThrow();
  let previous:string|undefined;
  for(const [index,rerouted] of [false,true].entries()){
   const observation=observeRuntime(f.reportAuth,{...binding,...mutation(),run_id:run.run_id,kind:'observed_execution',event_id:`configured-${index}`,observed_at_ms:Date.now(),
    evidence:{subtype:'native_event',native_session_ref:'synthetic-configured',trace_digest:digest('synthetic-configured'),native_model:{source:'codex_exec',models:[],complete:false,...(rerouted?{rerouted:true}:{})}}},f.database).data;
   // Synthetic OS assertion: this verifies the immutable model gate, not live qualification.
   const outcome=recordOutcome(f.reportAuth,{...mutation(),expected_revision:index,...(previous?{supersedes_id:previous}:{}),run_id:run.run_id,version_id:entry.version_id,
    evidence_class:'verified_outcome',execution_observation_id:observation.observation_id,artifacts:{'summary.json':'{"overall":25}','refusal.json':'{"status":"refused"}'},outside_writes:'none'},f.database);
   expect(outcome.data.status).toBe(rerouted?'failed':'unknown');previous=outcome.data.outcome_id;
  }
  skillLifecycle(f.auth,{version_id:version.version.id,kind:'revoke',reason:'configured grant withdrawn',...mutation()},f.database);
  expect(()=>authorizeRun(f.reportAuth,args,f.database)).toThrow('revoked');
 }finally{f.database.close();}
});
