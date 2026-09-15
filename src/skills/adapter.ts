import { assetPath } from "../utils/assets.ts";
import {nativeCommand} from '../utils/native-command.ts';
import { prepareNativeKeychain } from '../delivery/native-keychain.ts';
import { readJsonBytes } from '../delivery/files.ts';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { join, relative, isAbsolute, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/middleware.ts';
import { authorize } from '../auth/policy.ts';
import { QoopiaError } from '../utils/errors.ts';
import { redactSensitive } from '../utils/secret-guard.ts';
import { canonical, digest, command } from './commands.ts';
import { RUNTIMES, registration, reporter, loadoutOf, entriesOf, currentAssignmentPermission, sessionOpen, type RuntimeKind } from './loop.ts';
import { claimProjection, checkClaim, withProjectionClaim, failProjection, observeRuntime, authorizeRun, recordOutcome, evaluatorSchema, nativeOptionsSchema, nativeModelStatus, type NativeOptions, type NativeModelEvidence } from './runtime.ts';
import { bindNativeConnection, connectionLaunch, nativeMcpTools, type BoundConnection } from './connection.ts';
import { materializeOwned, existingRoot, hashTree, createRunSnapshot, createStrictCodexRunSnapshot, codexBookkeepingBinary, recoverProjection, removeOwned,previewAdoption,adoptOwned } from './native.ts';

export function bindManagedRoot(database:Database,auth:AuthContext,runtimeId:string,rootArg:string){
  const p=authorize(database,auth,'owner'),r=registration(database,p.workspace_id,runtimeId),root=existingRoot(rootArg);
  if(lstatSync(root).uid!==process.getuid?.())throw new QoopiaError('FORBIDDEN','Root must belong to the local operator');
  if(r.managed_root&&r.managed_root!==root)throw new QoopiaError('CONFLICT','Runtime root is already bound; enroll a new runtime instead of moving frozen sessions');
  const installation=(database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  return command(database,auth,'owner','runtime_bind',`bind-${digest(r.id+root)}`,{runtime_id:r.id,root_digest:digest(root)},r.id,
    principal=>{const current=registration(database,principal.workspace_id,r.id);if(current.managed_root&&current.managed_root!==root)throw new QoopiaError('CONFLICT','Runtime root is already bound');},()=>{
      const other=database.query('SELECT 1 FROM runtime_registrations WHERE managed_root=? AND id!=?').get(root,r.id);
      if(other)throw new QoopiaError('CONFLICT','Root is bound to another runtime');
      recoverProjection(root,installation,r.id);
      database.query('UPDATE runtime_registrations SET managed_root=? WHERE id=? AND workspace_id=?').run(root,r.id,p.workspace_id);
      return {data:{runtime_id:r.id,root,state:'bound',native_permissions:'default'},revision:r.revision};
    }).data;
}
function context(database:Database,auth:AuthContext,loadoutId:string){
  const l=loadoutOf(database,auth.workspace_id,loadoutId),r=reporter(database,auth,l.runtime_id);
  if(!r.managed_root)throw new QoopiaError('NOT_READY','Owner must bind an explicit disposable/local managed root first');
  const root=existingRoot(r.managed_root),installation=(database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  return {l,r,root,installation};
}
export function materializeSession(database:Database,auth:AuthContext,loadoutId:string){
  const {l,r,root,installation}=context(database,auth,loadoutId),entries=entriesOf(database,l.id);
  if(!entries.length)throw new QoopiaError('NOT_READY','Session has no active assignments');
  const complete=entries.every(e=>database.query("SELECT 1 FROM runtime_observations WHERE entry_id=? AND kind='projection_readback' AND stale=0").get(e.id));
  if(complete){
    recoverProjection(root,installation,r.id);
    for(const e of entries){const p=currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));
      if(digest(canonical(hashTree(join(root,'sessions',l.id,RUNTIMES[l.runtime_kind].skills,e.slot))))!==p.projection_digest)throw new QoopiaError('MANUAL_DRIFT','Frozen session projection changed');}
    return {loadout_id:l.id,entries:entries.map(e=>e.id),state:'projection_readback',replayed:true};
  }
  const claim=claimProjection(auth,{loadout_id:l.id,expected_revision:0,idempotency_key:randomUUID()},database).data;
  try{
    withProjectionClaim(database,auth,claim,()=>{
      for(const e of entries){
        const projected=currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));
        materializeOwned({root,installation,runtime:r.id,target:`sessions/${l.id}/${RUNTIMES[l.runtime_kind].skills}/${e.slot}`,
          skill_id:projected.v.skill_id,version_id:e.version_id,projection_digest:e.projection_digest,operation_id:claim.outbox_id,epoch:claim.token,
          files:projected.members,guard:()=>{checkClaim(database,auth,claim);currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));}});
      }
      for(const e of entries)observeRuntime(auth,{loadout_id:l.id,entry_id:e.id,version_id:e.version_id,projection_digest:e.projection_digest,
        kind:'projection_readback',event_id:`${claim.outbox_id}:${e.id}:${claim.token}`,observed_at_ms:Date.now(),evidence:{subtype:'readback',claim},
        expected_revision:0,idempotency_key:randomUUID()},database);
    });
  }catch(error){try{failProjection(database,auth,claim,(error as QoopiaError).code??'PROJECTION_FAILED');}catch{/* Preserve original failure when revoke has already fenced the claim. */}throw error;}
  return {loadout_id:l.id,entries:entries.map(e=>e.id),state:'projection_readback',replayed:false};
}
export function openManagedSession(database:Database,auth:AuthContext,runtimeId:string,nativeRef:string,qoopiaSession:string){
  const result=sessionOpen(auth,{runtime_id:runtimeId,native_session_ref:nativeRef,qoopia_session_id:qoopiaSession,expected_revision:0,idempotency_key:`open-${digest(nativeRef+qoopiaSession)}`},database);
  return materializeSession(database,auth,result.data.loadout_id);
}
export function removeSessionProjection(database:Database,auth:AuthContext,loadoutId:string){
  const {l,r,root,installation}=context(database,auth,loadoutId);
  if(database.query("SELECT 1 FROM skill_runs run WHERE run.loadout_id=? AND NOT EXISTS(SELECT 1 FROM runtime_observations o WHERE o.run_id=run.id AND o.kind='closed')").get(l.id))throw new QoopiaError('CONFLICT','Close or reconcile active/unknown runs before removing their frozen files');
  return entriesOf(database,l.id).map(e=>removeOwned(root,installation,r.id,`sessions/${l.id}/${RUNTIMES[l.runtime_kind].skills}/${e.slot}`,()=>{reporter(database,auth,r.id);}));
}
export const QUALIFICATION_MODELS = {
  codex:{model:'gpt-6-astra',effort:'high'},claude_code:{model:'claude-opus-5',effort:'high'},
} as const;
export function nativeOptions(kind:RuntimeKind,input:unknown):NativeOptions{
  const parsed=nativeOptionsSchema.safeParse(input);
  if(!parsed.success||!parsed.data.model.startsWith(kind==='codex'?'gpt-':'claude-'))
    throw new QoopiaError('INVALID_INPUT','Explicit auth_mode, exact runtime model and effort are required');
  const o=parsed.data;
  if(o.connection&&o.auth_mode!=='subscription-store'&&!(kind==='claude_code'&&o.auth_mode==='subscription'))
    throw new QoopiaError('INVALID_INPUT','Installed native connections require explicit subscription-store or Claude subscription; no API or automatic fallback');
  if(o.configured_profile_functional&&(kind!=='codex'||o.auth_mode!=='subscription-store'||o.login_backend!=='file'))
    throw new QoopiaError('INVALID_INPUT','Configured-profile functional qualification requires Codex subscription-store with explicit file backend');
  if(o.outer_seatbelt&&(!o.configured_profile_functional||kind!=='codex'||o.outer_seatbelt.installation_id!==join(o.login_store??'','installation_id')||o.outer_seatbelt.arg0!==join(o.login_store??'','tmp/arg0')))
    throw new QoopiaError('INVALID_INPUT','Outer Seatbelt requires explicit configured Codex and the exact two selected-store exceptions');
  if(o.task_write_directory&&kind==='codex'&&o.outer_seatbelt)
    throw new QoopiaError('UNSUPPORTED','Codex task writes cannot safely combine with the broad outer Seatbelt; nested sandboxing is forbidden');
  if(o.auth_mode==='subscription-store'){
    if(kind==='codex'?(!o.login_store||!['file','keyring'].includes(o.login_backend??'')):
      !(o.login_backend==='config-dir'&&o.login_store||o.login_backend==='default-keychain'&&!o.login_store))
      throw new QoopiaError('INVALID_INPUT','Select an explicit native login backend and its directory; no ambient profile discovery');
  }else if(o.login_store!==undefined||o.login_backend!==undefined)
    throw new QoopiaError('INVALID_INPUT','Login store selection requires subscription-store mode');
  return parsed.data;
}
function metadataExists(path:string){
  try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw new QoopiaError('FORBIDDEN','Native context metadata unavailable');}
}
function taskWriteRule(sessionRoot:string,taskDirectory:string){
  // Exact generated child, canonical parent, no glob/rule metacharacters from a path.
  const name=relative(sessionRoot,taskDirectory);
  if(!/^task-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)||
    taskDirectory!==join(sessionRoot,name)||!/^\/[A-Za-z0-9_./-]+$/.test(taskDirectory)||realpathSync(sessionRoot)!==sessionRoot)
    throw new QoopiaError('FORBIDDEN','Task write scope must be one canonical generated task directory');
  if(metadataExists(taskDirectory)){
    const stat=lstatSync(taskDirectory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||realpathSync(taskDirectory)!==taskDirectory)
      throw new QoopiaError('FORBIDDEN','Task write scope changed or is not an owned canonical directory');
  }
  // Claude Edit(path) covers both Write and Edit; a single / is settings-relative.
  return `Edit(/${taskDirectory}/**)`;
}
function nativeProcess(kind:RuntimeKind,options:NativeOptions,args:string[]){
  if(!options.outer_seatbelt)return {binary:RUNTIMES[kind].binary,args};
  // The guard verifies policy/paths and actual OS controls, then execs sandbox-exec
  // with the SAME inline profile. Never spawn these Codex args without that wrapper.
  const wrapper=assetPath('scripts/runtime/codex-seatbelt.py');
  return {binary:'/usr/bin/python3',args:[wrapper,'--guarded-native',JSON.stringify(options.outer_seatbelt),RUNTIMES[kind].binary,...args]};
}
export type NativeToolAccess='assigned'|'none';
export function nativeLaunch(kind:RuntimeKind,sessionRoot:string,prompt:string,input:unknown,source:NodeJS.ProcessEnv=process.env,homeRoot=sessionRoot,boundConnection?:BoundConnection,toolAccess:NativeToolAccess='assigned'){
  // Claude documents --tools "" as disabling all built-ins; pinned Codex has no equivalent.
  if(toolAccess==='none'&&kind==='codex')throw new QoopiaError('UNSUPPORTED','Codex 0.153.3 has no enforceable tool-less exec mode');
  const options=nativeOptions(kind,input),adapter=RUNTIMES[kind],home=join(homeRoot,adapter.home);
  const mcp=toolAccess==='assigned'&&options.connection?connectionLaunch(boundConnection,options.connection,kind,homeRoot):undefined;
  if(options.outer_seatbelt){
    const rel=relative(options.outer_seatbelt.outer_root,sessionRoot);
    if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new QoopiaError('FORBIDDEN','Native session must be inside its bound outer Seatbelt root');
  }
  const store=options.auth_mode==='subscription-store';
  const credentialName=options.auth_mode==='subscription'?(kind==='codex'?'CODEX_ACCESS_TOKEN':'CLAUDE_CODE_OAUTH_TOKEN'):
    (kind==='codex'?'CODEX_API_KEY':'ANTHROPIC_API_KEY');
  // OPENAI_API_KEY remains an explicit API-mode compatibility input only.
  const credential=store?undefined:source[credentialName]??(options.auth_mode==='api-key'&&kind==='codex'?source.OPENAI_API_KEY:undefined);
  if(!store&&(!credential||credential.length>16384||! /^[A-Za-z0-9._~+/-]+={0,2}$/.test(credential)))
    throw new QoopiaError('UNAUTHENTICATED',`Native ${options.auth_mode} authentication unavailable: operator-provided ${credentialName} required; no login-store reuse or billing fallback`);
  if(store){
    if(options.login_backend==='default-keychain'&&process.platform!=='darwin')throw new QoopiaError('UNSUPPORTED','Default Claude keychain selection requires macOS');
    if(options.login_store){
      // Metadata only: never read/list credentials or native profile contents.
      let stat;try{stat=lstatSync(options.login_store);}catch{throw new QoopiaError('UNAUTHENTICATED','Selected login directory unavailable; no discovery or creation');}
      if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||realpathSync(options.login_store)!==resolve(options.login_store))throw new QoopiaError('FORBIDDEN','Selected login directory must be an operator-owned directory, not a symlink');
      // arg0 loads this before CLI ignore flags; never inspect or import its values.
      if(options.configured_profile_functional&&metadataExists(join(options.login_store,'.env')))
        throw new QoopiaError('UNSUPPORTED','Selected CODEX_HOME has .env; native startup cannot ignore its environment overrides');
      // ignore-user-config keeps a User layer: its legacy skills root still loads.
      // Strict refuses without scanning; owner opt-in permits this native User root.
      if(kind==='codex'&&!options.configured_profile_functional&&metadataExists(join(options.login_store,'skills')))
        throw new QoopiaError('UNSUPPORTED','Selected CODEX_HOME has a skills directory; 0.153.3 cannot isolate it from frozen project discovery without inspecting or modifying the profile');
    }
  }
  const env:NodeJS.ProcessEnv={PATH:source.PATH,LANG:'en_US.UTF-8',HOME:homeRoot,TMPDIR:join(homeRoot,'tmp'),
    XDG_CONFIG_HOME:join(homeRoot,'xdg-config'),XDG_CACHE_HOME:join(homeRoot,'xdg-cache'),XDG_DATA_HOME:join(homeRoot,'xdg-data'),
    [adapter.env]:store&&options.login_store?options.login_store:home,...(credential?{[credentialName]:credential}:{})};
  // macOS's default keychain service is selected by an *unset* CONFIG_DIR.
  // HOME stays disposable: no real ~/.claude.json, skills or hooks are imported.
  if(store&&options.login_backend==='default-keychain')delete env.CLAUDE_CONFIG_DIR;
  const args=kind==='codex'?['exec','--json','--skip-git-repo-check','--ignore-user-config','--ephemeral','--model',options.model,
    '-c',`model_reasoning_effort="${options.effort}"`,'-c',`forced_login_method="${options.auth_mode==='api-key'?'api':'chatgpt'}"`,
    '-c',`cli_auth_credentials_store="${store?options.login_backend:'file'}"`,'-c','check_for_update_on_startup=false',
    '-c','shell_environment_policy.exclude=["*TOKEN*","*KEY*","*SECRET*"]']:
    [...(options.auth_mode==='api-key'?['--bare']:[]),'--print','--output-format','stream-json','--verbose','--no-session-persistence',
      '--model',options.model,'--effort',options.effort,'--setting-sources','project','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
      '--settings','{"disableAllHooks":true,"autoMemoryEnabled":false,"disableClaudeAiConnectors":true,"disableBundledSkills":true}',
      '--no-chrome','--tools',toolAccess==='none'?'':'Read,Write,Edit,Bash,Skill'];
  if(store&&kind==='codex')args.push('--ignore-rules','-c','skills.include_instructions=true','-c','skills.bundled.enabled=false',
    '-c','features.plugins=false','-c','features.apps=false','-c','features.multi_agent=false','-c','features.hooks=false','-c','features.memories=false','-c','project_doc_max_bytes=0');
  if(options.configured_profile_functional)args.push('-c',`log_dir=${JSON.stringify(join(homeRoot,'logs'))}`,
    '-c',`sqlite_home=${JSON.stringify(join(homeRoot,'sqlite'))}`,'-c','features.shell_snapshot=false','-c','features.shell_snapshot_v2=false');
  if(options.outer_seatbelt)args.push('--sandbox','danger-full-access','-c','approval_policy="never"','-c','approvals_reviewer="user"');
  if(store&&kind==='claude_code'){
    const index=args.indexOf('--settings')+1;
    args[index]=JSON.stringify({...JSON.parse(args[index]!),forceLoginMethod:'claudeai'});
    Object.assign(env,{CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',DISABLE_DOCTOR_COMMAND:'1'});
  }
  if(kind==='claude_code')Object.assign(env,{CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',CLAUDE_CODE_DISABLE_TERMINAL_TITLE:'1',CLAUDE_CODE_DISABLE_POLICY_SKILLS:'1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:'1',DISABLE_DOCTOR_COMMAND:'1'});
  if(options.task_write_directory){
    const rule=taskWriteRule(sessionRoot,options.task_write_directory);
    if(kind==='claude_code'){
      const index=args.indexOf('--settings')+1;
      args[index]=JSON.stringify({...JSON.parse(args[index]!),permissions:{defaultMode:'default',allow:[rule]}});
    }else args.push('--sandbox','workspace-write','-c','sandbox_workspace_write.network_access=false',
      '-c','sandbox_workspace_write.exclude_slash_tmp=true','-c','sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c','sandbox_workspace_write.writable_roots=[]');
  }
  if(mcp){
    if(kind==='claude_code'){
      args[args.indexOf('--mcp-config')+1]=mcp.file;
      const index=args.indexOf('--settings')+1,settings=JSON.parse(args[index]!);
      settings.permissions={...settings.permissions,defaultMode:'default',
        allow:[...(settings.permissions?.allow??[]),...nativeMcpTools.map(name=>'mcp__qoopia__'+name)],
        deny:[`Read(/${mcp.file})`,`Edit(/${mcp.file})`]};
      args[index]=JSON.stringify(settings);
    }else{
      args.push('-c',`mcp_servers.qoopia.url=${JSON.stringify(mcp.endpoint)}`,
        '-c','mcp_servers.qoopia.env_http_headers={Authorization="QOOPIA_NATIVE_MCP_AUTH"}',
        '-c',`mcp_servers.qoopia.enabled_tools=${JSON.stringify(nativeMcpTools)}`,
        '-c','mcp_servers.qoopia.default_tools_approval_mode="prompt"',
        ...nativeMcpTools.flatMap(name=>['-c',`mcp_servers.qoopia.tools.${name}.enabled=true`,
          '-c',`mcp_servers.qoopia.tools.${name}.approval_mode="approve"`]));
      args[args.indexOf('shell_environment_policy.exclude=["*TOKEN*","*KEY*","*SECRET*"]')]='shell_environment_policy.exclude=["*TOKEN*","*KEY*","*SECRET*","QOOPIA_NATIVE_MCP_AUTH"]';
      env.QOOPIA_NATIVE_MCP_AUTH=mcp.bearer;
    }
  }
  // Claude's variadic --tools must end before the positional prompt.
  if(kind==='claude_code')args.push('--');
  args.push(prompt);
  // The sole credential travels only to the official CLI environment. Accidental
  // JSON/console serialization of this launch description cannot expose it.
  const scrub=(text:string)=>[credential,mcp?.bearer,mcp?.bearer.slice(7)].filter((s):s is string=>!!s)
    .reduce((value,secret)=>value.split(secret).join('[NATIVE_AUTH_REDACTED]'),text);
  const launch={...nativeProcess(kind,options,args),cwd:kind==='codex'&&options.task_write_directory?options.task_write_directory:sessionRoot,home,options,scrub,redact:(text:string)=>redactSensitive(scrub(text)).text};
  Object.defineProperty(launch,'connectionConfig',{value:mcp&&kind==='claude_code'?{file:mcp.file,bytes:mcp.bytes}:undefined,enumerable:false});
  return Object.defineProperty(launch,'env',{value:env,enumerable:false}) as typeof launch & {env:NodeJS.ProcessEnv;connectionConfig?:{file:string;bytes:string}};
}
function checkNativeHostPolicy(kind:RuntimeKind,store:boolean){
  // Managed policy outranks --settings. Do not read, import or override it to
  // qualify a disposable task. Remote/MDM policy still needs operator checking.
  const policyRoot=process.platform==='darwin'?'/Library/Application Support/ClaudeCode':'/etc/claude-code';
  if(kind==='claude_code'&&['managed-settings.json','managed-settings.d','managed-mcp.json'].some(name=>metadataExists(join(policyRoot,name))))
    throw new QoopiaError('UNSUPPORTED','Managed Claude policy detected; use a separately authorized clean qualification environment, never disable required policy');
  if(store&&kind==='codex'&&['config.toml','requirements.toml','managed_config.toml','skills'].some(name=>metadataExists(join('/etc/codex',name))))
    throw new QoopiaError('UNSUPPORTED','Codex system configuration detected; qualification must not import or override unrelated system policy');
}
/** Whitelist auth-status metadata; never persist raw CLI output/account details.
 * This is a local credential-source check, not proof of a paid runtime response. */
export function nativeSubscriptionStatus(kind:RuntimeKind,code:number|null,stdout:string,stderr:string){
  if(code!==0)return false;
  if(kind==='codex')return (stdout+stderr).trim()==='Logged in using ChatGPT';
  try{const s=JSON.parse(stdout);return s.loggedIn===true&&s.authMethod==='claude.ai'&&s.apiProvider==='firstParty'&&
    (s.apiKeySource===undefined||s.apiKeySource==='none')&&['pro','max','team','enterprise'].includes(s.subscriptionType);
  }catch{return false;}
}
async function checkNativeVersion(kind:RuntimeKind,launch:ReturnType<typeof nativeLaunch>){
  const env={...launch.env,[RUNTIMES[kind].env]:launch.home};
  for(const key of ['CODEX_ACCESS_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CODEX_API_KEY','ANTHROPIC_API_KEY'])delete env[key];
  const command=nativeProcess(kind,launch.options,['--version']);
  const probe=await nativeCommand(command.binary,command.args,{cwd:launch.cwd,env,timeout:10_000,maxBuffer:64*1024});
  const expected=kind==='codex'?`codex-cli ${RUNTIMES.codex.version}`:`${RUNTIMES.claude_code.version} (Claude Code)`;
  if(probe.status!==0||probe.stdout?.trim()!==expected)throw new QoopiaError('UNSUPPORTED','Installed runtime version changed or executable is unavailable');
}
export async function preflightNativeSubscription(kind:RuntimeKind,launch:ReturnType<typeof nativeLaunch>){
  if(launch.options.auth_mode!=='subscription-store')throw new QoopiaError('INVALID_INPUT','Native login preflight requires subscription-store');
  if(launch.options.configured_profile_functional)throw new QoopiaError('UNSUPPORTED','Configured profile uses exec forced ChatGPT auth, not login status: status cannot ignore user config; auth source remains unverified');
  checkNativeHostPolicy(kind,true);
  // login status lacks exec's ignore-user-config: do not let its config loader
  // import a selected profile/proxy. No credential inspection can replace it.
  if(kind==='codex'&&metadataExists(join(launch.options.login_store!,'config.toml'))){
    // exec ignores user config, but writes project trust back to the native store.
    // login status may read these inert records; provider/profile overrides still refuse.
    try{
      z.object({projects:z.record(z.string().refine(isAbsolute),z.object({trust_level:z.literal('trusted')}).strict())}).strict()
        .parse(Bun.TOML.parse(readJsonBytes(join(launch.options.login_store!,'config.toml')).toString('utf8')));
    }catch{throw new QoopiaError('UNSUPPORTED','Codex login status cannot ignore selected config.toml; only native project-trust records are supported');}
  }
  if(kind==='claude_code')await prepareNativeKeychain(launch.env.HOME!);
  await checkNativeVersion(kind,launch);
  const args=kind==='codex'?['-c',`cli_auth_credentials_store="${launch.options.login_backend}"`,'login','status']:
    // auth status does not run a task. It uses the already isolated cwd/HOME and explicit login store.
    // Root --mcp-config is variadic and consumes trailing "auth status" as config paths.
    ['auth','status'];
  const status=await nativeCommand(launch.binary,args,{cwd:launch.cwd,env:launch.env,timeout:10_000,maxBuffer:64*1024});
  if(!nativeSubscriptionStatus(kind,status.status,status.stdout??'',status.stderr??''))
    throw new QoopiaError('UNAUTHENTICATED','Selected native login is not a confirmed subscription; no task, login, logout or billing fallback');
  return {status:'subscription_source_confirmed',runtime:kind,actual_model:'unknown',native_task_invocations:0} as const;
}
/** No copying/symlinking of login stores or discovery of ancestor customizations.
 * A fresh per-attempt HOME is created only after current authority is checked. */
export function prepareNativeSession(sessionRoot:string,homeRoot:string){
  for(let parent=dirname(sessionRoot);;parent=dirname(parent)){
    for(const name of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md','.claude','.codex','.agents','.mcp.json'])
      if(existsSync(join(parent,name)))throw new QoopiaError('CONFLICT','Ancestor native customization detected; use an isolated parent without agent configuration');
    if(parent===dirname(parent))break;
  }
  for(const name of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md','.mcp.json','.codex','.claude-plugin'])
    if(existsSync(join(sessionRoot,name)))throw new QoopiaError('CONFLICT','Session contains unrelated native configuration; open a clean managed session');
  for(const name of ['.claude','.agents']){
    const dir=join(sessionRoot,name);
    if(existsSync(dir)&&(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory()||readdirSync(dir).some(child=>child!=='skills')))
      throw new QoopiaError('CONFLICT','Session contains unrelated native configuration; open a clean managed session');
  }
  // A minimal empty Git repository bounds official project skill discovery.
  // No git templates, hooks, user config or external git process are involved.
  const git=join(sessionRoot,'.git'),files=new Map([['HEAD',Buffer.from('ref: refs/heads/p2\n')],
    ['config',Buffer.from('[core]\nrepositoryformatversion = 0\nbare = false\n')]]);
  if(existsSync(git)){
    if(lstatSync(git).isSymbolicLink()||canonical(hashTree(git))!==canonical(Object.fromEntries([...files].map(([n,b])=>[n,{sha256:digest(b),size:b.length}]))))
      throw new QoopiaError('MANUAL_DRIFT','Native repository boundary changed; no overwrite');
  }else{
    mkdirSync(git,{mode:0o700});for(const dir of ['objects','refs'])mkdirSync(join(git,dir),{mode:0o700});
    for(const [name,bytes] of files)writeFileSync(join(git,name),bytes,{flag:'wx',mode:0o600});
  }
  if(!isAbsolute(homeRoot)||!relative(sessionRoot,homeRoot)||relative(sessionRoot,homeRoot).startsWith('..')||existsSync(homeRoot))
    throw new QoopiaError('CONFLICT','Native HOME must be a new directory inside the managed session');
  mkdirSync(homeRoot,{mode:0o700});
}
/** Claude response metadata is evidence; init model/request flags/self-report are
 * not. Codex 0.153.3 exec JSONL has no model field: remain unknown, never guess. */
export function nativeModelEvidence(kind:RuntimeKind,stdout:string):NativeModelEvidence{
  const models=new Set<string>();let session='',response=false,complete=false,invalid=false;
  if(kind==='codex'){
    // Public reroute is negative evidence only; no event attests a matching model.
    const rerouted=stdout.split('\n').some(line=>{try{const e=JSON.parse(line);return e?.type==='item.completed'&&e.item?.type==='error'&&typeof e.item.message==='string'&&e.item.message.startsWith('model rerouted: ');}catch{return false;}});
    return {source:'codex_exec',models:[],complete:false,...(rerouted?{rerouted:true as const}:{})};
  }
  for(const line of stdout.split('\n')){
    let e:any;try{e=JSON.parse(line);}catch{if(line.trim())invalid=true;continue;}
    if(!e||typeof e!=='object'||complete){invalid=true;continue;}
    if(e.type==='system'&&e.subtype==='init'&&typeof e.session_id==='string'){if(session&&session!==e.session_id)invalid=true;session=e.session_id;}
    if(e.type==='assistant'){
      if(!session||e.session_id!==session||e.parent_tool_use_id!==null||e.error||e.message?.type!=='message'||e.message.role!=='assistant')invalid=true;
      const model=e.message?.model;
      if(typeof model==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(model)){models.add(model);response=true;}else invalid=true;
    }
    if(e.type==='result'){
      if(!session||!response||e.session_id!==session||e.subtype!=='success'||e.is_error!==false)invalid=true;
      complete=true;
      // When usage metadata is emitted, every billed model must match too.
      if(e.modelUsage!==undefined&&(!e.modelUsage||typeof e.modelUsage!=='object'||Array.isArray(e.modelUsage)))invalid=true;
      for(const model of Object.keys(e.modelUsage??{})){
        if(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(model))models.add(model);else invalid=true;
      }
    }
    if(models.size>32)invalid=true;
  }
  return {source:'claude_response',models:[...models].slice(0,32).sort(),complete:response&&complete&&!invalid};
}
/** Native events must show a tool read/invocation of this actual native location.
 * A model's final text or a receipt-marker echo never supplies that observation. */
export function nativeExecution(kind:RuntimeKind,stdout:string,skillPath:string,frozen?:{content:string;session_root:string;cwd?:string}):{native_session_ref:string;observed:boolean}{
  let ref='',observed=false;const requested=new Set<string>();
  for(const line of stdout.split('\n')){
    let event:any;try{event=JSON.parse(line);}catch{continue;}
    if(!event||typeof event!=='object')continue;
    if(kind==='codex'){
      if(event.type==='thread.started'&&typeof event.thread_id==='string')ref=event.thread_id;
      const item=event.item;
      if(event.type==='item.completed'&&item?.type==='command_execution'&&item.exit_code===0&&typeof item.aggregated_output==='string'&&item.aggregated_output.trim().length>0&&typeof item.command==='string'){
        if(frozen){
          // Bounded native evidence: exact full bytes and one literal cat target.
          // Partial/truncated reads and unfamiliar command shapes stay unobserved.
          const command=item.command.trim().replace(/^(?:\/bin\/)?(?:zsh|bash|sh) -l?c '([^']*)'$/, '$1');
          const paths=[skillPath,...[frozen.session_root,frozen.cwd].filter((root):root is string=>!!root).flatMap(root=>{const path=relative(root,skillPath);return [path,'./'+path];})];
          const reads=paths.flatMap(path=>[path,`'${path}'`,`"${path}"`]).flatMap(path=>[`cat ${path}`,`cat -- ${path}`,`/bin/cat ${path}`]);
          if(reads.includes(command)&&item.aggregated_output===frozen.content)observed=true;
        }else if(item.command.includes(skillPath)&&/^(?:cat|sed|head)\s/.test(item.command.trim())&&!/[;|&`$<>]/.test(item.command))observed=true;
      }
    }else{
      if(typeof event.session_id==='string')ref=event.session_id;
      if(event.type==='assistant')for(const block of event.message?.content??[]){
        if(block.type==='tool_use'&&block.name==='Read'&&block.input?.file_path===skillPath&&typeof block.id==='string')requested.add(block.id);
        if(block.type==='tool_use'&&block.name==='Skill'&&typeof block.input?.skill==='string'&&skillPath.endsWith(`/${block.input.skill}/SKILL.md`)&&typeof block.id==='string')requested.add(block.id);
      }
      if(event.type==='user')for(const block of event.message?.content??[]){
        if(block.type==='tool_result'&&!block.is_error&&requested.has(block.tool_use_id)&&!!block.content?.length)observed=true;
      }
    }
  }
  return {native_session_ref:ref,observed:!!ref&&observed};
}
function inside(root:string,path:string){const r=relative(root,realpathSync(path));return !r.startsWith('..')&&!isAbsolute(r);}
/** Successful native MCP call/result pairs plus an independently read installed note; text/echo alone cannot pass. */
export function nativeMcpEvidence(kind:RuntimeKind,stdout:string,marker:string,noteId:string|undefined){
  const calls:{tool:string;args:Record<string,unknown>;result:unknown}[]=[],pending=new Map<string,{tool:string;args:Record<string,unknown>}>();
  for(const line of stdout.split('\n')){
    let e:any;try{e=JSON.parse(line);}catch{continue;}
    if(kind==='claude_code'){
      if(e?.type==='assistant')for(const block of e.message?.content??[]){
        if(block.type==='tool_use'&&typeof block.id==='string'&&typeof block.name==='string'&&block.name.startsWith('mcp__qoopia__'))
          pending.set(block.id,{tool:block.name.slice('mcp__qoopia__'.length),args:block.input??{}});
      }
      if(e?.type==='user')for(const block of e.message?.content??[]){
        const request=pending.get(block.tool_use_id);
        if(block.type==='tool_result'&&request&&!block.is_error&&block.content?.length)calls.push({...request,result:block.content});
      }
    }else{
      const item=e?.item;
      if(e?.type==='item.completed'&&item?.type==='mcp_tool_call'&&item.server==='qoopia'&&item.status==='completed'&&!item.error&&item.result&&!item.result.isError)
        calls.push({tool:item.tool,args:item.arguments??{},result:item.result});
    }
  }
  const ok=new Set<string>();
  for(const call of calls){
    const text=JSON.stringify(call.result);
    if(call.tool==='qoopia_capabilities'&&text.includes('memory-worker'))ok.add(call.tool);
    if(noteId&&call.tool==='note_create'&&typeof call.args.text==='string'&&call.args.text.includes(marker)&&text.includes(noteId))ok.add(call.tool);
    if(noteId&&call.tool==='note_get'&&call.args.id===noteId&&text.includes(noteId)&&text.includes(marker))ok.add(call.tool);
    if(noteId&&call.tool==='recall'&&call.args.query===marker&&call.args.deep===false&&call.args.deep_llm===false&&text.includes(noteId))ok.add(call.tool);
  }
  return {complete:nativeMcpTools.every(name=>ok.has(name)),tools:[...ok].sort(),...(noteId?{note_id:noteId}:{})};
}
export function csvExpected(text:string){
  const rows=text.trim().split(/\r?\n/);if(rows.shift()!=='category,amount')throw new QoopiaError('INVALID_INPUT','CSV header must be category,amount');
  const counts:Record<string,number>={},totals:Record<string,number>={};let overall=0;
  if(!rows.length||rows.length>1000)throw new QoopiaError('INVALID_INPUT','CSV requires 1..1000 rows');
  for(const row of rows){const [category,amount,...extra]=row.split(',');if(!category||! /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(category)||extra.length||! /^-?\d+(?:\.\d{1,2})?$/.test(amount??'')||!Number.isSafeInteger(Math.round(Number(amount)*100)))throw new QoopiaError('INVALID_INPUT','CSV row must contain a category and a finite decimal amount');
    counts[category]=(counts[category]??0)+1;const cents=Math.round(Number(amount)*100);totals[category]=(totals[category]??0)+cents;overall+=cents;
    if(!Number.isSafeInteger(overall)||!Number.isSafeInteger(totals[category]))throw new QoopiaError('SIZE_LIMIT','CSV sum exceeds exact decimal range');}
  return {counts,totals:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v/100])),overall:overall/100};
}
/** The qualification-only clarification is identical in the prompt and immutable objective. */
export function csvTaskInstructions(kind:RuntimeKind,options:NativeOptions,slot:string,attempt:string,skillPath?:string){
  const configuredRead=kind==='codex'&&options.configured_profile_functional&&options.outer_seatbelt;
  const scopedRead=kind==='codex'&&options.task_write_directory;
  if(scopedRead&&(!skillPath||!isAbsolute(skillPath)))throw new QoopiaError('INVALID_INPUT','Codex task-write requires the canonical frozen skill path');
  const readPath=scopedRead?skillPath:`.agents/skills/${slot}/SKILL.md`;
  const clarification=configuredRead||scopedRead?
    ` Frozen skill read: Before processing CSV, issue a separate tool call from the current managed directory with command exactly \`cat ${readPath}\`. Require full untruncated output, byte-for-byte unchanged, with the tool output limit high enough for the entire file. Use no grouping, discovery or CSV commands in that call; no cd, separators, pipes, filters, redirects or extra output. Do not add your own shell wrapper. If the tool records a wrapper, use /bin/zsh with a single-quoted shell payload exactly as \`/bin/zsh -lc 'cat ${readPath}'\`, not a double-quoted payload. Only after that isolated full read, perform discovery or CSV work in separate calls.`+
    ' Qualification execution: Write required artifacts directly inside the assigned task directory; do not use shell heredocs or temporary files outside that directory. If a write is denied, recover only with an allowed direct-write method inside that same task directory; never bypass the sandbox or change permissions. Before completing, verify that summary.json and refusal.json exist and both parse as JSON. If unable to produce and verify them under the existing policy, report failure honestly.':'';
  const memory=options.connection?` Use only the configured qoopia MCP connection: call qoopia_capabilities; after computing the result, use note_create to save a workspace memory describing this CSV task and including the exact marker qoopianative${attempt.replaceAll('-','')}; call note_get on that note and recall with that marker, scope notes, deep false, deep_llm false. Do not inspect credentials or other servers.`:'';
  return {objective:'Validate and summarize CSV; refuse invalid input; write only inside the managed task directory'+clarification+memory,
    prompt:`Use the ${slot} native skill. Read its SKILL.md through native discovery. In task-${attempt}, summarize input.csv into summary.json. Then validate invalid.csv and record refusal.json; do not create invalid-summary.json. Write only in task-${attempt}. Do not use other agents, subagents, ${options.connection?'external network (except the configured local Qoopia MCP),':'network,'} external services or credentials. Follow the native permission policy; if permission is denied, report that refusal.`+clarification+memory};
}
export interface CsvTaskInput {loadout_id:string;entry_id:string;csv:string;auth_mode?:string;model?:string;effort?:string;login_store?:string;login_backend?:string;allow_task_writes?:boolean;configured_profile_functional?:true;outer_seatbelt?:NativeOptions['outer_seatbelt'];connection?:NativeOptions['connection'];}
/** Same concrete task preparation as execution; no version/auth/model process or run authorization. */
export function prepareCsvTask(database:Database,auth:AuthContext,input:CsvTaskInput,source:NodeJS.ProcessEnv=process.env){
  const {l,r,root}=context(database,auth,input.loadout_id),entry=entriesOf(database,l.id).find(e=>e.id===input.entry_id);
  if(!entry)throw new QoopiaError('NOT_FOUND','Loadout entry not found');
  materializeSession(database,auth,l.id);
  const permission=currentAssignmentPermission(database,JSON.parse(entry.assignment_snapshot));
  if(input.allow_task_writes!==undefined&&typeof input.allow_task_writes!=='boolean')throw new QoopiaError('INVALID_INPUT','Task write opt-in must be explicit boolean');
  if(input.allow_task_writes&&!permission.descriptor.requested_capabilities.includes('file_write_managed'))
    throw new QoopiaError('FORBIDDEN','Native task writes require current exact reviewed file_write_managed capability');
  const expected=csvExpected(input.csv),sessionRoot=join(root,'sessions',l.id);
  if(!inside(root,sessionRoot))throw new QoopiaError('FORBIDDEN','Session root escaped managed root');
  const attempt=randomUUID(),taskDir=join(sessionRoot,`task-${attempt}`),homeRoot=join(sessionRoot,`native-${attempt}`);
  const options=nativeOptions(l.runtime_kind,{...(input.connection?{connection:input.connection}:{}),...(input.outer_seatbelt!==undefined?{outer_seatbelt:input.outer_seatbelt}:{}),...(input.configured_profile_functional!==undefined?{configured_profile_functional:input.configured_profile_functional}:{}),...(input.allow_task_writes?{task_write_directory:taskDir}:{}),auth_mode:input.auth_mode,model:input.model,effort:input.effort,
    ...(input.login_store!==undefined?{login_store:input.login_store}:{}),...(input.login_backend!==undefined?{login_backend:input.login_backend}:{})});
  const {objective,prompt}=csvTaskInstructions(l.runtime_kind,options,entry.slot,attempt,join(sessionRoot,RUNTIMES[l.runtime_kind].skills,entry.slot,'SKILL.md'));
  const evaluator=evaluatorSchema.parse({kind:'json-artifacts/1',native:options,objective,cases:[
    {name:'valid_summary',path:'summary.json',expected}, {name:'invalid_refusal',path:'refusal.json',expected:{status:'refused',reason:'invalid_amount'},absent:['invalid-summary.json']} ]});
  const connectionExpected={runtime_id:l.runtime_id,runtime_kind:l.runtime_kind,workspace_id:auth.workspace_id};
  const bound=options.connection?bindNativeConnection(database,options.connection,connectionExpected):undefined;
  const launch=nativeLaunch(l.runtime_kind,sessionRoot,prompt,options,source,homeRoot,bound);
  checkNativeHostPolicy(l.runtime_kind,options.auth_mode==='subscription-store');
  // Every discoverable project skill must belong to this exact frozen loadout.
  const slots=entriesOf(database,l.id).map(e=>e.slot+'/');
  if(Object.keys(hashTree(join(sessionRoot,RUNTIMES[l.runtime_kind].skills))).some(path=>!slots.some(slot=>path.startsWith(slot))))
    throw new QoopiaError('MANUAL_DRIFT','Unowned native skill in session; no activation');
  prepareNativeSession(sessionRoot,homeRoot);
  mkdirSync(taskDir,{mode:0o700});
  writeFileSync(join(taskDir,'input.csv'),input.csv,{flag:'wx',mode:0o600});writeFileSync(join(taskDir,'invalid.csv'),'category,amount\nA,not-a-number\n',{flag:'wx',mode:0o600});
  for(const dir of [launch.home,launch.env.TMPDIR!,launch.env.XDG_CONFIG_HOME!,launch.env.XDG_CACHE_HOME!,launch.env.XDG_DATA_HOME!]){
    if(existsSync(dir)){if(lstatSync(dir).isSymbolicLink()||!inside(root,dir))throw new QoopiaError('MANUAL_DRIFT','Runtime home is not managed');}else mkdirSync(dir,{mode:0o700});
  }
  // Pin exact attempt-owned directories before vendor probes can add bookkeeping.
  // Prior configured attempts also remain in this root across update/rollback.
  const priorHomes=options.configured_profile_functional?database.query(`SELECT run.loadout_id,run.attempt_id FROM skill_runs run
    JOIN session_loadouts l ON l.id=run.loadout_id WHERE l.runtime_id=? AND l.workspace_id=?
    AND json_extract(run.evaluator_json,'$.native.configured_profile_functional')=1`).all(l.runtime_id,auth.workspace_id) as {loadout_id:string;attempt_id:string}[]:[];
  const snapshot=options.configured_profile_functional?createRunSnapshot(root,[...priorHomes,{loadout_id:l.id,attempt_id:attempt}]):()=>hashTree(root);
  if(launch.connectionConfig)writeFileSync(launch.connectionConfig.file,launch.connectionConfig.bytes,{mode:0o600,flag:'wx'});
  return {l,r,root,entry,permission,expected,sessionRoot,attempt,taskDir,homeRoot,options,evaluator,launch,snapshot,connectionExpected};
}
/** Called only on an explicit operator invocation. The builder never calls it as an AI worker. */
export async function runCsvTask(database:Database,auth:AuthContext,input:CsvTaskInput,source:NodeJS.ProcessEnv=process.env){
  const {l,root,homeRoot,entry,permission,sessionRoot,attempt,taskDir,options,evaluator,launch,snapshot:initialSnapshot,connectionExpected}=prepareCsvTask(database,auth,input,source);
  const r=registration(database,auth.workspace_id,l.runtime_id);
  if(options.auth_mode==='subscription-store'&&!options.configured_profile_functional)await preflightNativeSubscription(l.runtime_kind,launch);
  else await checkNativeVersion(l.runtime_kind,launch);
  let snapshot=initialSnapshot;
  if(l.runtime_kind==='codex'&&!options.configured_profile_functional&&existsSync(join(homeRoot,'.codex/tmp/arg0'))){
    const installed=codexBookkeepingBinary(homeRoot);
    const prior=database.query(`SELECT run.loadout_id,run.attempt_id FROM skill_runs run
      JOIN session_loadouts l ON l.id=run.loadout_id WHERE l.runtime_id=? AND l.workspace_id=?`)
      .all(l.runtime_id,auth.workspace_id) as {loadout_id:string;attempt_id:string}[];
    const withAliases=prior.filter(a=>existsSync(join(root,'sessions',a.loadout_id,`native-${a.attempt_id}`,'.codex/tmp/arg0')));
    snapshot=createStrictCodexRunSnapshot(root,[...withAliases,{loadout_id:l.id,attempt_id:attempt}],installed);
  }
  const environment=digest(canonical({kind:l.runtime_kind,version:l.runtime_version,platform:r.platform,capabilities:l.capabilities_digest,native:options,isolation:'disposable-home/1'}));
  const authorized=authorizeRun(auth,{loadout_id:l.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest,
    attempt_id:attempt,evaluator,environment_digest:environment,expected_revision:0,idempotency_key:randomUUID()},database);
  const skillPath=join(sessionRoot,RUNTIMES[l.runtime_kind].skills,entry.slot,'SKILL.md');
  // This run has an immutable authorization record before spawn. A crash does
  // not replay the external effect; the unclosed attempt remains unknown.
  const before=snapshot();let stdout='',stderr='',overflow=false;
  currentAssignmentPermission(database,JSON.parse(entry.assignment_snapshot));
  const checkConnection=()=>{
    if(options.connection)bindNativeConnection(database,options.connection,connectionExpected);
    if(launch.connectionConfig){
      const stat=lstatSync(launch.connectionConfig.file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)||stat.uid!==process.getuid?.()||readFileSync(launch.connectionConfig.file,'utf8')!==launch.connectionConfig.bytes)
        throw new QoopiaError('MANUAL_DRIFT','Native connection projection changed');
    }
  };
  checkConnection();
  if(authorized.data.authorization_expires_at_ms<=Date.now())throw new QoopiaError('EXPIRED','Run authorization expired before spawn');
  if(options.task_write_directory)taskWriteRule(sessionRoot,options.task_write_directory);
  const child=spawn(launch.binary,launch.args,{cwd:launch.cwd,env:launch.env,stdio:['ignore','pipe','pipe']});
  const collect=(which:'stdout'|'stderr',chunk:Buffer)=>{if(stdout.length+stderr.length+chunk.length>8*1024*1024){overflow=true;child.kill('SIGTERM');return;}if(which==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
  child.stdout.on('data',b=>collect('stdout',b));child.stderr.on('data',b=>collect('stderr',b));
  const deadline=setTimeout(()=>child.kill('SIGTERM'),300_000);
  const hardDeadline=setTimeout(()=>child.kill('SIGKILL'),310_000);
  let revoked=false;
  const refresh=setInterval(()=>{try{currentAssignmentPermission(database,JSON.parse(entry.assignment_snapshot));checkConnection();}catch{revoked=true;/* Native safe cancellation is not claimed. No further launch is permitted. */}},30_000);
  const exitCode=await new Promise<number|null>((resolve,reject)=>{child.once('error',()=>reject(new QoopiaError('DEPENDENCY_UNAVAILABLE','Native CLI failed to start; no automatic retry')));child.once('close',resolve);}).finally(()=>{clearTimeout(deadline);clearTimeout(hardDeadline);clearInterval(refresh);});
  const modelEvidence=nativeModelEvidence(l.runtime_kind,launch.scrub(stdout));
  if(exitCode!==0||overflow)modelEvidence.complete=false;
  const modelStatus=nativeModelStatus(options.model,modelEvidence);
  try{checkConnection();}catch{revoked=true;}
  const marker='qoopianative'+attempt.replaceAll('-','');
  const notes=options.connection?database.query('SELECT id FROM notes WHERE workspace_id=? AND agent_id=? AND instr(text,?)>0')
    .all(auth.workspace_id,options.connection.agent_id,marker) as {id:string}[]:[];
  const mcp=options.connection?nativeMcpEvidence(l.runtime_kind,launch.scrub(stdout),marker,notes.length===1?notes[0]!.id:undefined):undefined;
  if(mcp&&(revoked||overflow||exitCode!==0))mcp.complete=false;
  const evidence=launch.redact(canonical({stdout,stderr,exit_code:exitCode,overflow,native:options,model_evidence:modelEvidence,model_status:modelStatus,...(mcp?{native_mcp:mcp}:{})}));
  const traceDigest=digest(evidence);writeFileSync(join(taskDir,'runtime-redacted.json'),evidence,{mode:0o600,flag:'wx'});
  const exactRead=options.configured_profile_functional||options.task_write_directory?{content:permission.members.get('SKILL.md')!.toString('utf8'),session_root:sessionRoot,cwd:launch.cwd}:undefined;
  const event=nativeExecution(l.runtime_kind,launch.scrub(stdout),skillPath,exactRead),runId=authorized.data.run_id;
  if(options.configured_profile_functional&&overflow)event.observed=false;
  let executionId:string|undefined;
  if(event.observed){executionId=observeRuntime(auth,{loadout_id:l.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest,
    run_id:runId,kind:'observed_execution',event_id:randomUUID(),observed_at_ms:Date.now(),evidence:{subtype:'native_event',native_session_ref:event.native_session_ref,trace_digest:traceDigest,exit_code:exitCode,native_model:modelEvidence,...(mcp?{native_mcp:mcp}:{})},expected_revision:0,idempotency_key:randomUUID()},database).data.observation_id;}
  const artifacts:Record<string,string>={};for(const name of ['summary.json','refusal.json','invalid-summary.json']){const path=join(taskDir,name);if(existsSync(path)){if(lstatSync(path).isSymbolicLink()||!inside(taskDir,path))throw new QoopiaError('MANUAL_DRIFT','Task artifact escaped managed root');artifacts[name]=launch.scrub(readFileSync(path,'utf8'));}}
  const after=snapshot(),changed=Object.keys({...before,...after}).filter(n=>canonical(before[n]??null)!==canonical(after[n]??null));
  const scopePrefix=`sessions/${l.id}/`;
  const outsideRootChanges=changed.some(n=>!n.startsWith(scopePrefix)&&!n.startsWith('.qoopia/'));
  // Tree comparison proves preservation of managed neighbours, not the entire OS.
  // Native policy/OS audit qualification must supply the outside-root evidence.
  const outside=outsideRootChanges?'detected':'unknown';
  if(options.configured_profile_functional){
    // A late revoke (including one after the polling tick) cannot advance qualification.
    try{currentAssignmentPermission(database,JSON.parse(entry.assignment_snapshot));}catch{revoked=true;}
    if(digest(canonical(hashTree(join(sessionRoot,RUNTIMES[l.runtime_kind].skills,entry.slot))))!==entry.projection_digest)
      throw new QoopiaError('MANUAL_DRIFT','Frozen skill changed during configured-profile task');
  }
  const outcome=executionId?recordOutcome(auth,{run_id:runId,version_id:entry.version_id,evidence_class:'verified_outcome',artifacts,outside_writes:outside,
    execution_observation_id:executionId,expected_revision:0,idempotency_key:randomUUID()},database):null;
  observeRuntime(auth,{loadout_id:l.id,entry_id:entry.id,version_id:entry.version_id,projection_digest:entry.projection_digest,run_id:runId,kind:'closed',event_id:randomUUID(),
    observed_at_ms:Date.now(),evidence:{subtype:'close',trace_digest:traceDigest,exit_code:exitCode,native_model:modelEvidence},expected_revision:0,idempotency_key:randomUUID()},database);
  return {run_id:runId,version_id:entry.version_id,loadout_id:l.id,entry_id:entry.id,native_session_ref:event.native_session_ref||null,
    native_execution_observed:event.observed,...(mcp?{native_mcp:mcp}:{}),...(options.configured_profile_functional?{frozen_skill_read_digest:event.observed?digest(permission.members.get('SKILL.md')!):null}:{}),native:options,model_evidence:modelEvidence,model_status:modelStatus,exit_code:exitCode,revoked_during_run:revoked,task_directory:taskDir,trace_digest:traceDigest,outcome:outcome?.data??{status:'unknown'},
    outside_root_writes:options.outer_seatbelt?'NOT VERIFIED: outer Seatbelt permits two explicit selected-profile bookkeeping paths; requires OS audit':'NOT VERIFIED: requires native sandbox/OS audit evidence',changed_managed_files:changed};
}


/** Qualification progression is separate from strict verified_outcome/model attestation. */
export function nativeQualificationCanContinue(result:Pick<Awaited<ReturnType<typeof runCsvTask>>,'exit_code'|'revoked_during_run'|'native_execution_observed'|'native'|'model_status'|'outcome'>,
  assertions:{name:string;passed:boolean}[]){
  const current='stale' in result.outcome&&result.outcome.stale===false;
  return result.exit_code===0&&!result.revoked_during_run&&current&&result.native_execution_observed&&result.outcome.status!=='failed'&&
    (result.model_status==='verified'||result.native.configured_profile_functional===true&&result.model_status==='unknown')&&
    ['valid_summary','invalid_refusal',...(result.native.connection?['native_connection_used']:[])].every(name=>assertions.some(a=>a.name===name&&a.passed));
}

/** Local-only owner decision, intentionally absent from remote reporter tools. */
export function adoptManagedSkill(database:Database,auth:AuthContext,input:{runtime_id:string;target:string;preview_digest?:string;skill_id?:string;version_id?:string;idempotency_key?:string}){
 const p=authorize(database,auth,'owner'),r=registration(database,p.workspace_id,input.runtime_id);
 if(!r.managed_root)throw new QoopiaError('NOT_READY','Bind a managed root first');
 const nativePrefix=RUNTIMES[r.runtime_kind]?.skills;
 if(!nativePrefix||!(/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.target.slice(nativePrefix.length+1))&&input.target.startsWith(nativePrefix+'/')||/^sessions\/[a-zA-Z0-9-]+\/(?:\.agents|\.claude)\/skills\/[a-z0-9-]+$/.test(input.target)))throw new QoopiaError('INVALID_INPUT','Adoption is limited to native skill directories');
 if(!input.preview_digest)return previewAdoption(r.managed_root,input.target);
 if(!input.skill_id||!input.version_id||!input.idempotency_key)throw new QoopiaError('INVALID_INPUT','Confirm preview digest, skill, version and idempotency key');
 const installation=(database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
 return command(database,auth,'owner','native_adopt',input.idempotency_key,input,input.runtime_id,()=>{
  registration(database,p.workspace_id,r.id);
  const version=database.query('SELECT skill_id FROM skill_versions WHERE id=? AND workspace_id=?').get(input.version_id!,p.workspace_id) as {skill_id:string}|null;
  if(!version||version.skill_id!==input.skill_id)throw new QoopiaError('NOT_FOUND','Exact version and skill required');
 },()=>({data:adoptOwned({root:r.managed_root!,installation,runtime:r.id,target:input.target,preview_digest:input.preview_digest!,skill_id:input.skill_id!,version_id:input.version_id!,operation_id:digest(input.idempotency_key!)}),revision:1}));
}
