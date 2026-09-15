#!/usr/bin/env bun
import {agentProtocol} from '../agent-kit/index.ts';
import { redactSensitive } from "../utils/secret-guard.ts";
// This entry has no domain imports before an explicit isolated root is configured.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Delivery, readCurrent, dataFile, lockInstallation, operationsDirectory } from './operations.ts';
import { safePath, readJson, readJsonBytes } from '../utils/fs.ts';
import { verifyBundle, requireOpsJournalV3 } from './bundle.ts';
import { platformPaths } from './platform-paths.ts';
import { privateDirectory } from '../utils/fs.ts';
import { linuxUserManagerEnvironment, UserAutostart } from './autostart.ts';
import { inspectInstallationRequirements } from './requirements.ts';
import { nativeRuntimeEnvironment } from './native-provision.ts';
import { PRODUCT_VERSION } from '../utils/product-version.ts';
import {bindNativeOwnerHome} from './native-keychain.ts';
import {bindNativeClientDirectories} from './native-client-paths.ts';
import { localSessionSecret } from './local-login.ts';
import { readServerWorkspace, selectServerWorkspace, serverWorkspaceUrl } from './remote.ts';
import { browserEnvironment as captureBrowserEnvironment, openBrowser } from './browser-open.ts';
declare const QOOPIA_PINNED_KEY:string;
declare const QOOPIA_BUILD_SHA:string;
const argv=process.argv.slice(2), cmd=argv[0]??'help';
const arg=(name:string)=>{const i=argv.indexOf('--'+name);return i<0?undefined:argv[i+1];};
const flag=(name:string)=>argv.includes('--'+name);
const need=(name:string)=>{const v=arg(name);if(!v||v.startsWith('--'))throw new Error('--'+name+' required');return v;};
const emit=(v:unknown)=>console.log(JSON.stringify(v));
function configure(root:string,bundle:string,port=3737,layout?:ReturnType<typeof platformPaths>,instance?:string) {
  bindNativeOwnerHome(os.homedir());
  bindNativeClientDirectories(process.env);
  // Only mutating/runtime entry paths call configure; doctor never repairs modes.
  process.umask(0o077);
  // Deliberately ignore ambient Qoopia/.env/native/paid-API settings. No credential reads.
  const runtimeEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,TMPDIR:process.env.TMPDIR??'/tmp',NODE_ENV:'production',
    QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:layout?.logs??path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(layout?.root??root,'backups'),
    QOOPIA_SERVER_ROLE:'canonical',QOOPIA_PORT:String(port),QOOPIA_HOST:'127.0.0.1',QOOPIA_PUBLIC_URL:`http://127.0.0.1:${port}`,
    QOOPIA_LOG_LEVEL:'error',QOOPIA_MANAGED_LOGS:layout?'true':'false',QOOPIA_BUNDLE_ASSETS:path.join(bundle,'assets'),QOOPIA_SKILLS:'true',QOOPIA_ENTITY_PAGES:'true',
    QOOPIA_STANDALONE:'true',...(instance?{QOOPIA_INSTANCE_ID:instance}:{}),QOOPIA_EXPECTED_RELEASE_SHA:QOOPIA_BUILD_SHA,QOOPIA_RELEASE_STAMP_PATH:path.join(bundle,'manifest.json'),QOOPIA_ADMIN_SECRET:randomBytes(32).toString('hex'),QOOPIA_SESSION_SECRET:layout?localSessionSecret(layout.root):randomBytes(32).toString('hex')};
  if(layout){
    Object.assign(runtimeEnv,{QOOPIA_OPS_STATE_DIR:operationsDirectory(layout.root,readCurrent(layout.root)),QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root:layout.root,logs:layout.logs}),QOOPIA_OPS_CHANNELS_FILE:path.join(layout.root,'ops-channels.json')});
    for(const directory of [layout.config,layout.state,layout.logs])privateDirectory(directory);
    Object.assign(runtimeEnv,{XDG_CONFIG_HOME:layout.config,XDG_STATE_HOME:layout.state});
  }
  process.env=runtimeEnv;
}
export async function reservePort(port:number) {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
  const server=net.createServer(socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());});
  const chosen=(server.address() as net.AddressInfo).port;
  return {port:chosen,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
async function main(){
 const browserEnvironment=captureBrowserEnvironment();
 if(['client-auth','client-auth-status','client-stdio'].includes(cmd)){
   const {stdioBindingSchema,stdioAuthStatus,authorizeStdioClient,StdioAccessError}=await import('./stdio-oauth.ts');
   const binding=stdioBindingSchema.parse(readJson(safePath(need('file')))),clientRoot=platformPaths(arg('root')).root;
   if(cmd==='client-auth'&&!flag('commit')){
     emit({format:'qoopia-connections/1',state:'requires_user_action',code:'COMMIT_REQUIRED',binding,
       next_action:'Run client-auth with --commit to prepare explicit browser consent; --open opens that page. This does not verify the client.'});return;
   }
   verifyBundle(path.dirname(process.execPath),QOOPIA_PINNED_KEY,flag('allow-test-fixture'));
   if(cmd==='client-auth-status'){emit(stdioAuthStatus(clientRoot,binding));return;}
   if(cmd==='client-auth'){
     try{emit(await authorizeStdioClient(clientRoot,binding,step=>{
       emit({format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_AUTHORIZATION_REQUIRED',...step,
         next_action:'Review and approve this one connection in your browser, then return here. This sign-in expires in ten minutes.'});
       if(flag('open')){
         if(!openBrowser(step.open_url,browserEnvironment))emit({format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_OPEN_BROWSER_MANUALLY',
           ...step,next_action:'Open this authorization page in your browser. This command is still waiting for your consent.'});
       }
     }));}catch(error){
       const code=error instanceof StdioAccessError?error.code:'CLIENT_AUTH_REFUSED';
       emit({format:'qoopia-connections/1',state:code==='CLIENT_AUTH_BUSY'?'temporarily_unavailable':'requires_user_action',code,
         next_action:'Check client-auth-status. Complete an active sign-in or start sign-in again; this does not change memory.'});process.exitCode=1;
     }return;
   }
   const {serveStdioClient}=await import('./stdio-client.ts');const bridge=await serveStdioClient(clientRoot,binding);
   process.stdin.once('end',()=>{void bridge.close();});
   for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void bridge.close().finally(()=>process.exit(0));});
   return;
 }
 if(cmd==='memory-hook'){
   const {runMemoryHook}=await import('./memory-client.ts');
   const input=await Bun.stdin.text();if(input.length>2*1024*1024)throw new Error('Hook input too large');
   const output=await runMemoryHook(need('config'),JSON.parse(input));if(output)console.log(JSON.stringify(output));return;
 }
 if(cmd==='client-link'){
   const {configureNativeClient}=await import('./client-config.ts');
   const input=readJson(safePath(need('file'))),clientRoot=platformPaths(arg('root')).root;
   const plan=configureNativeClient(clientRoot,input,'plan',undefined,arg('config-directory'));
   if(flag('commit')&&need('approve')!==plan.plan_digest)throw new Error('Connection file changed after review; create a fresh client-link plan');
   emit(flag('commit')?configureNativeClient(clientRoot,input,'apply',undefined,arg('config-directory')):plan);return;
 }
 if(cmd==='memory-link'){
   const {installMemoryClient}=await import('./memory-client.ts');
   const file=need('file'),input=JSON.parse(readJsonBytes(file).toString());
   const root=platformPaths(arg('root')).root,server=readServerWorkspace(root);
   if(server&&new URL(server).origin!==new URL(input.url).origin)throw new Error('Connection belongs to another workspace; select that server explicitly before connecting');
   emit(installMemoryClient(input,root,process.execPath,undefined,arg('config-directory')));return;
 }

 if(cmd==='agent-guide'){const section=arg('section')??'protocol';if(!['protocol','connections','operations','soul'].includes(section))throw new Error('Unknown guide section');emit(agentProtocol(section as 'protocol'|'connections'|'operations'|'soul'));return;}
 if(cmd==='help')console.log('Quick start: qoopia open — opens your selected workspace. To use an existing server: qoopia use-server --url https://YOUR-SERVER --commit. This preserves local data; stop an existing local service with service uninstall --commit.');
 if(cmd==='agent-guide'){const section=arg('section')??'protocol';if(!['protocol','connections','operations','soul'].includes(section))throw new Error('Unknown guide section');emit(agentProtocol(section as 'protocol'|'connections'|'operations'|'soul'));return;}
 if(cmd==='help'){console.log('Qoopia '+PRODUCT_VERSION+' standalone candidate\nCommands: agent-guide [--section protocol|connections|operations|soul], connections plan|apply|status|resume|verify|disconnect --input ABSOLUTE_JSON, setup, install, start, service install|uninstall, steward [--agent-id ID --commit --approve PLAN_DIGEST] [--owner-id ID], owner-login, memory-link --file CONNECTION [--config-directory ABSOLUTE_DIRECTORY], client-link --file CONNECTION [--commit --approve PLAN_DIGEST], client-auth --file BINDING [--commit --open], client-auth-status --file BINDING, client-stdio --file BINDING, connect, skill, runtime, doctor, diagnostic, support-preview, backup, restore, recover-ops, authorize-ops-replay, update, rollback, uninstall, migrate-source, maintenance, parser-smoke.\nsetup [--runtime codex|claude_code] is read-only and resumes from the installation pointer, owner bindings, selected runtime, and connect receipts. It emits one exact next action and never logs in, opens a browser, starts a service/model, or reads credentials.\nDefaults use macOS Application Support/Logs or Linux XDG paths; --root ABSOLUTE_DIRECTORY isolates all data. Use owner-login --owner-name NAME once, then owner-login to sign in through UID-authenticated IPC.\nupdate --bundle ABSOLUTE_BUNDLE previews qoopia-update-plan/1; apply with --commit --plan ABSOLUTE_PLAN_JSON --approve EXACT_PLAN_DIGEST. Writes after preview are caught up from the final locked snapshot.\nconnect --runtime claude_code|codex --name NAME --config ABSOLUTE_FILE [--owner-id ID]: stopped-installation scope/file/sample-memory preview; apply with --commit --approve EXACT_PREVIEW_DIGEST. Config parent must already be private (0700); existing file private (0600). Native qualification is NOT RUN.\ndiagnostic --input ABSOLUTE_JSON previews unless --commit is present; commit validates a connect-published config and exact loopback listener/build/instance before one identifiable write/read/recall fixture. doctor remains read-only.\nskill capture|compile|accept|assign|get|loop --input ABSOLUTE_JSON; runtime bind|start|sync|inspect|run|audit|cleanup|task --input ABSOLUTE_JSON. runtime provision --runtime claude_code|codex previews an installation-local package; apply with --commit --plan ABSOLUTE_PLAN_JSON --approve EXACT_PLAN_DIGEST and performs no login or model invocation. These are stopped-installation local owner operations; --commit explicitly applies. runtime run and runtime task serve the shipped loopback HTTP handler for one task and require an exact connect receipt plus explicit subscription-store or Claude subscription options. inspect performs no native/auth process.\nMutations require --commit. Test bundles require --allow-test-fixture. Install leaves autostart disabled; enable it only with service install --commit.');return;}
 if(cmd==='version'){emit({version:PRODUCT_VERSION,build_sha:QOOPIA_BUILD_SHA,platform:`${process.platform}-${process.arch}`,publisher_trust:'test fixture builds do not establish publisher trust'});return;}
 const layout=platformPaths(arg('root'));
 const root=layout.root,self=path.dirname(process.execPath),allow=flag('allow-test-fixture');

 if(cmd==='connections'){
   const {runConnectionCommand}=await import('./connection-cli.ts');
   const action=argv[1]??'status';
   if(!['plan','apply','status','resume','verify','disconnect','network-plan','network-status','network-start','network-resume','network-enable','network-disable','network-devices','network-revoke','client-plan','client-apply','client-status','client-remove','client-export','client-auth-start','client-auth-status'].includes(action))throw new Error('Unknown connections action');
   const input=arg('input')?readJson<Record<string,unknown>>(safePath(need('input'))):{};
   if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Connection input must be an object');
   if(['apply','disconnect','network-start','network-enable','network-disable','network-revoke','client-apply','client-remove','client-auth-start'].includes(action)&&!flag('commit')){
     emit({format:'qoopia-connections/1',state:'requires_user_action',code:'COMMIT_REQUIRED',next_action:'Review the plan, then apply with --commit.'});return;
   }
   try {
     let library:string|undefined;
     if(!readServerWorkspace(root)){
       const selected=readCurrent(root),installedBundle=path.join(root,'bundles',selected.bundle);
       verifyBundle(installedBundle,QOOPIA_PINNED_KEY,allow);
       library=path.join(installedBundle,'assets/native',`owner-peer.${process.platform==='darwin'?'dylib':'so'}`);
     }
     emit(await runConnectionCommand(root,{...input,action},arg('owner-id'),library));
   }
   catch {emit({format:'qoopia-connections/1',state:'temporarily_unavailable',code:'LOCAL_SERVICE_UNAVAILABLE',next_action:'Start Qoopia on this root and retry status. Never retry a write without checking status.'});process.exitCode=1;}
   return;
 }
 if(cmd==='use-server'){
   const url=serverWorkspaceUrl(need('url'));
   emit(flag('commit')?selectServerWorkspace(root,url):{state:'PREVIEW',url,requires:'--commit',local_data_preserved:true});return;
 }
 const remote=readServerWorkspace(root);
 if(remote && cmd==='desktop-prepare'){emit({state:'server_workspace',binary:process.execPath});return;}
 if(remote && cmd==='open'){
   if(flag('desktop')){emit({event:'workspace',url:remote});return;}
   if(!openBrowser(remote,browserEnvironment))throw new Error('Could not open your Qoopia server in the browser');
   emit({url:remote,data_location:'server'});return;
 }
 if(remote && cmd==='setup'){emit({state:'SERVER_WORKSPACE',url:remote,data_location:'server',next_action:'qoopia open'});return;}
 if(remote && (['start','connect','runtime','skill','owner-login'].includes(cmd)||(cmd==='service'&&argv[1]==='install'))){
   throw new Error('This installation uses a server workspace. Open Qoopia to access it; local runtime operations require an explicitly separate --root.');
 }

 if(cmd==='source-plan'||cmd==='_import-source'){
   const scratch=cmd==='source-plan'?fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-source-plan-')):root;
   configure(scratch,self);
   const {preflightSource,importSource}=await import('../migrations/source-adapters.ts');
   const {db,closeDb}=await import('../db/connection.ts');
   try {
     const kind=need('kind');if(kind!=='qoopia'&&kind!=='skillonomia')throw new Error('Unknown source kind');
     const blobs=arg('blobs')?new Map(Object.entries(readJson<Record<string,string>>(safePath(need('blobs')))).map(([ref,p])=>[ref,fs.readFileSync(safePath(p))])):undefined;
     const source: import('../migrations/source-adapters.ts').SourceSnapshot={kind,origin:need('origin'),bytes:fs.readFileSync(safePath(need('source'))),blobs};
     const plan=preflightSource(source);
     if(cmd==='source-plan')emit(plan);
     else {
       if(need('expected-digest')!==plan.source_digest)throw new Error('Source changed after plan; cutover refused');
       emit(importSource(db,source,{build_sha:QOOPIA_BUILD_SHA,workspace_map:readJson<Record<string,string>>(safePath(need('workspace-map'))),archive_workspace:arg('archive-workspace')}));
     }
   } finally {closeDb();if(cmd==='source-plan')fs.rmSync(scratch,{recursive:true,force:true});}return;
 }
 if(cmd==='_migrate'){
   configure(root,self);const {db,closeDb}=await import('../db/connection.ts');
   const {getPendingMigrations,runMigrations,backupDbBeforeMigrate}=await import('../db/migrate.ts');
   const {assertDatabaseIntegrity}=await import('../db/sqlite.ts');
   try{assertDatabaseIntegrity(db);const pending=getPendingMigrations();if(pending.length){backupDbBeforeMigrate(pending);runMigrations();}assertDatabaseIntegrity(db);}finally{closeDb();}return;
 }
 const migrate=(bundle:string,generationRoot:string)=>{
   const child=spawnSync(path.join(bundle,'qoopia'),['_migrate','--root',generationRoot],{encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},timeout:120000});
   if(child.status!==0)throw new Error('Copy migration failed; previous generation preserved (child exit '+child.status+')');
 };
 const nativeConfig=process.platform==='darwin'?path.join(os.homedir(),'Library/LaunchAgents/com.qoopia.server.plist'):
   path.join(process.env.XDG_CONFIG_HOME??path.join(os.homedir(),'.config'),'systemd/user/qoopia.service');
 const executeService=(command:string,args:string[])=>{const result=spawnSync(command,args,{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,...linuxUserManagerEnvironment(process.platform,process.env)}});if(result.error||result.status!==0)throw new Error('User service command failed; native config and ownership ledger were preserved');};
 const autostart=(installation:string)=>new UserAutostart({root,installation,platform:process.platform as 'darwin'|'linux',configFile:nativeConfig,execute:executeService,allowTestFixture:allow});
 const dispatchInstalled=async (requiresOpsV3=false,nativeSource:NodeJS.ProcessEnv={},localNative=false)=>{
   const current=readCurrent(root),bundle=path.join(root,'bundles',current.bundle);
   const verified=verifyBundle(bundle,QOOPIA_PINNED_KEY,allow);
   if(requiresOpsV3)requireOpsJournalV3(verified);
   const source=localNative?await nativeRuntimeEnvironment(root,{...nativeSource,PATH:nativeSource.PATH??process.env.PATH}):nativeSource;
   if(path.resolve(self)!==path.resolve(bundle)){
     // Keep the desktop session across first-install dispatch, before configure isolates the server environment.
     const child=spawnSync(path.join(bundle,'qoopia'),argv,{stdio:'inherit',env:{TMPDIR:process.env.TMPDIR,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,XDG_DATA_HOME:process.env.XDG_DATA_HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,XDG_STATE_HOME:process.env.XDG_STATE_HOME,...(cmd==='open'?browserEnvironment:{}),...source,PATH:source.PATH??process.env.PATH},timeout:cmd==='start'||cmd==='open'?undefined:cmd==='runtime'&&argv[1]==='task'?330_000:120_000});process.exit(child.status??1);
   }
   return {current,bundle,nativeSource:source};
 };
 if(cmd==='setup'){
   const seen=new Set<string>();
   for(let i=1;i<argv.length;i++){
     const option=argv[i]!;if(seen.has(option))throw new Error('Duplicate setup option');seen.add(option);
     if(option==='--allow-test-fixture')continue;
     if(!['--root','--runtime'].includes(option)||!argv[i+1]||argv[i+1]!.startsWith('--'))throw new Error('Invalid setup option');i++;
   }
   if(fs.existsSync(path.join(root,'current.json')))await dispatchInstalled();
   const {inspectSetup}=await import('./setup.ts');emit(inspectSetup(root,arg('runtime')));return;
 }
 const delivery=new Delivery(root,QOOPIA_PINNED_KEY,allow,migrate,undefined,autostart);
 if(cmd==='desktop-prepare'){
   if(!flag('commit'))throw new Error('Desktop upgrade requires --commit');
   const {prepareDesktopUpdate}=await import('./desktop-update.ts');
   const prepared=prepareDesktopUpdate(delivery,self,QOOPIA_PINNED_KEY,allow);
   if(prepared.state==='first_install'){
     const requirements=inspectInstallationRequirements(verifyBundle(self,QOOPIA_PINNED_KEY,allow),root);
     if(!requirements.ok)throw new Error('Installation requirements not met: '+requirements.blockers.join(','));
     const reserved=await reservePort(0);try{delivery.install(self,reserved.port);}finally{await reserved.close();}
     emit(prepareDesktopUpdate(delivery,self,QOOPIA_PINNED_KEY,allow));
   }else emit(prepared);
   return;
 }
 if(cmd==='support-preview'){emit(delivery.supportPreview(layout.logs));return;}
 if(cmd==='doctor'){const report=delivery.doctor(layout.logs);emit(report);if(!report.ok)process.exitCode=1;return;}
 if(cmd==='diagnostic'){
   if(!flag('commit')){emit({state:'PREVIEW',command:'diagnostic',requires:'--commit --input ABSOLUTE_JSON',write:false,doctor_read_only:true});return;}
   const selected=await dispatchInstalled(),current=readCurrent(root);
   if(JSON.stringify(current)!==JSON.stringify(selected.current))throw new Error('Installation changed; retry diagnostic');
   configure(path.dirname(path.dirname(dataFile(root,current))),selected.bundle,current.port,undefined,current.instance);
   const {db}=await import('../db/connection.ts');const {assertSchemaCurrent}=await import('../db/migrate.ts');assertSchemaCurrent('functional diagnostic');
   const schema=(db.query('SELECT max(version) AS version FROM schema_versions').get() as {version:number}).version;
   const {functionalDiagnostic}=await import('./functional-diagnostic.ts');
   emit(await functionalDiagnostic(db,readJson<unknown>(safePath(need('input'))),{root,instance:current.instance,bundle:current.bundle,generation:current.generation,port:current.port,build:QOOPIA_BUILD_SHA,version:PRODUCT_VERSION,schema}));return;
 }
 if(cmd==='recover-ops'){
   await dispatchInstalled(true);
   const backup=safePath(need('backup'));
   emit(flag('commit')?delivery.recoverOps(backup,need('confirm-recovery')):delivery.previewOpsRecovery(backup));return;
 }
 if(cmd==='authorize-ops-replay'){
   await dispatchInstalled(true);
   emit(flag('commit')?delivery.authorizeOpsReplay(need('confirm-replay')):delivery.previewOpsReplay());return;
 }
 if(cmd==='update'){
   const bundle=safePath(need('bundle'));
   if(!flag('commit'))emit(delivery.previewUpdate(bundle));
   else emit(delivery.update(bundle,readJson<unknown>(safePath(need('plan'))),need('approve')));
   return;
 }
 if(cmd==='service'){
   if(!['install','uninstall'].includes(argv[1]??''))throw new Error('service install|uninstall required');
   const selected=await dispatchInstalled(false,linuxUserManagerEnvironment(process.platform,process.env));
   if(!flag('commit')){emit({state:'PREVIEW',command:`service ${argv[1]}`,requires:'--commit',autostart_default:'disabled'});return;}
   // The running service owns the workspace lock. Autostart has a separate
   // OS-backed control lock so repeat-enable and stop can reach the user manager.
   emit((()=>{
     const current=readCurrent(root);if(JSON.stringify(current)!==JSON.stringify(selected.current))throw new Error('Installation changed; retry service operation');
     const service=autostart(current.instance);
     return argv[1]==='install'?service.install(path.join(selected.bundle,'qoopia')):service.remove();
   })());return;
 }
 if(cmd==='connect'){
   const seen=new Set<string>();
   for(let i=1;i<argv.length;i++){
     const option=argv[i]!;
     if(seen.has(option))throw new Error('Duplicate connect option');seen.add(option);
     if(['--commit','--allow-test-fixture'].includes(option))continue;
     if(!['--root','--runtime','--name','--config','--owner-id','--approve'].includes(option)||!argv[i+1]||argv[i+1]!.startsWith('--'))throw new Error('Invalid connect option');
     i++;
   }
   if(flag('commit')!==!!arg('approve'))throw new Error('Connect requires both --commit and --approve EXACT_PREVIEW_DIGEST to apply');
   const selected=await dispatchInstalled();
   const release=lockInstallation(root);
   try{
     const current=readCurrent(root);
     if(JSON.stringify(current)!==JSON.stringify(selected.current))throw new Error('Installation changed; retry connect');
     configure(path.dirname(path.dirname(dataFile(root,current))),selected.bundle,current.port,undefined,current.instance);
     const {assertSchemaCurrent}=await import('../db/migrate.ts');assertSchemaCurrent('installed connect');
     const {connectInstalled}=await import('./connect.ts');
     emit(await connectInstalled({runtime:need('runtime'),name:need('name'),config:need('config'),ownerId:arg('owner-id')},
       {root,instance:current.instance,bundle:current.bundle,generation:current.generation,port:current.port},arg('approve')));
   }finally{release();}
   return;
 }
 if(cmd==='runtime'&&argv[1]==='provision'){
   const seen=new Set<string>();
   for(let i=2;i<argv.length;i++){
     const option=argv[i]!;if(seen.has(option))throw new Error('Duplicate runtime provision option');seen.add(option);
     if(['--commit','--allow-test-fixture'].includes(option))continue;
     if(!['--root','--runtime','--plan','--approve'].includes(option)||!argv[i+1]||argv[i+1]!.startsWith('--'))throw new Error('Invalid runtime provision option');i++;
   }
   await dispatchInstalled();
   const {nativePackagePreview,nativeProvisionPlan,applyNativeProvision}=await import('./native-provision.ts');
   if(!flag('commit')){
     if(arg('plan')||arg('approve'))throw new Error('Runtime provision preview accepts --runtime only');
     emit(nativeProvisionPlan(root,await nativePackagePreview(need('runtime') as 'codex'|'claude_code')));
   }else{
     if(arg('runtime'))throw new Error('Runtime provision apply uses only the saved plan');
     emit(await applyNativeProvision(root,readJson<unknown>(safePath(need('plan'))),need('approve')));
   }
   return;
 }
 if(cmd==='skill'||cmd==='runtime'){
   const seen=new Set<string>();
   for(let i=2;i<argv.length;i++){
     const option=argv[i]!;if(seen.has(option))throw new Error('Duplicate installed native option');seen.add(option);
     if(['--commit','--allow-test-fixture'].includes(option))continue;
     if(!['--root','--input','--owner-id'].includes(option)||!argv[i+1]||argv[i+1]!.startsWith('--'))throw new Error('Invalid installed native option');i++;
   }
   if(!argv[1]||argv[1]!.startsWith('--'))throw new Error('Installed skill/runtime operation required');
   const input=readJson<unknown>(safePath(need('input')));
   // Explicit task-only env handoff. configure still clears all ambient auth for the server/domain imports.
   // Full schema/runtime/current-connection validation remains in installedRuntime and adapter before launch.
   const nativeSource:NodeJS.ProcessEnv={};
   if(cmd==='runtime'&&['run','inspect','task'].includes(argv[1]!)&&flag('commit')&&
      (input as {native?:{auth_mode?:unknown}}|null)?.native?.auth_mode==='subscription')
     nativeSource.CLAUDE_CODE_OAUTH_TOKEN=process.env.CLAUDE_CODE_OAUTH_TOKEN;
   const selected=await dispatchInstalled(false,nativeSource,cmd==='runtime'&&['run','inspect','task'].includes(argv[1]!)),release=lockInstallation(root);
   try{
     const current=readCurrent(root);
     if(JSON.stringify(current)!==JSON.stringify(selected.current))throw new Error('Installation changed');
     configure(path.dirname(path.dirname(dataFile(root,current))),selected.bundle,current.port,undefined,current.instance);
     const {assertSchemaCurrent}=await import('../db/migrate.ts');assertSchemaCurrent('installed native');
     if(!flag('commit')){emit({state:'PREVIEW',command:cmd,operation:argv[1],requires:'--commit',native:'NOT RUN',
       boundary:'Stopped installation local OS owner; run starts the existing loopback HTTP handler for this one task; inspect performs no native/auth process.'});return;}
     const {installedRuntime,installedSkill}=await import('./installed-runtime.ts');
     emit(cmd==='runtime'?await installedRuntime(argv[1]!,input,root,arg('owner-id'),selected.nativeSource):await installedSkill(argv[1]!,input,arg('owner-id')));
   }finally{release();}
   return;
 }
 if(cmd==='install'){
   const bundle=arg('bundle')??self,verified=verifyBundle(bundle,QOOPIA_PINNED_KEY,allow);
   const requirements=inspectInstallationRequirements(verified,root);
   if(!flag('commit')){emit({state:'PREVIEW',command:'install',requirements,requires:'--commit',data_preserved_by_default:true});return;}
   if(!requirements.ok)throw new Error('Installation requirements not met: '+requirements.blockers.join(','));
   const reservation=await reservePort(Number(arg('port')??0));
   try{emit(delivery.install(bundle,reservation.port));}finally{await reservation.close();}return;
 }
 if(!['start','open','owner-login','parser-smoke','steward'].includes(cmd)&&!flag('commit')){emit({state:'PREVIEW',command:cmd,requires:'--commit',data_preserved_by_default:true});return;}
 if(cmd==='backup'){emit(delivery.backup(safePath(need('out'))));return;}

 if(cmd==='rollback'){emit(delivery.rollback());return;}
 if(cmd==='uninstall'){emit(delivery.uninstall());return;}
 if(cmd==='restore'){
   if(flag('new-machine')){const reserve=await reservePort(Number(arg('port')??0));try{emit(delivery.restoreNew(safePath(need('backup')),arg('bundle')??self,reserve.port));}finally{await reserve.close();}}
   else emit(delivery.restore(safePath(need('backup'))));return;
 }
 if(cmd==='migrate-source'){
   const c=readCurrent(root),b=path.join(root,'bundles',c.bundle);verifyBundle(b,QOOPIA_PINNED_KEY,allow);
   const parameters=['source','kind','origin','expected-digest','workspace-map'].flatMap(name=>['--'+name,need(name)]);
   if(arg('blobs'))parameters.push('--blobs',need('blobs'));
   if(arg('archive-workspace'))parameters.push('--archive-workspace',need('archive-workspace'));
   emit(delivery.importCopy(gen=>{
     const child=spawnSync(path.join(b,'qoopia'),['_import-source','--root',gen,...parameters],{encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},timeout:120000});
     if(child.status!==0)throw new Error('Import copy refused; original target and source preserved (child exit '+child.status+')');
     return JSON.parse(child.stdout);
   }));return;
 }
 // Runtime commands use installed code; launcher update/rollback/restore above
 // check target compatibility in Delivery before publishing a journal pointer.
 if(cmd==='open'){
   if(!fs.existsSync(path.join(root,'current.json'))){
     const verified=verifyBundle(self,QOOPIA_PINNED_KEY,allow),requirements=inspectInstallationRequirements(verified,root);
     if(!requirements.ok)throw new Error('Installation requirements not met: '+requirements.blockers.join(','));
     const reserved=await reservePort(0);try{delivery.install(self,reserved.port);}finally{await reserved.close();}
   }
 }
 const {current,bundle}=await dispatchInstalled();
 const showWorkspace=(code:string,browserPath=process.env.PATH)=>{
   const url=`http://127.0.0.1:${current.port}/dashboard`;
   if(flag('desktop')){emit({event:'workspace',url:url+'#setup='+code});return;}
   console.log('\nWelcome to Qoopia. Complete sign-in in your browser.\n'+url+'\n');
   // The single-use OS capability is cleared from browser history before any request.
   if(!openBrowser(url+'#setup='+code,{...browserEnvironment,PATH:browserPath}))throw new Error('Could not open your browser. Run Open Qoopia again from your desktop.');
 };
 if(cmd==='open'){
   const {requestOwnerLogin}=await import('./owner-control.ts');
   const library=path.join(bundle,'assets/native',`owner-peer.${process.platform==='darwin'?'dylib':'so'}`);
   const response=await requestOwnerLogin(root,{operation:'login',ownerId:arg('owner-id')},library).catch(()=>undefined);
   if(response){
     const ready='code' in response?response:await requestOwnerLogin(root,{operation:'bootstrap',name:arg('owner-name')??os.userInfo().username},library);
     if('error' in ready)throw new Error(ready.error);
     showWorkspace(ready.code);return;
   }
 }
 if(cmd==='owner-login'){
   if(!process.stdout.isTTY)throw new Error('Owner login code is shown only in a local TTY; never logs or URLs');
   if(arg('owner-name')&&arg('owner-id'))throw new Error('Choose bootstrap name or existing owner ID');
   const {requestOwnerLogin}=await import('./owner-control.ts');
   const request:import('./owner-control.ts').OwnerRequest=arg('owner-name')
     ?{operation:'bootstrap',name:need('owner-name'),workspaceName:arg('workspace-name'),workspaceId:arg('workspace-id')}
     :{operation:'login',ownerId:arg('owner-id')};
   const response=await requestOwnerLogin(root,request,path.join(bundle,'assets/native',`owner-peer.${process.platform==='darwin'?'dylib':'so'}`));
   if('error' in response)throw new Error(response.error);
   console.log('One-time local login code (5 minutes): '+response.code);
   console.log(`Open http://127.0.0.1:${current.port}/local-login and enter the code.`);return;
 }
 if(cmd==='start'||cmd==='open'){
   if(cmd==='start'&&(arg('owner-name')||arg('owner-id')))throw new Error('Use open for interactive owner setup, or owner-login with a running server');
   const reservation=await reservePort(current.port);await reservation.close();
   const release=lockInstallation(root);process.on('exit',release);
   const nativeSource={PATH:process.env.PATH},ownerName=arg('owner-name')??os.userInfo().username;
   configure(path.dirname(path.dirname(dataFile(root,current))),bundle,current.port,layout,current.instance);
   const {db}=await import('../db/connection.ts');
   const {enableLocalWorkspace}=await import('./workspace.ts');enableLocalWorkspace(root,nativeSource);
   const {startOwnerControl}=await import('./owner-control.ts');
   const {ownerControlRequest}=await import('./owner-onboarding.ts');
   const closeControl=startOwnerControl(root,input=>ownerControlRequest(db,input));
   process.on('exit',closeControl);
   const {enableManagedTransport}=await import('./managed-transport.ts');enableManagedTransport(root,db,bundle);
   try { await import('../index.ts'); }
   catch(error){closeControl();release();throw error;}
   const url=`http://127.0.0.1:${current.port}/dashboard`;
   if(cmd==='open'){
     const existing=db.query('SELECT 1 FROM workspace_owners LIMIT 1').get();
     const response=ownerControlRequest(db,existing?{operation:'login',ownerId:arg('owner-id')}:{operation:'bootstrap',name:ownerName});
     if('error' in response)throw new Error(response.error);
     showWorkspace(response.code,nativeSource.PATH);
   }
   console.log('Qoopia: '+url);
   console.log('Qoopia is running. Complete account setup in your browser.');return;
 }
 const release=lockInstallation(root);
 try{
   configure(path.dirname(path.dirname(dataFile(root,current))),bundle,current.port,layout,current.instance);
   if(cmd==='steward'){
     const {db}=await import('../db/connection.ts');
     const {stewardCommand}=await import('./steward.ts');
     emit(stewardCommand(db,{ownerId:arg('owner-id'),agentId:arg('agent-id'),commit:flag('commit'),approve:arg('approve')}));
   }else if(cmd==='maintenance'){const {runOperationalMaintenance}=await import('../services/retention.ts');const result=await runOperationalMaintenance();emit(result);if(!result.ok)process.exitCode=1;}
   else if(cmd==='parser-smoke'){
     const {parseFileText}=await import('../services/files.ts');const file=safePath(need('file'));emit(await parseFileText(need('mime'),path.basename(file),fs.readFileSync(file)));
   }else throw new Error('Unknown command');
 }finally{release();}
}
if(import.meta.main)main().catch((error:unknown)=>{console.error('Qoopia operation refused: '+redactSensitive(error instanceof Error?error.message:'Unknown error').text.slice(0,1000));process.exitCode=1;});
