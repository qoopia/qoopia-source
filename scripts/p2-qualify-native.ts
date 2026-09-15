/** Operator-only real qualification. No implicit auth, billing, model or retry. */
import '../tests/helpers/p2-safe-env.ts';
import '../tests/setup.ts';
import {Database} from 'bun:sqlite';
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {loopFixture,accepted,assigned,opened,csvContent} from '../tests/helpers/p2-fixtures.ts';
import {bindManagedRoot,materializeSession,runCsvTask,nativeQualificationCanContinue,nativeLaunch,nativeOptions,prepareNativeSession,preflightNativeSubscription} from '../src/skills/adapter.ts';
import {digest} from '../src/skills/commands.ts';
import type {RuntimeKind} from '../src/skills/loop.ts';
const args=process.argv.slice(2),options=new Map<string,string>();let execute=false,preflight=false,allowTaskWrites=false,configuredProfile=false;
for(let i=0;i<args.length;i++){
 const key=args[i]!;
 if(key==='--codex-configured-profile-functional'&&!configuredProfile){configuredProfile=true;continue;}
 if(key==='--allow-claude-task-writes'&&!allowTaskWrites){allowTaskWrites=true;continue;}
 if(key==='--execute-real-native'&&!execute){execute=true;continue;}
 if(key==='--preflight-native-auth'&&!preflight){preflight=true;continue;}
 if(!['--root','--runtime','--auth-mode','--codex-model','--codex-effort','--claude-model','--claude-effort','--codex-outer-seatbelt','--codex-login-store','--codex-login-backend','--claude-login-store','--claude-login-backend'].includes(key)||options.has(key)||!args[i+1]||args[i+1]!.startsWith('--'))
  throw new Error('Use explicit --root, --runtime, --auth-mode, per-runtime --model/--effort and optional --login-store/--login-backend. Choose --execute-real-native or --preflight-native-auth, never both. No shared --model or credential arguments.');
 options.set(key,args[++i]!);
}
if(execute&&preflight)throw new Error('Choose preflight OR native task execution');
if(preflight&&options.get('--auth-mode')!=='subscription-store')throw new Error('Auth preflight requires explicit subscription-store');
const rootArg=options.get('--root');if(!rootArg)throw new Error('Required --root EXISTING_DISPOSABLE_PARENT');
const selected=options.get('--runtime');if(!['codex','claude_code','both'].includes(selected??''))throw new Error('Explicit --runtime codex|claude_code|both required');
if(allowTaskWrites&&selected==='codex')throw new Error('Task write opt-in requires Claude qualification');
if(configuredProfile&&(selected!=='codex'||preflight))throw new Error('Configured-profile functional mode requires --runtime codex and cannot run native auth status');
if(options.has('--codex-outer-seatbelt')&&!configuredProfile)throw new Error('Outer Seatbelt requires explicit configured-profile functional opt-in');
const outerSeatbelt=options.has('--codex-outer-seatbelt')?JSON.parse(readFileSync(options.get('--codex-outer-seatbelt')!,'utf8')):undefined;
const kinds:RuntimeKind[]=selected==='both'?['codex','claude_code']:[selected as RuntimeKind];
const choices=Object.fromEntries(kinds.map(kind=>[kind,nativeOptions(kind,{...(outerSeatbelt?{outer_seatbelt:outerSeatbelt}:{}),...(configuredProfile?{configured_profile_functional:true}:{}),auth_mode:options.get('--auth-mode'),
 model:options.get(kind==='codex'?'--codex-model':'--claude-model'),effort:options.get(kind==='codex'?'--codex-effort':'--claude-effort'),
 login_store:options.get(kind==='codex'?'--codex-login-store':'--claude-login-store'),login_backend:options.get(kind==='codex'?'--codex-login-backend':'--claude-login-backend')})]));
