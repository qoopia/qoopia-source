import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stripVTControlCharacters} from 'node:util';
import {z} from 'zod';
import {db} from '../db/connection.ts';
import {localOwner} from '../delivery/owner-onboarding.ts';
import {authorize} from '../auth/policy.ts';
import {privateDirectory,durableWrite,preflightSpace,hasNulOrNewline,readJson} from '../utils/fs.ts';
import {nativePackagePreview,nativeRuntimeEnvironment,unpackNativePackage,verifyInstalledNativeAsync,vendorDownload} from '../delivery/native-provision.ts';
import {prepareNativeKeychain,nativeOwnerHome} from '../delivery/native-keychain.ts';
import {RUNTIMES} from '../delivery/runtime-versions.ts';
import {createAgent} from '../admin/agents.ts';
import {sha256Hex} from '../auth/api-keys.ts';
import {embeddingCoverage} from './embedding-store.ts';
import {memoryClientConnectionPath,memoryProfile,memoryRoot,memoryModelStatus,memoryText,selectMemoryProfile,type MemoryProfile} from './memory-model.ts';
import {QoopiaError} from '../utils/errors.ts';
import {localServiceOrigin} from '../utils/standalone.ts';
import {env} from '../utils/env.ts';
import {installMemoryClient,ownTunnelOrigin,relocateMemoryClient} from '../delivery/memory-client.ts';
import {selectedNativeDirectory} from '../delivery/native-client-paths.ts';

const actions=z.discriminatedUnion('action',[
  z.object({action:z.literal('select'),runtime:z.enum(['claude_code','codex'])}).strict(),
  z.object({action:z.literal('login')}).strict(),
  z.object({action:z.literal('cancel-login')}).strict(),
  z.object({action:z.literal('login-code'),code:z.string().trim().min(1).max(8192).refine(s=>!hasNulOrNewline(s))}).strict(),
  z.object({action:z.literal('check')}).strict(),
  // another_computer: a file for an agent on a different machine, served through this installation's external address.
  z.object({action:z.literal('connect-agent'),runtime:z.enum(['claude_code','codex']),target:z.enum(['this_computer','another_computer']).optional()}).strict(),
]);
type Login={state:'waiting'|'completed'|'failed'|'cancelled';url?:string;code?:string;submit?:(code:string)=>void;cancel?:()=>void};
const logins=new Map<string,Login>(),busy=new Set<string>();
type Operation={action:string;state:'running'|'completed'|'failed';error?:string};
const operations=new Map<string,Operation>();
export function submitMemorySetupAction(ownerId:string,raw:unknown){
  const auth=owner(ownerId),input=actions.parse(raw);
  if(!['select','login','check'].includes(input.action))return memorySetupAction(ownerId,input);
  if(operations.get(auth.workspace_id)?.state==='running'||busy.has(auth.workspace_id))throw new QoopiaError('CONFLICT','A memory setup action is running');
  const operation:Operation={action:input.action,state:'running'};operations.set(auth.workspace_id,operation);
  void Promise.resolve().then(()=>memorySetupAction(ownerId,input)).then(()=>{operation.state='completed';},error=>{
    operation.state='failed';operation.error=error instanceof QoopiaError?error.message:'Subscription setup failed. Check your connection and try again.';
  });
  return {accepted:true};
}
function owner(ownerId:string){const auth=localOwner(db,ownerId);authorize(db,auth,'owner');return auth;}
export function memorySetupState(ownerId:string) {
  const auth=owner(ownerId),login=logins.get(auth.workspace_id);
  const sessions=db.query(`SELECT COUNT(*) AS tracked,COUNT(n.id) AS summarized FROM sessions s LEFT JOIN notes n
    ON n.session_id=s.id AND n.agent_id=s.agent_id AND n.workspace_id=s.workspace_id AND n.source='qoopia-continuity' AND n.deleted_at IS NULL
    WHERE s.workspace_id=? AND json_extract(s.metadata,'$.continuity_enabled')=1`).get(auth.workspace_id);
  return {model:memoryModelStatus(auth.workspace_id),embedding:embeddingCoverage(auth.workspace_id),sessions,busy:busy.has(auth.workspace_id)||operations.get(auth.workspace_id)?.state==='running',operation:operations.get(auth.workspace_id)??null,
    login:login?{state:login.state,url:login.url,code:login.code}:null,
    clients:{claude_code:'native lifecycle hooks',codex:'native lifecycle hooks; one-time hook trust review',browser:'MCP memory access; automatic lifecycle capture is not available through MCP alone'}};
}
export async function provision(runtime:MemoryProfile['runtime']) {
  const root=memoryRoot(),selected=path.join(root,'native-runtimes',runtime+'.json');
  if(fs.existsSync(selected)){await nativeRuntimeEnvironment(root,{PATH:process.env.PATH});return;}
  const pkg=await nativePackagePreview(runtime);preflightSpace(root,[pkg.size,1024*1024*1024]);const dest=path.join(root,'native-runtimes',runtime,pkg.version);
  privateDirectory(path.dirname(dest));
  if(fs.existsSync(dest))await verifyInstalledNativeAsync(pkg,dest);
  else await unpackNativePackage(pkg,await vendorDownload(pkg.url,pkg.size),dest);
  durableWrite(selected,JSON.stringify(pkg));
}
async function login(workspace:string,profile:MemoryProfile) {
  const home=privateDirectory(path.join(memoryRoot(),'native-login-home',workspace,profile.runtime));
  if(profile.runtime==='claude_code')await prepareNativeKeychain(home);
  const environment=await nativeRuntimeEnvironment(memoryRoot(),{PATH:process.env.PATH});
  const child=spawn(RUNTIMES[profile.runtime].binary,profile.runtime==='codex'?['-c','cli_auth_credentials_store="file"','login','--device-auth']:['auth','login','--claudeai'],
    {cwd:home,env:{PATH:environment.PATH,HOME:home,[RUNTIMES[profile.runtime].env]:profile.login_store},stdio:['pipe','pipe','pipe']});
  const state:Login={state:'waiting',submit:code=>child.stdin.write(code+'\n')};logins.set(workspace,state);
  let cancellation:ReturnType<typeof setTimeout>|undefined;
  state.cancel=()=>{state.state='cancelled';state.submit=undefined;state.cancel=undefined;child.kill('SIGTERM');cancellation=setTimeout(()=>child.kill('SIGKILL'),2000);cancellation.unref();};
  child.stdin.on('error',()=>{});
  let pending='';const capture=(chunk:Buffer)=>{
    pending=stripVTControlCharacters((pending+chunk.toString()).slice(-16_384));
    const url=pending.match(/https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth|auth\.openai\.com\/oauth)\/authorize\?[^\s<>"']+/)?.[0]
      ??pending.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s<>"']*/)?.[0];
    if(url)state.url=url;
    if(profile.runtime==='codex'){const code=pending.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b|\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];if(code)state.code=code;}
  };
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const timer=setTimeout(()=>child.kill('SIGTERM'),300_000),hard=setTimeout(()=>child.kill('SIGKILL'),302_000);
  const finish=(success:boolean)=>{clearTimeout(timer);clearTimeout(hard);clearTimeout(cancellation);pending='';if(logins.get(workspace)===state){logins.set(workspace,{state:state.state==='cancelled'?'cancelled':success?'completed':'failed'});busy.delete(workspace);}};
  child.once('error',()=>finish(false));child.once('close',code=>finish(code===0));
}
type StoredConnection={format:'qoopia-memory-connection/1';url:string;agent_id:string;key:string;runtime:'codex'|'claude_code'};
/** The stored memory connection while its agent is active with that key. 5.0.16 stored the tunnel
 * origin, which never serves /memory/continuity: the same agent moves to loopback. */
