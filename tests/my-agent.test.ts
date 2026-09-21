import {test,expect,beforeAll} from 'bun:test';
import {ownerFixture} from './helpers/p1-fixtures.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {myAgentState,myAgentAction,recoverMyAgentRuns,agentDirectory,agentArtifact,readAgentArtifact,safeAgentAnswer} from '../src/services/my-agent.ts';
import {createAgent} from '../src/admin/agents.ts';
import {durableWrite,privateDirectory} from '../src/utils/fs.ts';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {isBoundTelegramMessage,telegramState,telegramCall,pollTelegramOwner,telegramAction,stopTelegramChannels,deliverTelegram} from '../src/services/my-agent-telegram.ts';
import {inspectSnapshot} from '../src/delivery/snapshot.ts';
beforeAll(()=>runMigrations());

test('schema 42 preserves owner and memory in the normal verified snapshot',()=>{
  const {database:d,owner}=ownerFixture(42);
  try{
    d.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,owner.workspace_id,owner.agent_id,new Date().toISOString());
    expect(inspectSnapshot(d).schema).toBe(42);
    expect(d.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(()=>d.query('INSERT INTO qoopia_agent_conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)').run('bad','foreign','no','now')).toThrow();
  }finally{d.close();}
});
test('agent control requires a human owner and cannot read another owner conversation',async()=>{
  db.query("INSERT INTO workspaces(id,name,slug) VALUES('my-agent-a','My agent A','my-agent-a'),('my-agent-b','My agent B','my-agent-b')").run();
  const a=bootstrapOwner(db,'Agent UI fixture',undefined,'my-agent-a'),b=bootstrapOwner(db,'Other UI fixture',undefined,'my-agent-b');
  expect(()=>myAgentState('missing')).toThrow();expect(()=>telegramState('missing')).toThrow();
  db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,enabled,created_at) VALUES(?,?,?,0,?)').run(a.agent_id,a.workspace_id,a.agent_id,'now');
  db.query('INSERT INTO qoopia_agent_conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)').run('foreign-conversation',a.agent_id,'Private','now');
  expect(()=>myAgentState(b.agent_id,'foreign-conversation')).toThrow('not found');
  expect(myAgentState(b.agent_id).conversations).toEqual([]);
  await expect(myAgentAction(b.agent_id,{action:'setup',acceptPermissions:false})).rejects.toThrow();
  await expect(myAgentAction(b.agent_id,{action:'rpc',method:'anything'})).rejects.toThrow();
  db.query("INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,state,created_at,updated_at) VALUES('recover','foreign-conversation','req','synthetic','running','now','now')").run();
  recoverMyAgentRuns();
  expect(db.query("SELECT state FROM qoopia_agent_runs WHERE id='recover'").get()).toEqual({state:'interrupted'});
  expect(()=>db.query("INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,state,created_at,updated_at) VALUES('duplicate','foreign-conversation','req','synthetic','starting','now','now')").run()).toThrow();
});
test('Telegram binding accepts only the confirmed person in their private chat',()=>{
  const settings={telegram_user_id:'123',telegram_chat_id:'123'} as any;
  const message={from:{id:123,is_bot:false},chat:{id:123,type:'private'},text:'hello'};
  expect(isBoundTelegramMessage(settings,message)).toBe(true);
  expect(isBoundTelegramMessage(settings,{...message,from:{id:456}})).toBe(false);
  expect(isBoundTelegramMessage(settings,{...message,chat:{id:123,type:'group'}})).toBe(false);
  expect(isBoundTelegramMessage(settings,{...message,from:{id:123,is_bot:true}})).toBe(false);
  expect(isBoundTelegramMessage(settings,undefined)).toBe(false);
});
test('Telegram transport errors never expose a token or request URL',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=(()=>{throw new Error('https://api.telegram.org/bot123:SECRET/sendMessage');}) as any;
    await expect(telegramCall('123:SECRET','getMe',{})).rejects.toThrow('Telegram did not accept');
    try{await telegramCall('123:SECRET','getMe',{});}catch(error){expect(String(error)).not.toContain('SECRET');expect(String(error)).not.toContain('api.telegram.org');}
  }finally{globalThis.fetch=original;}
});
test('shared channel selection and paged history include turn 201; artifacts cannot escape agent folder',async()=>{
  db.query("INSERT INTO workspaces(id,name,slug) VALUES('agent-history','Agent history','agent-history')").run();
  const owner=bootstrapOwner(db,'History owner',undefined,'agent-history');
  const agent=createAgent({name:'History steward',workspaceSlug:'agent-history',type:'steward'});
  db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,owner.workspace_id,agent.id,'now');
  const folder=agentDirectory(owner.agent_id);durableWrite(path.join(folder,'credentials.json'),JSON.stringify({key:agent.api_key}));
  const a=randomUUID(),b=randomUUID();
  for(const [id,title] of [[a,'Older task'],[b,'Newer task']])db.query('INSERT INTO qoopia_agent_conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)').run(id!,owner.agent_id,title!,'now');
  for(let i=0;i<201;i++)db.query('INSERT INTO qoopia_agent_runs(id,conversation_id,request_id,prompt,answer,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('history-'+i,a,'req-'+i,'Question '+i,'Answer '+i,'completed',new Date(1700000000000+i*1000).toISOString(),'now');
  await myAgentAction(owner.agent_id,{action:'select-conversation',conversation:a});
  const state=myAgentState(owner.agent_id);expect(state.selected).toBe(a);expect(state.runs.at(-1)?.prompt).toBe('Question 200');expect(state.runs.length).toBe(50);expect(state.has_older_runs).toBe(true);
  const older=myAgentState(owner.agent_id,a,{runBefore:state.runs[0]!.id});expect(older.runs.at(-1)?.prompt).toBe('Question 150');
  expect(()=>myAgentState(owner.agent_id,b,{runBefore:state.runs[0]!.id})).toThrow('cursor');
  const workspace=privateDirectory(path.join(folder,'workspace'));durableWrite(path.join(workspace,'result.txt'),'Synthetic result');
  expect(agentArtifact(owner.agent_id,'result.txt').size).toBe(16);
  expect(readAgentArtifact(owner.agent_id,'result.txt').bytes.toString()).toBe('Synthetic result');
  for(let i=0;i<101;i++)db.query('INSERT INTO qoopia_agent_conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)').run(randomUUID(),owner.agent_id,'Archived '+i,'later');
  const index=myAgentState(owner.agent_id);expect(index.more_conversations).toBe(true);expect(index.conversations.length).toBe(100);
  const index2=myAgentState(owner.agent_id,undefined,{conversationOffset:index.next_conversation_offset});expect(index2.conversations.length).toBe(3);expect(index2.more_conversations).toBe(false);
  expect(()=>agentArtifact(owner.agent_id,'../credentials.json')).toThrow();
  fs.symlinkSync(path.join(folder,'credentials.json'),path.join(workspace,'link.txt'));
  expect(()=>agentArtifact(owner.agent_id,'link.txt')).toThrow();
  expect(safeAgentAnswer('/Users/example/result.txt')).toBe('/Users/example/result.txt');
  expect(safeAgentAnswer('Bearer '+agent.api_key)).not.toContain(agent.api_key);
});

