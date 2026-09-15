import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { Delivery, dataFile, readCurrent, operationsDirectory, lockInstallation, type Current } from '../src/delivery/operations.ts';
import { durableWrite, privateDirectory, hash, inventory, MAX_JSON_BYTES } from '../src/utils/fs.ts';
import { opsFile, readOps, writeOps, recordMaintenance, opsSummary, RECOVERY_DELIVERY_HOLD, mergeRecoveryOps } from '../src/delivery/ops-state.ts';
import { backupUnified, verifyBackup } from '../src/delivery/snapshot.ts';
import { deliverOpsAlerts } from '../src/services/ops-alerts.ts';
import { journalBundleFixture } from './helpers/p3-journal-bundle.ts';

function fixture() {
  const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-recovery-go-'))),root=path.join(outer,'Owner Ж space');
  privateDirectory(root);
  const f=ownerFixture(37),instance=(f.database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  const b=journalBundleFixture(outer);
  privateDirectory(path.join(root,'bundles'));fs.renameSync(b.bundle,path.join(root,'bundles',b.digest));
  durableWrite(path.join(root,'fixture-public.pem'),b.trust);
  const current:Current={format:'qoopia-installation/1',generation:'generation-'+randomUUID(),bundle:b.digest,bundle_digest:b.digest,instance,port:3737};
  const db=dataFile(root,current);privateDirectory(path.dirname(db));durableWrite(db,f.database.serialize());f.database.close();
  durableWrite(path.join(root,'current.json'),JSON.stringify(current));
  const ops=operationsDirectory(root,current),original=opsFile(ops),delivery=new Delivery(root,b.trust,true,()=>{throw new Error('Migration must not run');});
  recordMaintenance(ops,instance,'BACKUP_FAILED',1000);
  const saved=readOps(ops),backup=path.join(outer,'good-backup');delivery.backup(backup);
  // Newer local knowledge is deliberately unavailable after corruption, never claimed merged.
  const damaged=Buffer.from('{"private newer delivery knowledge":\u0000broken');durableWrite(original,damaged);
  const pointer=fs.readFileSync(path.join(root,'current.json')),dbBytes=fs.readFileSync(db),backupInventory=inventory(backup);
  const unchanged=()=>{expect(fs.readFileSync(original)).toEqual(damaged);expect(fs.readFileSync(db)).toEqual(dbBytes);expect(inventory(backup)).toEqual(backupInventory);};
  return {outer,root,trust:b.trust,delivery,current,instance,ops,original,saved,backup,damaged,pointer,db,dbBytes,unchanged,cleanup:()=>fs.rmSync(outer,{recursive:true,force:true})};
}
const destination={id:'fixture',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:new Uint8Array(32).fill(17)};

test('owner recovery preserves exact damage and database, restores held intent; only separate bound replay authorization permits sends',async()=>{
 const f=fixture();try {
  const p=f.delivery.previewOpsRecovery(f.backup);expect(p.warning).toContain('may be lost');expect(p.warning).toContain('not merged');expect(p.restored_pending).toBe(1);
  expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);f.unchanged();
  const recovered=f.delivery.recoverOps(f.backup,p.confirmation),selected=operationsDirectory(f.root,recovered.current);
  expect(recovered.current).toEqual({...f.current,operations_generation:recovered.current.operations_generation});
  expect(readOps(selected)).toEqual({...f.saved,delivery_hold:RECOVERY_DELIVERY_HOLD});f.unchanged();
  expect(fs.readFileSync(path.join(recovered.preserved,'damaged-operations-status.bin'))).toEqual(f.damaged);
  expect(fs.statSync(recovered.preserved).mode&0o777).toBe(0o700);expect(fs.statSync(path.join(recovered.preserved,'damaged-operations-status.bin')).mode&0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(path.join(recovered.preserved,'manifest.json'),'utf8'))).toMatchObject({history_merged:false,database_restored:false,confirmation:p.confirmation});
  let sends=0,resolves=0;
  const transport={resolver:async()=>{resolves++;return [{address:'93.184.216.34'}];},fetchImpl:(async(_url,init)=>{sends++;return new Response(JSON.stringify({accepted:true,event_id:JSON.parse(String(init?.body)).id,payload_sha256:hash(String(init?.body))}));}) as typeof fetch};
  await deliverOpsAlerts(selected,[destination],transport,2000);expect(sends).toBe(0);expect(resolves).toBe(0);expect(readOps(selected).alerts).toEqual(f.saved.alerts);
  recordMaintenance(selected,f.instance,null,2001);recordMaintenance(selected,f.instance,'BACKUP_FAILED',2002);
  await deliverOpsAlerts(selected,[destination],transport,3000);expect(sends).toBe(0);
  expect(opsSummary(selected,f.instance)).toMatchObject({status:'degraded',delivery_hold:RECOVERY_DELIVERY_HOLD,pending:2});
  const heldBackup=path.join(f.outer,'held-backup');f.delivery.backup(heldBackup);expect(verifyBackup(heldBackup).operations).toBeDefined();
  const restored=f.delivery.restore(f.backup);const restoredDir=operationsDirectory(f.root,restored.current);
  expect(readOps(restoredDir).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
  await deliverOpsAlerts(restoredDir,[destination],transport,3000);expect(sends).toBe(0);
  expect(()=>f.delivery.authorizeOpsReplay()).toThrow('REPLAY_CONFIRMATION_REQUIRED');
  expect(()=>f.delivery.authorizeOpsReplay(p.confirmation)).toThrow('REPLAY_CONFIRMATION_STALE');
  const stale=f.delivery.previewOpsReplay();recordMaintenance(restoredDir,f.instance,null,4000);
  expect(()=>f.delivery.authorizeOpsReplay(stale.confirmation)).toThrow('REPLAY_CONFIRMATION_STALE');
  const replay=f.delivery.previewOpsReplay(),authorized=f.delivery.authorizeOpsReplay(replay.confirmation);
  expect(authorized.sends_performed).toBe(0);expect(sends).toBe(0);
  const enabled=operationsDirectory(f.root,authorized.current);expect(readOps(enabled).delivery_hold).toBeUndefined();
  expect(readOps(restoredDir).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
  await deliverOpsAlerts(enabled,[destination],transport,5000);expect(sends).toBe(2);expect(resolves).toBe(2);
  expect(readOps(enabled).alerts.every(a=>a.state==='confirmed')).toBe(true);
  // Old held backups conservatively reapply the gate in either merge direction.
  expect(mergeRecoveryOps(readOps(restoredDir),readOps(enabled),f.instance).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
  expect(mergeRecoveryOps(readOps(enabled),readOps(restoredDir),f.instance).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
  expect(()=>f.delivery.recoverOps(f.backup,p.confirmation)).toThrow('OPS_JOURNAL_NOT_DAMAGED');
 } finally {f.cleanup();}
});

test('no confirmation, wrong token, changed bytes, replaced inode, pointer drift, backup path and manifest drift refuse',()=>{
 for(const change of ['missing','wrong','bytes','inode','pointer','backup-path','manifest']){
  const f=fixture();try{
   const p=f.delivery.previewOpsRecovery(f.backup);let candidate=f.backup,token:string|undefined=p.confirmation;
   if(change==='missing')token=undefined;
   if(change==='wrong')token='0'.repeat(64);
   if(change==='bytes')fs.appendFileSync(f.original,'newer');
   if(change==='inode')durableWrite(f.original,f.damaged);
   if(change==='pointer')durableWrite(path.join(f.root,'current.json'),JSON.stringify({...f.current,port:3738}));
   if(change==='backup-path'){candidate=path.join(f.outer,'copied');fs.cpSync(f.backup,candidate,{recursive:true});}
   if(change==='manifest')fs.appendFileSync(path.join(f.backup,'manifest.json'),'\n');
   const pointer=fs.readFileSync(path.join(f.root,'current.json')),original=fs.readFileSync(f.original);
   expect(()=>f.delivery.recoverOps(candidate,token)).toThrow(change==='missing'?'RECOVERY_CONFIRMATION_REQUIRED':'RECOVERY_CONFIRMATION_STALE');
   expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(pointer);expect(fs.readFileSync(f.original)).toEqual(original);expect(fs.readFileSync(f.db)).toEqual(f.dbBytes);
   expect(fs.existsSync(path.join(f.root,'operations-recovery'))).toBe(false);
  }finally{f.cleanup();}
 }
},15000); // Seven independent signed-backup fixtures can exceed 5s on shared CI disks.

test('invalid or legacy backup, foreign instance, healthy/missing/oversized/unsafe local journal and lock contention refuse',()=>{
 for(const change of ['backup','backup-journal','legacy','foreign-backup','foreign-local','healthy','missing','oversized','symlink','hardlink','busy']){
  const f=fixture();try{
   let release:(()=>void)|undefined;
   if(change==='backup')fs.appendFileSync(path.join(f.backup,'snapshot.db'),'bad');
   if(change==='backup-journal')fs.appendFileSync(opsFile(f.backup),'bad');
   if(change==='legacy'){const legacy=path.join(f.outer,'legacy');backupUnified(f.db,legacy);fs.rmSync(f.backup,{recursive:true});fs.renameSync(legacy,f.backup);}
   if(change==='foreign-backup'){const file=path.join(f.backup,'manifest.json'),m=JSON.parse(fs.readFileSync(file,'utf8'));m.instance='other';durableWrite(file,JSON.stringify(m));}
   if(change==='foreign-local')writeOps(f.ops,{...f.saved,alerts:f.saved.alerts.map(a=>({...a,installation:'other'}))});
   if(change==='healthy')writeOps(f.ops,f.saved);
   if(change==='missing')fs.unlinkSync(f.original);
   if(change==='oversized')fs.truncateSync(f.original,MAX_JSON_BYTES+1);
   if(change==='symlink'){fs.renameSync(f.original,f.original+'.original');fs.symlinkSync(f.original+'.original',f.original);}
   if(change==='hardlink')fs.linkSync(f.original,f.original+'.original');
   if(change==='busy')release=lockInstallation(f.root);
   const before=inventory(f.backup),pointer=fs.readFileSync(path.join(f.root,'current.json'));
   try {expect(()=>f.delivery.previewOpsRecovery(f.backup)).toThrow();expect(()=>f.delivery.recoverOps(f.backup,'0'.repeat(64))).toThrow();}
   finally {release?.();}
   expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(pointer);expect(fs.readFileSync(f.db)).toEqual(f.dbBytes);expect(inventory(f.backup)).toEqual(before);
   expect(fs.existsSync(path.join(f.root,'operations-recovery'))).toBe(false);
  }finally{f.cleanup();}
 }
},15000); // Eleven isolated backup/journal cases include durable filesystem writes.

test('regular backup/restore/import/maintenance never acquire the explicit recovery reset behavior',()=>{
 const f=fixture();try{
  let called=false;
  for(const call of [()=>f.delivery.backup(path.join(f.outer,'refused')),()=>f.delivery.restore(f.backup),()=>f.delivery.importCopy(()=>{called=true;}),()=>recordMaintenance(f.ops,f.instance,'BACKUP_FAILED')])expect(call).toThrow('OPS_JOURNAL_INVALID');
  expect(called).toBe(false);f.unchanged();expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);
 }finally{f.cleanup();}
});

test('preservation write/fsync/rename failures refuse before publication and retain original bytes',()=>{
 for(const boundary of ['write','sync','rename']){
  const f=fixture();try{
   const p=f.delivery.previewOpsRecovery(f.backup);
   const write=fs.writeFileSync,sync=fs.fsyncSync,rename=fs.renameSync;let preservedFd:number|undefined;
   const w=spyOn(fs,'writeFileSync').mockImplementation(((file,...args)=>{
    if(typeof file==='number'){
     // durableWrite first writes the preserved damaged bytes after the lock is acquired.
     if(Buffer.isBuffer(args[0]) && args[0].equals(f.damaged)){preservedFd=file;if(boundary==='write')throw Object.assign(new Error('fixture disk full'),{code:'ENOSPC'});}
    }
    return write(file,...args as [any,any]);
   }) as typeof fs.writeFileSync);
   const s=spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(boundary==='sync'&&fd===preservedFd)throw Object.assign(new Error('fixture fsync failed'),{code:'EIO'});return sync(fd);});
   const r=spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(boundary==='rename'&&String(to).endsWith('damaged-operations-status.bin'))throw new Error('fixture rename failed');return rename(from,to);});
   try{expect(()=>f.delivery.recoverOps(f.backup,p.confirmation)).toThrow('fixture');}finally{w.mockRestore();s.mockRestore();r.mockRestore();}
   f.unchanged();expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);
  }finally{f.cleanup();}
 }
});