function reusableConnection(workspace:string,file:string,origin=localServiceOrigin()):StoredConnection|undefined {
  if(!fs.existsSync(file))return undefined;
  const stored=readJson(file) as StoredConnection;
  const agent=db.query('SELECT active,api_key_hash FROM agents WHERE id=? AND workspace_id=?').get(stored.agent_id,workspace) as {active:number;api_key_hash:string}|null;
  if(agent?.active&&agent.api_key_hash===sha256Hex(stored.key)){
    // 5.0.16 stored the tunnel origin for local clients; a remote file follows the current external address.
    if(process.env.QOOPIA_STANDALONE!=='true'||stored.url===origin)return stored;
    const moved={...stored,url:origin};durableWrite(file,JSON.stringify(moved));return moved;
  }
  // A rotated key may now be held elsewhere: never replace that live agent from here.
  if(agent?.active)throw new QoopiaError('CONFLICT','The key of this memory agent was rotated; deactivate that agent, then connect again');
  // Revoked: the old agent stays inactive; an explicit connect issues a new one.
  return undefined;
}
/** Start of a standalone server: a local hook binding that 5.0.16 linked to the tunnel origin moves to
 * loopback for the same agent and key, so capture resumes without reconnecting the client. */
export function migrateMemoryOrigins() {
  const results:{runtime:'codex'|'claude_code';state:string;reason?:string}[]=[];
  if(process.env.QOOPIA_STANDALONE!=='true')return results;
  const tunnel=ownTunnelOrigin(memoryRoot());
  for(const runtime of ['claude_code','codex'] as const)try{
    // The file for another computer, linked on this one, names our own tunnel address (5.0.17).
    const binding=path.join(memoryRoot(),'memory-clients',runtime,'connection.json');
    if(tunnel&&fs.existsSync(binding)&&new URL((readJson(binding) as StoredConnection).url).origin===tunnel)
      results.push(relocateMemoryClient(memoryRoot(),runtime,localServiceOrigin(),nativeOwnerHome()));
  }catch(error){results.push({runtime,state:'refused',reason:error instanceof Error?error.message:'unknown'});}
  for(const {id:workspace} of db.query('SELECT id FROM workspaces').all() as {id:string}[])for(const runtime of ['claude_code','codex'] as const) {
    try {
      const connection=reusableConnection(workspace,memoryClientConnectionPath(workspace,runtime));
      const binding=path.join(memoryRoot(),'memory-clients',runtime,'connection.json');
      if(!connection||!fs.existsSync(binding))continue;
      const linked=readJson(binding) as StoredConnection;
      if(linked.agent_id!==connection.agent_id||linked.key!==connection.key)continue;
      results.push(relocateMemoryClient(memoryRoot(),runtime,connection.url,nativeOwnerHome()));
    } catch(error) {results.push({runtime,state:'refused',reason:error instanceof Error?error.message:'unknown'});}
  }
  return results;
}
export async function memorySetupAction(ownerId:string,raw:unknown) {
  const auth=owner(ownerId),input=actions.parse(raw),workspace=auth.workspace_id;
  if(input.action==='cancel-login'){logins.get(workspace)?.cancel?.();return {state:'cancelled'};}
  if(input.action==='login-code'){
    const state=logins.get(workspace);if(state?.state!=='waiting'||!state.submit)throw new QoopiaError('CONFLICT','No sign-in is waiting');
    state.submit(input.code);state.submit=undefined;return {state:'submitted'};
  }
  if(busy.has(workspace))throw new QoopiaError('CONFLICT','A memory setup action is running');
  busy.add(workspace);
  try {
    if(input.action==='select'){await provision(input.runtime);selectMemoryProfile(workspace,input.runtime);
      // Sessions parked without a usable profile resume at once.
      db.query("UPDATE sessions SET metadata=json_remove(metadata,'$.continuity_retry_at','$.continuity_error','$.continuity_backoff') WHERE workspace_id=?").run(workspace);
      return memorySetupState(ownerId);}
    if(input.action==='connect-agent') {
      // An installed Qoopia links its own computer over loopback. Another computer reaches it only through the
      // external (tunnel) address, with its own agent and key so either side can be revoked alone.
      const remote=input.target==='another_computer'&&process.env.QOOPIA_STANDALONE==='true';
      if(remote&&!env.PUBLIC_URL.startsWith('https://'))throw new QoopiaError('NOT_READY','Enable external access first: another computer reaches this installation only through its external address',
        {next_action:'Open Connections, enable external access, then download the file for another computer again.'});
      const origin=remote?new URL(env.PUBLIC_URL).origin:localServiceOrigin();
      const name=(input.runtime==='codex'?'Qoopia Codex memory':'Qoopia Claude memory')+(remote?' remote':'');
      const local=memoryClientConnectionPath(workspace,input.runtime),file=remote?local.replace(/\.json$/,'-remote.json'):local;privateDirectory(path.dirname(file));
      let connection=reusableConnection(workspace,file,origin);
      if(!connection) {
        const ws=db.query('SELECT slug FROM workspaces WHERE id=?').get(workspace) as {slug:string};
        const created=createAgent({name,workspaceSlug:ws.slug,type:'standard'});
        // A memory client's model reads over the same key while its hooks capture: Autosave never asks it.
        db.query("UPDATE agents SET tool_profile='no-destructive',legacy_skill_access=0,metadata=json_set(metadata,'$.memory_client',?) WHERE id=?").run(input.runtime,created.id);
        connection={format:'qoopia-memory-connection/1',url:origin,agent_id:created.id,key:created.api_key,runtime:input.runtime};
        durableWrite(file,JSON.stringify(connection));
      }
      if(process.env.QOOPIA_STANDALONE==='true'&&!remote)return installMemoryClient(connection,memoryRoot(),process.execPath,nativeOwnerHome(),selectedNativeDirectory(connection.runtime));
      // Returned only to the human owner's same-origin download action. Never log.
      return {state:'download_connection',connection};
    }
    const profile=memoryProfile(workspace);if(!profile)throw new QoopiaError('NOT_READY','Choose Claude or ChatGPT first');
    if(input.action==='login'){await login(workspace,profile);return {state:'waiting'};}
    const result=await memoryText(workspace,'Return exactly OK in result.',{purpose:'Qoopia subscription connection check'});
    if(result.text!=='OK')throw new QoopiaError('MODEL_INVALID_RESPONSE','Unexpected connection check response');
    // Owner fixed the dependency: pending checkpoints can now resume immediately.
    db.query("UPDATE sessions SET metadata=json_remove(metadata,'$.continuity_retry_at','$.continuity_error','$.continuity_backoff') WHERE workspace_id=?").run(workspace);
    return memorySetupState(ownerId);
  } finally {if(logins.get(workspace)?.state!=='waiting')busy.delete(workspace);}
}
