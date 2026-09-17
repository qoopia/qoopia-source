import {beforeAll,afterEach,expect,test} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ownerFixture} from './helpers/p1-fixtures.ts';
import {inspectSnapshot,invalidateRestoredAccess} from '../src/delivery/snapshot.ts';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {createAgent} from '../src/admin/agents.ts';
import {durableWrite,privateDirectory} from '../src/utils/fs.ts';
import {agentDirectory,myAgentAction,myAgentState,stopMyAgents} from '../src/services/my-agent.ts';
import {telegramAction,telegramState,pollTelegramOwner,deliverTelegram,runTelegramQueue,stopTelegramChannels,simpleTelegramApproval} from '../src/services/my-agent-telegram.ts';
import {channel,ensureChannel,recoverTelegram,queueTelegram,telegramChunks} from '../src/services/telegram-store.ts';
beforeAll(()=>runMigrations());
const originalFetch=globalThis.fetch,originalPath=process.env.PATH;
afterEach(async()=>{stopTelegramChannels();globalThis.fetch=originalFetch;await stopMyAgents();process.env.PATH=originalPath;});
function fixture(bound=true){
  const id=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(id,id,id);
  const owner=bootstrapOwner(db,'Synthetic Telegram owner',undefined,id),agent=createAgent({name:'Synthetic Telegram agent',workspaceSlug:id,type:'steward'});
  db.query("INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,telegram_username,telegram_user_id,telegram_chat_id,created_at) VALUES(?,?,?,? ,?,?,'now')").run(owner.agent_id,id,agent.id,bound?'fixture_'+id.slice(0,8)+'_bot':null,bound?'123':null,bound?'123':null);
  const folder=agentDirectory(owner.agent_id);durableWrite(path.join(folder,'credentials.json'),JSON.stringify({key:agent.api_key}));durableWrite(path.join(folder,'telegram.json'),JSON.stringify({token:'12345:synthetic-not-a-real-token'}));
  ensureChannel(owner.agent_id);return {owner:owner.agent_id,folder};
}
const update=(id:number,text:string,person=123)=>({update_id:id,message:{from:{id:person,first_name:'Synthetic'},chat:{id:person,type:'private'},text}});
function mockTelegram(updates:unknown[],send?:(body:any)=>Promise<Response>|Response){
  const messages:any[]=[];globalThis.fetch=(async(url:any,init:any)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(init.body);
    if(method==='getUpdates')return Response.json({ok:true,result:updates});
    if(method==='getMe')return Response.json({ok:true,result:{id:12345,is_bot:true,username:'fixture_'+randomUUID().slice(0,8)+'_bot'}});
    if(method==='getWebhookInfo')return Response.json({ok:true,result:{url:''}});
    if(method==='sendMessage'){messages.push(body);if(send)return send(body);}
    return Response.json({ok:true,result:{message_id:messages.length}});
  }) as typeof fetch;return messages;
}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await Bun.sleep(10);}throw new Error('Fixture timeout');}
function binary(folder:string,source:string){const bin=privateDirectory(path.join(folder,'bin'));durableWrite(path.join(bin,'codex'),'#!'+process.execPath+'\n'+source,0o700);process.env.PATH=bin+path.delimiter+originalPath;}

test('pairing survives a new process, expired links remain actionable, plain Start receives guidance',async()=>{
  const {owner}=fixture(false),updates:any[]=[];const sent=mockTelegram(updates);
  const setup=await telegramAction(owner,{action:'telegram-connect',token:'12345:'+ 'x'.repeat(24)});stopTelegramChannels();
  const code=new URL(setup.url!).searchParams.get('start')!;
  updates.push(update(1,'/start'));await pollTelegramOwner(owner);await deliverTelegram(owner);
  expect(sent[0].text).toContain('pairing link');expect(telegramState(owner).pending?.user).toBeNull();
  updates.push(update(2,'/start '+code));await pollTelegramOwner(owner);
  expect(telegramState(owner).pending?.user?.id).toBe('123');
  const child=Bun.spawnSync([process.execPath,'-e',`import {telegramState} from './src/services/my-agent-telegram.ts'; console.log(JSON.stringify(telegramState(${JSON.stringify(owner)})))`],{cwd:process.cwd(),env:process.env});
  expect(child.exitCode).toBe(0);const state=JSON.parse(child.stdout.toString());expect(state.pending.user.id).toBe('123');expect(state.pending.url).toBe(setup.url);
  db.query('UPDATE qoopia_telegram_channels SET pairing_expires=0 WHERE owner_id=?').run(owner);
  expect(telegramState(owner).expired).toBe(true);
  const retry=await telegramAction(owner,{action:'telegram-retry'});expect(retry.url).not.toBe(setup.url);expect(telegramState(owner).pending?.user).toBeNull();
  updates.push(update(3,'/start '+code,456));await pollTelegramOwner(owner);expect(telegramState(owner).pending?.user).toBeNull();
});