test('a Telegram message received before sign-in is saved before acknowledgment; foreign messages never enter the queue',async()=>{
  const id='telegram-queue';db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(id,id,id);
  const owner=bootstrapOwner(db,'Telegram queue owner',undefined,id),agent=createAgent({name:'Queue agent',workspaceSlug:id,type:'steward'});
  db.query("INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,telegram_username,telegram_user_id,telegram_chat_id,created_at) VALUES(?,?,?,'fixture_bot','123','123','now')").run(owner.agent_id,id,agent.id);
  const folder=agentDirectory(owner.agent_id);durableWrite(path.join(folder,'credentials.json'),JSON.stringify({key:agent.api_key}));durableWrite(path.join(folder,'telegram.json'),JSON.stringify({token:'123:FAKE'}));
  const original=globalThis.fetch;const notices:unknown[]=[];
  try {
    globalThis.fetch=(async(url:any,init:any)=>{const body=JSON.parse(init.body);if(String(url).endsWith('/getUpdates'))return Response.json({ok:true,result:[{update_id:7,message:{from:{id:123},chat:{id:123,type:'private'},text:'Hello'}},{update_id:8,message:{from:{id:999},chat:{id:999,type:'private'},text:'Do not run'}}]});notices.push(body);return Response.json({ok:true,result:{message_id:9}});}) as any;
    await pollTelegramOwner(owner.agent_id);
    expect(db.query('SELECT telegram_offset FROM qoopia_agent_settings WHERE owner_id=?').get(owner.agent_id)).toEqual({telegram_offset:9});
    expect(notices.length).toBe(0);expect(telegramState(owner.agent_id).queued).toBe(1);expect(myAgentState(owner.agent_id).runs).toEqual([]);
    await deliverTelegram(owner.agent_id);expect(notices.length).toBe(1);
    await pollTelegramOwner(owner.agent_id);expect(telegramState(owner.agent_id).queued).toBe(1);
  }finally{globalThis.fetch=original;}
});

