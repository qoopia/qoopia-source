import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {continuityEvent,checkpointSession,restoreContext,processMemoryMaintenance} from '../src/services/continuity.ts';
import {saveMessage} from '../src/services/sessions.ts';
import {memoryPolicy,setMemoryPolicy,listMemoryPolicies,resolveAgentByName} from '../src/services/memory-policy.ts';

let workspace:string,owner:string,steward:string,aidan:string,liam:string,foreignWorkspace:string,foreignOwner:string;
beforeAll(()=>{
  runMigrations();
  const ws=createWorkspace({name:'Memory policy check',slug:'memory-policy-check'});workspace=ws.id;
  owner=createAgent({name:'policy-owner',workspaceSlug:ws.slug,type:'owner'}).id;
  steward=createAgent({name:'policy-steward',workspaceSlug:ws.slug,type:'steward'}).id;
  aidan=createAgent({name:'synthetic-aidan',workspaceSlug:ws.slug}).id;
  liam=createAgent({name:'synthetic-liam',workspaceSlug:ws.slug}).id;
  const other=createWorkspace({name:'Foreign policy check',slug:'memory-policy-foreign'});foreignWorkspace=other.id;
  foreignOwner=createAgent({name:'foreign-owner',workspaceSlug:other.slug,type:'owner'}).id;
});
const summarize=async()=>({text:'Цель: проверить политику памяти.',model:'test-fixture',observed_models:[]});
const messages=(session:string)=>(db.query('SELECT COUNT(*) AS n FROM session_messages WHERE session_id=?').get(session) as {n:number}).n;
const contextNotes=(agent:string)=>(db.query("SELECT COUNT(*) AS n FROM notes WHERE agent_id=? AND source='qoopia-continuity'").get(agent) as {n:number}).n;
const progress=(session:string,id:string,content:string)=>({session_id:session,project:'/policy',runtime:'claude_code',event:'progress',messages:[{id,role:'user',content}]});

test('every agent starts in auto and a repeated migration keeps an explicit manual',()=>{
  expect(memoryPolicy(workspace,aidan)).toMatchObject({mode:'auto',revision:0});
  setMemoryPolicy({workspace_id:workspace,agent_id:liam,mode:'manual',actor_id:owner});
  runMigrations();
  expect(memoryPolicy(workspace,liam).mode).toBe('manual');
  setMemoryPolicy({workspace_id:workspace,agent_id:liam,mode:'auto',actor_id:owner});
});

test('manual records nothing new on progress, precompact and end while existing memory stays readable',async()=>{
  const session='claude_code:policy-manual';
  continuityEvent(workspace,aidan,progress(session,'m1','До отключения: данные на Corsair.'));
  await checkpointSession(workspace,aidan,session,summarize);
  const before={messages:messages(session),notes:contextNotes(aidan),context:restoreContext(workspace,aidan,session).context};
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:owner});
  for(const event of ['progress','precompact','end']) {
    const result=continuityEvent(workspace,aidan,{...progress(session,'secret-'+event,'Содержимое периода manual'),event});
    expect(result).toMatchObject({accepted:[],memory_mode:'manual',context:before.context});
  }
  expect(messages(session)).toBe(before.messages);expect(contextNotes(aidan)).toBe(before.notes);
  expect((db.query("SELECT COUNT(*) AS n FROM session_messages WHERE content LIKE '%периода manual%'").get() as {n:number}).n).toBe(0);
  // A brand-new session under manual leaves no session row behind either.
  continuityEvent(workspace,aidan,progress('claude_code:policy-manual-new','n1','Новая сессия в manual'));
  expect(db.query('SELECT 1 FROM sessions WHERE id=?').get('claude_code:policy-manual-new')).toBeNull();
  // Every write path shares the gate: a direct message save and a forced checkpoint are refused too.
  expect(()=>saveMessage({workspace_id:workspace,agent_id:aidan,session_id:session,role:'user',content:'обход через другой путь'})).toThrow('Automatic memory is off');
  await expect(checkpointSession(workspace,aidan,session,summarize)).rejects.toThrow('Automatic memory is off');
});

