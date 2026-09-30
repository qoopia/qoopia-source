import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {continuityEvent,checkpointSession,restoreContext} from '../src/services/continuity.ts';
import {updateNote} from '../src/services/notes.ts';
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
