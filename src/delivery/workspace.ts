import {enableMemoryRoot} from '../services/memory-model.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { db } from '../db/connection.ts';
import { authorize } from '../auth/policy.ts';
import { localOwner } from './owner-onboarding.ts';
import { readCurrent } from './operations.ts';
import { hash, privateDirectory, readJsonBytes, safePath } from './files.ts';
import { nativePackagePreview, nativeProvisionPlan, applyNativeProvisionLocked, nativeRuntimeEnvironment } from './native-provision.ts';
import { connectInstalled } from './connect.ts';
import { installedRuntime, reportAuth } from './installed-runtime.ts';
import { bindNativeConnection, refreshNativeConnection, type ConnectionRef } from '../skills/connection.ts';
import { registration, type RuntimeKind } from '../skills/loop.ts';
import { nativeLaunch, preflightNativeSubscription, QUALIFICATION_MODELS } from '../skills/adapter.ts';
import { runAgentTask } from '../skills/agent-task.ts';
import { fileUpload } from '../services/files.ts';
import type { NativeOptions } from '../skills/runtime.ts';
import { RUNTIMES } from './runtime-versions.ts';
import { prepareNativeKeychain } from './native-keychain.ts';
import { QoopiaError } from '../utils/errors.ts';
import { redactSensitive } from '../utils/secret-guard.ts';

