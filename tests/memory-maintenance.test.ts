import {afterAll,beforeAll,expect,spyOn,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RUNTIMES} from '../src/delivery/runtime-versions.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {continuityEvent,memoryMaintenanceTick,processMemoryMaintenance} from '../src/services/continuity.ts';
import {logger} from '../src/utils/logger.ts';
import {enableMemoryRoot,memoryModelBusy,memoryModelStatus,memoryProfilePath,memoryRoot,memoryText,selectMemoryProfile} from '../src/services/memory-model.ts';
import {createNote} from '../src/services/notes.ts';
import {embeddingHealth} from '../src/services/embedding-store.ts';
import {recall} from '../src/services/recall.ts';

// A fake codex on PATH stands in for the subscription runtime: no vendor CLI or subscription is used.
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-maintenance-'))),bin=path.join(root,'bin');
const before=memoryRoot(),path0=process.env.PATH;
const mode=(name:string)=>fs.writeFileSync(path.join(bin,'mode'),name);
const runs=()=>fs.existsSync(path.join(bin,'runs'))?fs.readFileSync(path.join(bin,'runs'),'utf8').length:0;
beforeAll(()=>{
  fs.chmodSync(root,0o700);fs.mkdirSync(bin,{mode:0o700});
  fs.writeFileSync(path.join(bin,'codex'),`#!/bin/sh
dir=$(dirname "$0")
[ "$1" = --version ] && { echo 'codex-cli ${RUNTIMES.codex.version}'; exit 0; }
case " $* " in *' login status '*) echo 'Logged in using ChatGPT'; exit 0;; esac
printf . >> "$dir/runs"; cat >/dev/null
[ -e "$dir/running" ] && printf x >> "$dir/overlaps"; : > "$dir/running"; trap 'rm -f "$dir/running"' EXIT
case $(cat "$dir/mode") in quota) echo 'usage limit reached' >&2; exit 1;; sleep) sleep 1;;
  crash) cat "$dir/crash"; exit 1;; esac
cat "$dir/response"
`,{mode:0o700});
  // The model reasons about the user's login bug, then the stream drops: nothing here is a sign-in failure.
  fs.writeFileSync(path.join(bin,'crash'),[{type:'item.completed',item:{type:'reasoning',text:'Users could not log in after the 401 OAuth fix; rate limit discussed'}},
    {type:'item.completed',item:{type:'agent_message',text:'Unauthorized author notes'}},{type:'turn.failed',error:{message:'stream disconnected before completion'}}]
    .map(e=>JSON.stringify(e)).join('\n')+'\n');
  fs.writeFileSync(path.join(bin,'response'),[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({result:'Working state.'})}},
    {type:'turn.completed'}].map(e=>JSON.stringify(e)).join('\n')+'\n');
  mode('ok');runMigrations();enableMemoryRoot(root);process.env.PATH=bin+path.delimiter+path0;
});
afterAll(()=>{process.env.PATH=path0;enableMemoryRoot(before);fs.rmSync(root,{recursive:true,force:true});});

const pending=(ws:string,agent:string,session:string,event='precompact')=>continuityEvent(ws,agent,{session_id:session,project:'/maintenance',
  runtime:'codex',event,messages:[{id:session+'-1',role:'user',content:'Turn of '+session}]});
const meta=(session:string)=>JSON.parse((db.query('SELECT metadata FROM sessions WHERE id=?').get(session) as {metadata:string}).metadata);
const notes=(ws:string)=>(db.query("SELECT COUNT(*) AS n FROM notes WHERE workspace_id=? AND source='qoopia-continuity'").get(ws) as {n:number}).n;

test('an unreadable profile marks only its own workspace; every other workspace still checkpoints',async()=>{
  const a=createWorkspace({name:'Broken profile',slug:'maintenance-broken'}),b=createWorkspace({name:'Healthy profile',slug:'maintenance-healthy'});
  const agentA=createAgent({name:'broken-agent',workspaceSlug:a.slug}).id,agentB=createAgent({name:'healthy-agent',workspaceSlug:b.slug}).id;
  selectMemoryProfile(a.id,'codex');selectMemoryProfile(b.id,'codex');
  // An extra key, as after a hand edit or a downgrade: the strict schema refuses it.
  const file=memoryProfilePath(a.id);fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,'utf8')),extra:1}));
  pending(a.id,agentA,'codex:broken-profile');pending(b.id,agentB,'codex:healthy-profile','progress');
  for(let tick=0;tick<5&&!notes(b.id);tick++)await processMemoryMaintenance();
  expect(notes(b.id)).toBe(1);
  expect(meta('codex:broken-profile').continuity_error).toBe('INVALID_PROFILE');
});

test('a quota failure pauses the whole workspace: pending sessions cost one model launch, not one each',async()=>{
  const ws=createWorkspace({name:'Quota',slug:'maintenance-quota'}),agent=createAgent({name:'quota-agent',workspaceSlug:ws.slug}).id;
  selectMemoryProfile(ws.id,'codex');mode('quota');
  try {
    const sessions=Array.from({length:6},(_,i)=>'codex:quota-'+i);
    for(const session of sessions)pending(ws.id,agent,session);
    const start=runs();
    for(let tick=0;tick<sessions.length;tick++)await processMemoryMaintenance();
    expect(runs()-start).toBe(1);
    expect(sessions.map(s=>meta(s).continuity_error)).toEqual(sessions.map(()=>'MODEL_QUOTA'));
  } finally {mode('ok');}
});

