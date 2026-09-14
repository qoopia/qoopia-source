import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactOps, mergeRecoveryOps, readRecoveryOps, readOps, writeOps, serializeOps, opsSerializedSize, opsFile, opsSummary, recordMaintenance, RECOVERY_DELIVERY_HOLD, validateRecoveryOps } from '../src/delivery/ops-state.ts';
import { deliverOpsAlerts } from '../src/services/ops-alerts.ts';
import { durableWrite, hash, MAX_JSON_BYTES, preflightSpace, privateDirectory, inventory } from '../src/delivery/files.ts';
import { retentionAlert, retentionState, exactPendingBoundary } from './helpers/p3-retention-fixtures.ts';
import { journalBundleFixture } from './helpers/p3-journal-bundle.ts';
import { Delivery, dataFile, operationsDirectory, readCurrent, lockInstallation } from '../src/delivery/operations.ts';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { backupUnified, verifyBackup } from '../src/delivery/snapshot.ts';
const fixture=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-scopeb-')));
const destination={id:'fixture',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:new Uint8Array(32).fill(17)};
function installation(){
 const outer=fixture(),b=journalBundleFixture(outer),root=path.join(outer,'installed');
 const migrate=(_b:string,g:string)=>{const f=ownerFixture(37);privateDirectory(path.join(g,'data'));durableWrite(path.join(g,'data','qoopia.db'),f.database.serialize());f.database.close();};
 const d=new Delivery(root,b.trust,true,migrate),c=d.install(b.bundle,3737);
 return {outer,b,root,d,c,ops:operationsDirectory(root,c),cleanup:()=>fs.rmSync(outer,{recursive:true,force:true})};
}
test('compact receipt dominates old pending in both merge orders, refuses digest/instance conflicts, never reactivates',async()=>{
 const root=fixture();try{
  const full=retentionAlert(1,true),pending={...retentionAlert(1),active:true};
  const saved=retentionState([pending]),local=compactOps(retentionState([full]));
  for(const [a,b] of [[saved,local],[local,saved]] as const){
   const merged=mergeRecoveryOps(a,b,'scopeb-fixture');expect(merged.alerts).toEqual([]);expect(merged.receipts).toEqual(local.receipts);
   writeOps(root,merged);let io=0;await deliverOpsAlerts(root,[destination],{resolver:async()=>{io++;return [];},fetchImpl:async()=>{io++;throw new Error('no send');}});expect(io).toBe(0);
   expect(opsSummary(root)).toMatchObject({pending:0,active:0,compact_receipts:1,total_alerts:1,omitted_alerts:1});
  }
  expect(()=>mergeRecoveryOps(retentionState([{...pending,cause:'DATABASE_FAILED'}]),local,'scopeb-fixture')).toThrow('event conflict');
  expect(()=>mergeRecoveryOps({...local,receipts:[{...local.receipts![0]!,payload_sha256:'0'.repeat(64)}]},local,'scopeb-fixture')).toThrow('event conflict');
  expect(()=>mergeRecoveryOps({...local,receipts:[{...local.receipts![0]!,installation:'foreign'}]},local,'scopeb-fixture')).toThrow('INSTANCE_MISMATCH');
  expect(()=>validateRecoveryOps({...local,alerts:[full]},'scopeb-fixture')).toThrow('INVALID');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy /1 and /2 inline acceptances and holds survive /3 writing; compact layout requires /3',()=>{
 const root=fixture();try{
  for(const format of ['qoopia-ops/1','qoopia-ops/2'] as const){
   const state={...retentionState([retentionAlert(1,true)]),format,delivery_hold:RECOVERY_DELIVERY_HOLD};
   const bytes=JSON.stringify(state);durableWrite(opsFile(root),bytes);
   const read=readRecoveryOps(root,'scopeb-fixture');expect(read.alerts).toEqual(state.alerts);expect(read.delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);expect(fs.readFileSync(opsFile(root),'utf8')).toBe(bytes);
   writeOps(root,read);expect(readOps(root).format).toBe('qoopia-ops/3');
   expect(()=>validateRecoveryOps({...compactOps(read),format},'scopeb-fixture')).toThrow('INVALID');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('compaction keeps every pending and active event in full; recurrence gets a distinct ID; accepted timestamp limitation remains',()=>{
 const root=fixture();try{
  const resolved=retentionAlert(1,true),pending=retentionAlert(2),active={...retentionAlert(3,true),active:true};
  const compact=compactOps(retentionState([resolved,pending,active]));expect(compact.alerts).toEqual([pending,active]);expect(compact.receipts).toHaveLength(1);
  writeOps(root,compact);recordMaintenance(root,'scopeb-fixture',null,1000);recordMaintenance(root,'scopeb-fixture','BACKUP_FAILED',1001);
  const state=readRecoveryOps(root,'scopeb-fixture');expect(state.alerts.at(-1)!.active).toBe(true);expect(state.alerts.at(-1)!.id).not.toBe(active.id);expect(state.receipts).toEqual(compact.receipts);
  const local={...retentionState([resolved]),last_run:{at:'2026-01-01T00:00:00.000Z',ok:true,cause:null}};
  const saved={...retentionState([{...resolved,active:true}]),last_run:{at:'2026-01-02T00:00:00.000Z',ok:false,cause:'BACKUP_FAILED'}};
  expect(mergeRecoveryOps(saved,local,'scopeb-fixture').alerts[0]!.active).toBe(true);
  expect(mergeRecoveryOps({...saved,last_run:local.last_run},local,'scopeb-fixture').alerts[0]!.active).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('new-machine restore from legacy/no-hold/held receipts always holds, old backup cannot clear it, separate authorization performs no sends',async()=>{
 const f=installation();try{
  const full=retentionAlert(1,true,f.c.instance);writeOps(f.ops,compactOps(retentionState([full])));
  const backup=path.join(f.outer,'saved');f.d.backup(backup);const before=inventory(backup);
  const legacy=path.join(f.outer,'legacy');backupUnified(dataFile(f.root,f.c),legacy);
  const held=path.join(f.outer,'held');writeOps(f.ops,{...readOps(f.ops),delivery_hold:RECOVERY_DELIVERY_HOLD});f.d.backup(held);
  for(const [i,input] of [legacy,backup,held].entries()){
   const d=new Delivery(path.join(f.outer,'restored-'+i),f.b.trust,true,()=>{}),result=d.restoreNew(input,f.b.bundle,4141);
   let ops=operationsDirectory(d.root,result.current);expect(readOps(ops).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
   recordMaintenance(ops,f.c.instance,'BACKUP_FAILED',1000);let io=0;
   const transport={resolver:async()=>{io++;return [];},fetchImpl:async()=>{io++;throw new Error('no network');}};
   await deliverOpsAlerts(ops,[destination],transport,2000);expect(io).toBe(0);expect(readOps(ops).alerts[0]!.attempts).toBe(0);
   ops=operationsDirectory(d.root,d.restore(backup).current);expect(readOps(ops).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
   await deliverOpsAlerts(ops,[destination],transport,3000);expect(io).toBe(0);
   expect(readOps(ops).receipts?.[0]?.event_id).toBe(full.id);
   const preview=d.previewOpsReplay(),authorized=d.authorizeOpsReplay(preview.confirmation);expect(authorized.sends_performed).toBe(0);expect(io).toBe(0);
   expect(readOps(operationsDirectory(d.root,authorized.current)).delivery_hold).toBeUndefined();
  }
  expect(inventory(backup)).toEqual(before);expect(verifyBackup(backup).operations!.sha256).toBe(hash(fs.readFileSync(opsFile(backup))));
 }finally{f.cleanup();}
});
test('exact serialized capacity accepts; one-byte growth refuses unchanged; attempt overflow produces zero DNS/sends; bounded disjoint union refuses',async()=>{
 const root=fixture();try{
  const state=exactPendingBoundary();writeOps(root,state);const before=fs.readFileSync(opsFile(root));expect(before.length).toBe(MAX_JSON_BYTES);expect(opsSerializedSize(state)).toBe(before.length);
  const grow={...state,alerts:[...state.alerts]};grow.alerts[grow.alerts.length-1]={...grow.alerts.at(-1)!,attempts:10};
  expect(opsSerializedSize(grow)).toBe(MAX_JSON_BYTES+1);expect(()=>writeOps(root,grow)).toThrow('TOO_LARGE');expect(fs.readFileSync(opsFile(root))).toEqual(before);
  let io=0;await expect(deliverOpsAlerts(root,[destination],{resolver:async()=>{io++;return [];},fetchImpl:async()=>{io++;throw new Error('no send');}},1)).rejects.toThrow('TOO_LARGE');expect(io).toBe(0);expect(fs.readFileSync(opsFile(root))).toEqual(before);
  const other=retentionState([retentionAlert(999999)]);expect(()=>mergeRecoveryOps(state,other,'scopeb-fixture')).toThrow('TOO_LARGE');expect(other.alerts).toHaveLength(1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
},30000);
test('overfull resolved confirmations compact losslessly, active/pending survive, future formats refuse before schema',()=>{
 const state=retentionState(Array.from({length:45000},(_,i)=>retentionAlert(i+1,true)));
 state.alerts.push({...retentionAlert(50000,true),active:true},retentionAlert(50001));
 expect(opsSerializedSize(state)).toBeGreaterThan(MAX_JSON_BYTES);
 const bytes=serializeOps(state),result=validateRecoveryOps(JSON.parse(bytes),'scopeb-fixture');
 expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_JSON_BYTES);expect(result.receipts).toHaveLength(45000);expect(result.alerts).toEqual(state.alerts.slice(-2));expect(state.alerts).toHaveLength(45002);
 expect(()=>serializeOps({...state,format:'qoopia-ops/999'} as any)).toThrow('UNSUPPORTED_VERSION');
},30000);
test('staging space refusal precedes preservation/publication and keeps exact originals',()=>{
 const f=installation();try{
  writeOps(f.ops,compactOps(retentionState([retentionAlert(1,true,f.c.instance)])));const backup=path.join(f.outer,'backup');f.d.backup(backup);
  const before=inventory(f.root),saved=inventory(backup),statfs=fs.statfsSync;
  const spy=spyOn(fs,'statfsSync').mockImplementation(((...args:any[])=>({...Reflect.apply(statfs,fs,args),bavail:0})) as typeof fs.statfsSync);
  try{expect(()=>preflightSpace(f.root,[1])).toThrow('STAGING_SPACE_INSUFFICIENT');expect(()=>f.d.restore(backup)).toThrow('STAGING_SPACE_INSUFFICIENT');expect(()=>writeOps(f.ops,readOps(f.ops))).toThrow('STAGING_SPACE_INSUFFICIENT');}finally{spy.mockRestore();}
  expect(inventory(f.root)).toEqual(before);expect(inventory(backup)).toEqual(saved);
 }finally{f.cleanup();}
});
test('SIGKILL before/after publication preserves local compact receipts and saved pending, selects whole old/new generation',async()=>{
 for(const boundary of ['staged','committed']){
  const f=installation();try{
   writeOps(f.ops,retentionState([retentionAlert(1,false,f.c.instance)]));const backup=path.join(f.outer,'pending');f.d.backup(backup);
   writeOps(f.ops,compactOps(retentionState([retentionAlert(1,true,f.c.instance)])));const local=fs.readFileSync(opsFile(f.ops)),saved=inventory(backup),pointer=fs.readFileSync(path.join(f.root,'current.json'));
   const key=path.join(f.outer,'public.pem');durableWrite(key,f.b.trust);
   const child=Bun.spawn([process.execPath,'tests/helpers/p3-crash.ts',f.root,backup,key,boundary,'restore'],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:f.outer,TMPDIR:f.outer,NODE_ENV:'test'}});
   await child.exited;expect(child.signalCode).toBe('SIGKILL');const current=readCurrent(f.root);
   expect(current.generation===f.c.generation).toBe(boundary==='staged');if(boundary==='staged')expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(pointer);
   expect(readOps(operationsDirectory(f.root,current)).receipts).toHaveLength(1);expect(readOps(operationsDirectory(f.root,current)).alerts).toEqual([]);
   expect(fs.readFileSync(opsFile(f.ops))).toEqual(local);expect(inventory(backup)).toEqual(saved);const release=lockInstallation(f.root);release();
  }finally{f.cleanup();}
 }
},15000);
