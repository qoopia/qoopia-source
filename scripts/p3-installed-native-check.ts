// Existing fixture/task/controller conventions, but ALL skill/runtime mutations use the installed executable.
import '../tests/helpers/p2-safe-env.ts';
import '../tests/setup.ts';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { Delivery, readCurrent, dataFile } from '../src/delivery/operations.ts';
import { verifyBundle } from '../src/delivery/bundle.ts';
import { hash } from '../src/delivery/files.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { csvContent } from '../tests/helpers/p2-fixtures.ts';
import { connectConfigFixture, assertConnectOutput } from '../tests/helpers/p3-connect-fixtures.ts';
import { QUALIFICATION_MODELS, nativeQualificationCanContinue } from '../src/skills/adapter.ts';
import { RUNTIMES, type RuntimeKind } from '../src/skills/loop.ts';
import type { ConnectionRef } from '../src/skills/connection.ts';
import { claudeAuthMode, bindAuthSelector, claudeEnvironment } from './p3-native-auth.ts';

const args=process.argv.slice(2),options=new Map<string,string>(),flags=new Set<string>();
for(let i=0;i<args.length;i++){
  const key=args[i]!;
  if(['--sockets','--execute-real-native'].includes(key)&&!flags.has(key)){flags.add(key);continue;}
  if(!['--bundle','--resume','--approve','--claude-auth-mode','--claude-login-store','--codex-login-store'].includes(key)||options.has(key)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('Explicit bundle, optional sockets or native auth/store/resume/approval options only');
  options.set(key,args[++i]!);
}
const execute=flags.has('--execute-real-native'),sockets=flags.has('--sockets')||execute;
if((options.has('--resume')||options.has('--approve'))&&!execute)throw new Error('Resume/approval belongs only to the explicit native sequence');
if(options.has('--resume')!==options.has('--approve'))throw new Error('Resume requires exact reviewed packet approval');
const claudeMode=claudeAuthMode(options.get('--claude-auth-mode'),options.get('--claude-login-store'),execute);
if(!execute&&(options.has('--claude-login-store')||options.has('--codex-login-store')))throw new Error('No real stores in no-model checks');
if(execute&&(process.platform!=='darwin'||!options.has('--codex-login-store')))throw new Error('Native sequence requires macOS, explicit Claude auth and an existing Codex file store');
const selectedStore=(value:string)=>{
  const stat=fs.lstatSync(value);
  assert(path.isAbsolute(value)&&fs.realpathSync(value)===value&&stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid?.(),
    'Selected store must already be canonical, owned and not a link; no discovery, normalization or creation');
  return value;
};
process.umask(0o077);
const bundle=path.resolve(options.get('--bundle')??''),trust=fs.readFileSync(path.join(bundle,'TEST-PUBLIC-KEY.pem'),'utf8');
const verified=verifyBundle(bundle,trust,true);
const inventory=JSON.parse(fs.readFileSync(path.join(bundle,'SOURCE-MANIFEST.json'),'utf8')) as {files:Record<string,string>};
for(const [name,sha] of Object.entries(inventory.files))if(name.startsWith('src/'))assert.equal(hash(fs.readFileSync(name)),sha,'Product source differs from selected bundle');
const outer=options.has('--resume')?fs.realpathSync(options.get('--resume')!):fs.realpathSync(fs.mkdtempSync('/private/tmp/leo-p2-codex-seatbelt-p3-'));
assert(path.basename(outer).startsWith('leo-p2-codex-seatbelt-p3-'));
const root=path.join(outer,'installed'),stateFile=path.join(outer,'qualification.json');
if(options.has('--resume'))assert(fs.existsSync(stateFile));else assert(!fs.existsSync(stateFile));
const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:outer,TMPDIR:outer,XDG_CONFIG_HOME:outer,XDG_CACHE_HOME:outer,XDG_DATA_HOME:outer};
const events:any[]=[],state:any=options.has('--resume')?JSON.parse(fs.readFileSync(stateFile,'utf8')):{outer,root,bundle_manifest_sha256:verified.digest,events,runs:[],mode:execute?'NATIVE_REQUESTED':'COMPILED_NO_MODEL',status:'IN_PROGRESS'};
assert.equal(state.bundle_manifest_sha256,verified.digest);
if(options.has('--resume'))assert.equal(state.status,'AWAITING_EXACT_REVIEW');
// Only the explicitly selected subscription variable is accessed, in memory, by the existing adapter.
// No-model mode always supplies its own synthetic value and never reads host auth.
const claudeAuth=claudeMode==='subscription'?claudeEnvironment(outer,execute?process.env:{CLAUDE_CODE_OAUTH_TOKEN:'synthetic-claude-subscription-fixture'}):undefined;
const fake=execute?undefined:fs.realpathSync(fs.mkdtempSync('/private/tmp/p3-native-stores-'));
if(fake)for(const name of ['claude','codex/tmp/arg0'])fs.mkdirSync(path.join(fake,name),{recursive:true,mode:0o700});
const stores={claude_code:claudeMode==='subscription'?null:execute?selectedStore(options.get('--claude-login-store')!):path.join(fake!,'claude'),
  codex:execute?selectedStore(options.get('--codex-login-store')!):path.join(fake!,'codex')};