// Set only by the local installed launcher, after it acquires the lifetime lock.
let installation: {root:string; source:NodeJS.ProcessEnv} | undefined;
// ponytail: one local action at a time; use a per-runtime queue if concurrent work is needed.
let busy: string | null = null;
let login: {runtime:RuntimeKind; state:'waiting'|'completed'|'failed'; url?:string} | null = null;
let submitLoginCode:((code:string)=>void)|undefined;
export function enableLocalWorkspace(root:string, source:NodeJS.ProcessEnv) {
  installation={root:safePath(root),source:{PATH:source.PATH}};
  enableMemoryRoot(root);
}
function context(ownerId:string) {
  if(!installation||process.env.QOOPIA_STANDALONE!=='true')throw new QoopiaError('NOT_FOUND','Local workspace is unavailable');
  const owner=localOwner(db,ownerId);authorize(db,owner,'owner');
  return {...installation,owner,current:readCurrent(installation.root)};
}
function connection(root:string,ownerId:string,kind:RuntimeKind,refresh=false):ConnectionRef|undefined {
  const folder=path.join(root,'connections');
  if(!fs.existsSync(folder))return;
  const found:ConnectionRef[]=[];
  for(const name of fs.readdirSync(safePath(folder))) {
    if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
    const file=path.join(folder,name),bytes=readJsonBytes(file),r=JSON.parse(bytes.toString());
    if(r.owner_id!==ownerId||r.runtime_kind!==kind)continue;
    const ref={path:file,sha256:hash(bytes),instance:r.installation.instance,workspace_id:r.workspace_id,runtime_id:r.runtime_id,agent_id:r.agent_id};
    found.push(ref);
  }
  if(found.length>1)throw new QoopiaError('CONFLICT','More than one connection for this runtime; select it with the local CLI');
  const ref=found[0];if(!ref)return;
  const expected={runtime_id:ref.runtime_id,runtime_kind:kind,workspace_id:ref.workspace_id};
  if(refresh)return refreshNativeConnection(db,ref,expected,localOwner(db,ownerId));
  bindNativeConnection(db,ref,expected);return ref;
}
function nativeSettings(root:string,kind:RuntimeKind):NativeOptions {
  return {auth_mode:'subscription-store',...QUALIFICATION_MODELS[kind],
    login_backend:kind==='codex'?'file':'config-dir',login_store:path.join(root,'native-logins',kind)};
}
export function workspaceState(ownerId:string) {
  const c=context(ownerId);
  const runtimes=(['claude_code','codex'] as const).map(kind=>{
    let ref:ConnectionRef|undefined,error:string|undefined;
    try{ref=connection(c.root,ownerId,kind);}catch(e){error=e instanceof Error?e.message:'Connection unavailable';}
    const runtime=ref?registration(db,c.owner.workspace_id,ref.runtime_id):undefined;
    return {kind,name:kind==='codex'?'Codex':'Claude Code',version:RUNTIMES[kind].version,model:QUALIFICATION_MODELS[kind].model,
      connected:!!runtime?.reporter_id&&!!runtime.managed_root,runtime_id:ref?.runtime_id,agent_id:ref?.agent_id,error};
  });
  const sessions=db.query(`SELECT s.id,s.title,s.agent_id,a.name AS agent_name,s.last_active FROM sessions s JOIN agents a ON a.id=s.agent_id
    WHERE s.workspace_id=? AND json_extract(s.metadata,'$.format')='qoopia-agent-session/1' ORDER BY s.last_active DESC LIMIT 30`).all(c.owner.workspace_id);
  return {owner:c.owner.agent_name,runtimes,sessions,busy,login};
}
const kindSchema=z.enum(['claude_code','codex']);
export const workspaceActionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('connect'),runtime:kindSchema}).strict(),
  z.object({action:z.literal('login'),runtime:kindSchema}).strict(),
  z.object({action:z.literal('login-code'),runtime:kindSchema,code:z.string().trim().min(1).max(8192).refine(value=>!['\r','\n','\0'].some(c=>value.includes(c)),'Use a single-line authorization code')}).strict(),
  z.object({action:z.literal('task'),runtime:kindSchema,session:z.string().trim().min(1).max(120),task:z.string().trim().min(1).max(20_000),
    model:z.string().regex(/^(?:gpt|claude)-[a-z0-9][a-z0-9.-]{0,100}$/),effort:z.enum(['low','medium','high'])}).strict(),
]);
async function provision(root:string,kind:RuntimeKind,source:NodeJS.ProcessEnv) {
  const environment=nativeRuntimeEnvironment(root,source);
  const version=spawnSync(RUNTIMES[kind].binary,['--version'],{env:{PATH:environment.PATH},encoding:'utf8',timeout:10_000,maxBuffer:65536});
  const expected=kind==='codex'?`codex-cli ${RUNTIMES[kind].version}`:`${RUNTIMES[kind].version} (Claude Code)`;
  if(version.status!==0||version.stdout.trim()!==expected){
    const plan=nativeProvisionPlan(root,await nativePackagePreview(kind));
    await applyNativeProvisionLocked(root,plan,plan.plan_digest);
  }
  return nativeRuntimeEnvironment(root,source);
}
export async function workspaceAction(ownerId:string,raw:unknown) {
  const input=workspaceActionSchema.parse(raw),c=context(ownerId),kind=input.runtime;
  if(input.action==='login-code'){
    if(busy!=='login'||login?.runtime!==kind||login.state!=='waiting'||!submitLoginCode)throw new QoopiaError('CONFLICT','No subscription sign-in is waiting for a code');
    submitLoginCode(input.code);submitLoginCode=undefined;
    return {state:'code_submitted',message:'Confirming sign-in with your provider…'};
  }
  if(busy)throw new QoopiaError('CONFLICT','Another local action is running; wait for it to finish');
  busy=input.action;
  try {
    const native=nativeSettings(c.root,kind);
    if(native.login_store?.startsWith(c.root+path.sep))privateDirectory(native.login_store);
    if(input.action==='connect') {
      const source=await provision(c.root,kind,c.source);
      let ref=connection(c.root,ownerId,kind,true);
      const work=privateDirectory(safePath(`/var/tmp/qoopia-${process.getuid!()}/${hash(c.root).slice(0,24)}/${kind}`));
      if(!ref){
        // Native discovery walks ancestors. Keep generated execution files away from the user's real agent profiles.
        const config=path.join(privateDirectory(path.join(work,'connection')),kind==='codex'?'config.toml':'mcp.json');
        const args={runtime:kind,name:kind==='codex'?'Qoopia Codex':'Qoopia Claude',config,ownerId};
        const {instance,bundle,generation,port}=c.current;
        const target={root:c.root,instance,bundle,generation,port};
        const preview=await connectInstalled(args,target);
        const result=await connectInstalled(args,target,preview.preview_digest);
        if(!('connection' in result)||!result.connection)throw new Error('Connection was not published');
        ref=result.connection;
      }
      if(!registration(db,c.owner.workspace_id,ref.runtime_id).managed_root||!registration(db,c.owner.workspace_id,ref.runtime_id).reporter_id){
        await installedRuntime('bind',{connection:ref,runtime_kind:kind,runtime_version:RUNTIMES[kind].version,
          managed_root:privateDirectory(path.join(work,'tasks')),expected_revision:registration(db,c.owner.workspace_id,ref.runtime_id).revision},c.root,ownerId);
      }
      const runtime=registration(db,c.owner.workspace_id,ref.runtime_id);
      if(!runtime.managed_root||!runtime.reporter_id)throw new Error('Existing runtime is not bound; finish its local setup before using it here');
      const probe=privateDirectory(path.join(runtime.managed_root,'login-check'));
      const launch=nativeLaunch(kind,probe,'',native,source,probe);
      for(const directory of [launch.home,launch.env.TMPDIR!,launch.env.XDG_CONFIG_HOME!,launch.env.XDG_CACHE_HOME!,launch.env.XDG_DATA_HOME!])privateDirectory(directory);
      try{preflightNativeSubscription(kind,launch);return {state:'ready',message:'Subscription login found. Your provider verifies it when you run a task.'};}
      catch(error){if(error instanceof QoopiaError&&error.code==='UNAUTHENTICATED')return {state:'login_required',message:'Connected. Sign in to your subscription to start working.'};throw error;}
    }
    if(input.action==='login') {
      const source=await provision(c.root,kind,c.source);
      const home=privateDirectory(path.join(c.root,'native-login-home',kind));
      if(kind==='claude_code')prepareNativeKeychain(home);
      const env={PATH:source.PATH,HOME:home,...(native.login_store?{[RUNTIMES[kind].env]:native.login_store}:{})};
      const args=kind==='codex'?['-c','cli_auth_credentials_store="file"','login']:['auth','login','--claudeai'];
      const child=spawn(RUNTIMES[kind].binary,args,{cwd:home,env,stdio:['pipe','pipe','pipe']});
      login={runtime:kind,state:'waiting'};
      submitLoginCode=code=>{child.stdin.write(code+'\n');};
      child.stdin.on('error',()=>{}); // A vendor process may finish before a submitted one-time code arrives.
      // Keep only the vendor's public authorization URL in memory, for desktops where auto-open is unavailable.
      const capture=()=>{let pending='';return(chunk:Buffer)=>{
        pending=(pending+chunk.toString()).slice(-16_384);
        const lines=pending.split('\n');pending=lines.pop()!;
        for(const line of [...lines,pending]){
          const text=stripVTControlCharacters(line).match(/https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth|auth\.openai\.com\/oauth)\/authorize\?[^\s<>"']+/)?.[0];
          if(text&&login?.state==='waiting')login.url=text;
        }
      };};
      child.stdout.on('data',capture());child.stderr.on('data',capture());
      // Vendor CLI owns authentication. No login output or credentials are persisted.
      const timer=setTimeout(()=>child.kill('SIGTERM'),300_000);
      const hard=setTimeout(()=>child.kill('SIGKILL'),310_000);
      child.once('error',()=>{clearTimeout(timer);clearTimeout(hard);submitLoginCode=undefined;login={runtime:kind,state:'failed'};busy=null;});
      child.once('close',code=>{clearTimeout(timer);clearTimeout(hard);submitLoginCode=undefined;login={runtime:kind,state:code===0?'completed':'failed'};busy=null;});
      return {state:'login_started',message:'Complete sign-in in the browser opened by your agent, then check the connection.'};
    }
    const ref=connection(c.root,ownerId,kind);
    if(!ref)throw new QoopiaError('NOT_READY','Connect your agent first');
    const result=await runAgentTask(db,reportAuth(c.owner,ref.runtime_id),{runtime_id:ref.runtime_id,session:input.session,task:input.task,
      native:{...native,model:input.model,effort:input.effort,connection:ref}},nativeRuntimeEnvironment(c.root,c.source));
    const artifacts:{id:string;filename:string}[]=[],warnings:string[]=[];
    if(result.status==='completed'){
      // ponytail: flat task outputs, at most 20 files / 16 MiB each. Zip directory outputs when needed.
      const names=fs.readdirSync(result.task_directory).filter(name=>!['task.txt','output.txt','runtime-redacted.json'].includes(name));
      if(names.length>20)warnings.push('Only the first 20 output files can be saved.');
      for(const filename of names.sort().slice(0,20))try{
        const bytes=readJsonBytes(path.join(result.task_directory,filename));
        if(!bytes.length)continue;
        const file=await fileUpload({workspace_id:c.owner.workspace_id,owner_agent_id:ref.agent_id,uploaded_by_agent_id:c.owner.agent_id,
          folder:'tasks/'+result.task_id,filename,bytes});
        artifacts.push({id:file.id,filename:file.filename});
      }catch{warnings.push('An output could not be saved: use flat regular files up to 16 MiB each.');}
      db.query("UPDATE session_messages SET metadata=json_set(metadata,'$.artifacts',json(?)) WHERE session_id=? AND agent_id=? AND role='assistant' AND json_extract(metadata,'$.task_id')=?")
        .run(JSON.stringify(artifacts),result.session_id,ref.agent_id,result.task_id);
    }
    return {status:result.status,session_id:result.session_id,output:result.output,model_status:result.model_status,
      artifacts,artifact_warning:warnings.length?warnings.join(' '):undefined,
      ...('error_description' in result?{error_description:result.error_description}:{}),
      model_evidence:result.model_evidence,skills:'skills' in result?result.skills:[],retry:'manual only'};
  }finally{if(login?.state!=='waiting')busy=null;}
}
export function workspaceError(error:unknown) {
  return {error_description:redactSensitive(error instanceof Error?error.message:'Local action failed').text.slice(0,1000)};
}
