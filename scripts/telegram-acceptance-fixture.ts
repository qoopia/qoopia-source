/** Isolated Telegram acceptance. Creates a NEW root and accepts only the named test bot.
 * bun run scripts/telegram-acceptance-fixture.ts --run --root ABS_NEW_PATH --bot qoopia_bot --port 43871
 * Type `login` for a five-minute local owner code. Stop with Ctrl-C.
 * No production database, installed profile, Keychain credential or bot is copied.
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {localSessionSecret} from '../src/delivery/local-login.ts';
const args=process.argv.slice(2),value=(name:string)=>args[args.indexOf(name)+1];
const root=value('--root'),bot=value('--bot'),port=Number(value('--port')),resume=args.includes('--resume');
if(!args.includes('--run')||!args.includes('--root')||!root||!path.isAbsolute(root)||(!resume&&fs.existsSync(root))||!args.includes('--bot')||!bot||!/^\w{5,32}$/.test(bot)||!args.includes('--port')||!Number.isInteger(port)||port<1024||port>65535||!process.stdin.isTTY)throw new Error('Use --run --root ABS_NEW_PATH --bot TEST_BOT_USERNAME --port PORT in an interactive terminal');
const marker=path.join(root,'fixture.json');
const saved=resume?JSON.parse(fs.readFileSync(marker,'utf8')):null;
if(resume&&(saved?.format!=='qoopia-telegram-acceptance/1'||saved.bot!==bot||saved.port!==port||typeof saved.owner_id!=='string'||fs.lstatSync(root).isSymbolicLink()))throw new Error('Only this fixture can be resumed');
fs.mkdirSync(root,{recursive:true,mode:0o700});
Object.assign(process.env,{
  NODE_ENV:'test',QOOPIA_SERVER_ROLE:'canonical',QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups'),QOOPIA_HOST:'127.0.0.1',QOOPIA_PORT:String(port),
  QOOPIA_PUBLIC_URL:'http://127.0.0.1:'+port,QOOPIA_ADMIN_SECRET:randomBytes(32).toString('hex'),QOOPIA_SESSION_SECRET:localSessionSecret(root),QOOPIA_LOG_LEVEL:'error',QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:'ollama',
  QOOPIA_STANDALONE:'true',QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root,logs:path.join(root,'logs')})
});
// Refuse an accidentally pasted production bot before telegramAction writes its token.
const nativeFetch=globalThis.fetch;
globalThis.fetch=(async(input:any,init:any)=>{
  const response=await nativeFetch(input,init);
  if(String(input).startsWith('https://api.telegram.org/bot')&&String(input).endsWith('/getMe')){
    const result=await response.clone().json() as any;
    if(result.ok&&result.result?.username?.toLowerCase()!==bot.toLowerCase())throw new Error('This fixture only accepts its designated test bot');
  }
  return response;
}) as typeof fetch;
const {db}=await import('../src/db/connection.ts'),{runMigrations}=await import('../src/db/migrate.ts');runMigrations();
const {createWorkspace}=await import('../src/admin/workspaces.ts'),{bootstrapOwner}=await import('../src/auth/pairings.ts');
const owner=saved?{agent_id:saved.owner_id}:bootstrapOwner(db,'Tester — isolated acceptance',undefined,createWorkspace({name:'Tester — synthetic Telegram acceptance',slug:randomUUID()}).id);
if(!saved)fs.writeFileSync(marker,JSON.stringify({format:'qoopia-telegram-acceptance/1',bot,port,owner_id:owner.agent_id}),{mode:0o600});
const {issueLocalLogin}=await import('../src/delivery/local-login.ts'),{startHttpServer}=await import('../src/http.ts');
const server=startHttpServer();if(!server.listening)await once(server,'listening');
const login=()=>console.log(JSON.stringify({dashboard:'http://127.0.0.1:'+port+'/local-login',local_owner_code:issueLocalLogin(owner.agent_id),test_bot:bot,isolated_root:root}));
login();process.stdin.on('data',chunk=>{if(chunk.toString().trim()==='login')login();});
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  const {stopTelegramChannels}=await import('../src/services/my-agent-telegram.ts');stopTelegramChannels();
  const {stopMyAgents}=await import('../src/services/my-agent.ts');await stopMyAgents();
  server.closeAllConnections();server.close();db.close();process.exit(0);
}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
setTimeout(()=>void stop(),2*60*60*1000).unref();
