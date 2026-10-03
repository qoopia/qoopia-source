import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {createNote,updateNote} from '../src/services/notes.ts';
import {sessionSummarize} from '../src/services/sessions.ts';
import {setMemoryPolicy,expireSaveRequests,SAVE_REQUEST_TTL_MS} from '../src/services/memory-policy.ts';
import {decideSaveRequest,listSaveRequests} from '../src/services/memory-save-requests.ts';
import {findTool} from '../src/mcp/tools.ts';
import {adminTools} from '../src/mcp/admin-tools.ts';
import {upsertEntity} from '../src/services/entities.ts';
import {skillUpsert} from '../src/services/skills.ts';
import {createExtractionRun} from '../src/services/extraction.ts';

let workspace:string,owner:string,steward:string,agent:string,foreignOwner:string;
beforeAll(()=>{
  runMigrations();
  const ws=createWorkspace({name:'Save request check',slug:'save-request-check'});workspace=ws.id;
  owner=createAgent({name:'save-owner',workspaceSlug:ws.slug,type:'owner'}).id;
  steward=createAgent({name:'save-steward',workspaceSlug:ws.slug,type:'steward'}).id;
  agent=createAgent({name:'save-synthetic-agent',workspaceSlug:ws.slug}).id;
  const other=createWorkspace({name:'Save request foreign',slug:'save-request-foreign'});
  foreignOwner=createAgent({name:'save-foreign-owner',workspaceSlug:other.slug,type:'owner'}).id;
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'manual',actor_id:owner});
});
const notes=(text:string)=>(db.query('SELECT COUNT(*) AS n FROM notes WHERE workspace_id=? AND text=?').get(workspace,text) as {n:number}).n;
const requestId=(error:unknown)=>/request (\S+) and waits/.exec((error as Error).message)![1]!;
const refused=(run:()=>unknown)=>{try{run();}catch(error){return error as Error&{code:string};}throw new Error('the write was accepted');};
const auth=(id:string,type='standard')=>({workspace_id:workspace,agent_id:id,agent_name:id,type,source:'api-key'}) as any;

test('note_create by a manual agent writes nothing and prepares exactly one request',()=>{
  const text='Синтетический материал: пользователь попросил запомнить адрес склада.';
  const tool=findTool('note_create')!;
  const first=refused(()=>tool.handler({text,origin:'owner_confirmed',explicit:true},auth(agent)));
  expect(first.code).toBe('APPROVAL_REQUIRED');
  // A model naming its own origin proves nothing: the argument never reaches the writer.
  expect(notes(text)).toBe(0);
  const again=refused(()=>createNote({workspace_id:workspace,agent_id:agent,text}));
  expect(requestId(again)).toBe(requestId(first));
  expect(listSaveRequests(workspace,owner,agent)).toHaveLength(1);
  // Not memory yet: search tables know nothing about it.
  expect((db.query("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'склада'").get() as {n:number}).n).toBe(0);
});

test('only the owner of this workspace decides; the asking agent never confirms itself',()=>{
  const id=listSaveRequests(workspace,owner,agent)[0]!.id;
  expect(refused(()=>listSaveRequests(workspace,steward)).code).toBe('FORBIDDEN');
  expect(refused(()=>decideSaveRequest({workspace_id:workspace,actor_id:steward,id,accept:true})).code).toBe('FORBIDDEN');
  expect(refused(()=>decideSaveRequest({workspace_id:workspace,actor_id:agent,id,accept:true})).code).toBe('FORBIDDEN');
  expect(refused(()=>decideSaveRequest({workspace_id:workspace,actor_id:foreignOwner,id,accept:true})).code).toBe('FORBIDDEN');
  // An owner-type agent in manual still cannot wave its own note through.
  setMemoryPolicy({workspace_id:workspace,agent_id:owner,mode:'manual',actor_id:owner});
  const own=requestId(refused(()=>createNote({workspace_id:workspace,agent_id:owner,text:'Синтетическая нота владельца-агента.'})));
  expect(refused(()=>decideSaveRequest({workspace_id:workspace,actor_id:owner,id:own,accept:true})).code).toBe('FORBIDDEN');
  setMemoryPolicy({workspace_id:workspace,agent_id:owner,mode:'auto',actor_id:owner});
  expect(notes('Синтетическая нота владельца-агента.')).toBe(0);
});

