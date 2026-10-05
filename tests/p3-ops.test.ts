import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendManagedLog, retainManagedLogs, inspectManagedLogs } from '../src/utils/managed-logs.ts';
import { recordMaintenance, readOps, opsSummary, opsFile } from '../src/delivery/ops-state.ts';
import { deliverOpsAlerts } from '../src/services/ops-alerts.ts';
import { hash } from '../src/utils/fs.ts';
import { fakeFetch } from './helpers/fake-fetch.ts';
const fixture = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-ops-')));
const day=86400000;
const destination={id:'disposable-receiver',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:new Uint8Array(32).fill(17)};
const resolver=async()=>[{address:'93.184.216.34'}];
test('managed logs retain exact/future boundary, remove only ledger owned expired files, never audit/unowned',()=>{
 const root=fixture(),now=Date.now();try{
  appendManagedLog(root,'info',hash('secret synthetic event'),now-15*day);
  const dir=path.join(root,'application');const old=fs.readdirSync(dir).find(n=>n.endsWith('.jsonl'))!;
  fs.utimesSync(path.join(dir,old),new Date(now-15*day),new Date(now-15*day));
  appendManagedLog(root,'error',hash('second'),now-14*day);
  const boundary=fs.readdirSync(dir).find(n=>n.endsWith('.jsonl')&&n!==old)!;
  fs.utimesSync(path.join(dir,boundary),new Date(now-14*day),new Date(now-14*day));
  appendManagedLog(root,'warn',hash('future'),now+day);
  fs.writeFileSync(path.join(dir,'security-audit.jsonl'),'retained');fs.writeFileSync(path.join(dir,'app-unowned.jsonl'),'retained');
  expect(retainManagedLogs(root,now)).toMatchObject({deleted:1,retained:2,days:14});
  expect(fs.existsSync(path.join(dir,boundary))).toBe(true);
  expect(fs.readFileSync(path.join(dir,'security-audit.jsonl'),'utf8')).toBe('retained');
  expect(fs.readFileSync(path.join(dir,'app-unowned.jsonl'),'utf8')).toBe('retained');
  expect(fs.readFileSync(path.join(dir,boundary),'utf8')).not.toContain('second');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('retention refuses hardlinks, symlink file/ancestor and corrupt ownership; preserves targets',()=>{
 const root=fixture(),now=Date.now();try{
  for(const kind of ['symlink','hardlink','corrupt','ancestor']){
   const logs=path.join(root,kind);appendManagedLog(logs,'info',hash('fixture'),now-16*day);
   const dir=path.join(logs,'application'),file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.jsonl'))!);
   fs.utimesSync(file,new Date(now-16*day),new Date(now-16*day));
   const external=path.join(root,kind+'-target');fs.writeFileSync(external,'untouched');
   if(kind==='symlink'){fs.unlinkSync(file);fs.symlinkSync(external,file);}
   if(kind==='hardlink')fs.linkSync(file,path.join(root,'hardlink-copy'));
   if(kind==='corrupt')fs.writeFileSync(path.join(dir,'ownership.json'),'{}');
   if(kind==='ancestor'){fs.renameSync(dir,dir+'-original');fs.symlinkSync(dir+'-original',dir);}
   expect(()=>retainManagedLogs(logs,now)).toThrow();
   expect(fs.readFileSync(external,'utf8')).toBe('untouched');expect(fs.existsSync(file)).toBe(true);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a replaced log file (new inode) becomes unowned: forgotten, never written or deleted, maintenance recovers',()=>{
 const root=fixture(),now=Date.now();try{
  appendManagedLog(root,'info',hash('fixture'),now-16*day);
  const dir=path.join(root,'application'),file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.jsonl'))!);
  fs.renameSync(file,file+'.original');fs.writeFileSync(file,'replacement',{mode:0o600});
  const old=new Date(now-16*day);fs.utimesSync(file,old,old);fs.utimesSync(file+'.original',old,old);
  expect(inspectManagedLogs(root)).toMatchObject({status:'pass'});
  expect(retainManagedLogs(root,now)).toMatchObject({deleted:0,retained:0,status:'ok'});
  appendManagedLog(root,'info',hash('after'),now);
  expect(fs.readFileSync(file,'utf8')).toBe('replacement');expect(fs.existsSync(file+'.original')).toBe(true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Migration Assistant / Time Machine restore gives every log a new inode: logging and retention keep working',()=>{
 const root=fixture(),now=Date.now();try{
  appendManagedLog(root,'info',hash('old Mac'),now-day);appendManagedLog(root,'info',hash('old Mac today'),now);
  const dir=path.join(root,'application');
  // A restore writes a copy and moves it into place. Writing the copy while the original still
  // exists guarantees a new inode: unlink-then-create lets ext4 hand the freed inode straight back.
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl'))){
   const f=path.join(dir,name),before=fs.statSync(f).ino;
   fs.writeFileSync(f+'.restoring',fs.readFileSync(f),{mode:0o600});fs.renameSync(f+'.restoring',f);
   expect(fs.statSync(f).ino).not.toBe(before);
  }
  expect(inspectManagedLogs(root)).toMatchObject({status:'pass'});
  expect(()=>appendManagedLog(root,'info',hash('new Mac'),now)).not.toThrow();
  expect(retainManagedLogs(root,now)).toMatchObject({retained:1,status:'ok'});
  expect(fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl'))).toHaveLength(3);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a reboot that renumbers the volume keeps the same log files owned: write, inspect and retention still work',()=>{
 const root=fixture(),now=Date.now();try{
  appendManagedLog(root,'info',hash('before reboot'),now-15*day);
  const dir=path.join(root,'application'),file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.jsonl'))!);
  // APFS assigns st_dev at mount time: after a restart the recorded number differs, the inode does not.
  const ledgerFile=path.join(dir,'ownership.json'),ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
  for(const item of Object.values(ledger.files) as {dev:number}[])item.dev+=2;
  fs.writeFileSync(ledgerFile,JSON.stringify(ledger),{mode:0o600});
  expect(inspectManagedLogs(root)).toMatchObject({status:'pass',reason:'LOG_OWNERSHIP_VERIFIED'});
  expect(()=>appendManagedLog(root,'info',hash('after reboot'),now-15*day)).not.toThrow();
  fs.utimesSync(file,new Date(now-15*day),new Date(now-15*day));
  expect(retainManagedLogs(root,now)).toMatchObject({deleted:1,retained:0});expect(fs.existsSync(file)).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a log file deleted outside Qoopia (a cleaner, the owner) is forgotten: logging, inspection and retention keep working',()=>{
 const root=fixture(),now=Date.now();try{
  appendManagedLog(root,'info',hash('yesterday'),now-day);appendManagedLog(root,'info',hash('today'),now);
  const dir=path.join(root,'application');for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')))fs.unlinkSync(path.join(dir,name));
  expect(inspectManagedLogs(root)).toMatchObject({status:'pass'});
  expect(()=>appendManagedLog(root,'info',hash('after cleanup'),now)).not.toThrow();
  expect(retainManagedLogs(root,now)).toMatchObject({deleted:0,retained:1,status:'ok'});
  expect(fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl'))).toHaveLength(1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('maintenance lifecycle durable pending, active suppression, resolve clears, two distinct confirmed receipts',async()=>{
 const root=fixture();try{
  const receive=fakeFetch(async(_url,init)=>new Response(JSON.stringify({accepted:true,event_id:JSON.parse(String(init?.body)).id,payload_sha256:hash(String(init?.body))})));
  const first=recordMaintenance(root,'installation','BACKUP_FAILED',1000).alerts[0]!;
  recordMaintenance(root,'installation','BACKUP_FAILED',1001);expect(readOps(root).alerts.length).toBe(1);
  await deliverOpsAlerts(root,[],{},1002);expect(opsSummary(root).pending).toBe(1);
  await deliverOpsAlerts(root,[destination],{fetchImpl:receive,resolver},1003);
  expect(readOps(root).alerts[0]).toMatchObject({state:'confirmed',receipt:{event_id:first.id,accepted:true}});
  recordMaintenance(root,'installation',null,1004);recordMaintenance(root,'installation','BACKUP_FAILED',1005);
  await deliverOpsAlerts(root,[destination],{fetchImpl:receive,resolver},1006);
  const alerts=readOps(root).alerts;expect(alerts).toHaveLength(2);expect(alerts[1]!.id).not.toBe(first.id);
  expect(alerts[1]).toMatchObject({state:'confirmed',receipt:{event_id:alerts[1]!.id,accepted:true}});
  expect(alerts[0]!.active).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('2xx alone, forged receipt, wrong digest, redirect, timeout and both channels failing stay visibly pending after restart',async()=>{
 const root=fixture();try{
  let now=1000;recordMaintenance(root,'installation','BACKUP_FAILED',now);
  const transports=[async()=>new Response('',{status:204}),async()=>new Response('{}'),async()=>new Response(JSON.stringify({accepted:true,event_id:readOps(root).alerts[0]!.id,payload_sha256:'0'.repeat(64)})),async()=>new Response('secret canary',{status:302}),async()=>{throw new Error('secret canary timeout');}].map(transport=>fakeFetch(transport));
  for(const fetchImpl of transports){now+=86400001;await deliverOpsAlerts(root,[destination,destination],{fetchImpl,resolver},now);expect(readOps(root).alerts[0]!.state).toBe('pending');expect(opsSummary(root).pending).toBe(1);}
  expect(fs.readFileSync(opsFile(root),'utf8')).not.toContain('secret canary');
  recordMaintenance(root,'installation',null,now+1);expect(opsSummary(root).pending).toBe(1);
  fs.writeFileSync(opsFile(root),'corrupt suppression');expect(()=>recordMaintenance(root,'installation','BACKUP_FAILED',now+2)).toThrow('OPS_JOURNAL_INVALID');
  expect(fs.readFileSync(opsFile(root),'utf8')).toBe('corrupt suppression');expect(fs.readdirSync(root).some(n=>n.includes('.corrupt-'))).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('owner channel policy is explicit, private and bounded; no default receiver',async()=>{
 const {readOwnerAlertChannels}=await import('../src/services/ops-alerts.ts');
 const root=fixture();try{
  expect(readOwnerAlertChannels()).toEqual([]);const file=path.join(root,'ops-channels.json');expect(readOwnerAlertChannels(file)).toEqual([]);
  fs.writeFileSync(file,JSON.stringify({format:'qoopia-alert-channels/1',channels:[{id:'fixture',url:destination.url,allowed_hosts:destination.allowed_hosts,signing_key_base64url:Buffer.from(destination.signing_key).toString('base64url')}]}),{mode:0o600});
  expect(readOwnerAlertChannels(file)).toHaveLength(1);fs.chmodSync(file,0o644);expect(()=>readOwnerAlertChannels(file)).toThrow('UNSAFE');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('inflight receiver attempt does not lose a concurrent resolve/recurrence or deliver twice',async()=>{
 const root=fixture();try{
  recordMaintenance(root,'installation','BACKUP_FAILED',1000);
  let release!:()=>void;const ready=new Promise<void>(resolve=>release=resolve);let calls=0;
  const fetchImpl=fakeFetch(async(_url,init)=>{calls++;await ready;return new Response(JSON.stringify({accepted:true,event_id:JSON.parse(String(init?.body)).id,payload_sha256:hash(String(init?.body))}));});
  const delivery=deliverOpsAlerts(root,[destination],{fetchImpl,resolver},1001);
  await Promise.resolve();await deliverOpsAlerts(root,[destination],{fetchImpl,resolver},1002);
  recordMaintenance(root,'installation',null,1003);const recurrence=recordMaintenance(root,'installation','BACKUP_FAILED',1004).alerts[1]!.id;
  release();await delivery;expect(calls).toBe(1);
  expect(readOps(root).alerts[0]).toMatchObject({active:false,state:'confirmed'});
  expect(readOps(root).alerts[1]).toMatchObject({id:recurrence,active:true,state:'pending'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
