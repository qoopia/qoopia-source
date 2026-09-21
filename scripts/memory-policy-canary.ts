/** Real-client acceptance of the memory policy against an isolated server. Synthetic data only:
 * a throw-away database on a loopback port, no tunnel, no installed data, no production memory.
 *
 *   bun scripts/memory-policy-canary.ts --client claude --binary ABSOLUTE/qoopia --out ABSOLUTE_NEW_DIR
 *   bun scripts/memory-policy-canary.ts --client codex  --binary ABSOLUTE/qoopia --out ABSOLUTE_NEW_DIR --codex-home ABSOLUTE_DIR
 *
 * --binary is the built `qoopia` (for example from build-bundle.ts --test-fixture); its memory-hook
 * is the adapter under test. Claude Code uses the owner's existing sign-in, but none of the
 * owner's settings, hooks or MCP servers are loaded. Codex has no such switch, so it needs its own
 * CODEX_HOME where a person has signed in (`CODEX_HOME=DIR codex login`); this script installs the
 * Qoopia hooks there with the product installer, and the person trusts them once in Codex /hooks.
 * Four real sessions run: auto, manual, manual, auto. Exit code 0 only if the journal holds both
 * auto turns, neither manual turn, and no session for the manual ones.
 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';import {once} from 'node:events';
const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const client=value('--client'),binary=value('--binary'),out=value('--out'),codexHome=value('--codex-home');
// Codex runs a hook only against persisted trust, which a person grants in /hooks for that exact
// file. `--hook-trust bypass` exercises the adapter without it: it proves delivery, never trust.
const hookTrust=value('--hook-trust')??'persisted';
if(hookTrust!=='persisted'&&hookTrust!=='bypass')throw Error('--hook-trust takes persisted or bypass');
// Codex trusts a hook by the hash of the exact hooks.json a person approved, so a run that writes
// that file somewhere new is never trusted. --client-root keeps it in one place across runs.
// Each run mints a fresh agent on a fresh port, so before re-running delete that root's
// connection.json and the [mcp_servers.qoopia_memory] block in the Codex config: the installer
// refuses to overwrite a connection it did not write, which is what protects a real one.
const clientRoot=value('--client-root');
if(clientRoot&&!path.isAbsolute(clientRoot))throw Error('--client-root must be absolute');
if((client!=='claude'&&client!=='codex')||!binary||!path.isAbsolute(binary)||!fs.existsSync(binary)||!out||!path.isAbsolute(out)||fs.existsSync(out))
  throw Error('Use --client claude|codex --binary ABSOLUTE/qoopia --out ABSOLUTE_NEW_DIRECTORY');
if(client==='codex'&&(!codexHome||!path.isAbsolute(codexHome)||path.resolve(codexHome)===path.join(os.homedir(),'.codex')))throw Error('Codex needs --codex-home: an isolated, signed-in directory, never ~/.codex');
const root=path.join(out,'server'),project=path.join(out,'project');fs.mkdirSync(root,{recursive:true,mode:0o700});fs.mkdirSync(project,{mode:0o700});
const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
Object.assign(process.env,{QOOPIA_ADMIN_SECRET:randomBytes(32).toString('hex'),NODE_ENV:'test',QOOPIA_SERVER_ROLE:'canonical',QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),
  QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups'),QOOPIA_PORT:String(port),QOOPIA_PUBLIC_URL:'http://127.0.0.1:'+port,QOOPIA_LOG_LEVEL:'error',
  QOOPIA_SESSION_SECRET:randomBytes(32).toString('hex'),QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:'ollama'});
const {runMigrations}=await import('../src/db/migrate.ts');runMigrations();
const {db}=await import('../src/db/connection.ts'),{createWorkspace}=await import('../src/admin/workspaces.ts'),{createAgent}=await import('../src/admin/agents.ts');
const {setMemoryPolicy}=await import('../src/services/memory-policy.ts'),{installMemoryClient}=await import('../src/delivery/memory-client.ts');
const ws=createWorkspace({name:'Memory policy canary — synthetic only',slug:'canary-'+randomUUID().slice(0,8)});
const owner=createAgent({name:'canary-owner',workspaceSlug:ws.slug,type:'owner'}),agent=createAgent({name:'canary-'+client,workspaceSlug:ws.slug});
const {startHttpServer}=await import('../src/http.ts');const server=startHttpServer();if(!server.listening)await once(server,'listening');
const url='http://127.0.0.1:'+port,runtime=client==='claude'?'claude_code':'codex',connection={format:'qoopia-memory-connection/1',url,agent_id:agent.id,key:agent.api_key,runtime};
const clientHome=clientRoot??out;
const config=path.join(clientHome,'memory-clients',runtime,'connection.json'),settings=path.join(out,'claude-settings.json'),mcp=path.join(out,'claude-mcp.json');
if(client==='codex')installMemoryClient(connection,clientHome,binary,undefined,codexHome);
else {
  // The transcript lives in the owner's Claude profile; nothing is written there by this script.
  fs.mkdirSync(path.dirname(config),{recursive:true,mode:0o700});fs.writeFileSync(config,JSON.stringify({...connection,native_root:path.join(os.homedir(),'.claude')}),{mode:0o600});
  const command=`'${binary}' memory-hook --config '${config}'`;
  fs.writeFileSync(settings,JSON.stringify({hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','PostToolUse','Stop','PreCompact','SessionEnd'].map(event=>[event,[{hooks:[{type:'command',command,timeout:event==='SessionEnd'?3:10}]}]]))}));
  fs.writeFileSync(mcp,JSON.stringify({mcpServers:{qoopia_memory:{type:'http',url:url+'/mcp',headers:{Authorization:'Bearer '+agent.api_key}}}}),{mode:0o600});
}
const {CLAUDECODE:_nested,CLAUDE_CODE_ENTRYPOINT:_entry,...inherited}=process.env;
// Asynchronous on purpose: this process also serves the hooks the client fires during the turn.
async function turn(marker:string) {
  const prompt=`Synthetic acceptance turn ${marker}. Reply with the single word OK.`;
  const child=client==='claude'
    ?Bun.spawn(['claude','-p',prompt,'--setting-sources','project,local','--settings',settings,'--mcp-config',mcp,'--strict-mcp-config','--model','haiku'],{cwd:project,env:inherited,stdout:'pipe',stderr:'pipe'})
    :Bun.spawn(['codex','exec','--skip-git-repo-check',...(hookTrust==='bypass'?['--dangerously-bypass-hook-trust']:[]),'-C',project,prompt],{env:{...inherited,CODEX_HOME:codexHome},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),180_000),status=await child.exited;clearTimeout(timer);
  if(status!==0)throw Error(`${client} did not complete the turn: ${(await new Response(child.stderr).text()).slice(0,400)}`);
}
const markers=['AUTO-A','MANUAL-B','MANUAL-C','AUTO-D'].map(name=>name+'-'+randomBytes(3).toString('hex'));
let failure:string|undefined;const report:Record<string,unknown>={client,binary,url,...(client==='codex'?{hook_trust:hookTrust}:{}),schema:(db.query('SELECT MAX(version) AS v FROM schema_versions').get() as {v:number}).v};
try {
  await turn(markers[0]!);
  setMemoryPolicy({workspace_id:ws.id,agent_id:agent.id,mode:'manual',actor_id:owner.id});
  await turn(markers[1]!);await turn(markers[2]!);
  setMemoryPolicy({workspace_id:ws.id,agent_id:agent.id,mode:'auto',actor_id:owner.id});
  await turn(markers[3]!);
  const count=(marker:string)=>(db.query('SELECT COUNT(*) AS n FROM session_messages WHERE instr(content,?)>0').get(marker) as {n:number}).n;
  const journal=Object.fromEntries(markers.map(marker=>[marker,count(marker)])),sessions=(db.query('SELECT COUNT(*) AS n FROM sessions').get() as {n:number}).n;
  // Name what was opened: a count alone cannot say which turn created a session it should not have.
  Object.assign(report,{journal,sessions,opened:db.query('SELECT id,(SELECT COUNT(*) FROM session_messages m WHERE m.session_id=s.id) AS messages FROM sessions s ORDER BY created_at').all()});
  if(!journal[markers[0]!]||!journal[markers[3]!])failure='An auto turn was not captured: the adapter or its hooks did not deliver.';
  else if(journal[markers[1]!]||journal[markers[2]!])failure='A manual turn reached the journal.';
  // A client replays what it held once auto returns, so a manual turn can still leave an empty
  // session row. That row is metadata; what must never exist is its content. Assert exactly that.
  else if((report.opened as {messages:number}[]).filter(session=>session.messages>0).length!==2)
    failure=`Expected content in exactly the two auto sessions, found ${JSON.stringify(report.opened)}.`;
} catch(error){failure=error instanceof Error?error.message:String(error);}
console.log(JSON.stringify({...report,result:failure?'FAIL':'PASS',failure:failure??null},null,2));
server.close();process.exit(failure?1:0);
