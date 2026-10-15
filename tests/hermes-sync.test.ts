/**
 * hermes-sync delivers a Hermes agent's conversations from its state.db into Qoopia memory without the
 * model. Synthetic state.db fixtures only; the server side is the real /memory/continuity handler.
 */
import {afterAll,beforeAll,expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {continuityEvent} from '../src/services/continuity.ts';
import {agentMemoryStatus,noteAgentWork,setMemoryPolicy} from '../src/services/memory-policy.ts';
import {hermesSyncOnce,hermesSessionId,hermesSyncService,stateDirectory,HermesSourceError} from '../src/delivery/hermes-sync.ts';
import {hermesSyncHealth,memoryClientsCheck} from '../src/delivery/memory-client.ts';

const KEY='q_hermesfixturekey';
const SECRET='ghp_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-hermes-sync-')));
let workspace='',agent='',owner='',status=200,server:ReturnType<typeof Bun.serve>;
const requests:any[]=[];
beforeAll(()=>{
  runMigrations();
  const ws=createWorkspace({name:'Hermes sync',slug:'hermes-sync-check'});workspace=ws.id;
  agent=createAgent({name:'hermes-leo',workspaceSlug:ws.slug}).id;owner=createAgent({name:'hermes-owner',workspaceSlug:ws.slug,type:'owner'}).id;
  server=Bun.serve({port:0,async fetch(req){
    if(req.headers.get('authorization')!=='Bearer '+KEY)return new Response('',{status:401});
    if(status!==200)return new Response('',{status});
    const body=await req.json() as any;requests.push(body);
    try{return Response.json(continuityEvent(workspace,agent,body));}catch{return Response.json({error:'refused'},{status:400});}
  }});
});
afterAll(()=>{server.stop(true);fs.rmSync(tmp,{recursive:true,force:true});});