test('returning to auto starts from the current position without backfilling the manual period',async()=>{
  const session='claude_code:policy-manual';
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'auto',actor_id:owner});
  // The client resumes this session from its own cursor. The turns it already showed while the
  // agent was manual are refused by id; everything after the switch is kept, including the very
  // first batch across the boundary.
  continuityEvent(workspace,aidan,progress(session,'a1','Партия через границу.'));
  continuityEvent(workspace,aidan,progress(session,'a2','После включения: продолжаем.'));
  const tail=restoreContext(workspace,aidan,session).tail.map(m=>m.content).join(' ');
  expect(tail).toContain('Партия через границу');
  expect(tail).toContain('После включения');
  expect(tail).not.toContain('периода manual');
});

test('a client that kept its own cursor cannot backfill the manual period, whatever its clock',async()=>{
  const dave=createAgent({name:'synthetic-replay',workspaceSlug:'memory-policy-check'}).id;
  const known='claude_code:policy-replay-known',opened='claude_code:policy-replay-new';
  const msg=(id:string,content:string,ms?:number)=>({id,role:'user',content,...(ms?{timestamp:new Date(ms).toISOString()}:{})});
  const send=(session:string,event:string,items:unknown[])=>continuityEvent(workspace,dave,{session_id:session,project:'/policy',runtime:'claude_code',event,messages:items}) as any;
  send(known,'start',[msg('k1','До отключения.')]);
  expect(messages(known)).toBe(1);
  setMemoryPolicy({workspace_id:workspace,agent_id:dave,mode:'manual',actor_id:owner});
  send(known,'progress',[msg('k2','Внутри периода manual.')]);
  send(opened,'start',[msg('n1','Новая сессия внутри manual.')]);
  expect(messages(known)).toBe(1);expect(messages(opened)).toBe(0);
  await Bun.sleep(5);
  setMemoryPolicy({workspace_id:workspace,agent_id:dave,mode:'auto',actor_id:owner});
  // An installed 5.0.4 adapter re-sends from its own cursor, and its clock is a month out. The
  // ids it already showed during the period are refused without consulting that clock at all.
  const skewed=Date.now()+30*24*60*60*1000;
  expect(send(opened,'progress',[msg('n1','Новая сессия внутри manual.',skewed)]).accepted).toEqual(['n1']);
  // The session row may exist — that is metadata. What must never exist is its content.
  expect(messages(opened)).toBe(0);
  // The mixed batch: its manual half is refused and its new half is kept, in one delivery.
  expect(send(known,'progress',[msg('k2','Внутри периода manual.',skewed),msg('k3','Уже после включения.',skewed)]).accepted).toEqual(['k2','k3']);
  send(known,'progress',[msg('k4','Следующая партия сохраняется.',skewed)]);
  expect((db.query('SELECT content FROM session_messages WHERE session_id=? ORDER BY id').all(known) as any[]).map(m=>m.content))
    .toEqual(['До отключения.','Уже после включения.','Следующая партия сохраняется.']);
  const leaked=(db.query('SELECT content FROM session_messages').all() as {content:string}[]).filter(r=>r.content.includes('периода manual')||r.content.includes('внутри manual'));
  expect(leaked).toEqual([]);
});

test('a switch to manual while a summary is in flight discards its result',async()=>{
  const session='claude_code:policy-race';
  continuityEvent(workspace,liam,{...progress(session,'r1','Событие до переключения.'),event:'start'});
  const notesBefore=contextNotes(liam);
  const result=await checkpointSession(workspace,liam,session,async()=>{
    setMemoryPolicy({workspace_id:workspace,agent_id:liam,mode:'manual',actor_id:owner});return summarize();});
  expect(result.state).toBe('policy_changed');expect(contextNotes(liam)).toBe(notesBefore);
  // The background worker skips a manual agent even though its journal holds pending messages.
  await processMemoryMaintenance();
  expect(contextNotes(liam)).toBe(notesBefore);
  setMemoryPolicy({workspace_id:workspace,agent_id:liam,mode:'auto',actor_id:owner});
});

