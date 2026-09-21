import {test,expect} from 'bun:test';
import {ClaudeAgentRuntime,claudeLoginUrl} from '../src/services/claude-agent-runtime.ts';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {privateDirectory,durableWrite} from '../src/utils/fs.ts';

async function until(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Fixture did not finish');}
const fixture=`
import readline from 'node:readline';
import fs from 'node:fs';
const args=process.argv.slice(2),send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
fs.appendFileSync(process.env.TRACE,JSON.stringify(args)+'\\n');
if(args[0]==='auth'){
 if(args[1]==='status'){send({loggedIn:true,authMethod:process.env.API_ONLY?'api_key':'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'});process.exit(0);}
 console.log('https://claude.com/cai/oauth/authorize?client_id=fixture&state=test');
 for await(const line of readline.createInterface({input:process.stdin})){if(line==='fixture-code')process.exit(0);}
}else{
 const id=args.find(a=>a.startsWith('--session-id=')||a.startsWith('--resume=')).split('=')[1];
 for await(const line of readline.createInterface({input:process.stdin})){
  const m=JSON.parse(line);
  if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
  if(m.type==='user'){
   if(m.message.content==='hang')continue;
   send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'fixture command'}}});
  }
  if(m.type==='control_response'){
   fs.appendFileSync(process.env.TRACE,JSON.stringify(m)+'\\n');
   const word=m.response.response?.behavior==='allow'?'Allowed ✓':'Declined';
   send({type:'stream_event',session_id:id,event:{delta:{type:'text_delta',text:word}}});
   send({type:'result',session_id:id,subtype:'success',is_error:false,result:word});
  }
 }
}
`;
test('Claude native adapter supports isolated subscription auth, approvals, resume and stop without replay',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-claude-adapter-'))),binary=path.join(root,'claude');
 durableWrite(binary,'#!'+process.execPath+'\n'+fixture,0o700);privateDirectory(path.join(root,'profile'));
 const env={PATH:'/usr/bin:/bin',HOME:root,CLAUDE_CONFIG_DIR:path.join(root,'profile'),TRACE:path.join(root,'trace')};
 const rpc=new ClaudeAgentRuntime({binary,cwd:root,env,mcpConfig:path.join(root,'mcp.json')}),events:any[]=[],requests:any[]=[];
 rpc.on('notification',e=>events.push(e));rpc.on('request',e=>requests.push(e));
 try{
  await rpc.start();expect((await rpc.call('account/read',{})).account.type).toBe('claude');
  const login=await rpc.call('account/login/start',{});expect(login.authUrl).toStartWith('https://claude.com/cai/oauth/authorize');
  await rpc.call('account/login/code',{code:'fixture-code'});await until(()=>events.some(e=>e.method==='account/login/completed'&&e.params.success));
  const thread=await rpc.call('thread/start',{developerInstructions:'fixture guidance'});
  await rpc.call('turn/start',{threadId:thread.thread.id,model:'opus',input:[{text:'approve'}]});await until(()=>requests.length===1);
  expect(requests[0].params.command).toBe('fixture command');rpc.respond(requests[0].id,{decision:'accept'});
  await until(()=>events.some(e=>e.method==='turn/completed'));expect(events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('')).toBe('Allowed ✓');
  expect(()=>rpc.respond('permission',{decision:'accept'})).toThrow('expired');
  await rpc.call('turn/start',{threadId:thread.thread.id,input:[{text:'deny'}]});await until(()=>requests.length===2);rpc.respond(requests[1].id,{decision:'decline'});
  await until(()=>events.filter(e=>e.method==='turn/completed').length===2);
  await rpc.call('turn/start',{threadId:thread.thread.id,input:[{text:'hang'}]});await rpc.call('turn/interrupt',{});
  expect(events.at(-1).params.turn.status).toBe('interrupted');
  const trace=fs.readFileSync(env.TRACE,'utf8');expect(trace).toContain('"--model","opus"');expect(trace).toContain('--resume='+thread.thread.id);expect(trace).toContain('"behavior":"deny"');expect(trace).not.toContain('bypassPermissions');expect(trace).not.toContain('--console');
 }finally{await rpc.stop();await new Promise(r=>setTimeout(r,30));fs.rmSync(root,{recursive:true,force:true});}
});
test('Claude login only accepts exact official OAuth paths and refuses API authentication',async()=>{
 expect(claudeLoginUrl('https://claude.ai/oauth/authorize?state=x')).toContain('state=x');
 for(const u of ['https://claude.ai.evil.test/oauth/authorize','https://claude.ai/other','https://x@claude.ai/oauth/authorize','http://claude.ai/oauth/authorize'])expect(()=>claudeLoginUrl(u)).toThrow();
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-claude-api-'))),binary=path.join(root,'claude');durableWrite(binary,'#!'+process.execPath+'\n'+fixture,0o700);
 const rpc=new ClaudeAgentRuntime({binary,cwd:root,env:{HOME:root,PATH:'/usr/bin:/bin',API_ONLY:'1',TRACE:path.join(root,'trace')},mcpConfig:path.join(root,'mcp.json')});
 try{await rpc.start();expect((await rpc.call('account/read',{})).account).toBeNull();await expect(rpc.call('thread/resume',{threadId:'--bad',developerInstructions:''})).rejects.toThrow('Invalid');}finally{await rpc.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('Claude completion flushes native history before reporting completion and resuming',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-claude-flush-'))),binary=path.join(root,'claude');
 durableWrite(binary,'#!'+process.execPath+'\n'+`
  import readline from 'node:readline';import fs from 'node:fs';
  const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
  const args=process.argv.slice(2),resume=args.some(a=>a.startsWith('--resume='));
  for await(const line of readline.createInterface({input:process.stdin})){
   const m=JSON.parse(line);
   if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
   if(m.type==='user')send({type:'result',subtype:'success',result:resume?fs.readFileSync('history','utf8'):'FIRST-ANSWER'});
  }
  await new Promise(r=>setTimeout(r,80));fs.writeFileSync('history','FIRST-ANSWER');
 `,0o700);
 const rpc=new ClaudeAgentRuntime({binary,cwd:root,env:{HOME:root,PATH:'/usr/bin:/bin'},mcpConfig:path.join(root,'mcp.json')}),events:any[]=[];
 rpc.on('notification',e=>events.push(e));
 try{
  await rpc.start();const thread=await rpc.call('thread/start',{developerInstructions:'Synthetic context'});
  await rpc.call('turn/start',{threadId:thread.thread.id,input:[{text:'first'}]});
  await until(()=>events.some(e=>e.method==='turn/completed'));
  expect(fs.readFileSync(path.join(root,'history'),'utf8')).toBe('FIRST-ANSWER');
  await rpc.call('turn/start',{threadId:thread.thread.id,input:[{text:'recall your answer'}]});
  await until(()=>events.filter(e=>e.method==='turn/completed').length===2);
  expect(events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta)).toEqual(['FIRST-ANSWER','FIRST-ANSWER']);
 }finally{await rpc.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('Claude interruption terminates a real detached command before reporting the turn stopped',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-claude-tree-'))),binary=path.join(root,'claude');
 durableWrite(binary,'#!'+process.execPath+'\n'+`
  import readline from 'node:readline';import {spawn} from 'node:child_process';
  const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');process.on('SIGTERM',()=>{});
  for await(const line of readline.createInterface({input:process.stdin})){
   const m=JSON.parse(line);
   if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
   if(m.type==='user')spawn('/bin/sh',['-c','printf ready > ready; sleep 1; printf BAD > result'],{detached:true,cwd:process.cwd(),stdio:'ignore'});
  }
 `,0o700);
 const rpc=new ClaudeAgentRuntime({binary,cwd:root,env:{HOME:root,PATH:'/usr/bin:/bin'},mcpConfig:path.join(root,'mcp.json')}),events:any[]=[];
 rpc.on('notification',e=>events.push(e));let control:ReturnType<typeof spawn>|undefined;
 try{
  await rpc.start();const thread=await rpc.call('thread/start',{developerInstructions:'Synthetic context'});
  const turn=await rpc.call('turn/start',{threadId:thread.thread.id,input:[{text:'run command'}]});
  await until(()=>fs.existsSync(path.join(root,'ready')));
  control=spawn('/bin/sh',['-c','sleep 1.2; printf done > control'],{cwd:root,stdio:'ignore'});
  await rpc.call('turn/interrupt',{threadId:thread.thread.id,turnId:turn.turn.id});
  expect(events.at(-1).params.turn.status).toBe('interrupted');
  await until(()=>fs.existsSync(path.join(root,'control')));
  expect(fs.existsSync(path.join(root,'result'))).toBe(false);
 }finally{await rpc.stop();control?.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});}
},10000);


test('Claude Stop terminates a stalled subscription check without waiting for its deadline',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-claude-auth-stop-'))),binary=path.join(root,'claude'),marker=path.join(root,'ready');
 durableWrite(binary,'#!'+process.execPath+'\n'+`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,0o700);
 const rpc=new ClaudeAgentRuntime({binary,cwd:root,env:{HOME:root,PATH:'/usr/bin:/bin'},mcpConfig:path.join(root,'mcp.json')});
 try{
  await rpc.start();const checking=rpc.call('account/read',{});await until(()=>fs.existsSync(marker));
  const pid=Number(fs.readFileSync(marker,'utf8')),began=Date.now();await rpc.stop();expect(Date.now()-began).toBeLessThan(3000);
  expect((await checking).account).toBeNull();expect(()=>process.kill(pid,0)).toThrow();
 }finally{await rpc.stop();fs.rmSync(root,{recursive:true,force:true});}
});