const connection=()=>({format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:agent,key:KEY,runtime:'hermes'});
/** The Hermes state schema 31 columns the collector reads, plus the reasoning columns it must never read. */
function hermesHome(name:string,{withUid=true}={}) {
  const home=path.join(tmp,name);fs.mkdirSync(home,{recursive:true});
  const state=new Database(path.join(home,'state.db'));state.exec('PRAGMA journal_mode=WAL');
  state.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL);INSERT INTO schema_version VALUES(31);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT NOT NULL,user_id TEXT,chat_id TEXT,parent_session_id TEXT,end_reason TEXT,started_at REAL NOT NULL DEFAULT 0);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT,timestamp REAL NOT NULL,
      reasoning TEXT,reasoning_content TEXT,_compressed_summary INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,compacted INTEGER NOT NULL DEFAULT 0,
      display_kind TEXT${withUid?',message_uid TEXT':''})`);
  let n=0;
  const session=(id:string,source='telegram',extra:{parent?:string;end?:string}={})=>state.query('INSERT INTO sessions(id,source,user_id,chat_id,parent_session_id,end_reason) VALUES(?,?,?,?,?,?)')
    .run(id,source,'136566708','136566708',extra.parent??null,extra.end??null);
  const add=(session:string,role:string,content:string|null,o:{uid?:string;active?:number;compacted?:number;summary?:number;kind?:string;reasoning?:string;at?:number}={})=>{
    n++;state.query(`INSERT INTO messages(session_id,role,content,timestamp,reasoning,reasoning_content,_compressed_summary,active,compacted,display_kind${withUid?',message_uid':''})
      VALUES(?,?,?,?,?,?,?,?,?,?${withUid?',?':''})`).run(session,role,content,o.at??Date.now()/1000-120,o.reasoning??null,o.reasoning??null,o.summary??0,o.active??1,o.compacted??0,o.kind??null,
      ...(withUid?[o.uid??'uid-'+name+'-'+n]:[]));
  };
  return {home,state,session,add};
}
const stored=(session:string)=>db.query('SELECT role,content FROM session_messages WHERE agent_id=? AND session_id=? ORDER BY id').all(agent,session) as {role:string;content:string}[];
const run=(home:string,extra:Record<string,unknown>={})=>hermesSyncOnce({root:path.join(tmp,'root'),home,connection:connection(),settleMs:0,...extra} as any);

test('a new home starts at the present; history only on request, once, without reasoning, hidden rows or secrets',async()=>{
  const h=hermesHome('leo');h.session('s1');
  h.add('s1','user','Привет, Leo. Ключ '+SECRET+' не сохраняй.');
  h.add('s1','assistant','Понял.',{reasoning:'SYNTHETIC-REASONING-MUST-NOT-LEAVE'});
  h.add('s1','tool','SYNTHETIC-TOOL-OUTPUT');
  h.add('s1','assistant','',{});                                    // tool-call-only turn
  h.add('s1','user','SYNTHETIC-INTERNAL-NOTICE',{kind:'internal_notification'});
  h.add('s1','assistant','SYNTHETIC-HIDDEN',{kind:'hidden',active:0});
  h.add('s1','assistant','SYNTHETIC-REWOUND',{active:0,compacted:0});
  h.add('s1','user','Старый вопрос до сжатия.',{active:0,compacted:1});
  h.add('s1','assistant','SYNTHETIC-COMPACTION-SUMMARY',{summary:1});
  h.add('s1','user','Поправка в середине хода.',{kind:'steer'});
  const sid=hermesSessionId('leo',{session_id:'s1',source:'telegram',chat_id:'136566708',user_id:'136566708'});
  expect(sid).toBe('leo:telegram:136566708:s1');

  expect(await run(h.home,{sessionPrefix:'leo'})).toMatchObject({state:'SYNCED',sent:0});
  expect(stored(sid)).toEqual([]);
  const all=await run(h.home,{afterId:0});
  expect(all).toMatchObject({sent:4,behind_rows:0});
  const contents=stored(sid).map(m=>m.content);
  expect(contents).toEqual(['Привет, Leo. Ключ [REDACTED:github-pat] не сохраняй.','Понял.','Старый вопрос до сжатия.','Поправка в середине хода.']);
  expect(requests.every(r=>r.runtime==='hermes')).toBe(true);
  expect(JSON.stringify(requests)).not.toMatch(/SYNTHETIC-|ghp_/);

  // Rerun and an explicit replay of the whole history store nothing twice.
  expect(await run(h.home)).toMatchObject({sent:0});
  expect(await run(h.home,{afterId:0})).toMatchObject({sent:4});
  expect(stored(sid)).toHaveLength(4);
  // Incremental: only what Hermes wrote since.
  h.add('s1','assistant','Новый ответ.');
  expect(await run(h.home)).toMatchObject({sent:1});
  expect(stored(sid).map(m=>m.content).at(-1)).toBe('Новый ответ.');
  // The prefix and the agent are bound to the home: changing them would split or misfile its conversations.
  await expect(run(h.home,{sessionPrefix:'hermes'})).rejects.toThrow('session prefix');
  // Delivered through Qoopia's own capture: the agent is not asked to autosave on top of it.
  const meta=JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(sid) as {metadata:string}).metadata);
  expect(meta.continuity_runtime).toBe('hermes');
  h.state.close();
});

test('compaction continues in a child session without copying the carried tail twice; sub-agent turns never speak as the user',async()=>{
  const h=hermesHome('compaction');h.session('p');h.session('c','telegram',{parent:'p',end:'compression'});h.session('sub','subagent',{parent:'p'});
  // Hermes ends the parent with end_reason compression; the fixture marks it on the parent row.
  h.state.query("UPDATE sessions SET end_reason='compression' WHERE id='p'").run();
  h.state.query("UPDATE sessions SET end_reason=NULL WHERE id='c'").run();
  h.add('p','user','Вопрос один.',{uid:'u1'});h.add('p','assistant','Ответ один.',{uid:'u2'});
  h.add('c','user','Вопрос один.',{uid:'u1'});h.add('c','assistant','Ответ один.',{uid:'u2'}); // carried tail copies
  h.add('c','user','Вопрос два.',{uid:'u3'});
  h.add('sub','user','Проверь лог.',{uid:'u4'});h.add('sub','assistant','Лог чистый.',{uid:'u5'});
  await run(h.home,{afterId:0});
  const id=(s:string,source='telegram')=>hermesSessionId('hermes',{session_id:s,source,chat_id:'136566708',user_id:null});
  expect(stored(id('p')).map(m=>m.content)).toEqual(['Вопрос один.','Ответ один.']);
  expect(stored(id('c')).map(m=>m.content)).toEqual(['Вопрос два.']);
  expect(stored(id('sub','subagent'))).toEqual([{role:'assistant',content:'[Sub-agent] Проверь лог.'},{role:'assistant',content:'[Sub-agent] Лог чистый.'}]);
  h.state.close();
});

test('a server outage keeps the cursor; the next run catches up and doctor shows both states',async()=>{
  const h=hermesHome('outage');h.session('o');
  const root=path.join(tmp,'root-outage');
  await hermesSyncOnce({root,home:h.home,connection:connection(),settleMs:0});
  for(let i=0;i<45;i++)h.add('o',i%2?'assistant':'user','Сообщение '+i);
  status=503;
  const error=await hermesSyncOnce({root,home:h.home,connection:connection(),settleMs:0}).catch(e=>e);
  expect(error).toBeInstanceOf(HermesSourceError);expect(error.code).toBe('SERVER_UNAVAILABLE');
  expect(hermesSyncHealth(root)).toEqual([expect.objectContaining({runtime:'hermes',agent_id:agent,status:'fail',reason:'SERVER_UNAVAILABLE',behind_rows:45})]);
  expect(memoryClientsCheck(root)).toMatchObject({status:'fail',reason:'SERVER_UNAVAILABLE'});
  status=401;
  expect((await hermesSyncOnce({root,home:h.home,connection:connection(),settleMs:0}).catch(e=>e)).code).toBe('KEY_REJECTED');
  status=200;
  // 45 messages are two batches of one session; nothing is lost or doubled.
  expect(await hermesSyncOnce({root,home:h.home,connection:connection(),settleMs:0})).toMatchObject({sent:45,behind_rows:0});
  expect(stored(hermesSessionId('hermes',{session_id:'o',source:'telegram',chat_id:'136566708',user_id:null}))).toHaveLength(45);
  expect(hermesSyncHealth(root)).toEqual([expect.objectContaining({status:'pass',reason:'DELIVERING',delivered:45})]);
  // A timer that stopped is a failure too.
  expect(hermesSyncHealth(root,Date.now()+2*3600_000)[0]).toMatchObject({status:'fail',reason:'NOT_RUNNING'});
  h.state.close();
});

test('a turn Hermes may still rewrite waits; a huge row is split across batches and resumed exactly',async()=>{
  const h=hermesHome('settle');h.session('t');
  await run(h.home);
  h.add('t','user','Только что написано.',{at:Date.now()/1000});
  expect(await run(h.home,{settleMs:60_000})).toMatchObject({sent:0,behind_rows:1});
  expect(await run(h.home)).toMatchObject({sent:1});
  // ~600 KB of text: more than one request body, so the row resumes mid-way on the next batch.
  const big=Array.from({length:50},(_,i)=>String(i).padStart(4,'0')+'я'.repeat(11_996)).join('');
  h.add('t','assistant',big);
  const before=requests.length;
  expect(await run(h.home)).toMatchObject({sent:50});
  expect(requests.length-before).toBeGreaterThan(1);
  const rows=stored(hermesSessionId('hermes',{session_id:'t',source:'telegram',chat_id:'136566708',user_id:null}));
  expect(rows.slice(1).map(m=>m.content).join('')).toBe(big);
  h.state.close();
});

test('a stopped Hermes (WAL database without -shm) is still read, and nothing is written beside it',async()=>{
  const h=hermesHome('stopped');h.session('st');await run(h.home);
  h.add('st','user','Сказано до остановки.');
  // Hermes (Python sqlite3) checkpoints and removes -wal and -shm when its last connection closes.
  h.state.exec('PRAGMA wal_checkpoint(TRUNCATE)');h.state.close();
  for(const suffix of ['-wal','-shm'])fs.rmSync(path.join(h.home,'state.db'+suffix),{force:true});
  const before=fs.readdirSync(h.home).sort(),bytes=fs.readFileSync(path.join(h.home,'state.db'));
  expect(before).toEqual(['state.db']);
  expect(await run(h.home)).toMatchObject({sent:1});
  expect(fs.readdirSync(h.home).sort()).toEqual(before);
  expect(fs.readFileSync(path.join(h.home,'state.db')).equals(bytes)).toBe(true);
});

test('an unknown state.db layout is refused before anything is read or sent',async()=>{
  const h=hermesHome('unknown',{withUid:false});h.session('u');h.add('u','user','Не должно уйти.');
  const root=path.join(tmp,'root-unknown'),before=requests.length;
  const error=await hermesSyncOnce({root,home:h.home,connection:connection(),afterId:0}).catch(e=>e);
  expect(error.code).toBe('HERMES_SCHEMA_UNKNOWN');expect(error.message).toContain('messages.message_uid');
  expect(requests.length).toBe(before);
  expect(hermesSyncHealth(root)[0]).toMatchObject({status:'fail',reason:'HERMES_SCHEMA_UNKNOWN'});
  // Never started: once the layout is known the home still begins at the present, not its whole history.
  expect(JSON.parse(fs.readFileSync(path.join(stateDirectory(root,h.home),'state.json'),'utf8')).cursor).toBe(-1);
  // The source database is untouched by the reader.
  expect((h.state.query('SELECT COUNT(*) AS n FROM messages').get() as {n:number}).n).toBe(1);
  h.state.close();
});

test('while the owner keeps the agent on manual, no text leaves the computer and nothing is sent later',async()=>{
  const h=hermesHome('manual');h.session('m');await run(h.home);
  setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'manual',actor_id:owner});
  try {
    h.add('m','user','Секретный разговор в ручном режиме.');
    expect(await run(h.home)).toMatchObject({manual:true,sent:0});
    h.add('m','user','Ещё один.');
    const before=requests.length;await run(h.home);
    // Only the empty probe went out.
    expect(requests.slice(before).every(r=>r.messages.length===0)).toBe(true);
  } finally {setMemoryPolicy({workspace_id:workspace,agent_id:agent,mode:'auto',actor_id:owner});}
  // Back on auto: the next turn is probed once more, then sent.
  h.add('m','assistant','Снова автоматически.');
  expect(await run(h.home)).toMatchObject({manual:false,sent:1});
  expect(stored(hermesSessionId('hermes',{session_id:'m',source:'telegram',chat_id:'136566708',user_id:null})).map(m=>m.content)).toEqual(['Снова автоматически.']);
  h.state.close();
});

test('hermes-sync counts as client-side capture: when it stops while the agent works, the server says so',()=>{
  const session='hermes:telegram:1:stopped',agent=createAgent({name:'hermes-stopped',workspaceSlug:'hermes-sync-check'}).id;
  continuityEvent(workspace,agent,{session_id:session,project:'/h',runtime:'hermes',event:'progress',messages:[{id:'x1',role:'user',content:'Синтетика.'}]});
  db.query("UPDATE session_messages SET created_at=? WHERE session_id=?").run(new Date(Date.now()-3*3600_000).toISOString(),session);
  db.query("UPDATE sessions SET created_at=?,last_active=? WHERE agent_id=?").run(new Date(Date.now()-4*3600_000).toISOString(),new Date(Date.now()-3*3600_000).toISOString(),agent);
  noteAgentWork(agent,'recall');
  expect(agentMemoryStatus(workspace,agent).error_code).toBe('CAPTURE_STOPPED');
});

test('timers are generated, never installed here: launchd every 2 minutes, a systemd user timer on Linux',()=>{
  const o={name:'leo',home:'/Users/example/.hermes-leo',config:'/Users/example/hermes/leo.json',root:'/Users/example/Library/Application Support/Qoopia'};
  const mac=hermesSyncService('/opt/q/qoopia',o,'darwin','/Users/example');
  expect(mac.file).toBe('/Users/example/Library/LaunchAgents/ai.qoopia.hermes-sync.leo.plist');
  expect(mac.bytes).toContain('<string>hermes-sync</string><string>run</string><string>--once</string><string>--home</string><string>/Users/example/.hermes-leo</string>');
  expect(mac.bytes).toContain('<key>StartInterval</key><integer>120</integer>');
  const linux=hermesSyncService('/opt/q/qoopia',{...o,home:'/srv/qoopia/agents/kai/hermes'},'linux','/home/example');
  expect(linux.bytes).toContain('OnUnitInactiveSec=2min');expect(linux.bytes).toContain('OnActiveSec=10s');
  expect(linux.files[0]!.file).toEndWith('systemd/user/qoopia-hermes-sync-leo.service');
  expect(linux.files[0]!.bytes).toContain('ExecStart="/opt/q/qoopia" "hermes-sync" "run" "--once" "--home" "/srv/qoopia/agents/kai/hermes"');
  expect(()=>hermesSyncService('/opt/q/qoopia',{...o,name:'Leo/../x'},'linux','/home/example')).toThrow('--name');
  expect(()=>hermesSyncService('/opt/q/qoopia',{...o,home:'relative'},'linux','/home/example')).toThrow('absolute');
});
