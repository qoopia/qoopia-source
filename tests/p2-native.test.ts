import { test,expect } from 'bun:test';
import { mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,linkSync,existsSync,readdirSync,lstatSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materializeOwned,recoverProjection,hashTree,createRunSnapshot,createStrictCodexRunSnapshot,removeOwned,previewAdoption,adoptOwned,type Boundary } from '../src/skills/native.ts';
import { sessionGet,skillLifecycle } from '../src/skills/loop.ts';
import { nativeModelStatus,evaluateArtifacts,authorizeRun } from '../src/skills/runtime.ts';
import { canonical,digest } from '../src/skills/commands.ts';
import { loopFixture,accepted,assigned,opened,csvContent } from './helpers/p2-fixtures.ts';
import { bindManagedRoot,materializeSession,nativeLaunch,nativeOptions,nativeExecution,nativeModelEvidence,nativeSubscriptionStatus,preflightNativeSubscription,prepareNativeSession,prepareCsvTask,runCsvTask,nativeQualificationCanContinue,csvExpected,csvTaskInstructions,QUALIFICATION_MODELS } from '../src/skills/adapter.ts';
const old=new Map([['SKILL.md',Buffer.from('old instructions')],['assets/data.txt',Buffer.from('old data')]]);
const newer=new Map([['SKILL.md',Buffer.from('new instructions')],['assets/data.txt',Buffer.from('new data')]]);
const map=(files:Map<string,Buffer>)=>Object.fromEntries([...files].map(([n,b])=>[n,{sha256:digest(b),size:b.length}]));
function op(root:string,files=old,epoch=1){return {root,installation:'fixture',runtime:'runtime',target:'skills/sample',skill_id:'skill',version_id:epoch===1?'old':'new',projection_digest:digest(canonical(map(files))),operation_id:epoch===1?'initial':'update',epoch,files,guard:()=>{}};}