test('storage failure never advances the receipt offset; retry saves exactly once',async()=>{
  const {owner}=fixture();mockTelegram([update(10,'Synthetic durable prompt')]);
  db.exec("CREATE TEMP TRIGGER fail_tg_inbox BEFORE INSERT ON qoopia_telegram_inbox BEGIN SELECT RAISE(ABORT,'fixture full'); END");
  try{await pollTelegramOwner(owner);expect(db.query('SELECT telegram_offset n FROM qoopia_agent_settings WHERE owner_id=?').get(owner)).toEqual({n:0});expect(telegramState(owner).queued).toBe(0);}finally{db.exec('DROP TRIGGER fail_tg_inbox');}
  db.query('UPDATE qoopia_telegram_channels SET retry_at=0 WHERE owner_id=?').run(owner);
  await pollTelegramOwner(owner);await pollTelegramOwner(owner);
  expect(telegramState(owner).queued).toBe(1);expect(db.query('SELECT telegram_offset n FROM qoopia_agent_settings WHERE owner_id=?').get(owner)).toEqual({n:11});
});

test('an old in-flight poll cannot populate a disconnected bot or advance its replacement offset',async()=>{
  const {owner}=fixture();let finish!:(r:Response)=>void;
  globalThis.fetch=(()=>new Promise<Response>(resolve=>finish=resolve)) as typeof fetch;
  const polling=pollTelegramOwner(owner);await telegramAction(owner,{action:'telegram-disconnect'});
  mockTelegram([]);await telegramAction(owner,{action:'telegram-connect',token:'12345:'+ 'y'.repeat(24)});stopTelegramChannels();
  finish(Response.json({ok:true,result:[update(999,'Wrong generation')]}));await polling;
  expect(telegramState(owner).queued).toBe(0);expect(db.query('SELECT telegram_offset n FROM qoopia_agent_settings WHERE owner_id=?').get(owner)).toEqual({n:0});
});

test('429 uses Telegram cooldown; ambiguous delivery is visible and never replayed after restart',async()=>{
  const {owner}=fixture(),generation=channel(owner)!.generation;
  queueTelegram(owner,generation,'rate',{chat_id:'123',text:'Synthetic'});
  let mode='rate';const sent=mockTelegram([],()=>mode==='rate'?Response.json({ok:false,error_code:429,parameters:{retry_after:60}},{status:429}):mode==='ambiguous'?Promise.reject(Error('network ended after write')):Response.json({ok:true,result:{message_id:55}}));
  await deliverTelegram(owner);await deliverTelegram(owner);expect(sent.length).toBe(1);expect(telegramState(owner).uncertain_deliveries).toBe(0);
  db.query('UPDATE qoopia_telegram_outbox SET retry_at=0 WHERE owner_id=?').run(owner);mode='ok';await deliverTelegram(owner);expect(sent.length).toBe(2);
  queueTelegram(owner,generation,'ambiguous',{chat_id:'123',text:'Do not repeat'});mode='ambiguous';await deliverTelegram(owner);expect(sent.length).toBe(3);recoverTelegram();mode='ok';await deliverTelegram(owner);expect(sent.length).toBe(3);expect(telegramState(owner).uncertain_deliveries).toBe(1);
});

