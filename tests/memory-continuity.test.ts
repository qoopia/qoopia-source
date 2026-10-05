import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {continuityEvent,checkpointSession,restoreContext} from '../src/services/continuity.ts';
import {updateNote} from '../src/services/notes.ts';
import {saveMessage} from '../src/services/sessions.ts';
import {memoryPrompt} from '../src/services/memory-model.ts';
import {QoopiaError} from '../src/utils/errors.ts';
let workspace:string,agent:string,other:string;
beforeAll(()=>{runMigrations();const ws=createWorkspace({name:'Continuity check',slug:'continuity-check'});workspace=ws.id;
  agent=createAgent({name:'continuity-agent',workspaceSlug:ws.slug}).id;other=createAgent({name:'continuity-other',workspaceSlug:ws.slug}).id;});
const summarize=async()=>({text:'Цель: сохранить данные на Corsair. Сделано: резервная копия. Дальше: проверить восстановление.',model:'test-fixture',observed_models:[]});
test('a timed-out checkpoint retries smaller batches without losing or acknowledging source messages',async()=>{
  const session='claude_code:timeout-recovery';
  const event={session_id:session,project:'/timeout-check',runtime:'claude_code',event:'precompact',
    messages:Array.from({length:4},(_,i)=>({id:'timeout-'+i,role:'user',content:'Synthetic decision '+i+' '.repeat(2100)}))};
  continuityEvent(workspace,agent,event);
  await expect(checkpointSession(workspace,agent,session,async(_w,_i,input)=>{
    expect((input as any).new_events).toHaveLength(4);throw new QoopiaError('MODEL_TIMEOUT','Synthetic timeout');
  })).rejects.toThrow('Synthetic timeout');
  expect(restoreContext(workspace,agent,session).revision).toBe(0);
  expect(restoreContext(workspace,agent,session).tail).toHaveLength(4);
  db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_error','MODEL_TIMEOUT','$.continuity_retry_at',?) WHERE id=?").run(Date.now()+300_000,session);
  const ids:number[]=[];
  for(let i=0;i<2;i++)await checkpointSession(workspace,agent,session,async(_w,_i,input)=>{
    const events=(input as any).new_events as {id:number}[];
    expect(events).toHaveLength(2);ids.push(...events.map(e=>e.id));return summarize();
  });
  expect(new Set(ids).size).toBe(4);
  expect(restoreContext(workspace,agent,session).revision).toBe(2);
  expect(restoreContext(workspace,agent,session).tail).toHaveLength(0);
  const meta=JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(session) as {metadata:string}).metadata);
  expect(meta.continuity_error).toBeUndefined();expect(meta.continuity_retry_at).toBeUndefined();
});
test('journal replay is idempotent; living note and immutable source ranges advance together',async()=>{
  const event={session_id:'claude_code:continuity-one',project:'/project-one',runtime:'claude_code',event:'progress',messages:[
    {id:'one-1',role:'user',content:'Данные остаются на Corsair.'},{id:'one-2',role:'assistant',content:'Резервная копия создана.'}]};
  continuityEvent(workspace,agent,event);continuityEvent(workspace,agent,event);
  expect(restoreContext(workspace,agent,event.session_id).tail).toHaveLength(2);
  const saved=await checkpointSession(workspace,agent,event.session_id,summarize);expect(saved.state).toBe('saved');
  const before=restoreContext(workspace,agent,event.session_id);expect(before.revision).toBe(1);expect(before.tail).toHaveLength(0);
  expect((await checkpointSession(workspace,agent,event.session_id,summarize)).state).toBe('unchanged');
  continuityEvent(workspace,agent,{...event,event:'precompact',messages:[{id:'one-3',role:'user',content:'Отменяю перенос на Mac.'}]});
  await checkpointSession(workspace,agent,event.session_id,async()=>({...await summarize(),text:'Данные остаются на Corsair. Перенос на Mac отменён.'}));
  const after=restoreContext(workspace,agent,event.session_id);expect(after.note_id).toBe(before.note_id);expect(after.revision).toBe(2);
  expect((db.query('SELECT COUNT(*) AS n FROM summaries WHERE session_id=?').get(event.session_id) as {n:number}).n).toBe(2);
  expect(()=>restoreContext(workspace,other,event.session_id)).toThrow('Session unavailable');
});
test('crash before summarization restores unsummarized predecessor events; parallel session notes remain separate',async()=>{
  const first={session_id:'codex:crashed',project:'/crash-project',runtime:'codex',event:'progress',messages:[{id:'crash-1',role:'user',content:'Новый адрес сервера: corsair.'}]};
  continuityEvent(workspace,agent,first);
  const next=continuityEvent(workspace,agent,{session_id:'codex:reopened',project:'/crash-project',runtime:'codex',event:'start',previous_session_id:'codex:crashed'});
  expect(next.tail.some(m=>m.content.includes('corsair'))).toBe(true);
  continuityEvent(workspace,agent,{session_id:'codex:reopened',project:'/crash-project',runtime:'codex',event:'progress',messages:[{id:'new-1',role:'assistant',content:'Продолжаю проверку.'}]});
  let inherited=false;
  await checkpointSession(workspace,agent,'codex:reopened',async(_w,_i,input)=>{inherited=JSON.stringify(input).includes('corsair');return summarize();});
  expect(inherited).toBe(true);
  await checkpointSession(workspace,agent,'codex:crashed',summarize);
  expect(restoreContext(workspace,agent,'codex:reopened').note_id).not.toBe(restoreContext(workspace,agent,'codex:crashed').note_id);
});
test('a concurrent manual correction fences an in-flight model result',async()=>{
  const session='claude_code:fencing';continuityEvent(workspace,agent,{session_id:session,project:'/fencing',runtime:'claude_code',event:'progress',messages:[{id:'f1',role:'user',content:'Сохрани это решение.'}]});
  await checkpointSession(workspace,agent,session,summarize);const old=restoreContext(workspace,agent,session);
  continuityEvent(workspace,agent,{session_id:session,project:'/fencing',runtime:'claude_code',event:'precompact',messages:[{id:'f2',role:'user',content:'Уточняю решение.'}]});
  const result=await checkpointSession(workspace,agent,session,async()=>{updateNote({workspace_id:workspace,agent_id:agent,is_admin:false,id:old.note_id!,text:'Ручное уточнение владельца.'});return summarize();});
  expect(result.state).toBe('changed_during_summary');expect(restoreContext(workspace,agent,session).tail).toHaveLength(1);
  expect(restoreContext(workspace,agent,session).context).toBe('Ручное уточнение владельца.');
});
// The real prompt bound of memoryText, with only the model launch stubbed.
const bounded=async(_w:string,instruction:string,input:unknown)=>{memoryPrompt(instruction,input);return summarize();};
const cursor=(session:string)=>restoreContext(workspace,agent,session).through_message_id;
const lastId=(session:string)=>(db.query('SELECT MAX(id) AS id FROM session_messages WHERE session_id=?').get(session) as {id:number}).id;
const drain=async(session:string)=>{for(let i=0;i<10&&cursor(session)<lastId(session);i++){
  db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_priority',1) WHERE id=?").run(session);
  await checkpointSession(workspace,agent,session,bounded);}};