test('T-07 real SIGKILL at stage/journal/swap/readback/ledger boundaries recovers whole old or new',()=>{
  const trace:unknown[]=[];
  for(const boundary of ['staged','intent','old_renamed','new_renamed','readback','ledger_committed'] as Boundary[]){
    const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-crash-')));
    try{
      materializeOwned(op(root));
      const child=Bun.spawnSync({cmd:[process.execPath,'--preload','./tests/setup.ts','tests/helpers/p2-crash-worker.ts',root,boundary],cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',HOME:root,TMPDIR:root},stdout:'pipe',stderr:'pipe',timeout:10000});
      expect(child.exitCode).not.toBe(0);expect(child.signalCode).toBe('SIGKILL');
      recoverProjection(root,'fixture','runtime');
      const actual=hashTree(join(root,'skills/sample'));
      expect([canonical(map(old)),canonical(map(newer))]).toContain(canonical(actual));
      const newCommitted=canonical(actual)===canonical(map(newer));
      if(newCommitted)expect(()=>materializeOwned(op(root,old,1))).toThrow('fencing');
      materializeOwned(op(root,newer,2));expect(hashTree(join(root,'skills/sample'))).toEqual(map(newer));
      trace.push({boundary,signal:child.signalCode,after_recovery:newCommitted?'new':'old',hashes:actual,retry:'whole_new'});
    }finally{rmSync(root,{recursive:true,force:true});}
  }
  if(process.env.P2_EVIDENCE_DIR)writeFileSync(join(process.env.P2_EVIDENCE_DIR,'crash-boundaries.json'),JSON.stringify(trace,null,2)+'\n');
});
test('T-09 same-name adoption, preview drift, user neighbours and edited owned files are preserved',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-owned-')));
  try{
    mkdirSync(join(root,'skills/sample'),{recursive:true});writeFileSync(join(root,'skills/sample/SKILL.md'),'user owned');
    expect(()=>materializeOwned(op(root))).toThrow('user-owned');
    const preview=previewAdoption(root,'skills/sample');writeFileSync(join(root,'skills/sample/SKILL.md'),'user edited');
    const adopt={root,installation:'fixture',runtime:'runtime',target:'skills/sample',preview_digest:preview.preview_digest,skill_id:'skill',version_id:'legacy',operation_id:'adopt'};
    expect(()=>adoptOwned(adopt)).toThrow('preview changed');adopt.preview_digest=previewAdoption(root,'skills/sample').preview_digest;adoptOwned(adopt);
    materializeOwned(op(root));writeFileSync(join(root,'neighbour.txt'),'keep neighbour');writeFileSync(join(root,'skills/sample/user.txt'),'keep extra');
    expect(()=>materializeOwned(op(root,newer,2))).toThrow('changed');
    writeFileSync(join(root,'skills/sample/SKILL.md'),'edited managed instructions');
    const result=removeOwned(root,'fixture','runtime','skills/sample',()=>{});
    expect(result.retained).toEqual(['SKILL.md']);expect(readFileSync(join(root,'skills/sample/SKILL.md'),'utf8')).toBe('edited managed instructions');
    expect(readFileSync(join(root,'skills/sample/user.txt'),'utf8')).toBe('keep extra');expect(readFileSync(join(root,'neighbour.txt'),'utf8')).toBe('keep neighbour');
    expect(existsSync(join(root,'skills/sample/assets/data.txt'))).toBe(false);
    expect(()=>materializeOwned({...op(root),target:'../outside'})).toThrow();
    symlinkSync(join(root,'neighbour.txt'),join(root,'skills/link'));expect(()=>materializeOwned({...op(root),target:'skills/link'})).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
});
for(const kind of ['codex','claude_code'] as const)test(`T-06/T-35 ${kind} enrolled reporter installs exact frozen native files with safe launch argv`,()=>{
  const f=loopFixture(kind),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-runtime-')));
  try{
    const v=accepted(f);assigned(f,v);const s=opened(f);bindManagedRoot(f.database,f.auth,f.runtimeId,root);
    expect(materializeSession(f.database,f.reportAuth,s.id).state).toBe('projection_readback');
    expect(materializeSession(f.database,f.reportAuth,s.id).replayed).toBe(true);
    const launch=nativeLaunch(kind,join(root,'sessions',s.id),'Use native CSV skill',{auth_mode:'api-key',...QUALIFICATION_MODELS[kind]}, {CODEX_API_KEY:'fixture-api',ANTHROPIC_API_KEY:'fixture-api'});
    expect(launch.args.join(' ')).not.toMatch(/bypass|dangerous|approve-for-me|acceptEdits|allowedTools|fallback/);
    expect(launch.env.HOME).toBe(join(root,'sessions',s.id));
    expect(nativeExecution(kind,JSON.stringify({type:'result',result:'SUCCESS SKLN-RECEIPT fake'}),'any').observed).toBe(false);
    expect(f.database.query("SELECT count(*) n FROM runtime_observations WHERE kind='projection_readback'").get()).toEqual({n:1});
  }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('T-35 two entries, physical generation isolation, replace and actual rollback',()=>{
 const f=loopFixture(),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-generations-')));
 try{
  const first=accepted(f),other=accepted(f,'1',undefined,0,'second-skill'),a=assigned(f,first);assigned(f,other);
  const oldSession=opened(f);expect(oldSession.entries.length).toBe(2);bindManagedRoot(f.database,f.auth,f.runtimeId,root);
  materializeSession(f.database,f.reportAuth,oldSession.id);const oldTree=hashTree(join(root,'sessions',oldSession.id));
  const procedure=[...csvContent.procedure];csvContent.procedure.push('Sort categories for stable output.');
  let next:ReturnType<typeof accepted>;try{next=accepted(f,'2',first.draft_id,1);}finally{csvContent.procedure=procedure;}
  assigned(f,next!,a.data.assignment_id,1,'replace');const newSession=opened(f);materializeSession(f.database,f.reportAuth,newSession.id);
  expect(hashTree(join(root,'sessions',oldSession.id))).toEqual(oldTree);
  expect(hashTree(join(root,'sessions',newSession.id))).not.toEqual(oldTree);
  assigned(f,first,a.data.assignment_id,2,'rollback');const rollback=opened(f);materializeSession(f.database,f.reportAuth,rollback.id);
  expect(hashTree(join(root,'sessions',rollback.id))).toEqual(oldTree);
  const before=JSON.stringify(oldSession.entries);
  skillLifecycle(f.auth,{version_id:first.version.id,kind:'revoke',reason:'revoke pinned version',expected_revision:0,idempotency_key:'revoke-pin'},f.database);
  expect(sessionGet(f.reportAuth,{loadout_id:oldSession.id},f.database).entries.some(e=>e.current_authorization==='REVOKED')).toBe(true);
  expect(()=>materializeSession(f.database,f.reportAuth,oldSession.id)).toThrow('revoked');
  expect(JSON.stringify(oldSession.entries)).toBe(before);expect(hashTree(join(root,'sessions',oldSession.id))).toEqual(oldTree);
 }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('CSV contract survives compile/freeze/projection and requires exact per-file JSON shapes without dataset answers',()=>{
 const summarySchema={type:'object',required:['counts','totals','overall'],additionalProperties:false,properties:{
  counts:{type:'object',minProperties:1,additionalProperties:{type:'integer',minimum:1}},
  totals:{type:'object',minProperties:1,additionalProperties:{type:'number'}},overall:{type:'number'}}};
 const refusalSchema={type:'object',required:['status','reason'],additionalProperties:false,
  properties:{status:{const:'refused'},reason:{const:'invalid_amount'}}};
 for(const kind of ['codex','claude_code'] as const){
  const f=loopFixture(kind),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-csv-contract-')));
  try{
   const version=accepted(f);assigned(f,version);const session=opened(f);
   bindManagedRoot(f.database,f.auth,f.runtimeId,root);materializeSession(f.database,f.reportAuth,session.id);
   const directory=join(root,'sessions',session.id,kind==='codex'?'.agents':'.claude','skills','csv-summary');
   const markdown=readFileSync(join(directory,'SKILL.md'),'utf8');
   const schema=JSON.parse(markdown.split('## Outputs\n\n')[1]!.split('\n\n## Procedure')[0]!);
   expect(schema).toEqual({type:'object',required:['summary.json','refusal.json'],additionalProperties:false,
    properties:{'summary.json':summarySchema,'refusal.json':refusalSchema}});
   expect(JSON.parse(readFileSync(join(directory,'content.json'),'utf8')).outputs_schema).toEqual(schema);
   const frozen=JSON.parse(version.version.members_json);
   expect(markdown).toBe(Buffer.from(frozen['SKILL.md'],'base64').toString());
   expect(markdown).toContain('not a combined wrapper');
   expect(markdown).toContain('numeric sum of all amounts, not an object');
   expect(markdown).toContain('Do not add source, status, detail, categories or any other keys to summary.json');
   // A different synthetic dataset: answers are fixtures here, never embedded in the skill.
   const expected=csvExpected('category,amount\nNorth,1.25\nNorth,-0.25\nSouth,2.50\n');
   expect(expected).toEqual({counts:{North:2,South:1},totals:{North:1,South:2.5},overall:3.5});
   expect(markdown).not.toContain('North');expect(markdown).not.toContain('South');
   const cases={kind:'json-artifacts/1' as const,objective:'Synthetic schema regression',cases:[
    {name:'valid_summary',path:'summary.json',expected,absent:[]},
    {name:'invalid_refusal',path:'refusal.json',expected:{status:'refused',reason:'invalid_amount'},absent:['invalid-summary.json']}]};
   const good={'summary.json':JSON.stringify(expected),'refusal.json':'{"status":"refused","reason":"invalid_amount"}'};
   // The outside='none' input is a synthetic unit-test assertion, not a live OS audit.
   expect(evaluateArtifacts(cases,good,'none').status).toBe('succeeded');
   expect(evaluateArtifacts(cases,good,'unknown').status).toBe('unknown');
   const wrong={'summary.json':JSON.stringify({categories:[{category:'North',count:2,total:1},{category:'South',count:1,total:2.5}],overall:{count:3,total:3.5}}),
    'refusal.json':'{"status":"refused","reason":"invalid_amount","source":"invalid.csv","detail":{"line":2}}'};
   const rejected=evaluateArtifacts(cases,wrong,'none');expect(rejected.status).toBe('failed');
   expect(rejected.assertions.slice(0,2).map(a=>a.passed)).toEqual([false,false]);
   expect(evaluateArtifacts(cases,{...good,'summary.json':JSON.stringify({...expected,source:'input.csv'})},'none').assertions[0]!.passed).toBe(false);
   expect(evaluateArtifacts(cases,{...good,'invalid-summary.json':'{}'},'none').assertions[1]!.passed).toBe(false);
  }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
 }
});

for(const kind of ['codex','claude_code'] as const)test(`Native ${kind}: subscription env is explicit, isolated and never serialized`,()=>{
 const token=`opaque-fixture-subscription-${kind}`,source={PATH:'/fixture/bin',CODEX_ACCESS_TOKEN:token,CLAUDE_CODE_OAUTH_TOKEN:token,
  CODEX_API_KEY:'unselected-billing-fixture',OPENAI_API_KEY:'unselected-billing-fixture',ANTHROPIC_API_KEY:'unselected-billing-fixture',
  ANTHROPIC_AUTH_TOKEN:'unselected-proxy-fixture',ANTHROPIC_BASE_URL:'https://unselected.invalid',CODEX_HOME:'/real/profile',CLAUDE_CONFIG_DIR:'/real/profile',
  NODE_OPTIONS:'--require /unselected/hook',CLAUDE_CODE_EFFORT_LEVEL:'low',CLAUDE_CODE_SYNC_SKILLS:'1'};
 const launch=nativeLaunch(kind,'/disposable/session','Use reviewed CSV skill',{auth_mode:'subscription',...QUALIFICATION_MODELS[kind]},source,'/disposable/session/native-attempt');
 expect(launch.env.HOME).toBe('/disposable/session/native-attempt');
 expect(launch.env[kind==='codex'?'CODEX_ACCESS_TOKEN':'CLAUDE_CODE_OAUTH_TOKEN']).toBe(token);
 for(const key of ['CODEX_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','NODE_OPTIONS','CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_SYNC_SKILLS'])expect(launch.env[key]).toBeUndefined();
 expect(launch.env[kind==='codex'?'CLAUDE_CODE_OAUTH_TOKEN':'CODEX_ACCESS_TOKEN']).toBeUndefined();
 expect(JSON.stringify(launch)).not.toContain(token);expect(launch.args.join(' ')).not.toContain(token);
 expect(launch.redact(`stdout ${token}\nstderr ${token}`)).not.toContain(token);
 expect(launch.redact(`stdout ${token}`)).toContain('[NATIVE_AUTH_REDACTED]');
 expect(launch.args[launch.args.indexOf('--model')+1]).toBe(QUALIFICATION_MODELS[kind].model);
 expect(launch.args.join(' ')).not.toMatch(/bypass|approve-for-me|acceptEdits|allowedTools|fallback|\/real\/profile/);
 if(kind==='claude_code'){
  expect(launch.args).not.toContain('--bare');expect(launch.args).not.toContain('--safe-mode');
  expect(launch.args[launch.args.indexOf('--setting-sources')+1]).toBe('project');
  expect(launch.args[launch.args.indexOf('--effort')+1]).toBe('high');
  expect(launch.args).toContain('--strict-mcp-config');expect(launch.args).toContain('--no-session-persistence');
  expect(launch.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
 }else{
  expect(launch.args).toContain('forced_login_method="chatgpt"');expect(launch.args).toContain('model_reasoning_effort="high"');
  expect(launch.args).toContain('--ignore-user-config');expect(launch.args).toContain('--ephemeral');
 }
});

test('CSV direct-write clarification is outer-Codex-only and bound to the immutable objective (no native task)',()=>{
 const slot='csv-summary',attempt='instruction-fixture';
 const original={objective:'Validate and summarize CSV; refuse invalid input; write only inside the managed task directory',
  prompt:`Use the ${slot} native skill. Read its SKILL.md through native discovery. In task-${attempt}, summarize input.csv into summary.json. Then validate invalid.csv and record refusal.json; do not create invalid-summary.json. Write only in task-${attempt}. Do not use other agents, subagents, network, external services or credentials. Follow the native permission policy; if permission is denied, report that refusal.`};
 for(const kind of ['codex','claude_code'] as const){
  const store={auth_mode:'subscription-store',login_store:'/synthetic/store',login_backend:kind==='codex'?'file':'config-dir'};
  for(const choice of [{auth_mode:'api-key'},{auth_mode:'subscription'},store,
   ...(kind==='codex'?[{...store,configured_profile_functional:true}]:[{...store,task_write_directory:'/synthetic/task'}])])
   expect(csvTaskInstructions(kind,nativeOptions(kind,{...QUALIFICATION_MODELS[kind],...choice}),slot,attempt)).toEqual(original);
 }
 const native=nativeOptions('codex',{auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:'/synthetic/store',login_backend:'file',configured_profile_functional:true,
  outer_seatbelt:{mode:'macos-seatbelt-only-bookkeeping/1',outer_root:'/synthetic/outer',profile_digest:digest('synthetic profile'),installation_id:'/synthetic/store/installation_id',arg0:'/synthetic/store/tmp/arg0'}});
 const scoped=csvTaskInstructions('codex',native,slot,attempt),clarification=scoped.prompt.slice(original.prompt.length);
 expect(scoped.prompt.startsWith(original.prompt)).toBe(true);expect(scoped.objective).toBe(original.objective+clarification);
 for(const instruction of ['directly inside the assigned task directory','do not use shell heredocs or temporary files outside that directory',
  'recover only with an allowed direct-write method inside that same task directory','never bypass the sandbox or change permissions',
  'summary.json and refusal.json exist and both parse as JSON','report failure honestly'])expect(clarification).toContain(instruction);
 expect(clarification).not.toMatch(/counts|totals|overall|category,amount/);
 const readCommand=`cat .agents/skills/${slot}/SKILL.md`,wrapped=`/bin/zsh -lc '${readCommand}'`;
 expect(clarification).toContain(`command exactly \`${readCommand}\``);
 expect(clarification).toContain(`\`${wrapped}\``);
 for(const instruction of ['separate tool call','full untruncated output','no grouping, discovery or CSV commands in that call',
  'single-quoted shell payload','not a double-quoted payload','Do not add your own shell wrapper'])expect(clarification).toContain(instruction);
 const frozen={session_root:'/disposable/session',content:'Frozen isolated-read fixture\n'},skillPath=`${frozen.session_root}/.agents/skills/${slot}/SKILL.md`;
 const readEvent=(command:string,output=frozen.content)=>[{type:'thread.started',thread_id:'synthetic-isolated-read'},
  {type:'item.completed',item:{type:'command_execution',command,aggregated_output:output,exit_code:0}}].map(e=>JSON.stringify(e)).join('\n');
 for(const command of [readCommand,wrapped])expect(nativeExecution('codex',readEvent(command),skillPath,frozen).observed).toBe(true);
 for(const command of [`${readCommand}; pwd; cat input.csv`,`/bin/zsh -lc "${readCommand}"`])
  expect(nativeExecution('codex',readEvent(command),skillPath,frozen).observed).toBe(false);
 expect(nativeExecution('codex',readEvent(readCommand,frozen.content.slice(0,-1)),skillPath,frozen).observed).toBe(false);
 const f=loopFixture('codex'),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-prompt-objective-')));
 try{
  assigned(f,accepted(f));const s=opened(f);bindManagedRoot(f.database,f.auth,f.runtimeId,root);materializeSession(f.database,f.reportAuth,s.id);
  const entry=s.entries[0]!,args={loadout_id:s.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest,attempt_id:attempt,
   evaluator:{kind:'json-artifacts/1',objective:scoped.objective,native,cases:[{name:'synthetic_only',path:'fixture.json',expected:{synthetic:true}}]},
   environment_digest:digest('synthetic instruction binding'),expected_revision:0,idempotency_key:randomUUID()};
  // Authorization/immutable replay only: no CLI, task outputs or execution observation.
  const run=authorizeRun(f.reportAuth,args,f.database).data;
  expect(f.database.query('SELECT objective FROM skill_runs WHERE id=?').get(run.run_id)).toEqual({objective:scoped.objective});
  expect(()=>authorizeRun(f.reportAuth,{...args,idempotency_key:randomUUID(),evaluator:{...args.evaluator,objective:original.objective}},f.database)).toThrow('another evaluator/environment');
 }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('Native trace redaction preserves outer JSON and every nested JSONL event (synthetic, no CLI)',()=>{
 const token='opaque-synthetic-trace-auth',detected='ghp_SYNTHETIC0123456789abcdefghijkl';
 const launch=nativeLaunch('codex','/tmp/harmless-session','synthetic prompt',
  {auth_mode:'subscription',...QUALIFICATION_MODELS.codex},{CODEX_ACCESS_TOKEN:token});
 const events=[
  {type:'thread.started',thread_id:'synthetic-thread'},
  {type:'item.started',item:{type:'command_execution',command:'cat "/tmp/harmless-demo" "C:\\harmless-owner\\private-leaf"'}},
  {type:'item.completed',item:{type:'command_execution',exit_code:0,
   aggregated_output:JSON.stringify({path:'/home/harmless-owner/deep-leaf',auth:token,detected})}},
  {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}},
 ];
 const stdout=events.map(event=>JSON.stringify(event)).join('\n')+'\n';
 const original={stdout,stderr:'warning: "/private/tmp/harmless-warning"',exit_code:0,overflow:false,
  native:launch.options,model_evidence:{source:'codex_exec',models:[],complete:false},model_status:'unknown'};
 // Exactly the adapter's serialize -> launch.redact path; no trace files are read/repaired.
 const clean=launch.redact(canonical(original));
 expect(clean).not.toMatch(/harmless|private-leaf|deep-leaf/);
 expect(clean).not.toContain(token);expect(clean).not.toContain(detected);
 const outer=JSON.parse(clean);
 expect(Object.keys(outer).sort()).toEqual(Object.keys(original).sort());
 expect(outer.exit_code).toBe(0);expect(outer.model_status).toBe('unknown');
 expect(outer.stderr).toBe('warning: "[LOCAL_PATH]"');
 const lines=outer.stdout.split('\n');expect(lines.pop()).toBe('');expect(lines).toHaveLength(events.length);
 const parsed=lines.map((line:string)=>JSON.parse(line));
 expect(parsed.map((event:{type:string})=>event.type)).toEqual(events.map(event=>event.type));
 expect(parsed.map((event:{item?:{type:string}})=>event.item?.type)).toEqual(events.map(event=>event.item?.type));
 expect(parsed[1].item.command).toBe('cat "[LOCAL_PATH]" "[LOCAL_PATH]"');
 expect(JSON.parse(parsed[2].item.aggregated_output)).toEqual({path:'[LOCAL_PATH]',auth:'[NATIVE_AUTH_REDACTED]',detected:'[REDACTED:github-pat]'});
});

test('Claude positional prompt is separated from variadic tools across auth modes',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-prompt-boundary-')));
 try{
  const choices=[{auth_mode:'subscription'},{auth_mode:'api-key'},
   {auth_mode:'subscription-store',login_backend:'config-dir',login_store:root},
   ...(process.platform==='darwin'?[{auth_mode:'subscription-store',login_backend:'default-keychain'}]:[])];
  const prompt='--literal prompt text\nUse the native CSV skill.';
  for(const choice of choices){
   const launch=nativeLaunch('claude_code',root,prompt,{...choice,...QUALIFICATION_MODELS.claude_code},
    {CLAUDE_CODE_OAUTH_TOKEN:'synthetic-oauth',ANTHROPIC_API_KEY:'synthetic-api'});
   const tools=launch.args.indexOf('--tools');
   expect(tools).toBeGreaterThan(-1);
   expect(launch.args.slice(tools+1)).toEqual(['Read,Write,Edit,Bash,Skill','--',prompt]);
   expect(launch.args.filter(arg=>arg==='--')).toHaveLength(1);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Claude task-write opt-in scopes only the exact attempt; defaults, skill discovery and prompt boundary stay intact',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-write-scope-')));
 try{
  const choices=[{auth_mode:'subscription'},{auth_mode:'api-key'},
   {auth_mode:'subscription-store',login_backend:'config-dir',login_store:root},
   ...(process.platform==='darwin'?[{auth_mode:'subscription-store',login_backend:'default-keychain'}]:[])];
  const source={CLAUDE_CODE_OAUTH_TOKEN:'synthetic-oauth',ANTHROPIC_API_KEY:'synthetic-api'};
  const tasks=[join(root,`task-${randomUUID()}`),join(root,`task-${randomUUID()}`)];
  mkdirSync(tasks[1]!); // Also validate an already-created canonical task directory.
  for(const choice of choices){
   const base=nativeLaunch('claude_code',root,'Use native CSV skill',{...choice,...QUALIFICATION_MODELS.claude_code},source);
   const settings=JSON.parse(base.args[base.args.indexOf('--settings')+1]!);
   expect(settings.permissions).toBeUndefined();expect(base.args).not.toContain('--permission-mode');
   expect(settings.disableBundledSkills).toBe(true);expect(base.env.DISABLE_DOCTOR_COMMAND).toBe('1');
   expect(base.args[base.args.indexOf('--setting-sources')+1]).toBe('project');
   for(const path of tasks){
    const launch=nativeLaunch('claude_code',root,'Use native CSV skill',{...choice,...QUALIFICATION_MODELS.claude_code,task_write_directory:path},source);
    const configured=JSON.parse(launch.args[launch.args.indexOf('--settings')+1]!);
    expect(configured.permissions).toEqual({defaultMode:'default',allow:[`Edit(/${path}/**)`]});
    const {permissions,...rest}=configured;expect(rest).toEqual(settings);
    expect(permissions.allow[0]).not.toContain(tasks.find(p=>p!==path)!);
    expect(permissions.allow).not.toContain(`Edit(/${root}/**)`);
    expect(launch.options.task_write_directory).toBe(path);
    expect(launch.args.slice(-2)).toEqual(['--','Use native CSV skill']);
    expect(launch.env).toEqual(base.env);
    expect(launch.args.join(' ')).not.toMatch(/acceptEdits|bypassPermissions|allowedTools|additionalDirectories|safe-mode|disable-slash-commands/);
   }
  }
  const options={auth_mode:'subscription',...QUALIFICATION_MODELS.claude_code};
  for(const path of [root,root+'-sibling/'+tasks[0]!.split('/').pop(),join(root,'task-*'),tasks[0]+'/../'+tasks[1]!.split('/').pop(),join(root,'nested',tasks[0]!.split('/').pop()!)])
   expect(()=>nativeLaunch('claude_code',root,'prompt',{...options,task_write_directory:path},source)).toThrow();
  symlinkSync(root,tasks[0]!);
  expect(()=>nativeLaunch('claude_code',root,'prompt',{...options,task_write_directory:tasks[0]},source)).toThrow('canonical directory');
  const alias=join(root,'alias');symlinkSync(root,alias);
  expect(()=>nativeLaunch('claude_code',alias,'prompt',{...options,task_write_directory:join(alias,`task-${randomUUID()}`)},source)).toThrow('canonical generated');
  expect(()=>nativeLaunch('codex',root,'prompt',{auth_mode:'subscription',...QUALIFICATION_MODELS.codex,task_write_directory:tasks[1]},{CODEX_ACCESS_TOKEN:'synthetic-oauth'})).not.toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Authorized Codex task-write prepares only the exact generated task cwd with restrictive workspace-write policy',()=>{
 const f=loopFixture('codex'),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-codex-write-')));
 try{
  const version=accepted(f);assigned(f,version);const s=opened(f);
  bindManagedRoot(f.database,f.auth,f.runtimeId,root);
  const prepared=prepareCsvTask(f.database,f.reportAuth,{loadout_id:s.id,entry_id:s.entries[0]!.id,csv:'category,amount\nA,1\n',
   auth_mode:'api-key',...QUALIFICATION_MODELS.codex,allow_task_writes:true},{CODEX_API_KEY:'synthetic-api'});
  expect(prepared.launch.cwd).toBe(prepared.taskDir);expect(prepared.launch.cwd).not.toBe(prepared.sessionRoot);
  for(const value of ['workspace-write','sandbox_workspace_write.network_access=false','sandbox_workspace_write.exclude_slash_tmp=true',
   'sandbox_workspace_write.exclude_tmpdir_env_var=true','sandbox_workspace_write.writable_roots=[]'])expect(prepared.launch.args).toContain(value);
  expect(prepared.launch.args.slice(0,-1).join(' ')).not.toContain(prepared.sessionRoot);
  expect(prepared.evaluator.objective).toContain(`cat ${join(prepared.sessionRoot,'.agents/skills/csv-summary/SKILL.md')}`);
  expect(prepared.options.task_write_directory).toBe(prepared.taskDir);
 }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('Codex task-write refuses the broad outer Seatbelt path instead of nesting or widening it',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-codex-outer-write-'))),task=join(root,`task-${randomUUID()}`),store=join(root,'store');mkdirSync(store);
 try{
  const options={auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:store,login_backend:'file' as const,configured_profile_functional:true as const,
   task_write_directory:task,outer_seatbelt:{mode:'macos-seatbelt-only-bookkeeping/1' as const,outer_root:root,profile_digest:digest('synthetic'),installation_id:join(store,'installation_id'),arg0:join(store,'tmp/arg0')}};
  expect(()=>nativeLaunch('codex',root,'prompt',options,{PATH:'/synthetic'})).toThrow('cannot safely combine');
 }finally{rmSync(root,{recursive:true,force:true});}
});

for(const kind of ['codex','claude_code'] as const)test(`${kind} task-write opt-in needs the current exact reviewed managed-write capability before any native probe`,async()=>{
 const f=loopFixture(kind),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-write-consent-')));
 const capabilities=csvContent.requested_capabilities;
 try{
  csvContent.requested_capabilities=['file_read'];let version:ReturnType<typeof accepted>;
  try{version=accepted(f);}finally{csvContent.requested_capabilities=capabilities;}
  assigned(f,version!);const s=opened(f);bindManagedRoot(f.database,f.auth,f.runtimeId,root);materializeSession(f.database,f.reportAuth,s.id);
  const before=hashTree(root);
  await expect(runCsvTask(f.database,f.reportAuth,{loadout_id:s.id,entry_id:s.entries[0]!.id,csv:'category,amount\nA,1\n',auth_mode:'subscription',...QUALIFICATION_MODELS[kind],allow_task_writes:true},{})).rejects.toThrow('reviewed file_write_managed');
  expect(hashTree(root)).toEqual(before);expect(f.database.query('SELECT count(*) n FROM skill_runs').get()).toEqual({n:0});
 }finally{csvContent.requested_capabilities=capabilities;f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('Native auth modes fail closed; billing compatibility requires explicit API mode',()=>{
 for(const kind of ['codex','claude_code'] as const){
  const choice=QUALIFICATION_MODELS[kind];
  expect(()=>nativeLaunch(kind,'/fixture','prompt',undefined,{})).toThrow('Explicit auth_mode');
  expect(()=>nativeLaunch(kind,'/fixture','prompt',{auth_mode:'automatic',...choice},{})).toThrow('Explicit auth_mode');
  expect(()=>nativeLaunch(kind,'/fixture','prompt',{auth_mode:'subscription',...choice},{OPENAI_API_KEY:'billing',ANTHROPIC_API_KEY:'billing'})).toThrow('no login-store reuse or billing fallback');
  expect(()=>nativeLaunch(kind,'/fixture','prompt',{auth_mode:'api-key',...choice},{CODEX_ACCESS_TOKEN:'oauth',CLAUDE_CODE_OAUTH_TOKEN:'oauth'})).toThrow('unavailable');
  expect(()=>nativeLaunch(kind,'/fixture','prompt',{auth_mode:'subscription',...choice},{CODEX_ACCESS_TOKEN:'\n',CLAUDE_CODE_OAUTH_TOKEN:'\n'})).toThrow('unavailable');
  const launch=nativeLaunch(kind,'/fixture','prompt',{auth_mode:'api-key',...choice},{OPENAI_API_KEY:'explicit-billing-fixture',ANTHROPIC_API_KEY:'explicit-billing-fixture',CODEX_ACCESS_TOKEN:'unused-oauth',CLAUDE_CODE_OAUTH_TOKEN:'unused-oauth'});
  expect(launch.env[kind==='codex'?'CODEX_API_KEY':'ANTHROPIC_API_KEY']).toBe('explicit-billing-fixture');
  expect(launch.env.CODEX_ACCESS_TOKEN).toBeUndefined();expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
 }
});

test('Explicit native stores retain project discovery without reading credentials or inheriting billing/customizations',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-store-fixture-'))),selected=join(root,'selected'),home=join(root,'disposable');mkdirSync(selected);
 try{
  // Synthetic content only. No official CLI is invoked by these launch checks.
  writeFileSync(join(selected,'auth.json'),'synthetic-unread-credential');
  writeFileSync(join(selected,'config.toml'),'unrelated profile config');
  const before=hashTree(selected);
  const source=new Proxy({PATH:'/nonexistent-p2-fixture'} as NodeJS.ProcessEnv,{get(target,key){if(key==='PATH')return target.PATH;throw new Error('Ambient auth/profile was accessed');}});
  for(const backend of ['file','keyring'] as const){
   const launch=nativeLaunch('codex',root,'Use native CSV skill',{auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:backend},source,home);
   expect(launch.env.CODEX_HOME).toBe(selected);expect(launch.env.HOME).toBe(home);
   expect(launch.args).toContain('--ignore-user-config');expect(launch.args).toContain('--ignore-rules');
   for(const flag of ['skills.include_instructions=true','skills.bundled.enabled=false','features.plugins=false','features.hooks=false','features.apps=false','features.multi_agent=false','project_doc_max_bytes=0',`cli_auth_credentials_store="${backend}"`])expect(launch.args).toContain(flag);
   expect(launch.args).toContain('forced_login_method="chatgpt"');
   expect(JSON.stringify(launch)).not.toContain('synthetic-unread-credential');
   expect(()=>preflightNativeSubscription('codex',launch)).toThrow('config.toml');
   expect(nativeModelStatus(launch.options.model,nativeModelEvidence('codex',''))).toBe('unknown');
  }
  expect(hashTree(selected)).toEqual(before);
  const codex=nativeLaunch('codex',root,'prompt',{auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:'file'},source,home);
  writeFileSync(join(selected,'config.toml'),'[projects."/fixture/generated-task"]\ntrust_level = "trusted"\n');
  expect(()=>preflightNativeSubscription('codex',codex)).toThrow('executable is unavailable');
  writeFileSync(join(selected,'config.toml'),'[projects."/fixture/generated-task"]\ntrust_level = "trusted"\n[profiles.unexpected]\nmodel_provider = "fixture"\n');
  expect(()=>preflightNativeSubscription('codex',codex)).toThrow('config.toml');
  // A dangling link also blocks discovery: existsSync alone would miss it.
  symlinkSync(join(root,'absent'),join(selected,'skills'));
  expect(()=>nativeLaunch('codex',root,'prompt',{auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:'file'},source,home)).toThrow('skills directory');
  rmSync(join(selected,'skills'));
  mkdirSync(join(selected,'skills'));writeFileSync(join(selected,'skills','unrelated.md'),'must not load');
  writeFileSync(join(selected,'settings.json'),'{"hooks":{"fixture":"must not execute"},"enabledPlugins":{"fixture":true}}');
  const claudeBefore=hashTree(selected);
  const launch=nativeLaunch('claude_code',root,'Use native CSV skill',{auth_mode:'subscription-store',...QUALIFICATION_MODELS.claude_code,login_store:selected,login_backend:'config-dir'},source,home);
  expect(launch.env.CLAUDE_CONFIG_DIR).toBe(selected);expect(launch.env.HOME).toBe(home);
  expect(launch.args[launch.args.indexOf('--setting-sources')+1]).toBe('project');
  expect(launch.args).toContain('--strict-mcp-config');expect(launch.args).toContain('{"mcpServers":{}}');
  expect(JSON.parse(launch.args[launch.args.indexOf('--settings')+1]!)).toEqual({disableAllHooks:true,autoMemoryEnabled:false,disableClaudeAiConnectors:true,forceLoginMethod:'claudeai',disableBundledSkills:true});
  expect(launch.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');expect(launch.env.DISABLE_DOCTOR_COMMAND).toBe('1');
  for(const flag of ['--safe-mode','--bare','--disable-slash-commands','--dangerously-skip-permissions','--fallback-model'])expect(launch.args).not.toContain(flag);
  expect(hashTree(selected)).toEqual(claudeBefore);
  if(process.platform==='darwin'){
   const keychain=nativeLaunch('claude_code',root,'prompt',{auth_mode:'subscription-store',...QUALIFICATION_MODELS.claude_code,login_backend:'default-keychain'},source,home);
   expect(keychain.env.HOME).toBe(home);expect(keychain.env.CLAUDE_CONFIG_DIR).toBeUndefined();
   expect(keychain.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Store selection fails closed on missing, ambiguous and linked contexts; unavailable CLI cannot start a task',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-store-unavailable-')));
 try{
  const base={auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex},source={PATH:'/nonexistent-p2-fixture'};
  for(const extra of [{},{login_store:root},{login_store:root,login_backend:'auto'},{login_store:root,login_backend:'config-dir'},{login_store:'/fixture\n',login_backend:'file'},{login_store:'/fixture\u007f',login_backend:'file'}])
   expect(()=>nativeLaunch('codex',root,'prompt',{...base,...extra},source)).toThrow();
  expect(()=>nativeLaunch('codex',root,'prompt',{...base,login_store:join(root,'missing'),login_backend:'file'},source)).toThrow('unavailable');
  symlinkSync(root,join(root,'link'));
  expect(()=>nativeLaunch('codex',root,'prompt',{...base,login_store:join(root,'link'),login_backend:'file'},source)).toThrow('symlink');
  expect(()=>nativeLaunch('codex',root,'prompt',{...base,auth_mode:'api-key',login_store:root,login_backend:'file'},source)).toThrow('requires subscription-store');
  const launch=nativeLaunch('codex',root,'prompt',{...base,login_store:root,login_backend:'file'},source);
  expect(()=>preflightNativeSubscription('codex',launch)).toThrow('executable is unavailable');
  expect(readdirSync(root)).toEqual(['link']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Auth status whitelists subscription metadata without returning account details or treating API-managed keys as OAuth',()=>{
 expect(nativeSubscriptionStatus('codex',0,'','Logged in using ChatGPT\n')).toBe(true);
 for(const output of ['Logged in using an API key - fixture','Logged in using access token','Logged in using ChatGPT\nextra','Not logged in'])expect(nativeSubscriptionStatus('codex',0,output,'')).toBe(false);
 expect(nativeSubscriptionStatus('codex',1,'Logged in using ChatGPT','')).toBe(false);
 const ok={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'synthetic@example.invalid',orgId:'synthetic-org'};
 const check=(value:unknown,code=0)=>nativeSubscriptionStatus('claude_code',code,JSON.stringify(value),'');
 expect(check(ok)).toBe(true);
 for(const change of [{loggedIn:false},{authMethod:'api_key'},{apiKeySource:'claude.ai'},{apiKeySource:'ANTHROPIC_API_KEY'},{apiProvider:'bedrock'},{subscriptionType:null},{subscriptionType:'unknown'}])expect(check({...ok,...change})).toBe(false);
 expect(check(ok,1)).toBe(false);expect(check(null)).toBe(false);
 expect(nativeSubscriptionStatus('claude_code',0,'invalid json','')).toBe(false);
 expect(JSON.stringify(check(ok))).toBe('true');
});

test('Store qualifier prepares exact models with synthetic stores and zero native calls; preflight never guesses unavailable auth',()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-store-qualifier-'))),selected=join(parent,'selected');mkdirSync(selected);
 writeFileSync(join(selected,'auth.json'),'synthetic-never-read');
 try{
  const before=hashTree(selected);
  for(const preflight of [false,true]){
   const root=join(parent,preflight?'preflight':'prepare');mkdirSync(root);
   const p=Bun.spawnSync({cmd:[process.execPath,'scripts/p2-qualify-native.ts','--root',root,'--runtime','both','--auth-mode','subscription-store',
    '--codex-model','gpt-6-astra','--codex-effort','high','--codex-login-backend','file','--codex-login-store',selected,
    '--claude-model','claude-opus-5','--claude-effort','high','--claude-login-backend','config-dir','--claude-login-store',selected,
    ...(preflight?['--preflight-native-auth']:[])],env:{PATH:'/nonexistent-p2-fixture',HOME:root,TMPDIR:root,NODE_ENV:'test'},stdout:'pipe',stderr:'pipe',timeout:15000});
   expect(p.exitCode).toBe(2);expect(p.stdout.toString()+p.stderr.toString()).not.toContain('synthetic-never-read');
   const directory=readdirSync(root).find(n=>n.startsWith('qoopia-p2-qualification-'))!;
   const records=JSON.parse(readFileSync(join(root,directory,'results.json'),'utf8'));
   expect(records).toHaveLength(2);
   for(const record of records){
    expect(record.runs).toEqual([]);expect(record.status).toBe(preflight?'BLOCKED':'NOT RUN');
    expect(record.native.model).toBe(QUALIFICATION_MODELS[record.runtime as keyof typeof QUALIFICATION_MODELS].model);
    expect(record.native.auth_mode).toBe('subscription-store');expect(record.native.effort).toBe('high');
    expect(record.auth_preflight).toBeUndefined();
   }
  }
  expect(hashTree(selected)).toEqual(before);
 }finally{rmSync(parent,{recursive:true,force:true});}
});

test('Native preparation bounds project discovery and refuses customization/drift without overwriting it',()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-isolation-'))),root=join(parent,'session');mkdirSync(root);
 try{
  writeFileSync(join(parent,'CLAUDE.md'),'unrelated ancestor');
  expect(()=>prepareNativeSession(root,join(root,'native-first'))).toThrow('Ancestor native customization');
  expect(readFileSync(join(parent,'CLAUDE.md'),'utf8')).toBe('unrelated ancestor');rmSync(join(parent,'CLAUDE.md'));
  mkdirSync(join(root,'.claude/rules'),{recursive:true});writeFileSync(join(root,'.claude/rules/private.md'),'unrelated rule');
  expect(()=>prepareNativeSession(root,join(root,'native-first'))).toThrow('unrelated native configuration');
  expect(readFileSync(join(root,'.claude/rules/private.md'),'utf8')).toBe('unrelated rule');rmSync(join(root,'.claude'),{recursive:true});
  prepareNativeSession(root,join(root,'native-first'));
  const git=Bun.spawnSync({cmd:['git','-C',root,'rev-parse','--show-toplevel'],env:{PATH:process.env.PATH,HOME:join(root,'native-first'),GIT_CONFIG_NOSYSTEM:'1'},stdout:'pipe',stderr:'pipe'});
  expect(git.exitCode).toBe(0);expect(realpathSync(git.stdout.toString().trim())).toBe(root);
  expect(()=>prepareNativeSession(root,join(root,'native-first'))).toThrow('new directory');
  writeFileSync(join(root,'.git/config'),'changed config');
  expect(()=>prepareNativeSession(root,join(root,'native-second'))).toThrow('boundary changed');
  expect(readFileSync(join(root,'.git/config'),'utf8')).toBe('changed config');
 }finally{rmSync(parent,{recursive:true,force:true});}
});

test('Missing subscription auth creates no run, task or credential store and never probes a CLI',async()=>{
 const f=loopFixture(),root=realpathSync(mkdtempSync(join(tmpdir(),'p2-no-auth-')));
 try{
  assigned(f,accepted(f));const s=opened(f);bindManagedRoot(f.database,f.auth,f.runtimeId,root);materializeSession(f.database,f.reportAuth,s.id);
  const before=hashTree(root);
  await expect(runCsvTask(f.database,f.reportAuth,{loadout_id:s.id,entry_id:s.entries[0]!.id,csv:'category,amount\nA,1\n',auth_mode:'subscription',...QUALIFICATION_MODELS.codex},{})).rejects.toThrow('authentication unavailable');
  expect(hashTree(root)).toEqual(before);expect(f.database.query('SELECT count(*) n FROM skill_runs').get()).toEqual({n:0});
 }finally{f.database.close();rmSync(root,{recursive:true,force:true});}
});

test('Native observed model uses response events: init, flags, self-report, wrong/mixed model and incomplete streams cannot pass',()=>{
 const model='claude-opus-5';
 const init={type:'system',subtype:'init',session_id:'s',model};
 const assistant={type:'assistant',session_id:'s',parent_tool_use_id:null,message:{id:'msg',type:'message',role:'assistant',model,content:[{type:'text',text:'synthetic response fixture'}]}};
 const result={type:'result',session_id:'s',subtype:'success',is_error:false,modelUsage:{[model]:{outputTokens:2}}};
 const proof=(events:unknown[])=>nativeModelEvidence('claude_code',events.map(e=>JSON.stringify(e)).join('\n'));
 expect(nativeModelStatus(model,proof([init,assistant,result]))).toBe('verified');
 expect(nativeModelStatus(model,proof([init,result]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,assistant]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,{...assistant,message:{...assistant.message,model:'claude-other'}},result]))).toBe('mismatch');
 expect(nativeModelStatus(model,proof([init,assistant,{...result,modelUsage:{'claude-other':{outputTokens:1}}}]))).toBe('mismatch');
 expect(nativeModelStatus(model,proof([init,{...assistant,session_id:'other'},result]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,{...assistant,parent_tool_use_id:'subagent'},result]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,assistant,null,result]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,result,assistant]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,assistant,result,assistant]))).toBe('unknown');
 expect(nativeModelStatus(model,proof([init,assistant,{...result,modelUsage:'invalid'}]))).not.toBe('verified');
 const codex=nativeModelEvidence('codex',JSON.stringify({type:'thread.started',thread_id:'s',model:'gpt-6-astra'})+'\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'I used gpt-6-astra high'}}));
 expect(nativeModelStatus('gpt-6-astra',codex)).toBe('unknown');expect(codex.models).toEqual([]);
 expect(nativeModelStatus('gpt-6-astra',{source:'claude_response',models:['gpt-6-astra'],complete:true})).toBe('unknown');
});

test('Qualification CLI keeps distinct models and NOT RUN with missing auth or without execution consent; never starts native binaries',()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-qualifier-test-')));
 const flags=['--runtime','both','--auth-mode','subscription','--codex-model','gpt-6-astra','--codex-effort','high','--claude-model','claude-opus-5','--claude-effort','high','--allow-claude-task-writes'];
 try{
  for(const execute of [false,true]){
   const root=join(parent,execute?'missing-auth':'prepare-only');mkdirSync(root);
   const token='synthetic-qualification-oauth';
   // Deliberately no native binary on PATH, real credentials, profile or network.
   const env={PATH:'/nonexistent-p2-fixture',HOME:root,TMPDIR:root,NODE_ENV:'test',OPENAI_API_KEY:'synthetic-unselected-api',ANTHROPIC_API_KEY:'synthetic-unselected-api',
    ...(!execute?{CODEX_ACCESS_TOKEN:token,CLAUDE_CODE_OAUTH_TOKEN:token}:{})};
   const p=Bun.spawnSync({cmd:[process.execPath,'scripts/p2-qualify-native.ts','--root',root,...flags,...(execute?['--execute-real-native']:[])],env,stdout:'pipe',stderr:'pipe',timeout:15000});
   expect(p.exitCode).toBe(2);expect(p.stdout.toString()+p.stderr.toString()).not.toContain(token);
   const directory=readdirSync(root).find(n=>n.startsWith('qoopia-p2-qualification-'))!;
   const records=JSON.parse(readFileSync(join(root,directory,'results.json'),'utf8'));
   expect(records).toHaveLength(2);
   for(const r of records){
    expect(r.status).toBe('NOT RUN');expect(r.runs).toEqual([]);
    expect(r.native).toEqual({auth_mode:'subscription',...QUALIFICATION_MODELS[r.runtime as keyof typeof QUALIFICATION_MODELS]});
    expect(r.task_write_opt_in).toBe(r.runtime==='claude_code'?true:undefined);
    if(execute)expect(r.code).toBe('UNAUTHENTICATED');else expect(r.reason).toContain('No --execute-real-native');
   }
   for(const path of Object.keys(hashTree(join(root,directory))))expect(path).not.toMatch(/auth\.json|\.credentials|runtime-redacted|task-|native-/);
  }
 }finally{rmSync(parent,{recursive:true,force:true});}
});


test('Configured-profile Codex is explicit, permits existing skills without credential reads and retains strict defaults',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-configured-'))),selected=join(root,'selected'),home=join(root,'native');mkdirSync(selected);
 try{
  mkdirSync(join(selected,'skills'));
  // Deliberately unreadable/nonexistent synthetic targets: launch may inspect only directory metadata.
  symlinkSync(join(root,'no-credential'),join(selected,'auth.json'));
  symlinkSync(join(root,'no-config'),join(selected,'config.toml'));
  const source=new Proxy({PATH:'/nonexistent-p2-fixture'} as NodeJS.ProcessEnv,{get(target,key){if(key==='PATH')return target.PATH;throw new Error('Credential environment read');}});
  const native={auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:'file'};
  expect(()=>nativeLaunch('codex',root,'prompt',native,source,home)).toThrow('skills directory');
  expect(()=>nativeLaunch('codex',root,'prompt',{...native,configured_profile_functional:false},source,home)).toThrow('Explicit auth_mode');
  const launch=nativeLaunch('codex',root,'prompt',{...native,configured_profile_functional:true},source,home);
  expect(launch.options.configured_profile_functional).toBe(true);expect(launch.env.CODEX_HOME).toBe(selected);expect(launch.env.HOME).toBe(home);
  for(const flag of ['--ignore-user-config','--ignore-rules','--ephemeral','skills.include_instructions=true','skills.bundled.enabled=false',
   'features.plugins=false','features.apps=false','features.multi_agent=false','features.hooks=false','features.memories=false','project_doc_max_bytes=0',
   'forced_login_method="chatgpt"','cli_auth_credentials_store="file"','features.shell_snapshot=false','features.shell_snapshot_v2=false',
   `log_dir=${JSON.stringify(join(home,'logs'))}`,`sqlite_home=${JSON.stringify(join(home,'sqlite'))}`])expect(launch.args).toContain(flag);
  expect(launch.args.join(' ')).not.toMatch(/bypass|dangerously|full-auto|--sandbox|mcp_servers|skills.include_instructions=false/);
  expect(launch.env.XDG_CACHE_HOME).toBe(join(home,'xdg-cache'));
  symlinkSync(join(root,'no-dotenv'),join(selected,'.env'));
  expect(()=>nativeLaunch('codex',root,'prompt',{...native,configured_profile_functional:true},source,home)).toThrow('startup cannot ignore');
  rmSync(join(selected,'.env'));
  expect(()=>preflightNativeSubscription('codex',launch)).toThrow('status cannot ignore user config');
  for(const change of [{auth_mode:'api-key'},{auth_mode:'subscription'},{login_backend:'keyring'}])
   expect(()=>nativeLaunch('codex',root,'prompt',{...native,...change,configured_profile_functional:true},source,home)).toThrow('requires Codex subscription-store');
  expect(()=>nativeLaunch('claude_code',root,'prompt',{...native,...QUALIFICATION_MODELS.claude_code,login_backend:'config-dir',configured_profile_functional:true},source,home)).toThrow('requires Codex subscription-store');
  // Actual qualifier wiring, never a native executable. Existing config/skills no longer stop preparation.
  for(const execute of [false,true]){
   const p=Bun.spawnSync({cmd:[process.execPath,'scripts/p2-qualify-native.ts','--root',root,'--runtime','codex','--auth-mode','subscription-store',
    '--codex-model','gpt-6-astra','--codex-effort','high','--codex-login-backend','file','--codex-login-store',selected,'--codex-configured-profile-functional',
    ...(execute?['--execute-real-native']:[])],env:{PATH:'/nonexistent-p2-fixture',HOME:root,TMPDIR:root,NODE_ENV:'test'},stdout:'pipe',stderr:'pipe',timeout:15000});
   expect(p.exitCode).toBe(2);
   const first=JSON.parse(p.stdout.toString().split('\n')[0]!);
   const [record]=JSON.parse(readFileSync(join(first.root,'results.json'),'utf8'));
   expect(record.qualification_mode).toBe('configured_profile_functional');expect(record.native.configured_profile_functional).toBe(true);
   expect(record.model_attestation).toBe('unknown');expect(record.actual_model).toBe('unknown');expect(record.auth_preflight).toContain('NOT RUN');expect(record.runs).toEqual([]);
   expect(record.status).toBe(execute?'BLOCKED':'NOT RUN');if(execute)expect(record.code).toBe('UNSUPPORTED');
  }
  expect(readdirSync(selected).sort()).toEqual(['auth.json','config.toml','skills']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Codex task-write trace accepts only an exact successful frozen skill read resolved from launch cwd',()=>{
 const session='/managed/session',cwd=`${session}/task-bdb148b6-faf0-4f9e-b6f7-bc0517e38b95`;
 const path=`${session}/.agents/skills/csv-summary/SKILL.md`,content='Recorded frozen skill bytes\n',frozen={content,session_root:session,cwd};
 const event=(command:string,output=content,exit_code=0)=>[{type:'thread.started',thread_id:'recorded-task-write-shape'},
  {type:'item.completed',item:{id:'item_1',type:'command_execution',command,aggregated_output:output,exit_code,status:'completed'}}].map(e=>JSON.stringify(e)).join('\n');
 const read="/bin/zsh -lc 'cat ../.agents/skills/csv-summary/SKILL.md'";
 expect(nativeExecution('codex',event(read),path,frozen).observed).toBe(true);
 for(const trace of [
  event("/bin/zsh -lc 'cat ../.agents/skills/wrong/SKILL.md'"),
  event(read,content,1),
  event("/bin/zsh -lc 'echo ../.agents/skills/csv-summary/SKILL.md'"),
  event("/bin/zsh -lc 'cat ../../unrelated/csv-summary/SKILL.md'"),
  event(read,'agent claims the skill was read'),
 ])expect(nativeExecution('codex',trace,path,frozen).observed).toBe(false);
});

test('Configured functional progression requires exact frozen native read/artifacts/current grant; reroute is negative model evidence only',()=>{
 const path='/disposable/session/.agents/skills/csv-summary/SKILL.md',content='Frozen fixture version two\n',frozen={content,session_root:'/disposable/session'};
 const events=(command:string,output=content)=>[{type:'thread.started',thread_id:'synthetic'},
  {type:'item.completed',item:{type:'command_execution',command,aggregated_output:output,exit_code:0}}].map(e=>JSON.stringify(e)).join('\n');
 for(const command of [`cat ${path}`,"/bin/zsh -lc 'cat .agents/skills/csv-summary/SKILL.md'"])
  expect(nativeExecution('codex',events(command),path,frozen).observed).toBe(true);
 for(const [command,output] of [[`cat ${path}`,content+'changed'],[`cat ${path}`,content.slice(0,10)],['cat /selected/skills/csv-summary/SKILL.md',content],[`cat ${path}-sibling`,content],[`echo ${path}`,content]])
  expect(nativeExecution('codex',events(command!,output),path,frozen).observed).toBe(false);
 const reroute=JSON.stringify({type:'item.completed',item:{type:'error',message:'model rerouted: gpt-6-astra -> gpt-other (Policy)'}});
 const proof=nativeModelEvidence('codex',reroute);expect(proof).toEqual({source:'codex_exec',models:[],complete:false,rerouted:true});
 expect(nativeModelStatus('gpt-6-astra',proof)).toBe('mismatch');
 expect(nativeModelStatus('gpt-6-astra',nativeModelEvidence('codex',events(`cat ${path}`)))).toBe('unknown');
 const base={exit_code:0,revoked_during_run:false,native_execution_observed:true,model_status:'unknown' as const,
  native:{auth_mode:'subscription-store' as const,...QUALIFICATION_MODELS.codex,login_store:'/synthetic/store',login_backend:'file' as const},
  outcome:{status:'unknown',stale:false}};
 const assertions=[{name:'valid_summary',passed:true},{name:'invalid_refusal',passed:true}];
 expect(nativeQualificationCanContinue(base,assertions)).toBe(false);
 const functional={...base,native:{...base.native,configured_profile_functional:true as const}};
 expect(nativeQualificationCanContinue(functional,assertions)).toBe(true);expect(functional.model_status).toBe('unknown');expect(functional.outcome.status).toBe('unknown');
 for(const change of [{exit_code:1},{revoked_during_run:true},{native_execution_observed:false},{model_status:'mismatch' as const},{outcome:{status:'unknown',stale:true}},{outcome:{status:'failed',stale:false}}])
  expect(nativeQualificationCanContinue({...functional,...change},assertions)).toBe(false);
 for(const name of ['valid_summary','invalid_refusal'])expect(nativeQualificationCanContinue(functional,assertions.map(a=>({...a,passed:a.name!==name})))).toBe(false);
 expect(nativeQualificationCanContinue(functional,[])).toBe(false);
});


test('Configured probe bookkeeping links survive pre/post snapshots and a following session; frozen/neighbour links never do (fake CLI only)',async()=>{
 for(const injection of ['none','pre-frozen','post-frozen','pre-neighbour','post-neighbour'] as const){
  const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-bookkeeping-'))),root=join(parent,'managed'),bin=join(parent,'bin'),selected=join(parent,'selected');
  for(const path of [root,bin,selected])mkdirSync(path,{mode:0o700});
  const f=loopFixture('codex');
  try{
   assigned(f,accepted(f));bindManagedRoot(f.database,f.auth,f.runtimeId,root);
   // Deliberately a local fixture executable, never an official CLI or a model.
   // Its version path emulates official arg0 symlinks; exec adds another HOME link.
   const program=`#!${process.execPath}
import {mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const home=process.env.HOME,probe=process.argv.includes('--version');
const aliases=join(probe?process.env.CODEX_HOME:home,'tmp','arg0','fixture');
mkdirSync(aliases,{recursive:true});
for(const name of ['apply_patch','applypatch','codex-execve-wrapper'])symlinkSync('/synthetic-unread-executable',join(aliases,name));
writeFileSync(join(home,probe?'probe-reached':'exec-reached'),'synthetic fixture only');
const injection=${JSON.stringify(injection)};
if(injection.startsWith(probe?'pre-':'post-')){
 const target=injection.endsWith('frozen')?join(process.cwd(),'.agents/skills/csv-summary/injected-link'):join(${JSON.stringify(root)},'neighbour-link');
 symlinkSync('/synthetic-unread-target',target);
}
if(probe)console.log('codex-cli 0.153.3');
`;
   writeFileSync(join(bin,'codex'),program,{mode:0o700});
   for(let n=0;n<(injection==='none'?2:1);n++){
    const session=opened(f);materializeSession(f.database,f.reportAuth,session.id);
    const invoke=runCsvTask(f.database,f.reportAuth,{loadout_id:session.id,entry_id:session.entries[0]!.id,csv:'category,amount\nA,1\n',
     auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:'file',configured_profile_functional:true},{PATH:bin});
    if(injection==='none'){
     const result=await invoke;expect(result.exit_code).toBe(0);
     // Reaching exec and completing both snapshots does not assert native use or PASS.
     expect(result.native_execution_observed).toBe(false);expect(result.model_status).toBe('unknown');expect(result.outcome.status).toBe('unknown');
     expect(result.outside_root_writes).toContain('NOT VERIFIED');
    }else await expect(invoke).rejects.toMatchObject({code:'MANUAL_DRIFT'});
    const directory=join(root,'sessions',session.id),home=join(directory,readdirSync(directory).find(name=>name.startsWith('native-'))!);
    expect(readFileSync(join(home,'probe-reached'),'utf8')).toBe('synthetic fixture only');
    expect(lstatSync(join(home,'.codex/tmp/arg0/fixture/apply_patch')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home,'exec-reached'))).toBe(!injection.startsWith('pre-'));
    if(!injection.startsWith('pre-'))expect(lstatSync(join(home,'tmp/arg0/fixture/apply_patch')).isSymbolicLink()).toBe(true);
    // The unchanged public hashTree rejects these same links; only run snapshots distinguish bookkeeping.
    expect(()=>hashTree(root)).toThrow('link or special file');
   }
   expect(readdirSync(selected)).toEqual([]);
  }finally{f.database.close();rmSync(parent,{recursive:true,force:true});}
 }
});

test('Strict Codex accepts and hashes the observed private arg0 lock but refuses linked locks',()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-strict-snapshot-'))),root=join(parent,'managed'),target=join(parent,'codex');
 const loadout=randomUUID(),attempt=randomUUID(),home=join(root,'sessions',loadout,`native-${attempt}`),aliases=join(home,'.codex/tmp/arg0/codex-arg0I0KiYW');
 try{
  mkdirSync(aliases,{recursive:true,mode:0o700});writeFileSync(target,'synthetic executable metadata only',{mode:0o700});
  for(const name of ['apply_patch','applypatch','codex-execve-wrapper'])symlinkSync(target,join(aliases,name));
  const lock=join(aliases,'.lock');writeFileSync(lock,'',{mode:0o600});
  writeFileSync(join(home,'ordinary'),'before');
  const installed=lstatSync(target),snapshot=createStrictCodexRunSnapshot(root,[{loadout_id:loadout,attempt_id:attempt}],
   {path:target,dev:installed.dev,ino:installed.ino,uid:installed.uid});
  const initial=snapshot();expect(initial[relative(root,lock)]).toEqual({size:0,sha256:digest(Buffer.alloc(0))});
  writeFileSync(join(home,'ordinary'),'after');
  expect(snapshot()).not.toEqual(initial);
  symlinkSync(target,join(home,'arbitrary-link'));expect(()=>snapshot()).toThrow('link or special file');
  rmSync(join(home,'arbitrary-link'));rmSync(lock);symlinkSync(target,lock);
  expect(()=>createStrictCodexRunSnapshot(root,[{loadout_id:loadout,attempt_id:attempt}],{path:target,dev:installed.dev,ino:installed.ino,uid:installed.uid})).toThrow('lock file');
  rmSync(lock);linkSync(target,lock);
  expect(()=>createStrictCodexRunSnapshot(root,[{loadout_id:loadout,attempt_id:attempt}],{path:target,dev:installed.dev,ino:installed.ino,uid:installed.uid})).toThrow('lock file');
 }finally{rmSync(parent,{recursive:true,force:true});}
});

test('Strict Codex accepts exact probed arg0 aliases across runs without omitting HOME (fake CLI only)',async()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-strict-bookkeeping-'))),root=join(parent,'managed'),bin=join(parent,'bin'),selected=join(parent,'selected');
 for(const path of [root,bin,selected])mkdirSync(path,{mode:0o700});
 const f=loopFixture('codex');
 try{
  assigned(f,accepted(f));bindManagedRoot(f.database,f.auth,f.runtimeId,root);
  const program=`#!${process.execPath}
import {mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.argv.includes('--version')){
 const aliases=join(process.env.CODEX_HOME,'tmp','arg0','codex-arg0I0KiYW');mkdirSync(aliases,{recursive:true,mode:0o700});
 for(const name of ['apply_patch','applypatch','codex-execve-wrapper'])symlinkSync(process.argv[1],join(aliases,name));
 writeFileSync(join(aliases,'.lock'),'',{mode:0o600});
 console.log('codex-cli 0.153.3');
}else if(process.argv.includes('status'))console.log('Logged in using ChatGPT');
else writeFileSync(join(process.env.HOME,'exec-reached'),'synthetic fixture only');
`;
  writeFileSync(join(bin,'codex'),program,{mode:0o700});
  for(let n=0;n<2;n++){
   const session=opened(f);materializeSession(f.database,f.reportAuth,session.id);
   const result=await runCsvTask(f.database,f.reportAuth,{loadout_id:session.id,entry_id:session.entries[0]!.id,csv:'category,amount\nA,1\n',
    auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:'file'},{PATH:bin});
   expect(result.exit_code).toBe(0);expect(result.native_execution_observed).toBe(false);
   const directory=join(root,'sessions',session.id),home=join(directory,readdirSync(directory).find(name=>name.startsWith('native-'))!);
   expect(readFileSync(join(home,'exec-reached'),'utf8')).toBe('synthetic fixture only');
  }
 }finally{f.database.close();rmSync(parent,{recursive:true,force:true});}
});

test('Run snapshot excludes only pinned canonical attempt HOME; boundary replacement, task and unregistered sibling links refuse',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-snapshot-scope-'))),loadout=randomUUID(),attempt=randomUUID();
 const session=join(root,'sessions',loadout),home=join(session,`native-${attempt}`),task=join(session,`task-${attempt}`);
 try{
  mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(task,{mode:0o700});
  const snapshot=createRunSnapshot(root,[{loadout_id:loadout,attempt_id:attempt}]);
  const initial=snapshot();symlinkSync('/synthetic-unread-target',join(home,'official-link'));
  expect(snapshot()).toEqual(initial);
  // Both sides of a pre/post pair retain strict file checks outside bookkeeping.
  for(const path of [join(task,'summary.json'),join(root,'neighbour-link'),join(session,`native-${attempt}-sibling`)]){
   symlinkSync('/synthetic-unread-target',path);expect(()=>snapshot()).toThrow('link or special file');rmSync(path);
   expect(snapshot()).toEqual(initial);
  }
  const unregistered=join(session,`native-${randomUUID()}`);mkdirSync(unregistered,{mode:0o700});symlinkSync('/synthetic-unread-target',join(unregistered,'link'));
  expect(()=>snapshot()).toThrow('link or special file');rmSync(unregistered,{recursive:true});
  for(const invalid of ['..',attempt+'-sibling'])expect(()=>createRunSnapshot(root,[{loadout_id:loadout,attempt_id:invalid}])).toThrow('attempt binding');
  const saved=home+'-saved';renameSync(home,saved);mkdirSync(home,{mode:0o700});
  expect(()=>snapshot()).toThrow('boundary was replaced');rmSync(home,{recursive:true});symlinkSync(saved,home);
  expect(()=>snapshot()).toThrow('owned canonical directory');
  expect(()=>createRunSnapshot(root,[{loadout_id:loadout,attempt_id:attempt}])).toThrow('owned canonical directory');
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('Outer Seatbelt is explicit, bound to exact exceptions, and native argv always passes the enforcing wrapper',()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'p2-outer-argv-'))),selected=join(parent,'selected'),session=join(parent,'session');
 mkdirSync(selected,{mode:0o700});mkdirSync(session,{mode:0o700});
 try{
  const base={auth_mode:'subscription-store',...QUALIFICATION_MODELS.codex,login_store:selected,login_backend:'file',configured_profile_functional:true};
  const strict=nativeLaunch('codex',session,'synthetic prompt',base,{PATH:'/fake-native-only'});
  expect(strict.binary).toBe('codex');expect(strict.args).not.toContain('--sandbox');expect(strict.args).not.toContain('danger-full-access');
  const outer={mode:'macos-seatbelt-only-bookkeeping/1',outer_root:parent,profile_digest:digest('synthetic binding, not OS proof'),installation_id:join(selected,'installation_id'),arg0:join(selected,'tmp/arg0')};
  const launch=nativeLaunch('codex',session,'synthetic prompt',{...base,outer_seatbelt:outer},{PATH:'/fake-native-only'});
  expect(launch.binary).toBe('/usr/bin/python3');expect(launch.args[0]).toEndWith('/scripts/runtime/codex-seatbelt.py');
  expect(launch.args[1]).toBe('--guarded-native');expect(JSON.parse(launch.args[2]!)).toEqual(outer);expect(launch.args.slice(3,5)).toEqual(['codex','exec']);
  expect(launch.args[launch.args.indexOf('--sandbox')+1]).toBe('danger-full-access');
  for(const flag of ['approval_policy="never"','approvals_reviewer="user"','--ignore-user-config','--ignore-rules','features.plugins=false','features.hooks=false'])expect(launch.args).toContain(flag);
  expect(launch.args.join(' ')).not.toContain('dangerously-bypass');
  for(const change of [{installation_id:join(selected,'auth.json')},{arg0:selected}])
   expect(()=>nativeLaunch('codex',session,'prompt',{...base,outer_seatbelt:{...outer,...change}},{PATH:'/fake-native-only'})).toThrow('exact two');
  expect(()=>nativeLaunch('codex',session,'prompt',{...base,configured_profile_functional:undefined,outer_seatbelt:outer},{PATH:'/fake-native-only'})).toThrow('explicit configured');
  expect(()=>nativeLaunch('codex',session,'prompt',{...base,outer_seatbelt:{...outer,outer_root:join(parent,'other')}},{PATH:'/fake-native-only'})).toThrow('inside its bound');
  // Invalid digest fails before controls/exec. A fabricated mode/binding never starts a native task.
  const p=Bun.spawnSync({cmd:[launch.binary,...launch.args],env:{PATH:'/fake-native-only',HOME:session,TMPDIR:session},stdout:'pipe',stderr:'pipe',timeout:15000});
  expect(p.exitCode).toBe(2);expect(p.stderr.toString()).toContain('BLOCKED');
 }finally{rmSync(parent,{recursive:true,force:true});}
});

// P3 packaging review: explicit negative evidence must precede conservative GPT unknown.
test('P3 model mismatch ordering preserves strict GPT unknown and stops configured progression',()=>{
 expect(nativeModelStatus('gpt-6-astra',{source:'codex_exec',models:['gpt-other'],complete:true})).toBe('mismatch');
 expect(nativeModelStatus('gpt-6-astra',{source:'codex_exec',models:['gpt-6-astra'],complete:true})).toBe('unknown');
 expect(nativeModelStatus('gpt-6-astra',{source:'codex_exec',models:[],complete:false})).toBe('unknown');
});
