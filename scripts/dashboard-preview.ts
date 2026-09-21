/** An isolated dashboard on a loopback port, filled with synthetic data, for checking the page
 * in a real browser. No tunnel, no installed data, no production memory: a throw-away database
 * under --out. Prints a one-time owner login URL and keeps running until interrupted.
 *
 *   bun scripts/dashboard-preview.ts --out ABSOLUTE_NEW_DIRECTORY
 */
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';import {once} from 'node:events';
const args=process.argv.slice(2),at=args.indexOf('--out'),out=args[at+1];
if(at<0||!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Use --out ABSOLUTE_NEW_DIRECTORY');
const root=path.join(out,'server');fs.mkdirSync(root,{recursive:true,mode:0o700});
const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
Object.assign(process.env,{QOOPIA_ADMIN_SECRET:randomBytes(32).toString('hex'),NODE_ENV:'test',QOOPIA_SERVER_ROLE:'canonical',
  QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups'),
  QOOPIA_PORT:String(port),QOOPIA_PUBLIC_URL:'http://127.0.0.1:'+port,QOOPIA_LOG_LEVEL:'error',QOOPIA_OWNER_LOGIN:'true',
  QOOPIA_SESSION_SECRET:randomBytes(32).toString('hex'),QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:'ollama',
  QOOPIA_STANDALONE:'true',QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root,logs:path.join(root,'logs')})});
const {runMigrations}=await import('../src/db/migrate.ts');runMigrations();
const {db}=await import('../src/db/connection.ts'),{createWorkspace}=await import('../src/admin/workspaces.ts');
const {createAgent}=await import('../src/admin/agents.ts'),{bootstrapOwner}=await import('../src/auth/pairings.ts');
const {continuityEvent}=await import('../src/services/continuity.ts'),{createNote}=await import('../src/services/notes.ts');
const {setMemoryPolicy}=await import('../src/services/memory-policy.ts');
const ws=createWorkspace({name:'Dashboard preview — synthetic only',slug:'preview-'+randomUUID().slice(0,8)});
const owner=bootstrapOwner(db,'Synthetic preview owner',undefined,ws.id);
const working=createAgent({name:'preview-working',workspaceSlug:ws.slug}).id;
const asking=createAgent({name:'preview-only-on-request',workspaceSlug:ws.slug}).id;
continuityEvent(ws.id,working,{session_id:'claude_code:preview',project:'/preview',runtime:'claude_code',event:'start',
  messages:[{id:'p1',role:'user',content:'Синтетическое сообщение для предпросмотра.'},{id:'p2',role:'assistant',content:'Синтетический ответ.'}]});
createNote({workspace_id:ws.id,agent_id:working,text:'Синтетическая нота для предпросмотра дашборда.',type:'note'});
setMemoryPolicy({workspace_id:ws.id,agent_id:asking,mode:'manual',actor_id:owner.agent_id});
// One prepared save waiting for the owner, so the confirmation UI has something to show.
try{createNote({workspace_id:ws.id,agent_id:asking,text:'Синтетика: пользователь попросил запомнить адрес склада.',type:'note'});}catch{}
const {startHttpServer}=await import('../src/http.ts');
const server=startHttpServer();if(!server.listening)await once(server,'listening');
const {issueLocalLogin}=await import('../src/delivery/local-login.ts');
const code=issueLocalLogin(owner.agent_id);
const url='http://127.0.0.1:'+port;
fs.writeFileSync(path.join(out,'preview.json'),JSON.stringify({fixture:'qoopia-dashboard-preview/1',url,code,workspace:ws.id,owner:owner.agent_id,
  owner_key:owner.api_key,agents:{working,asking}},null,2),{mode:0o600});
console.log(JSON.stringify({url,login:url+'/local-login',code,agents:{working,asking}}));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close(()=>process.exit(0)));