test('long replies survive chunk delivery without truncation or duplicate chunks',async()=>{
  const {owner}=fixture(),generation=channel(owner)!.generation;
  const conversation=await myAgentAction(owner,{action:'new',title:'Synthetic long answer'}),id=randomUUID(),answer='A'.repeat(3899)+'😀'+'B'.repeat(8000);
  db.query("INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,answer,state,created_at,updated_at) VALUES(?,?,?,'synthetic',?,'completed','now','now')").run(id,conversation.id,id,answer);
  db.query("INSERT INTO qoopia_agent_telegram_delivery(run_id,generation,state) VALUES(?,?,'pending')").run(id,generation);
  const sent=mockTelegram([]);await deliverTelegram(owner);recoverTelegram();await deliverTelegram(owner);
  expect(sent.map(s=>s.text).join('')).toBe(answer);expect(sent.every(s=>s.text.length<=3900)).toBe(true);expect(telegramChunks(answer).join('')).toBe(answer);
  expect(db.query('SELECT state FROM qoopia_agent_telegram_delivery WHERE run_id=?').get(id)).toEqual({state:'sent'});expect(myAgentState(owner).telegram.verified).toBe(true);
});

test('Stop interrupts initialization without waiting behind the busy lock and cancels its queue',async()=>{
  const {owner,folder}=fixture(),marker=path.join(folder,'initialize-started');
  binary(folder,`import fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){if(JSON.parse(line).method==='initialize')fs.writeFileSync(${JSON.stringify(marker)},'ready');}`);
  mockTelegram([update(1,'Synthetic pending task')]);await pollTelegramOwner(owner);
  const startup=myAgentAction(owner,{action:'start'}).then(()=>null,error=>error);await until(()=>fs.existsSync(marker));
  const began=Date.now();await myAgentAction(owner,{action:'stop'});expect(Date.now()-began).toBeLessThan(3000);expect(await startup).toBeInstanceOf(Error);
  expect(telegramState(owner).queued).toBe(0);expect(myAgentState(owner).running).toBe(false);
});

test('ten queued messages start subscribed Codex in order, retain Telegram context across dashboard changes, and are not replayed',async()=>{
  const {owner,folder}=fixture();
  binary(folder,`import readline from 'node:readline';let turn=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.id)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'synthetic-thread'}};if(m.method==='turn/start')result={turn:{id:'t'+(++turn)}};send({id:m.id,result});if(m.method==='turn/start')setTimeout(()=>{send({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'t'+turn,delta:'Synthetic reply '+turn}});send({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{id:'t'+turn,status:'completed'}}});},30);}`);
  const updates=Array.from({length:10},(_,i)=>update(i+1,'Synthetic message '+(i+1)));mockTelegram(updates);
  await pollTelegramOwner(owner);await runTelegramQueue(owner);await until(()=>!myAgentState(owner).active_conversation);
  const first=channel(owner)!.conversation_id;expect(first).toBeTruthy();
  const dashboard=await myAgentAction(owner,{action:'new',title:'Different dashboard chat'});expect(dashboard.id).not.toBe(first);
  for(let i=1;i<10;i++){await runTelegramQueue(owner);await until(()=>!myAgentState(owner).active_conversation);}
  await deliverTelegram(owner);await pollTelegramOwner(owner);await runTelegramQueue(owner);
  expect(channel(owner)!.conversation_id).toBe(first);expect(myAgentState(owner,first!).runs.map(r=>r.prompt)).toEqual(updates.map(u=>u.message.text));expect(myAgentState(owner,dashboard.id).runs.length).toBe(0);
  expect(telegramState(owner).queued).toBe(0);
});

test('Telegram command buttons never approve file writes or incomplete requests',()=>{
  expect(simpleTelegramApproval({method:'item/commandExecution/requestApproval',params:{command:'pwd',tool:'Bash'}})).toBe(true);
  expect(simpleTelegramApproval({method:'item/commandExecution/requestApproval',params:{tool:'Write',input:{file_path:'/tmp/test'}}})).toBe(false);
  expect(simpleTelegramApproval({method:'item/fileChange/requestApproval',params:{command:'synthetic'}})).toBe(false);
});