test('interactive recall does not queue behind a background model call; it ranks with FTS instead',async()=>{
  const ws=createWorkspace({name:'Busy slot',slug:'maintenance-busy'}),agent=createAgent({name:'busy-agent',workspaceSlug:ws.slug}).id;
  selectMemoryProfile(ws.id,'codex');
  for(const text of ['busyslotmark первый документ','busyslotmark второй документ'])createNote({workspace_id:ws.id,agent_id:agent,text});
  mode('sleep');
  try {
    const background=memoryText(ws.id,'Background checkpoint.',{}).catch(()=>null);
    const started=Date.now();
    const result=await recall({workspace_id:ws.id,caller_agent_id:agent,is_admin:false,query:'busyslotmark',mode:'fts5'});
    expect(Date.now()-started).toBeLessThan(1000);
    expect(result.results).toHaveLength(2);
    expect(result.judging).toMatchObject({applied:false,error:'MODEL_BUSY'});
    await background;
  } finally {mode('ok');}
});

test('a caller that stops waiting keeps its place in line: two model processes never overlap',async()=>{
  const ws=createWorkspace({name:'Impatient',slug:'maintenance-impatient'});selectMemoryProfile(ws.id,'codex');
  mode('sleep');
  try {
    const first=memoryText(ws.id,'Background.',{}),impatient=memoryText(ws.id,'Interactive.',{},{wait_ms:100}),next=memoryText(ws.id,'Next.',{});
    await expect(impatient).rejects.toMatchObject({code:'MODEL_BUSY'});
    // A busy slot says nothing about the subscription itself.
    expect(memoryModelStatus(ws.id).state).toBe('selected');
    await Promise.all([first,next]);
  } finally {mode('ok');}
  expect(fs.existsSync(path.join(bin,'overlaps'))).toBe(false);
  expect(memoryModelBusy()).toBe(false);
  // The abandoned place was released exactly once: one process runs, eight wait, the ninth is refused.
  const settled=await Promise.allSettled(Array.from({length:9},()=>memoryText(ws.id,'Queue.',{})));
  expect(settled.filter(s=>s.status==='fulfilled')).toHaveLength(8);
  expect(settled[8]).toMatchObject({status:'rejected',reason:{code:'MODEL_BUSY'}});
},30_000);

test('a crash is classified from CLI error events only, never from what the model wrote',async()=>{
  const ws=createWorkspace({name:'Crash',slug:'maintenance-crash'});selectMemoryProfile(ws.id,'codex');
  mode('crash');
  try {await expect(memoryText(ws.id,'Summarise.',{})).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});}
  finally {mode('ok');}
  expect(memoryModelStatus(ws.id).state).toBe('unavailable');
});

test('a failing embedding model backs off between maintenance ticks, and /health reports it passively',async()=>{
  let calls=0;
  const server=Bun.serve({port:0,fetch:()=>{calls++;return new Response('model missing',{status:500});}});
  const ws=createWorkspace({name:'Embedding outage',slug:'maintenance-embedding'}),agent=createAgent({name:'embedding-agent',workspaceSlug:ws.slug}).id;
  createNote({workspace_id:ws.id,agent_id:agent,text:'A note that waits for its embedding.'});
  const saved={endpoint:process.env.QOOPIA_EMBED_ENDPOINT,auto:process.env.QOOPIA_AUTO_EMBED};
  process.env.QOOPIA_EMBED_ENDPOINT=`http://127.0.0.1:${server.port}/api/embed`;process.env.QOOPIA_AUTO_EMBED='true';
  try {
    for(let tick=0;tick<3;tick++){await processMemoryMaintenance();await Bun.sleep(100);}
    // One failed attempt, then a pause: not a failing inference and a WARN on every 5-second tick.
    expect(calls).toBe(1);
    expect(embeddingHealth()).toBe('unavailable');
  } finally {
    server.stop(true);
    for(const [key,value] of [['QOOPIA_EMBED_ENDPOINT',saved.endpoint],['QOOPIA_AUTO_EMBED',saved.auto]] as const)
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  expect(embeddingHealth()).toBe('disabled');
});

test('a failing maintenance tick leaves one warn line, not silence and not one per tick',async()=>{
  const warn=spyOn(logger,'warn');
  db.exec('ALTER TABLE qoopia_telegram_outbox RENAME TO qoopia_telegram_outbox_hidden');
  try {
    await memoryMaintenanceTick();await memoryMaintenanceTick();
    const lines=warn.mock.calls.filter(([message])=>message==='Memory maintenance failed');
    expect(lines.length).toBe(1);
    expect(JSON.stringify(lines[0]![1])).toContain('qoopia_telegram_outbox');
  } finally {
    db.exec('ALTER TABLE qoopia_telegram_outbox_hidden RENAME TO qoopia_telegram_outbox');
    warn.mockRestore();
  }
});