test('SIGKILL after preservation, before pointer and after pointer retains complete old/new journal with zero database replacement',async()=>{
 for(const boundary of ['preserved','staged','committed']){
  const f=fixture();try{
   const p=f.delivery.previewOpsRecovery(f.backup);
   const child=Bun.spawn([process.execPath,'tests/helpers/p3-recovery-owner-go-crash.ts',f.root,f.backup,p.confirmation,boundary],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:f.outer,TMPDIR:f.outer,NODE_ENV:'test'}});
   await child.exited;expect(child.signalCode).toBe('SIGKILL');f.unchanged();
   const selected=readCurrent(f.root);expect(selected.generation).toBe(f.current.generation);
   const preserved=path.join(f.root,'operations-recovery',fs.readdirSync(path.join(f.root,'operations-recovery'))[0]!);
   expect(fs.readFileSync(path.join(preserved,'damaged-operations-status.bin'))).toEqual(f.damaged);
   expect(JSON.parse(fs.readFileSync(path.join(preserved,'manifest.json'),'utf8')).confirmation).toBe(p.confirmation);
   if(boundary==='committed')expect(readOps(operationsDirectory(f.root,selected)).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);
   else expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);
   const release=lockInstallation(f.root);release();
  }finally{f.cleanup();}
 }
},15000);