test('confirming writes the prepared note once; a repeat and a re-request return the same note',()=>{
  const pending=listSaveRequests(workspace,owner,agent)[0]!;
  const saved=decideSaveRequest({workspace_id:workspace,actor_id:owner,id:pending.id,accept:true});
  expect(saved.state).toBe('saved');expect(notes(pending.text!)).toBe(1);
  expect(decideSaveRequest({workspace_id:workspace,actor_id:owner,id:pending.id,accept:true}).note_id).toBe(saved.note_id);
  expect(createNote({workspace_id:workspace,agent_id:agent,text:pending.text!})).toMatchObject({created:false,id:saved.note_id!});
  expect(notes(pending.text!)).toBe(1);
  // The decision is recorded without a trace of the text; the note carries the asking agent.
  const row=db.query('SELECT agent_id,decision,note_id,decided_by FROM memory_save_decisions WHERE id=?').get(pending.id) as any;
  expect(row).toEqual({agent_id:agent,decision:'saved',note_id:saved.note_id,decided_by:owner});
  expect((db.query('SELECT * FROM memory_save_decisions').all() as object[]).some(r=>JSON.stringify(r).includes('склада'))).toBe(false);
  expect((db.query('SELECT agent_id FROM notes WHERE id=?').get(saved.note_id!) as any).agent_id).toBe(agent);
});

test('a declined request, an expired one and a restart all leave nothing behind',()=>{
  const declined=requestId(refused(()=>createNote({workspace_id:workspace,agent_id:agent,text:'Синтетика: отклонить.'})));
  expect(decideSaveRequest({workspace_id:workspace,actor_id:owner,id:declined,accept:false}).state).toBe('declined');
  expect(refused(()=>decideSaveRequest({workspace_id:workspace,actor_id:owner,id:declined,accept:true})).code).toBe('CONFLICT');
  const expired=requestId(refused(()=>createNote({workspace_id:workspace,agent_id:agent,text:'Синтетика: истечёт.'})));
  expireSaveRequests(Date.now()+SAVE_REQUEST_TTL_MS+1);
  expect(refused(()=>decideSaveRequest({workspace_id:workspace,actor_id:owner,id:expired,accept:true})).code).toBe('NOT_FOUND');
  expect(listSaveRequests(workspace,owner,agent)).toHaveLength(0);
  expect(notes('Синтетика: отклонить.')+notes('Синтетика: истечёт.')).toBe(0);
  // Nothing a manual agent prepared is anywhere in the database.
  const tables=(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'").all() as {name:string}[]).map(t=>t.name);
  const leaked=tables.filter(table=>{try{return (db.query(`SELECT * FROM "${table}"`).all() as object[]).some(row=>JSON.stringify(row).includes('Синтетика: отклонить.'));}catch{return false;}});
  expect(leaked).toEqual([]);
});

test('the other write paths are not a side door: update, summary and a full queue',()=>{
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'auto',actor_id:owner});
  const existing=createNote({workspace_id:workspace,agent_id:agent,text:'Синтетика: исходный текст.'});
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'manual',actor_id:owner});
  const held=refused(()=>updateNote({workspace_id:workspace,agent_id:agent,is_admin:false,id:existing.id,text:'Синтетика: подменённый текст.'}));
  expect(held.code).toBe('APPROVAL_REQUIRED');expect(notes('Синтетика: исходный текст.')).toBe(1);
  // A steward writing under the manual agent's identity is held the same way.
  expect(refused(()=>updateNote({workspace_id:workspace,agent_id:agent,is_admin:true,id:existing.id,tags:['обход']})).code).toBe('APPROVAL_REQUIRED');
  expect(refused(()=>sessionSummarize({workspace_id:workspace,agent_id:agent,session_id:'none',content:'Синтетика',msg_start_id:1,msg_end_id:1})).code).toBe('APPROVAL_REQUIRED');
  decideSaveRequest({workspace_id:workspace,actor_id:owner,id:requestId(held),accept:true});
  expect(notes('Синтетика: подменённый текст.')).toBe(1);
  for(let i=0;i<25;i++)try{createNote({workspace_id:workspace,agent_id:agent,text:'Синтетика: очередь '+i});}catch{/* Expected: APPROVAL_REQUIRED until 20 requests are held, then RATE_LIMITED. */}
  expect(listSaveRequests(workspace,owner,agent).length).toBe(20);
  expect(refused(()=>createNote({workspace_id:workspace,agent_id:agent,text:'Синтетика: сверх лимита'})).code).toBe('RATE_LIMITED');
});

test('the owner reviews through the same tools; auto agents keep note_create exactly as before',async()=>{
  const list=adminTools.find(t=>t.name==='memory_save_list')!,decide=adminTools.find(t=>t.name==='memory_save_decide')!;
  const items=(await list.handler({agent},auth(owner,'owner')) as any).items;
  expect(items.length).toBe(20);
  expect(refused(()=>list.handler({},auth(steward,'steward'))).code).toBe('FORBIDDEN');
  expect((await decide.handler({id:items[0].id,accept:false},auth(owner,'owner')) as any).state).toBe('declined');
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'auto',actor_id:owner});
  expect(createNote({workspace_id:workspace,agent_id:agent,text:'Синтетика: обычная запись в auto.'}).created).toBe(true);
});