const save=(session:string,role:'user'|'tool',content:string)=>saveMessage({workspace_id:workspace,agent_id:agent,session_id:session,role,content});
test('one quote-dense message cannot stall a session: the summary sees an excerpt, the journal keeps it whole',async()=>{
  const session='mcp:oversized-message',big='"x"\n'.repeat(24_000);
  save(session,'tool',big);for(let i=0;i<5;i++)save(session,'user','Later decision '+i);
  await drain(session);
  expect(restoreContext(workspace,agent,session).revision).toBeGreaterThanOrEqual(1);
  expect(cursor(session)).toBe(lastId(session));
  expect((db.query('SELECT content FROM session_messages WHERE session_id=? ORDER BY id LIMIT 1').get(session) as {content:string}).content).toBe(big);
});
test('binary tool output that escapes far beyond its raw size still advances the cursor',async()=>{
  const session='mcp:binary-chunks';
  for(let i=0;i<4;i++)save(session,'tool','\u0001'.repeat(12_000));save(session,'user','After the dump.');
  await drain(session);
  expect(restoreContext(workspace,agent,session).revision).toBeGreaterThanOrEqual(1);
  expect(cursor(session)).toBe(lastId(session));
});
test('an over-long summary is cut at a line boundary instead of being thrown away',async()=>{
  const session='mcp:long-summary';save(session,'user','Normal turn.');
  const saved=await checkpointSession(workspace,agent,session,async()=>({text:'Строка состояния.\n'.repeat(500),model:'test-fixture',observed_models:[]}));
  expect(saved.state).toBe('saved');
  const context=restoreContext(workspace,agent,session).context;
  expect(context.length).toBeLessThanOrEqual(8000);expect(context.endsWith('Строка состояния.')).toBe(true);
});
test('a batch shrunk by timeouts grows back after recovery, and a pending backlog never waits',async()=>{
  const session='claude_code:batch-regrowth';
  continuityEvent(workspace,agent,{session_id:session,project:'/regrowth',runtime:'claude_code',event:'precompact',
    messages:Array.from({length:60},(_,i)=>({id:'grow-'+i,role:'user',content:'Short turn '+i}))});
  for(let i=0;i<7;i++)await checkpointSession(workspace,agent,session,async()=>{throw new QoopiaError('MODEL_TIMEOUT','Synthetic timeout');}).catch(()=>{});
  const meta=()=>JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(session) as {metadata:string}).metadata);
  expect(meta().continuity_batch_limit).toBe(1);
  const sizes:number[]=[],states:string[]=[];
  const ok=async(_w:string,_i:string,input:unknown)=>{sizes.push((input as any).new_events.length);return summarize();};
  for(let i=0;i<6;i++)states.push((await checkpointSession(workspace,agent,session,ok)).state);
  // Five healthy rounds double the batch; the sixth finds only a small remainder, which waits as before.
  expect(sizes).toEqual([1,2,4,8,16]);expect(states.at(-1)).toBe('waiting');
  db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_priority',1) WHERE id=?").run(session);
  expect((await checkpointSession(workspace,agent,session,ok)).state).toBe('saved');
  expect(meta().continuity_batch_limit).toBe(64);
  continuityEvent(workspace,agent,{session_id:session,project:'/regrowth',runtime:'claude_code',event:'precompact',messages:[{id:'grow-last',role:'user',content:'One more.'}]});
  await checkpointSession(workspace,agent,session,ok);
  expect(meta().continuity_batch_limit).toBeUndefined();
});
test('a predecessor the server never recorded, or one already continued, stays unlinked instead of failing the start',()=>{
  const event=(session_id:string,extra:Record<string,unknown>={})=>({session_id,project:'/guess',runtime:'claude_code',event:'start',...extra});
  continuityEvent(workspace,agent,event('claude_code:guess-1',{event:'progress',messages:[{id:'guess-1',role:'user',content:'Решение: оставить Corsair.'}]}));
  expect(continuityEvent(workspace,agent,event('claude_code:guess-2',{previous_session_id:'claude_code:guess-1'})).tail.some(m=>m.content.includes('Corsair'))).toBe(true);
  // A second session guessing the same predecessor starts, empty and unlinked; the first link stays.
  expect(continuityEvent(workspace,agent,event('claude_code:guess-3',{previous_session_id:'claude_code:guess-1'})).tail).toEqual([]);
  // A session from a manual period or an outage was never recorded here.
  expect(continuityEvent(workspace,agent,event('claude_code:guess-4',{previous_session_id:'claude_code:never-recorded'})).tail).toEqual([]);
  // Another agent's session is still never linked.
  continuityEvent(workspace,other,event('claude_code:guess-foreign',{event:'progress',messages:[{id:'f-1',role:'user',content:'foreign'}]}));
  expect(continuityEvent(workspace,agent,event('claude_code:guess-5',{previous_session_id:'claude_code:guess-foreign'})).tail).toEqual([]);
  const meta=(id:string)=>JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(id) as {metadata:string}).metadata);
  expect(meta('claude_code:guess-1').continuity_successor).toBe('claude_code:guess-2');
  for(const id of ['claude_code:guess-3','claude_code:guess-4','claude_code:guess-5'])expect(meta(id).continuity_previous).toBeUndefined();
});
test('a resumed conversation written to a new transcript does not store its earlier history twice',()=>{
  const turn=(id:string,content:string)=>({id,role:'user' as const,content});
  const count=(session:string)=>(db.query('SELECT COUNT(*) AS n FROM session_messages WHERE session_id=?').get(session) as {n:number}).n;
  continuityEvent(workspace,agent,{session_id:'claude_code:resume-1',project:'/resume',runtime:'claude_code',event:'progress',messages:[turn('r-a:0:0','первый'),turn('r-b:0:0','второй')]});
  // Resumed once: the new file starts with the copied history under the same record ids.
  continuityEvent(workspace,agent,{session_id:'claude_code:resume-2',project:'/resume',runtime:'claude_code',event:'start',previous_session_id:'claude_code:resume-1',
    messages:[turn('r-a:0:0','первый'),turn('r-b:0:0','второй'),turn('r-c:0:0','третий')]});
  // Resumed again: history from both earlier files is copied.
  continuityEvent(workspace,agent,{session_id:'claude_code:resume-3',project:'/resume',runtime:'claude_code',event:'start',previous_session_id:'claude_code:resume-2',
    messages:[turn('r-a:0:0','первый'),turn('r-b:0:0','второй'),turn('r-c:0:0','третий'),turn('r-d:0:0','четвёртый')]});
  expect([count('claude_code:resume-1'),count('claude_code:resume-2'),count('claude_code:resume-3')]).toEqual([2,1,1]);
  expect(restoreContext(workspace,agent,'claude_code:resume-3').tail.map(m=>m.content)).toEqual(['первый','второй','третий','четвёртый']);
});
test('memory keeps file paths in the journal and the summary; credential files stay hidden',async()=>{
  const session='claude_code:paths-kept',file='/Users/example/Code/qoopia/src/services/continuity.ts';
  continuityEvent(workspace,agent,{session_id:session,project:'/paths',runtime:'claude_code',event:'precompact',messages:[
    {id:'p-1',role:'assistant',content:`Edited ${file}; the key stays in /Users/example/.ssh/id_ed25519.`}]});
  const tail=restoreContext(workspace,agent,session).tail;
  expect(tail[0]!.content).toBe(`Edited ${file}; the key stays in [REDACTED:credential-path].`);
  let source='';
  await checkpointSession(workspace,agent,session,async(_w,_i,input)=>{source=JSON.stringify(input);
    return {text:`Done: changed ${file}. Key: /Users/example/.ssh/id_ed25519`,model:'test-fixture',observed_models:[]};});
  expect(source).toContain(file);
  expect(restoreContext(workspace,agent,session).context).toBe(`Done: changed ${file}. Key: [REDACTED:credential-path]`);
});
test('a 7 MB tool output reaches the summarizer as a few KB of head and tail; the journal keeps it whole [F-341]',async()=>{
  const session='claude_code:huge-tool-output';
  const line='ok  src/module.test.ts  builds and links every target cleanly\n';
  const log='$ bun test --coverage\n'+line.repeat(Math.ceil(7_000_000/line.length))+'Ran 1342 tests: 1342 pass, 0 fail. Exit code 0.';
  // Shaped like the hook delivers it: the action, then the result split into 12k-char rows.
  const rows:Array<{id:string;role:'assistant'|'tool';content:string}>=[{id:'act:0:0',role:'assistant',content:'Action requested: Bash\n{"command":"bun test --coverage"}'}];
  for(let start=0;start<log.length;start+=12_000)rows.push({id:'res:0:'+start,role:'tool',content:log.slice(start,start+12_000)});
  rows.push({id:'after:0:0',role:'assistant',content:'All tests pass; moving on to the release notes.'});
  for(let i=0;i<rows.length;i+=100)continuityEvent(workspace,agent,{session_id:session,project:'/huge',runtime:'claude_code',event:'precompact',messages:rows.slice(i,i+100)});
  const prompts:string[]=[];
  for(let i=0;i<200&&cursor(session)<lastId(session);i++) {
    db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_priority',1) WHERE id=?").run(session);
    await checkpointSession(workspace,agent,session,async(_w,instruction,input)=>{prompts.push(memoryPrompt(instruction,input));return summarize();});
  }
  expect(cursor(session)).toBe(lastId(session));
  // Before: ~150 calls of ~50k chars each. Now the 584-row output is one event, so the backlog
  // drains in two calls whose prompts a model reads and answers well within its 45-second budget.
  expect(prompts).toHaveLength(2);for(const prompt of prompts)expect(prompt.length).toBeLessThan(8000);
  expect(prompts[0]).toContain('Action requested: Bash');expect(prompts[0]).toContain('$ bun test --coverage');
  expect(prompts[0]).toContain('1342 pass, 0 fail. Exit code 0.');expect(prompts[1]).toContain('All tests pass');
  expect(prompts[0]).toMatch(/\[… \d+ characters omitted …\]/);
  const stored=db.query("SELECT content FROM session_messages WHERE session_id=? AND role='tool' ORDER BY id").all(session) as {content:string}[];
  expect(stored.map(r=>r.content).join('')).toBe(log);
  // Following the output must not leave a statement mid-step: that holds a read transaction open (the WAL
  // cannot checkpoint) and locks the table against schema changes.
  expect(()=>db.exec('CREATE INDEX f341_probe ON session_messages(id); DROP INDEX f341_probe')).not.toThrow();
});