test('managed turn approval, answer persistence and duplicate send are one transactionally tracked conversation',async()=>{
  const {stopMyAgents}=await import('../src/services/my-agent.ts');
  const slug='managed-turn';db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Managed turn owner',undefined,slug),agent=createAgent({name:'Managed fixture agent',workspaceSlug:slug,type:'steward'});
  db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,slug,agent.id,'now');
  const folder=agentDirectory(owner.agent_id);durableWrite(path.join(folder,'credentials.json'),JSON.stringify({key:agent.api_key}));
  const bin=privateDirectory(path.join(folder,'fixture-bin')),binary=path.join(bin,'codex'),previousPath=process.env.PATH;
  durableWrite(binary,'#!'+process.execPath+'\n'+`
    import readline from 'node:readline';
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    for await(const line of readline.createInterface({input:process.stdin})){
      const m=JSON.parse(line);if(m.method==='initialized')continue;
      if(m.id===900){send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',turnId:'fixture-turn',delta:'Synthetic approved result'}});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}});continue;}
      let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};
      if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'fixture-thread'}};
      if(m.method==='turn/start')result={turn:{id:'fixture-turn'}};
      send({id:m.id,result});
      if(m.method==='turn/start')setTimeout(()=>send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',turnId:'fixture-turn',command:'synthetic command',reason:'Fixture approval'}}),20);
    }
  `,0o700);
  async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Synthetic turn timeout');}
  try {
    process.env.PATH=bin+path.delimiter+previousPath;
    await myAgentAction(owner.agent_id,{action:'start'});
    const c=await myAgentAction(owner.agent_id,{action:'new',title:'Synthetic turn'}),request={action:'send',conversation:c.id,requestId:'same-request',text:'Create a synthetic result'};
    const first=await myAgentAction(owner.agent_id,request);await until(()=>myAgentState(owner.agent_id).approvals.length===1);
    const approval=myAgentState(owner.agent_id).approvals[0]!;
    await expect(myAgentAction(owner.agent_id,{action:'approve',id:randomUUID(),accept:true})).rejects.toThrow('expired');
    await myAgentAction(owner.agent_id,{action:'approve',id:approval.id,accept:true});await until(()=>myAgentState(owner.agent_id).runs[0]?.state==='completed');
    expect(myAgentState(owner.agent_id).runs[0]?.answer).toBe('Synthetic approved result');
    expect((await myAgentAction(owner.agent_id,request)).id).toBe(first.id);expect(myAgentState(owner.agent_id).runs.length).toBe(1);
    const messages=db.query('SELECT role FROM session_messages WHERE session_id=? ORDER BY created_at').all(c.id);expect(messages.length).toBe(2);
    await expect(myAgentAction(owner.agent_id,{action:'approve',id:approval.id,accept:true})).rejects.toThrow('expired');

    // «Only on request»: the chat keeps working, but the turn's text exists in this process only.
    const {setMemoryPolicy}=await import('../src/services/memory-policy.ts');
    setMemoryPolicy({workspace_id:slug,agent_id:agent.id,mode:'manual',actor_id:owner.agent_id});
    const marker='MANUAL-ONLY-PROMPT-7f3a',manual=await myAgentAction(owner.agent_id,{action:'send',conversation:c.id,requestId:'manual-turn',text:marker});
    await until(()=>myAgentState(owner.agent_id).approvals.length===1);
    await myAgentAction(owner.agent_id,{action:'approve',id:myAgentState(owner.agent_id).approvals[0]!.id,accept:true});
    await until(()=>myAgentState(owner.agent_id).runs[1]?.state==='completed');
    expect(myAgentState(owner.agent_id).runs[1]).toMatchObject({id:manual.id,prompt:marker,answer:'Synthetic approved result'});
    expect(db.query('SELECT prompt,answer,state FROM qoopia_agent_runs WHERE id=?').get(manual.id)).toEqual({prompt:'',answer:'',state:'completed'});
    expect(db.query('SELECT role FROM session_messages WHERE session_id=?').all(c.id).length).toBe(2);
    const tables=(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts_%' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(t=>t.name);
    const leaked=tables.filter(table=>{try{return (db.query(`SELECT * FROM "${table}"`).all() as object[]).some(row=>JSON.stringify(row).includes(marker));}catch{return false;}});
    expect(leaked).toEqual([]);
    expect((await myAgentAction(owner.agent_id,{action:'send',conversation:c.id,requestId:'manual-turn',text:marker})).id).toBe(manual.id);
  }finally{process.env.PATH=previousPath;await stopMyAgents();}
});