const authSelector={claude_code:claudeMode==='subscription'?{auth_mode:'subscription' as const}:
  {auth_mode:'subscription-store' as const,login_backend:'config-dir' as const,login_store:stores.claude_code!},
  codex:{auth_mode:'subscription-store' as const,login_backend:'file' as const,login_store:stores.codex}};
if(options.has('--resume')){bindAuthSelector(authSelector,state.auth_selector);assert.deepEqual(stores,state.stores);}
else{state.auth_selector=authSelector;state.stores=stores;state.synthetic_stores=fake??null;}
const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n',{mode:0o600});
let binary=path.join(bundle,'qoopia');
const run=(command:string[],expected=0,claudeBoundary=false,expectedError?:string,withClaudeAuth=false)=>{
  const profile=`(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(outer)}))\n(allow file-write-data (literal "/dev/null"))\n`;
  const argv=claudeBoundary?['/usr/bin/sandbox-exec','-p',profile,binary,...command]:[binary,...command];
  const childEnv=withClaudeAuth&&claudeAuth?{...env,CLAUDE_CODE_OAUTH_TOKEN:claudeAuth.env.CLAUDE_CODE_OAUTH_TOKEN}:env;
  const start=Date.now(),p=spawnSync(argv[0]!,argv.slice(1),{cwd:outer,env:childEnv,encoding:'utf8',timeout:400000,maxBuffer:8*1024*1024});
  const stdout=claudeAuth?claudeAuth.scrub(p.stdout??''):p.stdout??'',stderr=claudeAuth?claudeAuth.scrub(p.stderr??''):p.stderr??'';
  assertConnectOutput(stdout+stderr);
  state.events.push({argv:claudeBoundary?['/usr/bin/sandbox-exec','-p','<root-bound profile>',binary,...command]:argv,
    exit_code:p.status,elapsed_ms:Date.now()-start,stdout_sha256:hash(stdout),stderr_sha256:hash(stderr)});save();
  assert.equal(p.status,expected,JSON.stringify({command:command[0],stderr}));
  if(expectedError)assert(stderr.includes(expectedError),'Expected exact refusal: '+expectedError);
  return stdout.trim();
};
const common=['--root',root,'--allow-test-fixture'];
const request=(kind:'skill'|'runtime',operation:string,input:unknown,boundary=false,withClaudeAuth=false)=>{
  const file=path.join(outer,`${kind}-${operation}-${randomUUID()}.json`);
  fs.writeFileSync(file,JSON.stringify(input),{mode:0o600,flag:'wx'});
  return JSON.parse(run([kind,operation,...common,'--input',file,'--commit'],0,boundary,undefined,withClaudeAuth));
};
const read=<T>(sql:string,...values:any[]):T=>{
  const d=new Database(dataFile(root,readCurrent(root)),{readonly:true});
  try{return d.query(sql).get(...values) as T;}finally{d.close();}
};
let server:ReturnType<typeof Bun.spawn>|undefined;
const stop=async()=>{if(server){server.kill('SIGTERM');await server.exited;server=undefined;}};
try{
  if(!options.has('--resume')){
    // Native/socket modes use actual compiled install+owner IPC; local mode reuses the existing no-bind Delivery seam.
    if(sockets)run(['install',...common,'--bundle',bundle,'--commit']);
    else new Delivery(root,trust,true,(b,g)=>{const old=binary;binary=path.join(b,'qoopia');try{run(['_migrate','--root',g]);}finally{binary=old;}}).install(bundle,43737);
    const current=readCurrent(root);binary=path.join(root,'bundles',current.bundle,'qoopia');
    if(sockets){
      server=Bun.spawn([binary,'start',...common],{cwd:outer,env,stdout:'ignore',stderr:'ignore'});
      for(let i=0;i<100;i++){
        if(server.exitCode!==null)throw new Error('Installed server exited');
        try{if((await fetch(`http://127.0.0.1:${current.port}/health`)).ok)break;}catch{}
        if(i===99)throw new Error('Installed server timeout');await Bun.sleep(50);
      }
      const {requestOwnerLogin}=await import('../src/delivery/owner-control.ts');
      const claim=await requestOwnerLogin(root,{operation:'bootstrap',name:'Installed qualification owner'},path.join(bundle,'assets/native',`owner-peer.${process.platform==='darwin'?'dylib':'so'}`));
      assert('code' in claim);await stop();state.owner_bootstrap='actual compiled IPC';
    }else{
      const d=new Database(dataFile(root,current));try{bootstrapOwner(d,'Installed qualification owner','Installed task fixture');}finally{d.close();}
      state.owner_bootstrap='direct fixture seed (no socket claim)';
    }
    state.workspace_id=read<{workspace_id:string}>('SELECT workspace_id FROM workspace_owners').workspace_id;
    const guard=path.join(bundle,'assets/scripts/runtime/codex-seatbelt.py');
    const p=spawnSync('/usr/bin/python3',['-c',
      'import importlib.util,json,sys,pathlib; s=importlib.util.spec_from_file_location("guard",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); v=m.binding(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3])); m.validate_binding(v); print(json.dumps(v))',
      guard,outer,state.stores.codex],{cwd:outer,env:{...env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:10000});
    assert.equal(p.status,0,p.stderr);state.outer_seatbelt=JSON.parse(p.stdout);
    state.runtime={};
    for(const kind of ['claude_code','codex'] as const){
      const fixture=connectConfigFixture(outer,kind,false);
      const command=['connect',...common,'--runtime',kind,'--name','Installed '+kind,'--config',fixture.config];
      const preview=JSON.parse(run(command));
      const connected=JSON.parse(run([...command,'--commit','--approve',preview.preview_digest]));
      const managed=path.join(outer,'managed-'+kind);fs.mkdirSync(managed,{mode:0o700});
      const bound=request('runtime','bind',{connection:connected.connection,runtime_kind:kind,runtime_version:RUNTIMES[kind].version,managed_root:managed,expected_revision:1});
      assert.equal(bound.state,'INSTALLED_RUNTIME_BOUND');assert.equal(bound.workspace_id,state.workspace_id);
      state.runtime[kind]={connected,managed,config:fixture.config};
    }
    if(sockets){
      server=Bun.spawn([binary,'start',...common],{cwd:outer,env,stdout:'ignore',stderr:'ignore'});
      const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
      const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      for(let i=0;i<100;i++){
        if(server.exitCode!==null)throw new Error('Installed server exited');
        try{if((await fetch(`http://127.0.0.1:${current.port}/health`)).ok)break;}catch{}
        if(i===99)throw new Error('Installed server timeout');await Bun.sleep(50);
      }
      for(const kind of ['claude_code','codex'] as const){
        const text=fs.readFileSync(state.runtime[kind].config,'utf8');
        const parsed=kind==='codex'?Bun.TOML.parse(text):JSON.parse(text);
        const entry=kind==='codex'?parsed.mcp_servers.qoopia:parsed.mcpServers.qoopia;
        const client=new Client({name:'installed-native-precondition',version:'1'});
        try{
          await client.connect(new StreamableHTTPClientTransport(new URL(entry.url),{requestInit:{headers:kind==='codex'?entry.http_headers:entry.headers}}));
          const catalog=await client.listTools();assert(catalog.tools.some(tool=>tool.name==='note_create'));
          const note=await client.callTool({name:'note_get',arguments:{id:state.runtime[kind].connected.first_memory_id}});
          assert(!note.isError);assert(JSON.stringify(note).includes(state.runtime[kind].connected.first_memory_id));
          const denied=await client.callTool({name:'agent_pairing_create',arguments:{}});assert(denied.isError);
        }finally{await client.close();}
      }
      await stop();state.installed_http_sdk='PASS both exact config files; owner tool refused; NOT native runtime evidence';
    }
  }else{
    binary=path.join(root,'bundles',readCurrent(root).bundle,'qoopia');
  }
  const mutation=()=>({expected_revision:0,idempotency_key:randomUUID()});
  const capture=(label:string,draft?:string,revision=0,sourceRun?:string)=>{
    const content=structuredClone(csvContent);
    if(label==='3')content.procedure.push('Sort categories alphabetically and verify totals before writing.');
    const d=request('skill','capture',{kind:sourceRun?'run':'manual',...(sourceRun?{source_id:sourceRun}:{text:'1. Validate input.\n2. Group and sum.'}),
      title:content.title,slug:'csv-summary',content,choice:draft?'update':'new',...(draft?{draft_id:draft}:{}),expected_revision:revision,idempotency_key:randomUUID()});
    const c=request('skill','compile',{draft_id:d.data.draft_id,expected_revision:revision+1,version_label:label,license:'MIT',native_name:'csv-summary',idempotency_key:randomUUID()});
    const version=request('skill','get',{version_id:c.data.version_id});
    return {draft_id:d.data.draft_id,version,candidate_digest:c.data.candidate_digest};
  };
  const accept=(v:any)=>{
    const r=request('skill','accept',{version_id:v.version.id,expected_digest:v.candidate_digest,target_scope:'project',expires_at_ms:Date.now()+86400000,...mutation()});
    v.approval=r.data.approval_id;v.version=request('skill','get',{version_id:v.version.id});return v;
  };
  const assign=(kind:RuntimeKind,v:any,prior?:any,reason:'assign'|'replace'|'rollback'='assign')=>request('skill','assign',{
    runtime_id:state.runtime[kind].connected.runtime_registration_id,version_id:v.version.id,package_digest:v.version.package_digest,approval_id:v.approval,
    target_scope:'project',expires_at_ms:Date.now()+3600000,adoption_operation_id:randomUUID(),...(prior?{assignment_id:prior.data.assignment_id}:{}),
    expected_revision:prior?.revision??0,reason,idempotency_key:randomUUID()});
  const task=(kind:RuntimeKind,actual:boolean)=>{
    const s=request('runtime','start',{runtime_id:state.runtime[kind].connected.runtime_registration_id,native_session_ref:randomUUID(),qoopia_session_id:randomUUID()});
    const input={loadout_id:s.loadout_id,entry_id:s.entries[0],csv_file:path.resolve('tests/fixtures/p2/'+(kind==='codex'?'first.csv':'second.csv')),
      native:{...authSelector[kind],...QUALIFICATION_MODELS[kind],
        connection:state.runtime[kind].connected.connection as ConnectionRef,...(kind==='codex'?{configured_profile_functional:true,outer_seatbelt:state.outer_seatbelt}:{})},
      ...(kind==='claude_code'?{allow_task_writes:true}:{})};
    // The installed command may not read workspace inputs under the native boundary. Stage only the existing synthetic CSV.
    const csv=path.join(outer,kind+'-input.csv');if(!fs.existsSync(csv))fs.copyFileSync(input.csv_file,csv);input.csv_file=csv;
    const result=request('runtime',actual?'run':'inspect',input,actual&&kind==='claude_code',kind==='claude_code'&&claudeMode==='subscription');
    if(actual){
      state.runs.push(result);save();
      const fact=read<{assertions_json:string}>('SELECT assertions_json FROM skill_outcomes WHERE run_id=? ORDER BY revision DESC LIMIT 1',result.run_id);
      assert(nativeQualificationCanContinue(result,JSON.parse(fact?.assertions_json??'[]')),'Native/artifact/current-grant/MCP gate failed; sequence stops without retry');
    }else{
      assert.equal(result.state,'PREPARED_NOT_RUN');assert.equal(result.native_invocations,0);assert.equal(result.native.connection.instance,readCurrent(root).instance);
      state.inspections??=[];state.inspections.push(result);
    }
    return result;
  };
  if(!options.has('--resume')){
    // Existing reviewed CSV sample seeds the first useful task; its fixture acceptance is explicitly distinguished from the captured-run review below.
    state.seed=accept(capture('1'));state.seed_acceptance='fixture owner command, existing CSV content; not a new human UI review';
    state.assignment={claude_code:assign('claude_code',state.seed)};
    const first=task('claude_code',execute);
    state.captured=capture('2',state.seed.draft_id,1,execute?first.run_id:undefined);
    state.revised=capture('3',state.seed.draft_id,2,execute?first.run_id:undefined);
    assert.equal(state.captured.version.skill_id,state.seed.version.skill_id);assert.equal(state.revised.version.skill_id,state.seed.version.skill_id);
    if(execute){
      const readable=[['Captured version',state.captured],['Revised version',state.revised]].map(([label,value]:any)=>{
        const members=JSON.parse(value.version.members_json) as Record<string,string>;
        return `# ${label}\nCandidate ${value.candidate_digest}\nVersion ${value.version.id}\n\n`+
          Object.entries(members).map(([name,encoded])=>`## ${name}\nSHA-256 ${hash(Buffer.from(encoded,'base64'))}\n\n\`\`\`text\n${Buffer.from(encoded,'base64').toString('utf8')}\n\`\`\`\n`).join('\n');
      }).join('\n');
      const packet={installation:readCurrent(root),workspace_id:state.workspace_id,auth_selector:state.auth_selector,source_run_id:first.run_id,
        source_task_directory:first.task_directory,captured:state.captured,revised:state.revised,readable_review:readable};
      const bytes=JSON.stringify(packet,null,2)+'\n';fs.writeFileSync(path.join(outer,'review.json'),bytes,{mode:0o600,flag:'wx'});
      fs.writeFileSync(path.join(outer,'review.md'),readable,{mode:0o600,flag:'wx'});
      state.review_sha256=hash(bytes);state.status='AWAITING_EXACT_REVIEW';save();
      console.log(JSON.stringify({status:state.status,outer,review:path.join(outer,'review.json'),approve:state.review_sha256,
        next:'Inspect both exact candidates and source task artifacts, then rerun with --execute-real-native --resume OUTER --approve DIGEST and the same explicit stores. No automatic acceptance.'},null,2));
      process.exitCode=2;
    }
  }
  if(!execute||options.has('--resume')){
    if(execute){
      const bytes=fs.readFileSync(path.join(outer,'review.json'));
      assert.equal(hash(bytes),state.review_sha256);
      assert.equal(options.get('--approve'),state.review_sha256,'Exact human-reviewed packet digest required');
      const packet=JSON.parse(bytes.toString('utf8'));
      assert.equal(fs.readFileSync(path.join(outer,'review.md'),'utf8'),packet.readable_review);
      assert.deepEqual(packet.captured,state.captured);assert.deepEqual(packet.revised,state.revised);
      assert.deepEqual(packet.installation,readCurrent(root));assert.equal(packet.workspace_id,state.workspace_id);
      bindAuthSelector(state.auth_selector,packet.auth_selector);
      assert.equal(packet.source_run_id,state.runs[0].run_id);
      state.review_approval={digest:state.review_sha256,method:'explicit local operator --approve',at:new Date().toISOString()};
      // Fence a crashed/interrupted native continuation before any external effect; never replay it automatically.
      state.status='EXECUTING_REVIEWED_SEQUENCE';save();
    }
    accept(state.captured);accept(state.revised);
    for(const kind of ['codex','claude_code'] as const){
      let a=state.assignment[kind];
      a=assign(kind,state.captured,a,a?'replace':'assign');const initial=task(kind,execute);
      a=assign(kind,state.revised,a,'replace');const revised=task(kind,execute);
      a=assign(kind,state.captured,a,'rollback');const rollback=task(kind,execute);
      assert.notEqual(initial.version_id,revised.version_id);assert.equal(initial.version_id,rollback.version_id);
      state.assignment[kind]=a;
    }
    const integrity=read<Record<string,string>>('PRAGMA integrity_check');assert.equal(Object.values(integrity)[0],'ok');
    assert.equal(read<{n:number}>('SELECT count(*) n FROM workspaces').n,1);
    assert.equal(read<{n:number}>('SELECT count(DISTINCT skill_id) n FROM skill_versions').n,1);
    if(!execute){
      assert.equal(read<{n:number}>('SELECT count(*) n FROM skill_runs').n,0);assert.equal(state.inspections.length,7);
      const last=state.inspections.at(-1),assignment=state.assignment.claude_code;
      request('skill','assignment_update',{assignment_id:assignment.data.assignment_id,desired_state:'paused',reason:'compiled current-grant refusal check',
        expected_revision:assignment.revision,idempotency_key:randomUUID()});
      const native={...last.native};delete native.task_write_directory;
      const file=path.join(outer,'paused-inspection.json');
      fs.writeFileSync(file,JSON.stringify({loadout_id:last.loadout_id,entry_id:last.entry_id,csv_file:path.join(outer,'claude_code-input.csv'),native,allow_task_writes:true}),{mode:0o600});
      run(['runtime','inspect',...common,'--input',file,'--commit'],1,false,'Assignment is paused or revoked');
      assert.equal(read<{n:number}>('SELECT count(*) n FROM skill_runs').n,0);
      state.current_grant_refusal='PASS compiled paused loadout before any native/auth process';
    }
    state.status=execute?'NATIVE_FUNCTIONAL_SEQUENCE_COMPLETE_EXTERNAL_AUDIT_REQUIRED':'PASS_COMPILED_NO_MODEL_SHARED_LINEAGE';
    state.clean_os='NOT QUALIFIED';state.T01='NOT DONE';state.P3='NOT DONE';
    state.sequence='seed task; captured revision; Codex initial/revision/rollback; Claude solo initial/revision/rollback';
    save();console.log(JSON.stringify({status:state.status,outer,bundle_manifest_sha256:verified.digest,owner_bootstrap:state.owner_bootstrap,
      workspace_id:state.workspace_id,runs:state.runs.length,inspections:state.inspections?.length??0,
      native:execute?'Attempted; inspect per-run model/MCP/outcome/audit facts':'NOT RUN',T01:state.T01,P3:state.P3},null,2));
  }
}catch(error){state.status='BLOCKED';state.failure='Installed/native check failed; no retry or fallback';save();throw error;}
finally{await stop();}