test('Telegram Stop reaches a worker stuck in provider startup and cancelled receipt stays cancelled',async()=>{
  const {owner,folder}=fixture(),marker=path.join(folder,'queue-initialize');
  binary(folder,`import fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){if(JSON.parse(line).method==='initialize')fs.writeFileSync(${JSON.stringify(marker)},'ready');}`);
  const updates=[update(1,'Synthetic queued task')];mockTelegram(updates);await pollTelegramOwner(owner);
  const working=runTelegramQueue(owner);await until(()=>fs.existsSync(marker));
  updates.push(update(2,'/stop'));const began=Date.now();await pollTelegramOwner(owner);await working;
  expect(Date.now()-began).toBeLessThan(3000);expect(myAgentState(owner).running).toBe(false);
  expect(db.query('SELECT state FROM qoopia_telegram_inbox WHERE owner_id=?').get(owner)).toEqual({state:'cancelled'});
});

test('migration 44 preserves existing bot deliveries; restore invalidates pairing and cancels pending work',()=>{
  const {database:d,owner}=ownerFixture(43),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-restore-'));
  try{
    d.query("INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,telegram_username,telegram_user_id,telegram_chat_id,created_at) VALUES(?,?,?,'old_fixture_bot','123','123','now')").run(owner.agent_id,owner.workspace_id,owner.agent_id);
    d.query("INSERT INTO qoopia_agent_conversations(id,owner_id,title,created_at) VALUES('old-conversation',?,'synthetic','now')").run(owner.agent_id);
    d.query("UPDATE qoopia_agent_settings SET active_conversation_id='old-conversation' WHERE owner_id=?").run(owner.agent_id);
    d.query("INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,state,created_at,updated_at) VALUES('old-run','old-conversation','old-request','synthetic','completed','now','now')").run();
    d.query("INSERT INTO qoopia_agent_telegram_delivery(run_id,state) VALUES('old-run','pending')").run();
    d.exec(fs.readFileSync(new URL('../migrations/044-telegram-recovery.sql',import.meta.url),'utf8'));
    d.query("INSERT INTO schema_versions(version,description) VALUES(44,'test migration')").run();
    const c=d.query('SELECT generation,conversation_id FROM qoopia_telegram_channels').get() as {generation:string;conversation_id:string};
    expect(c.conversation_id).toBe('old-conversation');expect(d.query('SELECT generation FROM qoopia_agent_telegram_delivery').get()).toEqual({generation:c.generation});expect(inspectSnapshot(d).schema).toBe(44);
    d.query("UPDATE qoopia_telegram_channels SET pairing_code='synthetic-pairing',pairing_expires=9999999999999").run();
    d.query("INSERT INTO qoopia_telegram_inbox(owner_id,generation,update_id,prompt,created_at) VALUES(?,?,1,'synthetic',1)").run(owner.agent_id,c.generation);
    d.query("INSERT INTO qoopia_telegram_outbox(owner_id,generation,delivery_key,body) VALUES(?,?,'synthetic','{}')").run(owner.agent_id,c.generation);
    const file=path.join(dir,'restore.db');fs.writeFileSync(file,d.serialize());invalidateRestoredAccess(file);
    const restored=new Database(file,{readonly:true});try{
      expect(restored.query('SELECT enabled,telegram_username FROM qoopia_agent_settings').get()).toEqual({enabled:0,telegram_username:null});
      expect(restored.query('SELECT paused,pairing_code FROM qoopia_telegram_channels').get()).toEqual({paused:1,pairing_code:null});
      expect(restored.query('SELECT state FROM qoopia_telegram_inbox').get()).toEqual({state:'cancelled'});expect(restored.query('SELECT state FROM qoopia_telegram_outbox').get()).toEqual({state:'cancelled'});
      expect(restored.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }finally{restored.close();}
  }finally{d.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('a provider switch racing with message receipt never executes it under another subscription',async()=>{
 const {owner}=fixture();mockTelegram([update(1,'Synthetic provider-bound task')]);await pollTelegramOwner(owner);
 db.query("UPDATE qoopia_agent_settings SET provider='claude_code' WHERE owner_id=?").run(owner);
 await runTelegramQueue(owner);
 expect(db.query('SELECT provider,state FROM qoopia_telegram_inbox WHERE owner_id=?').get(owner)).toEqual({provider:'codex',state:'failed'});
 expect(myAgentState(owner).running).toBe(false);expect(myAgentState(owner).runs).toEqual([]);
});

function loginBinary(folder:string){
 const auth=path.join(folder,'synthetic-signed-in');
 binary(folder,`import fs from 'node:fs';import readline from 'node:readline';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.id)continue;let result={};if(m.method==='account/read')result={account:fs.existsSync(${JSON.stringify(auth)})?{type:'chatgpt'}:null};if(m.method==='account/login/start'){result={authUrl:'https://auth.openai.com/synthetic'};fs.writeFileSync(${JSON.stringify(auth)},'yes');}if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'login-thread'}};if(m.method==='turn/start')result={turn:{id:'login-turn'}};send({id:m.id,result});if(m.method==='account/login/start')setTimeout(()=>send({method:'account/login/completed',params:{success:true}}),10);if(m.method==='turn/start')setTimeout(()=>{send({method:'item/agentMessage/delta',params:{threadId:'login-thread',turnId:'login-turn',delta:'Resumed once'}});send({method:'turn/completed',params:{threadId:'login-thread',turn:{id:'login-turn',status:'completed'}}});},10);}`);
 return auth;
}
test('subscription login resumes a saved Telegram task without another incoming message',async()=>{
 const {owner,folder}=fixture();loginBinary(folder);mockTelegram([update(1,'Synthetic login recovery')]);
 await pollTelegramOwner(owner);await runTelegramQueue(owner);expect(channel(owner)!.paused).toBe(2);expect(telegramState(owner).queued).toBe(1);
 await myAgentAction(owner,{action:'login'});await until(()=>myAgentState(owner).account);expect(channel(owner)!.paused).toBe(0);
 await runTelegramQueue(owner);await until(()=>!myAgentState(owner).active_conversation);await runTelegramQueue(owner);
 expect(myAgentState(owner).runs).toHaveLength(1);expect(myAgentState(owner).runs[0]!.answer).toBe('Resumed once');expect(telegramState(owner).queued).toBe(0);
});
test('waiting subscription queue resumes from persisted native authentication after a runtime restart',async()=>{
 const {owner,folder}=fixture();const auth=loginBinary(folder);mockTelegram([update(1,'Synthetic restart recovery')]);
 await pollTelegramOwner(owner);await runTelegramQueue(owner);expect(channel(owner)!.paused).toBe(2);
 await stopMyAgents();fs.writeFileSync(auth,'yes');await runTelegramQueue(owner);await until(()=>!myAgentState(owner).active_conversation);
 expect(channel(owner)!.paused).toBe(0);expect(myAgentState(owner).runs).toHaveLength(1);
});
test('sign-in cannot resurrect an explicitly stopped queue',async()=>{
 const {owner,folder}=fixture();loginBinary(folder);mockTelegram([update(1,'Synthetic stopped task')]);
 await pollTelegramOwner(owner);await runTelegramQueue(owner);await myAgentAction(owner,{action:'stop'});
 await myAgentAction(owner,{action:'login'});await until(()=>myAgentState(owner).account);await runTelegramQueue(owner);
 expect(channel(owner)!.paused).toBe(1);expect(telegramState(owner).queued).toBe(0);expect(myAgentState(owner).runs).toHaveLength(0);
});
test('a partial interrupted answer is delivered with an explicit stopped label',async()=>{
 const {owner}=fixture(),generation=channel(owner)!.generation;
 const conversation=await myAgentAction(owner,{action:'new',title:'Synthetic interrupted answer'}),id=randomUUID();
 db.query("INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,answer,state,created_at,updated_at) VALUES(?,?,?,'synthetic','I will start now','interrupted','now','now')").run(id,conversation.id,id);
 db.query("INSERT INTO qoopia_agent_telegram_delivery(run_id,generation,state) VALUES(?,?,'pending')").run(id,generation);
 const sent=mockTelegram([]);await deliverTelegram(owner);expect(sent[0].text).toContain('Task stopped.');expect(sent[0].text).toContain('I will start now');
});
for(const form of ['empty','fields'])test('native MCP '+form+' confirmation is exposed and answered using its own protocol',async()=>{
 const {owner,folder}=fixture();
 const schema=form==='empty'?{type:'object',properties:{}}:{type:'object',properties:{reason:{type:'string'}},required:['reason']};
 binary(folder,`import readline from 'node:readline';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===900){send({method:'item/agentMessage/delta',params:{threadId:'approval-thread',turnId:'approval-turn',delta:JSON.stringify(m.result)}});send({method:'turn/completed',params:{threadId:'approval-thread',turn:{id:'approval-turn',status:'completed'}}});continue;}if(!m.id)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'approval-thread'}};if(m.method==='turn/start')result={turn:{id:'approval-turn'}};send({id:m.id,result});if(m.method==='turn/start')setTimeout(()=>send({id:900,method:'mcpServer/elicitation/request',params:{threadId:'approval-thread',turnId:'approval-turn',serverName:'qoopia',mode:'form',message:'Synthetic MCP permission',requestedSchema:${JSON.stringify(schema)}}}),10);}`);
 await myAgentAction(owner,{action:'start'});const c=await myAgentAction(owner,{action:'new',title:'Synthetic MCP approval'});
 await myAgentAction(owner,{action:'send',conversation:c.id,requestId:randomUUID(),text:'Synthetic permission'});await until(()=>myAgentState(owner).approvals.length===1);
 const approval=myAgentState(owner).approvals[0]!;expect(approval.params.reason).toBe('Synthetic MCP permission');expect(simpleTelegramApproval(approval)).toBe(false);
 if(form==='fields')await expect(myAgentAction(owner,{action:'approve',id:approval.id,accept:true})).rejects.toThrow('form input');
 await myAgentAction(owner,{action:'approve',id:approval.id,accept:form==='empty'});await until(()=>!myAgentState(owner).active_conversation);
 expect(JSON.parse(myAgentState(owner).runs[0]!.answer)).toEqual(form==='empty'?{action:'accept',content:{}}:{action:'decline'});
});
test('temporary Telegram transport loss backs off without losing or duplicating a receipt',async()=>{
 const {owner}=fixture();globalThis.fetch=(()=>Promise.reject(new Error('synthetic offline'))) as typeof fetch;
 await pollTelegramOwner(owner);expect(channel(owner)!.failures).toBe(1);expect(channel(owner)!.retry_at).toBeGreaterThan(Date.now());expect(telegramState(owner).queued).toBe(0);
 mockTelegram([update(1,'Synthetic after network recovery')]);await pollTelegramOwner(owner);expect(telegramState(owner).queued).toBe(0);
 db.query('UPDATE qoopia_telegram_channels SET retry_at=0 WHERE owner_id=?').run(owner);await pollTelegramOwner(owner);await pollTelegramOwner(owner);
 expect(telegramState(owner).queued).toBe(1);expect(channel(owner)!.failures).toBe(0);expect(channel(owner)!.error).toBeNull();
});
test('a subscribed provider failure is terminal for that receipt, with no automatic replay or provider fallback',async()=>{
 const {owner,folder}=fixture();
 binary(folder,`import readline from 'node:readline';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.id)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'limited-thread'}};if(m.method==='turn/start')result={turn:{id:'limited-turn'}};send({id:m.id,result});if(m.method==='turn/start')setTimeout(()=>send({method:'turn/completed',params:{threadId:'limited-thread',turn:{id:'limited-turn',status:'failed',error:{message:'Synthetic subscription limit'}}}}),10);}`);
 const sent=mockTelegram([update(1,'Synthetic provider failure')]);await pollTelegramOwner(owner);await runTelegramQueue(owner);await until(()=>!myAgentState(owner).active_conversation);await deliverTelegram(owner);await runTelegramQueue(owner);
 expect(myAgentState(owner).provider).toBe('codex');expect(myAgentState(owner).runs).toHaveLength(1);expect(myAgentState(owner).runs[0]!.state).toBe('failed');expect(sent.some(m=>m.text.includes('Task failed.'))).toBe(true);
 expect(db.query('SELECT state FROM qoopia_telegram_inbox WHERE owner_id=?').get(owner)).toEqual({state:'failed'});
});
