/** Isolated, short-lived real-client acceptance. Never uses installed data or login stores.
 * Run in an interactive terminal with --run --out ABSOLUTE_NEW_DIRECTORY.
 * Optional --surface chatgpt_desktop selects the Desktop connection profile (default: chatgpt_web).
 * Type login for a fresh local owner code; Ctrl-C stops the public tunnel.
 * The public edge exposes OAuth/MCP only. Owner consent stays on localhost.
 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';
const args=process.argv.slice(2),index=args.indexOf('--out'),out=args[index+1];
const surfaceIndex=args.indexOf('--surface'),surface=surfaceIndex<0?'chatgpt_web':args[surfaceIndex+1];
if(surface!=='chatgpt_web'&&surface!=='chatgpt_desktop')throw Error('Surface must be chatgpt_web or chatgpt_desktop');
if(!args.includes('--run')||index<0||!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Use --run --out ABSOLUTE_NEW_DIRECTORY for synthetic acceptance only');
if(!process.stdin.isTTY)throw Error('An interactive terminal is required for local login and cleanup');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-chatgpt-acceptance-')));
process.once('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
Object.assign(process.env,{QOOPIA_ADMIN_SECRET:randomBytes(32).toString('hex'),NODE_ENV:'test',QOOPIA_SERVER_ROLE:'canonical',QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups'),QOOPIA_PORT:'0',QOOPIA_LOG_LEVEL:'error',QOOPIA_SESSION_SECRET:randomBytes(32).toString('hex'),QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:'ollama',QOOPIA_STANDALONE:'true',QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root,logs:path.join(root,'logs')})});
const {env}=await import('../src/utils/env.ts'),{db}=await import('../src/db/connection.ts'),{runMigrations}=await import('../src/db/migrate.ts');runMigrations();
const {createWorkspace}=await import('../src/admin/workspaces.ts'),{bootstrapOwner}=await import('../src/auth/pairings.ts');
const owner=bootstrapOwner(db,'Synthetic acceptance owner',undefined,createWorkspace({name:'Qoopia ChatGPT acceptance — synthetic only',slug:randomUUID()}).id);
const {startHttpServer}=await import('../src/http.ts'),{startMcpEdge}=await import('../src/delivery/mcp-edge.ts'),{connectionAction}=await import('../src/services/client-connections.ts');
const server=startHttpServer();if(!server.listening)await once(server,'listening');env.PORT=(server.address() as net.AddressInfo).port;
const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const edgePort=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
const tunnel=spawn('/opt/homebrew/bin/cloudflared',['--config','/dev/null','tunnel','--url','http://127.0.0.1:'+edgePort,'--no-autoupdate'],{env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:root},stdio:['ignore','ignore','pipe']});
let edge:ReturnType<typeof startMcpEdge>|undefined,stopping=false;
const events:unknown[]=[];
server.on('request',(req,res)=>{
 const route=(req.url??'').split('?')[0]!;if(!route.startsWith('/mcp')&&!route.startsWith('/oauth')&&!route.startsWith('/.well-known'))return;
 const event:{at:string;path:string;method?:string;status?:number;rpc?:string;tool?:string}={at:new Date().toISOString(),path:route,method:req.method};events.push(event);
 if(route.startsWith('/mcp')&&req.method==='POST'){let body='';req.on('data',c=>{if(body.length<131072)body+=c.toString();});req.on('end',()=>{try{const input=JSON.parse(body);event.rpc=input.method;if(input.method==='tools/call')event.tool=input.params?.name;}catch{}body='';});}
 res.once('finish',()=>{event.status=res.statusCode;fs.writeFileSync(path.join(out,'events.json'),JSON.stringify(events,null,2),{mode:0o600});});
});
function stop(){if(stopping)return;stopping=true;tunnel.kill('SIGTERM');edge?.close();server.closeAllConnections();server.close();fs.writeFileSync(path.join(out,'final-state.json'),JSON.stringify(connectionAction(owner.agent_id,{action:'status'}),null,2));db.close();fs.rmSync(root,{recursive:true,force:true});setTimeout(()=>process.exit(0),250).unref();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);setTimeout(stop,45*60*1000).unref();
try{
 const publicOrigin=await new Promise<string>((resolve,reject)=>{let pending='';const timer=setTimeout(()=>reject(Error('Tunnel start timeout')),30000);tunnel.once('error',reject);tunnel.stderr.on('data',chunk=>{pending=(pending+chunk.toString()).slice(-16384);const match=pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){clearTimeout(timer);resolve(match[0]);}});});
 env.PUBLIC_URL=publicOrigin;env.OAUTH_ISSUER=publicOrigin;env.DASHBOARD_ALLOWED_ORIGINS=['http://127.0.0.1:'+env.PORT];
 edge=startMcpEdge({publicOrigin,upstreamPort:env.PORT,port:edgePort});if(!edge.listening)await once(edge,'listening');
 const {issueLocalLogin}=await import('../src/delivery/local-login.ts');
 process.stdin.on('data',chunk=>{if(chunk.toString().trim()==='login')console.log(JSON.stringify({local_owner_code:issueLocalLogin(owner.agent_id)}));});
 const connection=(connectionAction(owner.agent_id,{action:'apply',surface,access_mode:'read_write',request_key:randomUUID(),transport:'remote'}) as any).connection;
 const info={synthetic_only:true,surface,root,local_dashboard:'http://127.0.0.1:'+env.PORT+'/local-login',local_owner_code:issueLocalLogin(owner.agent_id),mcp_url:connection.mcp_url,connection_id:connection.id};
 fs.writeFileSync(path.join(out,'local-session.json'),JSON.stringify(info,null,2),{mode:0o600});console.log(JSON.stringify(info));
}catch(error){console.error(error instanceof Error?error.message:'Fixture startup failed');stop();}