test('schema 43 preserves old Codex conversations and pins new conversations to their selected subscription',async()=>{
  const {database:d,owner}=ownerFixture(43);
  try{
    d.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,owner.workspace_id,owner.agent_id,'now');
    d.query('INSERT INTO qoopia_agent_conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)').run('old',owner.agent_id,'Preserved','now');
    expect(d.query('SELECT provider FROM qoopia_agent_conversations').get()).toEqual({provider:'codex'});
    expect(inspectSnapshot(d).schema).toBe(43);expect(d.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{d.close();}
  const slug='claude-conversation';db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner2=bootstrapOwner(db,'Claude fixture owner',undefined,slug),agent=createAgent({name:'Claude steward fixture',workspaceSlug:slug,type:'steward'});
  db.query("INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,provider,created_at) VALUES(?,?,?,'claude_code','now')").run(owner2.agent_id,slug,agent.id);
  const folder=agentDirectory(owner2.agent_id);durableWrite(path.join(folder,'credentials.json'),JSON.stringify({key:agent.api_key}));
  const newConversation=await myAgentAction(owner2.agent_id,{action:'new',title:'Claude task'});
  expect(myAgentState(owner2.agent_id).provider).toBe('claude_code');expect(myAgentState(owner2.agent_id).selected_provider).toBe('claude_code');
  db.query("UPDATE qoopia_agent_settings SET provider='codex',active_conversation_id=NULL WHERE owner_id=?").run(owner2.agent_id);
  expect(myAgentState(owner2.agent_id).selected).toBeUndefined();
  expect(myAgentState(owner2.agent_id,newConversation.id).selected_provider).toBe('claude_code');
});

test('switching the dashboard to Claude retains Codex history, verifies selected auth and completes a stored Claude turn',async()=>{
  const {stopMyAgents}=await import('../src/services/my-agent.ts');
  const {memoryRoot}=await import('../src/services/memory-model.ts');
  const {unpackNativePackage}=await import('../src/delivery/native-provision.ts');
  const {hash}=await import('../src/utils/fs.ts');
  const slug='provider-switch';db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Provider owner',undefined,slug),agent=createAgent({name:'Provider steward',workspaceSlug:slug,type:'steward'});
  db.query("INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,'now')").run(owner.agent_id,slug,agent.id);
  const folder=agentDirectory(owner.agent_id);durableWrite(path.join(folder,'credentials.json'),JSON.stringify({key:agent.api_key}));
  const old=await myAgentAction(owner.agent_id,{action:'new',title:'Codex history'});
  const bytes=Buffer.from('#!'+process.execPath+'\n'+`
   import readline from 'node:readline';
   const args=process.argv.slice(2),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
   if(args[0]==='auth'){(await import('node:fs')).appendFileSync(process.cwd()+'/.auth-probes','1');send({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'});process.exit(0);}
   const id=args.find(a=>a.startsWith('--session-id=')||a.startsWith('--resume=')).split('=')[1];
   for await(const line of readline.createInterface({input:process.stdin})){
    const m=JSON.parse(line);
    if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
    if(m.type==='user')send({type:'result',session_id:id,subtype:'success',is_error:false,result:'Claude fixture complete'});
   }
  `);
  const target=process.platform+'-'+process.arch,base=path.join(memoryRoot(),'native-runtimes'),dest=path.join(base,'claude_code','2.1.224'),selected=path.join(base,'claude_code.json');
  expect(fs.existsSync(selected)||fs.existsSync(dest)).toBe(false);
  const pkg={runtime:'claude_code',target,version:'2.1.224',url:'https://downloads.claude.ai/claude-code-releases/2.1.224/'+target+'/claude',sha256:hash(bytes),size:bytes.length,binary:'claude'};
  try{
    privateDirectory(path.dirname(dest));await unpackNativePackage(pkg,bytes,dest);durableWrite(selected,JSON.stringify(pkg));
    const state=await myAgentAction(owner.agent_id,{action:'provider',provider:'claude_code'});
    expect(state.provider).toBe('claude_code');expect(state.account).toBe(true);expect(state.selected).toBeUndefined();
    const probes=path.join(folder,'workspace','.auth-probes');expect(fs.readFileSync(probes,'utf8')).toBe('1');
    await stopMyAgents();await myAgentAction(owner.agent_id,{action:'start'});expect(fs.readFileSync(probes,'utf8')).toBe('11');
    await myAgentAction(owner.agent_id,{action:'start'});expect(fs.readFileSync(probes,'utf8')).toBe('111');
    await expect(myAgentAction(owner.agent_id,{action:'send',conversation:old.id,requestId:'foreign',text:'Must stay in Codex'})).rejects.toThrow('another subscription');
    const c=await myAgentAction(owner.agent_id,{action:'new',title:'Claude history'});
    const request={action:'send',conversation:c.id,requestId:'once',text:'Synthetic instruction'};
    const result=await myAgentAction(owner.agent_id,request);
    for(let i=0;i<100&&myAgentState(owner.agent_id).runs[0]?.state!=='completed';i++)await new Promise(r=>setTimeout(r,10));
    expect(myAgentState(owner.agent_id).runs[0]?.answer).toBe('Claude fixture complete');
    expect((await myAgentAction(owner.agent_id,request)).id).toBe(result.id);
    expect(db.query('SELECT count(*) n FROM session_messages WHERE session_id=?').get(c.id)).toEqual({n:2});
    expect(myAgentState(owner.agent_id).conversations.length).toBe(2);
    expect(fs.readFileSync(path.join(folder,'claude_code','CLAUDE.md'),'utf8')).toContain('@qoopia-protocol.md');
  }finally{await stopMyAgents();fs.rmSync(selected,{force:true});fs.rmSync(path.join(base,'claude_code'),{recursive:true,force:true});}
});

test('Telegram setup checks in parallel and persists confirmation independently of greeting delivery',async()=>{
  const slug='tg-retry-'+randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Telegram retry owner',undefined,slug),agent=createAgent({name:'Retry steward',workspaceSlug:slug,type:'steward'});
  db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,created_at) VALUES(?,?,?,?)').run(owner.agent_id,slug,agent.id,'now');
  durableWrite(path.join(agentDirectory(owner.agent_id),'credentials.json'),JSON.stringify({key:agent.api_key}));
  const original=globalThis.fetch;let checks=0,peak=0,failGreeting=true,code='',person=123;
  try{
    globalThis.fetch=(async(url:any)=>{
      const method=String(url).split('/').at(-1);
      if(method==='getMe'||method==='getWebhookInfo'){
        checks++;peak=Math.max(peak,checks);await Bun.sleep(20);checks--;
        return Response.json({ok:true,result:method==='getMe'?{is_bot:true,username:'retry_fixture_bot'}:{url:''}});
      }
      if(method==='getUpdates')return Response.json({ok:true,result:[{update_id:1,message:{from:{id:person,first_name:'Fixture'},chat:{id:person,type:'private'},text:'/start '+code}}]});
      if(method==='sendMessage'&&failGreeting)return Response.json({ok:false},{status:503});
      if(method==='sendMessage'&&!failGreeting){person=456;await pollTelegramOwner(owner.agent_id);}
      return Response.json({ok:true,result:{message_id:1}});
    }) as typeof fetch;
    const connected=await telegramAction(owner.agent_id,{action:'telegram-connect',token:'12345:'+ 'a'.repeat(24)});stopTelegramChannels();
    expect(peak).toBe(2);code=new URL(connected.url!).searchParams.get('start')!;
    await pollTelegramOwner(owner.agent_id);expect(telegramState(owner.agent_id).pending?.user?.id).toBe('123');
    expect(await telegramAction(owner.agent_id,{action:'telegram-confirm',userId:'123',chatId:'123'})).toEqual({linked:true});
    await deliverTelegram(owner.agent_id);expect(telegramState(owner.agent_id).uncertain_deliveries).toBe(1);
    expect(myAgentState(owner.agent_id).telegram.linked).toBe(true);
    failGreeting=false;expect(await telegramAction(owner.agent_id,{action:'telegram-confirm',userId:'123',chatId:'123'})).toEqual({linked:true});
    expect(telegramState(owner.agent_id).pending).toBeNull();expect(myAgentState(owner.agent_id).telegram.linked).toBe(true);
    expect(db.query('SELECT telegram_user_id FROM qoopia_agent_settings WHERE owner_id=?').get(owner.agent_id)).toEqual({telegram_user_id:'123'});
  }finally{stopTelegramChannels();globalThis.fetch=original;}
});