test('an owner-confirmed write is accepted in manual; an unconfirmed one is not',()=>{
  const session='claude_code:policy-confirmed';
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:owner});
  saveMessage({workspace_id:workspace,agent_id:aidan,session_id:session,role:'user',content:'Сохранить по явной просьбе.',origin:'owner_confirmed',ingest_uuid:'c1'});
  saveMessage({workspace_id:workspace,agent_id:aidan,session_id:session,role:'user',content:'Сохранить по явной просьбе.',origin:'owner_confirmed',ingest_uuid:'c1'});
  expect(messages(session)).toBe(1);
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'auto',actor_id:owner});
});

test('only the owner of this workspace changes a policy, and only for the named agent',()=>{
  expect(()=>setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:steward})).toThrow('Only the workspace owner');
  expect(()=>setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:aidan})).toThrow('Only the workspace owner');
  expect(()=>setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:foreignOwner})).toThrow('Only the workspace owner');
  expect(()=>setMemoryPolicy({workspace_id:foreignWorkspace,agent_id:aidan,mode:'manual',actor_id:foreignOwner})).toThrow('Agent unavailable');
  const liamBefore=memoryPolicy(workspace,liam);
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:owner});
  expect(memoryPolicy(workspace,liam)).toEqual(liamBefore);
  expect(listMemoryPolicies(workspace).filter(p=>p.mode==='manual').map(p=>p.agent_id)).toEqual([aidan]);
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'auto',actor_id:owner});
});

test('the change is idempotent, revision-checked and logged without conversation content',()=>{
  const start=memoryPolicy(workspace,aidan).revision;
  const first=setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:owner,expected_revision:start});
  expect(first.revision).toBe(start+1);
  expect(setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'manual',actor_id:owner}).revision).toBe(start+1);
  expect(()=>setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'auto',actor_id:owner,expected_revision:start})).toThrow('Policy revision is');
  const log=db.query('SELECT mode,revision,actor_id FROM agent_memory_policy_log WHERE agent_id=? ORDER BY id DESC LIMIT 1').get(aidan);
  expect(log).toEqual({mode:'manual',revision:start+1,actor_id:owner});
  expect((db.query("SELECT group_concat(name) AS columns FROM pragma_table_info('agent_memory_policy_log')").get() as {columns:string}).columns)
    .toBe('id,workspace_id,agent_id,mode,revision,actor_id,created_at_ms');
  setMemoryPolicy({workspace_id:workspace,agent_id:aidan,mode:'auto',actor_id:owner});
});

test('an ambiguous name is reported, never guessed',()=>{
  createAgent({name:'Synthetic-Aidan',workspaceSlug:'memory-policy-check'});
  expect(()=>resolveAgentByName(workspace,'synthetic-aidan')).toThrow('Several agents are named');
  expect(resolveAgentByName(workspace,'synthetic-liam').agent_id).toBe(liam);
  expect(()=>resolveAgentByName(workspace,'nobody')).toThrow('No active agent named');
});

