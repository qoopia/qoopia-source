import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRecoveryOps, recordMaintenance, opsSummary, opsFile, writeOps, opsPayload, mergeRecoveryOps, type OpsState, type OpsAlert } from '../src/delivery/ops-state.ts';
import { backupOperations } from '../src/delivery/snapshot.ts';
import { hash } from '../src/delivery/files.ts';
const budget=16*1024*1024;
const fixture=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-round1-')));
const alert=(confirmed=false):OpsAlert=>{
 const a:OpsAlert={id:randomUUID(),installation:'fixture',component:'maintenance',subject:'daily',cause:'BACKUP_FAILED',active:false,state:confirmed?'confirmed':'pending',attempts:confirmed?1:0,next_attempt_at:1000,last_error:confirmed?null:'NO_CHANNEL',receipt:null};
 if(confirmed)a.receipt={event_id:a.id,accepted:true,payload_sha256:hash(JSON.stringify({id:a.id,event_type:'operational_alert',payload:opsPayload(a)}))};
 return a;
};
const state=(alerts:OpsAlert[]):OpsState=>({format:'qoopia-ops/1',last_run:null,alerts});
test('round1 journal IO, malformed and instance failures are distinct safe codes; maintenance preserves corruption',()=>{
 const root=fixture();try{
  fs.writeFileSync(opsFile(root),'secret malformed content');
  expect(()=>readRecoveryOps(root,'fixture')).toThrow('OPS_JOURNAL_INVALID');
  expect(()=>recordMaintenance(root,'fixture','BACKUP_FAILED')).toThrow('OPS_JOURNAL_INVALID');
  expect(fs.readdirSync(root)).toEqual(['operations-status.json']);expect(fs.readFileSync(opsFile(root),'utf8')).toBe('secret malformed content');
  fs.writeFileSync(opsFile(root),JSON.stringify(state([alert()])));
  expect(()=>readRecoveryOps(root,'foreign')).toThrow('OPS_JOURNAL_INSTANCE_MISMATCH');
  const original=fs.openSync;
  for(const code of ['EACCES','EIO']){
   const spy=spyOn(fs,'openSync').mockImplementation(((file:unknown,...args:unknown[])=>{
    if(file===opsFile(root))throw Object.assign(new Error('private path secret'),{code});
    return (original as Function)(file,...args);
   }) as typeof fs.openSync);
   try{expect(()=>readRecoveryOps(root,'fixture')).toThrow('OPS_JOURNAL_IO');expect(opsSummary(root)).toMatchObject({error:'OPS_JOURNAL_IO'});}finally{spy.mockRestore();}
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('round1 journal and malicious backup descriptor refuse over budget before any content read',()=>{
 const root=fixture();try{
  const file=opsFile(root);fs.writeFileSync(file,'');fs.truncateSync(file,budget+1);
  const readFile=spyOn(fs,'readFileSync'),read=spyOn(fs,'readSync');
  try{
   expect(()=>readRecoveryOps(root,'fixture')).toThrow('OPS_JOURNAL_TOO_LARGE');
   for(const size of [budget+1,1])expect(()=>backupOperations(root,{format:'qoopia-backup/2',instance:'fixture',operations:{size,sha256:'0'.repeat(64)}} as Parameters<typeof backupOperations>[1])).toThrow('OPS_JOURNAL_TOO_LARGE');
   expect(readFile).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
  }finally{readFile.mockRestore();read.mockRestore();}
  expect(fs.statSync(file).size).toBe(budget+1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('round1 summary is bounded with exact totals while older snapshot merge retains every acceptance and pending ID',()=>{
 const root=fixture();try{
  const saved=state(Array.from({length:60},()=>alert())),local=state(saved.alerts.map(a=>({...a})));
  for(const a of local.alerts){a.state='confirmed';a.attempts=1;a.last_error=null;a.receipt={event_id:a.id,accepted:true,payload_sha256:hash(JSON.stringify({id:a.id,event_type:'operational_alert',payload:opsPayload(a)}))};}
  local.alerts.push(...Array.from({length:25},()=>alert()));local.alerts.at(-1)!.active=true;
  writeOps(root,local);const before=fs.readFileSync(opsFile(root)),summary=opsSummary(root);
  expect(summary.alerts.length).toBeLessThanOrEqual(20);expect(summary).toMatchObject({pending:25,total_alerts:85,active:1,omitted_alerts:65});
  expect(summary.alerts.some(a=>a.active)).toBe(true);
  expect(fs.readFileSync(opsFile(root))).toEqual(before);
  const merged=mergeRecoveryOps(saved,readRecoveryOps(root,'fixture'),'fixture');
  expect(merged.alerts).toHaveLength(85);expect(merged.alerts.filter(a=>a.state==='confirmed')).toHaveLength(60);
  expect(merged.alerts.filter(a=>a.state==='pending').map(a=>a.id)).toEqual(local.alerts.slice(60).map(a=>a.id));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('round1 over-budget write refuses without replacing existing history',()=>{
 const root=fixture();try{
  writeOps(root,state([alert(true)]));const original=fs.readFileSync(opsFile(root));
  const seed=alert(false),count=Math.ceil((budget+1)/(Buffer.byteLength(JSON.stringify(seed))+1));
  const large=state(Array.from({length:count},()=>alert(false)));
  expect(()=>writeOps(root,large)).toThrow('OPS_JOURNAL_TOO_LARGE');expect(fs.readFileSync(opsFile(root))).toEqual(original);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('round1 exact budget accepts, growth after fstat stays bounded, short reads work, mid-read IO refuses',()=>{
 const root=fixture();try{
  const file=opsFile(root),json=JSON.stringify(state([]));
  fs.writeFileSync(file,json+' '.repeat(budget-Buffer.byteLength(json)));
  expect(readRecoveryOps(root,'fixture').alerts).toEqual([]);
  const original=fs.readSync;
  let requested=0,grown=false;
  const growth=spyOn(fs,'readSync').mockImplementation(((fd,buffer,offset,length,position)=>{
   requested+=length;
   if(!grown){grown=true;fs.appendFileSync(file,'x');}
   return (original as Function)(fd,buffer,offset,length,position);
  }) as typeof fs.readSync);
  try{expect(()=>readRecoveryOps(root,'fixture')).toThrow('OPS_JOURNAL_TOO_LARGE');expect(requested).toBeLessThanOrEqual(budget+1);}finally{growth.mockRestore();}
  fs.writeFileSync(file,json);
  const short=spyOn(fs,'readSync').mockImplementation(((fd,buffer,offset,length,position)=>(original as Function)(fd,buffer,offset,Math.min(length,7),position)) as typeof fs.readSync);
  try{expect(readRecoveryOps(root,'fixture').alerts).toEqual([]);}finally{short.mockRestore();}
  const io=spyOn(fs,'readSync').mockImplementation(()=>{throw Object.assign(new Error('secret mid-read IO'),{code:'EIO'});});
  try{expect(()=>readRecoveryOps(root,'fixture')).toThrow('OPS_JOURNAL_IO');}finally{io.mockRestore();}
  expect(fs.readFileSync(file,'utf8')).toBe(json);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('round1 backup validates the very bytes hashed, and rejects a lying size before reading',()=>{
 const root=fixture();try{
  const bytes=JSON.stringify(state([alert(true)]));fs.writeFileSync(opsFile(root),bytes);
  const manifest={format:'qoopia-backup/2',instance:'fixture',operations:{size:Buffer.byteLength(bytes),sha256:hash(bytes)}} as Parameters<typeof backupOperations>[1];
  const readFile=spyOn(fs,'readFileSync');
  try{expect(backupOperations(root,manifest)?.alerts[0]!.state).toBe('confirmed');expect(readFile).not.toHaveBeenCalled();}finally{readFile.mockRestore();}
  const read=spyOn(fs,'readSync');
  try{expect(()=>backupOperations(root,{...manifest,operations:{...manifest.operations!,size:1}})).toThrow('OPS_JOURNAL_INVALID');expect(read).not.toHaveBeenCalled();}finally{read.mockRestore();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('round1 actual authenticated dashboard overview bounds journal output without sockets',async()=>{
 const {handleDashboardApi}=await import('../src/dashboard-api.ts');
 const {runMigrations}=await import('../src/db/migrate.ts');
 const {createWorkspace}=await import('../src/admin/workspaces.ts');
 const {createAgent}=await import('../src/admin/agents.ts');
 const {env}=await import('../src/utils/env.ts');
 const root=fixture(),original=env.OPS_STATE_DIR;try{
  runMigrations();const ws=createWorkspace({name:'Round1 dashboard'}),owner=createAgent({name:'Round1 owner fixture',type:'steward',workspaceSlug:ws.slug});
  env.OPS_STATE_DIR=root;writeOps(root,state(Array.from({length:80},()=>alert())));const bytes=fs.readFileSync(opsFile(root));
  let status=0,body='';
  const req={url:'/api/dashboard/overview',method:'GET',headers:{authorization:'Bearer '+owner.api_key}} as import('node:http').IncomingMessage;
  const res={writeHead(code:number){status=code;},end(value:string){body=value;}} as import('node:http').ServerResponse;
  expect(handleDashboardApi(req,res)).toBe(true);expect(status).toBe(200);
  const summary=JSON.parse(body).health.operations;expect(summary).toMatchObject({pending:80,total_alerts:80,omitted_alerts:60});expect(summary.alerts).toHaveLength(20);
  expect(fs.readFileSync(opsFile(root))).toEqual(bytes);
 }finally{env.OPS_STATE_DIR=original;fs.rmSync(root,{recursive:true,force:true});}
});