test('drift after durable preservation refuses publication; archive survives for diagnosis',()=>{
 for(const change of ['journal','backup','pointer']){
  const f=fixture();try{
   const preview=f.delivery.previewOpsRecovery(f.backup);
   const d=new Delivery(f.root,f.trust,true,()=>{},at=>{
    if(at!=='preserved')return;
    if(change==='journal')fs.appendFileSync(f.original,' changed');
    if(change==='backup')fs.appendFileSync(path.join(f.backup,'manifest.json'),'\n');
    if(change==='pointer')durableWrite(path.join(f.root,'current.json'),JSON.stringify({...f.current,port:3739}));
   });
   expect(()=>d.recoverOps(f.backup,preview.confirmation)).toThrow('RECOVERY_CONFIRMATION_STALE');
   expect(readCurrent(f.root).operations_generation).toBeUndefined();expect(fs.readFileSync(f.db)).toEqual(f.dbBytes);
   const dir=path.join(f.root,'operations-recovery',fs.readdirSync(path.join(f.root,'operations-recovery'))[0]!);
   expect(fs.readFileSync(path.join(dir,'damaged-operations-status.bin'))).toEqual(f.damaged);
  }finally{f.cleanup();}
 }
});

test('future local journals refuse recovery preview/commit/replay and ordinary callers with exact bytes and pointer preserved',()=>{
 for(const format of ['qoopia-ops/4','qoopia-ops/999','unknown']){
  const f=fixture();try{
   const preview=f.delivery.previewOpsRecovery(f.backup);
   const bytes=JSON.stringify({format,alerts:'future body',delivery_hold:'future hold'},null,2)+'\n';durableWrite(f.original,bytes);
   let imported=false;
   for(const call of [()=>f.delivery.previewOpsRecovery(f.backup),()=>f.delivery.recoverOps(f.backup,preview.confirmation),()=>f.delivery.previewOpsReplay(),()=>f.delivery.authorizeOpsReplay(preview.confirmation),()=>f.delivery.backup(path.join(f.outer,'refused')),()=>f.delivery.restore(f.backup),()=>f.delivery.importCopy(()=>{imported=true;})])expect(call).toThrow('OPS_JOURNAL_UNSUPPORTED_VERSION');
   expect(imported).toBe(false);expect(fs.readFileSync(f.original,'utf8')).toBe(bytes);expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);expect(fs.readFileSync(f.db)).toEqual(f.dbBytes);
   expect(fs.existsSync(path.join(f.root,'operations-recovery'))).toBe(false);
   expect(f.delivery.doctor().checks.maintenance!.reason).toBe('OPS_JOURNAL_UNSUPPORTED_VERSION');
   expect(f.delivery.doctor().checks.maintenance!.action).toContain('recover-ops is forbidden');
  }finally{f.cleanup();}
 }
});