test('the other doors into memory are shut too: knowledge pages, skills and extraction',()=>{
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'manual',actor_id:owner});
  const entity=findTool('entity_upsert');
  if(entity)expect(refused(()=>entity.handler({type:'knowledge',slug:'canary-knowledge',title:'Синтетика'},auth(agent))).code).toBe('APPROVAL_REQUIRED');
  // The guard sits on the writer, so skill_upsert cannot reach it either.
  expect(refused(()=>upsertEntity({workspace_id:workspace,type:'knowledge',slug:'direct-knowledge',title:'Синтетика',summary:null},auth(agent))).code).toBe('APPROVAL_REQUIRED');
  // The agent protocol names skill_upsert as refused in manual [F-231].
  expect(refused(()=>skillUpsert({workspace_id:workspace,slug:'synthetic-skill',title:'Синтетика',summary:'Шаги',status:'draft',metadata:{skill_version:'1',owner_agent:'save-synthetic-agent',
    trigger_conditions:['t'],scope:'s',prerequisites:['p'],exact_steps:['a'],verification_gates:['v'],failure_modes:['f'],rollback:'r',related_code_paths:['c'],related_incidents:['i']}} as any,auth(agent))).code).toBe('APPROVAL_REQUIRED');
  expect(refused(()=>createExtractionRun({auth:auth(agent),session_id:'none',source_start_id:1,source_end_id:1,
    extractor_version:'test',prompt_hash:'0'.repeat(64),candidates:[]})).code).toBe('APPROVAL_REQUIRED');
  // An owner-started agent task records under the target agent's identity: covered in
  // tests/v1-runtime.test.ts, where the runtime registration the task needs actually exists.
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'auto',actor_id:owner});
});

test('a confirmed note_update asked again is a no-op; once the note moved on it is a new request',()=>{
  const editor=createAgent({name:'save-update-repeat',workspaceSlug:'save-request-check'}).id;
  const mode=(m:'auto'|'manual')=>setMemoryPolicy({workspace_id:workspace,agent_id:editor,mode:m,actor_id:owner});
  const note=createNote({workspace_id:workspace,agent_id:editor,text:'Синтетика: до правки.'});
  const text=()=>(db.query('SELECT text FROM notes WHERE id=?').get(note.id) as {text:string}).text;
  const edit={workspace_id:workspace,agent_id:editor,is_admin:false,id:note.id,text:'Синтетика: после правки.'};
  mode('manual');
  const first=requestId(refused(()=>updateNote(edit)));
  decideSaveRequest({workspace_id:workspace,actor_id:owner,id:first,accept:true});
  expect(updateNote(edit)).toMatchObject({updated:false,id:note.id,fields_updated:[]});
  expect(listSaveRequests(workspace,owner,editor)).toHaveLength(0);
  mode('auto');updateNote({...edit,text:'Синтетика: третья версия.'});mode('manual');
  const second=requestId(refused(()=>updateNote(edit)));
  expect(second).not.toBe(first);
  decideSaveRequest({workspace_id:workspace,actor_id:owner,id:second,accept:true});
  expect(text()).toBe('Синтетика: после правки.');
  mode('auto');
});

test('note_create idempotency is settled before the manual hold',()=>{
  const flag=process.env.QOOPIA_V4_BITEMPORAL;process.env.QOOPIA_V4_BITEMPORAL='true';
  const keyed=createAgent({name:'save-idempotent-key',workspaceSlug:'save-request-check'}).id;
  const create=(text:string,key:string)=>createNote({workspace_id:workspace,agent_id:keyed,text,idempotency_key:key});
  try{
    const first=create('Синтетика: ключ один.','save-key-1');
    setMemoryPolicy({workspace_id:workspace,agent_id:keyed,mode:'manual',actor_id:owner});
    // A retry of a committed key replays the note: nothing new waits for the owner.
    expect(create('Синтетика: ключ один.','save-key-1').id).toBe(first.id);
    expect(refused(()=>create('Синтетика: другое под ключом один.','save-key-1')).code).toBe('IDEMPOTENCY_MISMATCH');
    // A key held for the owner is taken as well: other material under it is refused, not queued.
    const held=requestId(refused(()=>create('Синтетика: ключ два.','save-key-2')));
    expect(requestId(refused(()=>create('Синтетика: ключ два.',' save-key-2 ')))).toBe(held);
    expect(refused(()=>create('Синтетика: другое под ключом два.','save-key-2')).code).toBe('IDEMPOTENCY_MISMATCH');
    expect(listSaveRequests(workspace,owner,keyed).map(r=>r.id)).toEqual([held]);
  }finally{
    if(flag===undefined)delete process.env.QOOPIA_V4_BITEMPORAL;else process.env.QOOPIA_V4_BITEMPORAL=flag;
    setMemoryPolicy({workspace_id:workspace,agent_id:keyed,mode:'auto',actor_id:owner});
  }
});
