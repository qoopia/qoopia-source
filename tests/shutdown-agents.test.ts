import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';

const repo=path.join(import.meta.dir,'..');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(check:()=>boolean,ms:number){const end=Date.now()+ms;while(!check()){if(Date.now()>end)return false;await Bun.sleep(25);}return true;}

// An open MCP request keeps the HTTP server's 'close' event from firing, so
// shutdown must stop agent process trees itself rather than waiting for it.
test('SIGTERM stops a live agent process while an MCP request keeps the server open',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-shutdown-agents-')));
  const bin=path.join(root,'bin'),pidFile=path.join(root,'agent.pid'),keyFile=path.join(root,'agent.key'),preload=path.join(root,'preload.ts');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+'\n'+`
    import readline from 'node:readline';import fs from 'node:fs';
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
    for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id)send({id:m.id,result:m.method==='account/read'?{account:{type:'chatgpt'}}:{}});}
  `,{mode:0o700});
  const src=JSON.stringify(path.join(repo,'src'));
  fs.writeFileSync(preload,`
    import fs from 'node:fs';import path from 'node:path';
    const {runMigrations}=await import(${src}+'/db/migrate.ts');const {db}=await import(${src}+'/db/connection.ts');
    const {bootstrapOwner}=await import(${src}+'/auth/pairings.ts');const {createAgent}=await import(${src}+'/admin/agents.ts');
    const {durableWrite}=await import(${src}+'/utils/fs.ts');const {agentDirectory,myAgentAction}=await import(${src}+'/services/my-agent.ts');
    runMigrations();
    const slug='shutdown-fixture';db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
    const owner=bootstrapOwner(db,'Shutdown owner',undefined,slug),agent=createAgent({name:'Shutdown steward',workspaceSlug:slug,type:'steward'});
    db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,slug,agent.id,new Date().toISOString());
    durableWrite(path.join(agentDirectory(owner.agent_id),'credentials.json'),JSON.stringify({key:agent.api_key}));
    fs.writeFileSync(${JSON.stringify(keyFile)},agent.api_key);
    setTimeout(()=>void myAgentAction(owner.agent_id,{action:'start'}).catch(error=>console.error('fixture start failed',String(error))),200);
  `);
  const env={...process.env,NODE_ENV:'test',QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups'),
    QOOPIA_SERVER_ROLE:'canonical',QOOPIA_HOST:'127.0.0.1',QOOPIA_PORT:'0',QOOPIA_LOG_LEVEL:'info',QOOPIA_ADMIN_SECRET:'a'.repeat(64),QOOPIA_SESSION_SECRET:'b'.repeat(64),PATH:bin+path.delimiter+process.env.PATH};
  const server=spawn('bun',['--preload',preload,'src/index.ts'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let output='';server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
  const exited=new Promise<number|null>(resolve=>server.once('close',resolve));
  let agentPid=0,socket:net.Socket|undefined;
  try{
    expect(await until(()=>fs.existsSync(pidFile)&&/listening on http:\/\/127\.0\.0\.1:\d+/.test(output),20_000)).toBe(true);
    agentPid=Number(fs.readFileSync(pidFile,'utf8'));expect(alive(agentPid)).toBe(true);
    const port=output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1];
    // Stateless /mcp has no standalone GET stream (F-261); an MCP request still in flight holds the server open the same way.
    socket=net.connect(Number(port),'127.0.0.1');await new Promise(resolve=>socket!.once('connect',resolve));
    socket.write(`POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nauthorization: Bearer ${fs.readFileSync(keyFile,'utf8')}\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"jsonrpc":`);
    await Bun.sleep(100);
    const began=Date.now();server.kill('SIGTERM');
    const code=await Promise.race([exited,Bun.sleep(10_000).then(()=>'timeout' as const)]);
    expect(code).toBe(0);expect(Date.now()-began).toBeLessThan(8000);
    expect(await until(()=>!alive(agentPid),2000)).toBe(true);
  }finally{
    socket?.destroy();
    if(agentPid&&alive(agentPid))process.kill(agentPid,'SIGKILL');
    if(server.exitCode===null&&server.signalCode===null)server.kill('SIGKILL');
    fs.rmSync(root,{recursive:true,force:true});
  }
},30_000);