test('future backup journal with a valid checksum is not recoverable corruption and preserves all original inputs',()=>{
 const f=fixture();try{
  const p=f.delivery.previewOpsRecovery(f.backup),bytes=JSON.stringify({...f.saved,format:'qoopia-ops/4'});
  durableWrite(opsFile(f.backup),bytes);const file=path.join(f.backup,'manifest.json'),m=JSON.parse(fs.readFileSync(file,'utf8'));
  m.operations={size:Buffer.byteLength(bytes),sha256:hash(bytes)};durableWrite(file,JSON.stringify(m));const before=inventory(f.backup);
  expect(()=>f.delivery.previewOpsRecovery(f.backup)).toThrow('OPS_JOURNAL_UNSUPPORTED_VERSION');expect(()=>f.delivery.recoverOps(f.backup,p.confirmation)).toThrow('OPS_JOURNAL_UNSUPPORTED_VERSION');
  expect(fs.readFileSync(f.original)).toEqual(f.damaged);expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);expect(fs.readFileSync(f.db)).toEqual(f.dbBytes);expect(inventory(f.backup)).toEqual(before);expect(fs.existsSync(path.join(f.root,'operations-recovery'))).toBe(false);
 }finally{f.cleanup();}
});

test('supported legacy backup recovery retains hold and live database instance mismatch refuses binding',()=>{
 for(const legacyHold of [false,true]){
  const f=fixture();try{
   const bytes=JSON.stringify({...f.saved,format:'qoopia-ops/1',...(legacyHold?{delivery_hold:RECOVERY_DELIVERY_HOLD}:{})});durableWrite(opsFile(f.backup),bytes);
   const file=path.join(f.backup,'manifest.json'),m=JSON.parse(fs.readFileSync(file,'utf8'));m.operations={size:Buffer.byteLength(bytes),sha256:hash(bytes)};durableWrite(file,JSON.stringify(m));
   const p=f.delivery.previewOpsRecovery(f.backup),result=f.delivery.recoverOps(f.backup,p.confirmation);expect(readOps(operationsDirectory(f.root,result.current))).toMatchObject({format:'qoopia-ops/3',delivery_hold:RECOVERY_DELIVERY_HOLD,alerts:f.saved.alerts});
   expect(fs.readFileSync(opsFile(f.backup),'utf8')).toBe(bytes);expect(fs.readFileSync(f.original)).toEqual(f.damaged);
  }finally{f.cleanup();}
 }
 const f=fixture();try{
  durableWrite(path.join(f.root,'current.json'),JSON.stringify({...f.current,instance:'wrong-pointer-instance'}));const pointer=fs.readFileSync(path.join(f.root,'current.json'));
  expect(()=>f.delivery.previewOpsRecovery(f.backup)).toThrow('OPS_JOURNAL_INSTANCE_MISMATCH');expect(()=>f.delivery.recoverOps(f.backup,'0'.repeat(64))).toThrow('OPS_JOURNAL_INSTANCE_MISMATCH');
  f.unchanged();expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(pointer);expect(fs.existsSync(path.join(f.root,'operations-recovery'))).toBe(false);
 }finally{f.cleanup();}
});