const parent=realpathSync(resolve(rootArg));
const root=realpathSync(mkdtempSync(join(parent,'qoopia-p2-qualification-')));const records:Record<string,unknown>[]=[];
const save=()=>writeFileSync(join(root,'results.json'),JSON.stringify(records,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({root,mode:execute?'REAL_NATIVE_REQUESTED':preflight?'NATIVE_AUTH_STATUS_ONLY':'PREPARE_ONLY_NOT_RUN'}));
for(const kind of kinds){
 const dataset=kind==='codex'?'first.csv':'second.csv',choice=choices[kind]!;
 const f=loopFixture(kind),managed=join(root,kind);mkdirSync(managed,{mode:0o700});
 const disk=join(root,kind+'.sqlite');writeFileSync(disk,f.database.serialize(),{mode:0o600});f.database.close();f.database=new Database(disk);f.database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
 const record:Record<string,unknown>={runtime:kind,dataset,native:choice,...(allowTaskWrites&&kind==='claude_code'?{task_write_opt_in:true,task_write_scope:'Bound only to each generated task at run authorization'}:{}),...(configuredProfile?{qualification_mode:'configured_profile_functional',auth_preflight:'NOT RUN: exec enforces forced_login_method=chatgpt; isolated status unavailable',model_attestation:'unknown',actual_model:'unknown',user_skills:'Operator-selected CODEX_HOME skills permitted; not frozen or attested'}:{}),status:'NOT RUN',runs:[]};records.push(record);
 try{
  const v1=accepted(f),a=assigned(f,v1);bindManagedRoot(f.database,f.auth,f.runtimeId,managed);
  const s1=opened(f);materializeSession(f.database,f.reportAuth,s1.id);
  const csv=readFileSync(new URL('../tests/fixtures/p2/'+dataset,import.meta.url),'utf8');
  Object.assign(record,{input_digest:digest(csv),loadout_id:s1.id,entry_id:s1.entries[0]!.id,version_id:v1.version.id,
    model_observation:kind==='codex'?'UNAVAILABLE: 0.153.3 exec JSONL omits actual model; cannot PASS':'Requires actual assistant response metadata, never init/request flags'});
  // Preparation reads only selected directory metadata, never credential bytes.
  const session=join(managed,'sessions',s1.id),home=join(session,'native-auth-preflight');
  const launch=nativeLaunch(kind,session,'Qualification preflight only',choice,process.env,home);
  if(preflight){
   prepareNativeSession(session,home);
   for(const dir of [launch.home,launch.env.TMPDIR!,launch.env.XDG_CONFIG_HOME!,launch.env.XDG_CACHE_HOME!,launch.env.XDG_DATA_HOME!])mkdirSync(dir,{mode:0o700});
   record.auth_preflight=await preflightNativeSubscription(kind,launch);
   record.reason='Native auth source preflight only; model/useful task NOT RUN';continue;
  }
  if(!execute){record.reason='No --execute-real-native flag; selected auth not verified';continue;}
  const runs:Awaited<ReturnType<typeof runCsvTask>>[]=[];record.runs=runs;
  const run=async(s:ReturnType<typeof opened>)=>{
   const result=await runCsvTask(f.database,f.reportAuth,{loadout_id:s.id,entry_id:s.entries[0]!.id,csv,...choice,...(allowTaskWrites&&kind==='claude_code'?{allow_task_writes:true}:{})});
   runs.push(result);save();
   const fact=f.database.query('SELECT assertions_json FROM skill_outcomes WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(result.run_id) as {assertions_json:string}|null;
   const assertions=JSON.parse(fact?.assertions_json??'[]') as {name:string;passed:boolean}[];
   if(!nativeQualificationCanContinue(result,assertions)){
    record.status='BLOCKED';record.reason='Native execution/model/artifacts/current grant not verified; no further task or fallback for this runtime';return false;
   }
   return true;
  };
  if(!await run(s1))continue;
  const original=[...csvContent.procedure];csvContent.procedure.push('Sort categories alphabetically and verify totals before writing.');
  let v2:ReturnType<typeof accepted>;try{v2=accepted(f,'2',v1.draft_id,1);}finally{csvContent.procedure=original;}
  assigned(f,v2!,a.data.assignment_id,1,'replace');if(!await run(opened(f)))continue;
  assigned(f,v1,a.data.assignment_id,2,'rollback');if(!await run(opened(f)))continue;
  record.status=configuredProfile?'FUNCTIONAL_SEQUENCE_COMPLETED_MODEL_UNATTESTED_WRITE_AUDIT_REQUIRED':'NATIVE_ATTEMPTED_EXTERNAL_WRITE_AUDIT_REQUIRED';
 }catch(error){
  const code=(error as {code?:string}).code;
  record.status=code==='UNAUTHENTICATED'?'NOT RUN':'BLOCKED';
  record.code=code??'QUALIFICATION_ERROR';record.reason=code==='UNAUTHENTICATED'?'Selected auth unavailable or not subscription; no login, token copy or billing fallback':'Selected context/isolation or execution blocked; inspect runbook, no fallback or automatic retry';
 }finally{f.database.close();save();}
}
console.log(JSON.stringify({results:join(root,'results.json'),records},null,2));
// Independent outside-write evidence and final acceptance are still required.
process.exitCode=2;