test('the owner command switches one agent by name; a steward can list but not switch',async()=>{
  const {adminTools}=await import('../src/mcp/admin-tools.ts');
  const tool=(name:string)=>adminTools.find(t=>t.name===name)!;
  const as=(id:string,type:string)=>({agent_id:id,agent_name:type,workspace_id:workspace,type,source:'api-key' as const});
  const off=tool('memory_policy_set').handler({agent:'synthetic-liam',mode:'manual'},as(owner,'owner')) as any;
  expect(off).toMatchObject({changed:true,agent_id:liam,mode:'manual'});
  expect((tool('memory_policy_set').handler({agent:liam,mode:'manual'},as(owner,'owner')) as any).changed).toBe(false);
  const listed=tool('memory_policy_list').handler({},as(steward,'steward')) as any;
  expect(listed.agents.find((a:any)=>a.agent_id===liam).mode).toBe('manual');expect(listed.manual).toBe(1);
  expect(()=>tool('memory_policy_set').handler({agent:liam,mode:'auto'},as(steward,'steward'))).toThrow('Only the workspace owner');
  expect(()=>tool('memory_policy_list').handler({},as(aidan,'standard'))).toThrow('steward or owner');
  tool('memory_policy_set').handler({agent:liam,mode:'auto'},as(owner,'owner'));
});

test('a session whose start event never landed is still captured from its next batch',async()=>{
  const eve=createAgent({name:'synthetic-late-start',workspaceSlug:'memory-policy-check'}).id;
  const session='claude_code:policy-late-start';
  const send=(event:string,items:unknown[])=>continuityEvent(workspace,eve,{session_id:session,project:'/policy',runtime:'claude_code',event,messages:items}) as any;
  setMemoryPolicy({workspace_id:workspace,agent_id:eve,mode:'manual',actor_id:owner});
  await Bun.sleep(5);
  setMemoryPolicy({workspace_id:workspace,agent_id:eve,mode:'auto',actor_id:owner});
  // The start delivery was lost, so the first thing this server sees is a progress batch. This
  // server never refused these ids and they carry no manual timestamp, so nothing is dropped.
  expect(send('progress',[{id:'l1',role:'user',content:'Первая партия без start.'}]).accepted).toEqual(['l1']);
  expect(db.query('SELECT 1 FROM sessions WHERE id=?').get(session)).not.toBeNull();
  send('progress',[{id:'l2',role:'user',content:'Следующая партия сохраняется.'}]);
  expect((db.query('SELECT content FROM session_messages WHERE session_id=?').all(session) as any[]).map(m=>m.content))
    .toEqual(['Первая партия без start.','Следующая партия сохраняется.']);
});

test('repeated switches keep every new turn and no manual one, and a restart changes nothing',async()=>{
  const nina=createAgent({name:'synthetic-repeat',workspaceSlug:'memory-policy-check'}).id;
  const session='claude_code:policy-repeat';
  const send=(event:string,items:unknown[])=>continuityEvent(workspace,nina,{session_id:session,project:'/policy',runtime:'claude_code',event,messages:items}) as any;
  const line=(id:string,text:string)=>({id,role:'user',content:text});
  const kept=()=>(db.query('SELECT content FROM session_messages WHERE session_id=? ORDER BY id').all(session) as {content:string}[]).map(row=>row.content);
  send('start',[line('r1','Первый ход в auto.')]);
  for(const round of [1,2]) {
    setMemoryPolicy({workspace_id:workspace,agent_id:nina,mode:'manual',actor_id:owner});
    send('progress',[line('m'+round,'Содержимое периода manual '+round)]);
    await Bun.sleep(3);
    setMemoryPolicy({workspace_id:workspace,agent_id:nina,mode:'auto',actor_id:owner});
    // The client replays its held turn together with the new one, exactly as a restarted hook does.
    send('progress',[line('m'+round,'Содержимое периода manual '+round),line('a'+round,'Новый ход после возврата '+round)]);
  }
  // A restarted handler re-sends the whole tail from its cursor; the ledger still separates it.
  send('progress',[line('m1','Содержимое периода manual 1'),line('m2','Содержимое периода manual 2'),
    line('a1','Новый ход после возврата 1'),line('a2','Новый ход после возврата 2'),line('a3','Ход после перезапуска.')]);
  expect(kept()).toEqual(['Первый ход в auto.','Новый ход после возврата 1','Новый ход после возврата 2','Ход после перезапуска.']);
  expect(kept().filter(text=>text.includes('периода manual'))).toEqual([]);
});
