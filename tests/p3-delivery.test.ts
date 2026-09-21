import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { Delivery, readCurrent, dataFile, lockInstallation } from '../src/delivery/operations.ts';
import { inventory, hash, durableWrite, privateDirectory, safePath } from '../src/utils/fs.ts';
import { verifyBundle, OPS_READER_MEMBER, OPS_READER_CAPABILITY } from '../src/delivery/bundle.ts';
import { backupUnified, verifyBackup, snapshotInfo } from '../src/delivery/snapshot.ts';
import { issueLocalLogin, consumeLocalLogin } from '../src/delivery/local-login.ts';
import { UserAutostart, disabledAutostart } from '../src/delivery/autostart.ts';
function fixture(withAutostart=false) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-p3-'))),install=path.join(root,'Installed Ж space');
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),trust=publicKey.export({type:'spki',format:'pem'}).toString();
 const bundle=(name:string,includePeer=true,opsV2=true)=>{
  const dir=path.join(root,name);privateDirectory(dir);
  for(const file of ['qoopia','assets/src/public/dashboard.html', 'assets/src/public/brand/dashboard.js','assets/migrations/037-skill-loop.sql','SBOM.json','THIRD-PARTY-NOTICES.txt','assets/scripts/runtime/codex-seatbelt.py', ...(includePeer ? [`assets/native/owner-peer.${process.platform === 'darwin' ? 'dylib' : 'so'}`] : [])]){privateDirectory(path.dirname(path.join(dir,file)));durableWrite(path.join(dir,file),name);}
  if(opsV2)durableWrite(path.join(dir,OPS_READER_MEMBER),JSON.stringify(OPS_READER_CAPABILITY));
  const raw=JSON.stringify({format:'qoopia-bundle/1',version:'5.0.0-p3.0',horizon:'QOOPIA-V-1',api_version:1,build_sha:'a'.repeat(40),source_digest:hash(name),target:`${process.platform}-${process.arch}`,bun_version:Bun.version,schema_min:32,schema_max:37,signing:'test-fixture',publisher_key_sha256:hash(trust),platform_signing:'NOT_RUN',members:inventory(dir)});
  durableWrite(path.join(dir,'manifest.json'),raw);durableWrite(path.join(dir,'manifest.sig'),sign(null,Buffer.from(raw),privateKey));return dir;
 };
 let fail=false;
 const migrate=(_bundle:string,gen:string)=>{if(fail)throw new Error('injected copy migration failure');privateDirectory(path.join(gen,'data'));const file=path.join(gen,'data','qoopia.db');if(!fs.existsSync(file)){const f=ownerFixture(37);durableWrite(file,f.database.serialize());f.database.close();}};
 const calls:{command:string;args:string[]}[]=[],nativeConfig=path.join(root,'Native Config','qoopia.plist');
 const autostart=(installation:string)=>withAutostart?new UserAutostart({root:install,installation,platform:'darwin',configFile:nativeConfig,execute:(command,args)=>{calls.push({command,args});}}):disabledAutostart;
 const delivery=new Delivery(install,trust,true,migrate,undefined,autostart);
 return {root,install,trust,bundle,delivery,autostart,nativeConfig,calls,fail:()=>{fail=true;},cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('P3 pinned bundle rejects tamper, foreign key, unsupported target, links and unlabelled test signing',()=>{
 const f=fixture();try{const b=f.bundle('first');expect(()=>verifyBundle(f.bundle('missing-peer',false),f.trust,true)).toThrow('Required bundle member');expect(()=>verifyBundle(b,f.trust)).toThrow('test signing');expect(()=>verifyBundle(b,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString(),true)).toThrow('trust root');expect(()=>verifyBundle(b,f.trust,true,'win32-x64')).toThrow('Unsupported');fs.appendFileSync(path.join(b,'qoopia'),'tamper');expect(()=>verifyBundle(b,f.trust,true)).toThrow('changed');const link=path.join(f.root,'alias');fs.symlinkSync(b,link);expect(()=>safePath(link)).toThrow('Links');}finally{f.cleanup();}
});
test('P3 install/backup/update rollback preserve matching data; post-cutover writes refuse rollback',()=>{
 const f=fixture();try{
  const b=f.bundle('first'),next=f.bundle('next');const installed=f.delivery.install(b,3737);const before=snapshotInfo(dataFile(f.install,installed));
  const backup=path.join(f.root,'backup');f.delivery.backup(backup);expect(verifyBackup(backup).logical_hash).toBe(before.logical_hash);
  f.delivery.update(next);expect(readCurrent(f.install).bundle).not.toBe(installed.bundle);expect(f.delivery.rollback()).toEqual(installed);
  const updated=f.delivery.update(next);const d=new Database(dataFile(f.install,updated));d.query("UPDATE workspaces SET name='new post-cutover write'").run();d.close();
  expect(()=>f.delivery.rollback()).toThrow('Post-cutover');expect(readCurrent(f.install).generation).toBe(updated.generation);
 }finally{f.cleanup();}
});
test('P3 migration failure and concurrent owner lock leave old pointer/data usable',()=>{
 const f=fixture();try{const b=f.bundle('first'),next=f.bundle('next');f.delivery.install(b,3737);const original=fs.readFileSync(path.join(f.install,'current.json'));f.fail();expect(()=>f.delivery.update(next)).toThrow('injected');expect(fs.readFileSync(path.join(f.install,'current.json'))).toEqual(original);
 const release=lockInstallation(f.install);try{expect(()=>f.delivery.update(next)).toThrow('busy');}finally{release();}
 expect(f.delivery.doctor().ok).toBe(true);
 }finally{f.cleanup();}
});
test('P3 new-machine restore keeps IDs/history and public trust; rotates access, removes native roots; wrong instance refused',()=>{
 const f=fixture();try{const b=f.bundle('first');const c=f.delivery.install(b,3737);const source=dataFile(f.install,c),d=new Database(source);const old=d.query('SELECT id,api_key_hash,session_version,policy_epoch FROM agents').all();d.close();
 const backup=path.join(f.root,'backup');f.delivery.backup(backup);
 expect(()=>verifyBackup(backup,'different-instance')).toThrow('instance mismatch');
 const target=new Delivery(path.join(f.root,'Other user Ж'),f.trust,true,()=>{});const restored=target.restoreNew(backup,b,4141);const r=new Database(dataFile(target.root,restored.current),{readonly:true});
 const after=r.query('SELECT id,api_key_hash,session_version,policy_epoch FROM agents').all() as any[];expect(after.map(a=>a.id)).toEqual((old as any[]).map(a=>a.id));expect(after[0].api_key_hash).not.toBe((old as any[])[0].api_key_hash);expect(after[0].policy_epoch).toBeGreaterThan((old as any[])[0].policy_epoch);expect(r.query('PRAGMA foreign_key_check').all()).toEqual([]);r.close();
 expect(restored.current.instance).toBe(c.instance);expect(target.doctor().checks.maintenance!.reason).toBe('RECOVERY_REPLAY_REQUIRES_OWNER');
 fs.appendFileSync(path.join(backup,'snapshot.db'),'corrupt');expect(()=>target.restore(backup)).toThrow('checksum mismatch');
 }finally{f.cleanup();}
});
test('P3 doctor is read-only and support excludes private bodies; uninstall preserves data, backup and user skills',()=>{
 const f=fixture();try{const b=f.bundle('first'),c=f.delivery.install(b,3737);durableWrite(path.join(f.install,'user-skill.md'),'manual bytes');const before=inventory(f.install);const report=f.delivery.doctor();const preview=f.delivery.supportPreview();expect(preview.preview).toBe(true);expect(preview.automatic_send).toBe(false);expect(JSON.stringify(preview)).not.toContain(f.install);expect(report.ok).toBe(true);expect(inventory(f.install)).toEqual(before);expect(JSON.stringify(report)).not.toContain(f.install);
 f.delivery.update(f.bundle('next'));const installedBundles=fs.readdirSync(path.join(f.install,'bundles'));expect(installedBundles.length).toBe(2);
 const db=dataFile(f.install,c),bytes=fs.readFileSync(db);expect(f.delivery.uninstall().bundles_removed).toBe(2);expect(fs.readdirSync(path.join(f.install,'bundles'))).toEqual([]);expect(fs.readFileSync(db)).toEqual(bytes);expect(fs.readFileSync(path.join(f.install,'user-skill.md'),'utf8')).toBe('manual bytes');
 }finally{f.cleanup();}
});
test('T26 Delivery uninstall removes only ledger-owned autostart config through the injected executor',()=>{
 const f=fixture(true);try{
  const current=f.delivery.install(f.bundle('autostart-owned'),3737),manual=path.join(path.dirname(f.nativeConfig),'manual.plist');
  fs.mkdirSync(path.dirname(f.nativeConfig),{recursive:true,mode:0o700});fs.writeFileSync(manual,'manual bytes');
  const executable=path.join(f.install,'bundles',current.bundle,'qoopia');
  expect((f.autostart(current.instance) as UserAutostart).install(executable).autostart).toBe('enabled');
  const result=f.delivery.uninstall();expect(result).toMatchObject({autostart:'removed',native_files_touched:1,data_preserved:true});
  expect(f.calls.map(c=>c.args[0])).toEqual(['load','unload']);expect(fs.existsSync(f.nativeConfig)).toBe(false);expect(fs.readFileSync(manual,'utf8')).toBe('manual bytes');
 }finally{f.cleanup();}
});
test('P3 missing inline original is not a green backup and last valid backup remains',()=>{
 const f=fixture();try{const c=f.delivery.install(f.bundle('first'),3737);const db=dataFile(f.install,c);const d=new Database(db);const ids=d.query('SELECT id,workspace_id FROM agents LIMIT 1').get() as {id:string;workspace_id:string};
 d.query("INSERT INTO files(id,workspace_id,owner_agent_id,folder,filename,mime,size,sha256,content,uploaded_by_agent_id,created_at) VALUES ('file',?,?,'','fixture.txt','text/plain',3,?,?,?,'2026-01-01')").run(ids.workspace_id,ids.id,hash('abc'),Buffer.from('abc'),ids.id);d.close();
 const backup=path.join(f.root,'good');backupUnified(db,backup);const original=fs.readFileSync(path.join(backup,'snapshot.db'));
 const broken=new Database(db);broken.query("UPDATE files SET content=? WHERE id='file'").run(Buffer.from('bad'));broken.close();expect(()=>backupUnified(db,path.join(f.root,'bad'))).toThrow('checksum');expect(fs.readFileSync(path.join(backup,'snapshot.db'))).toEqual(original);
 }finally{f.cleanup();}
});
test('P3 OS-issued one-time login is 128-bit, expires in five minutes and cannot replay',()=>{
 const code=issueLocalLogin('synthetic-only',1000);expect(code).toHaveLength(32);expect(consumeLocalLogin('f'.repeat(32),1001)).toBeNull();expect(consumeLocalLogin(code,1002)).toBe('synthetic-only');expect(consumeLocalLogin(code,1003)).toBeNull();const expired=issueLocalLogin('synthetic-only',2000);expect(consumeLocalLogin(expired,302000)).toBeNull();
});

test('P3 actual process kill before/after pointer swap leaves a whole generation and releases OS lock',async()=>{
 for(const boundary of ['staged','committed']){
  const f=fixture();try{
   const b=f.bundle('first'),next=f.bundle('next'),old=f.delivery.install(b,3737),key=path.join(f.root,'fixture-public.pem');durableWrite(key,f.trust);
   const child=Bun.spawn([process.execPath,'tests/helpers/p3-crash.ts',f.install,next,key,boundary],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root,NODE_ENV:'test'}});
   const code=await child.exited;expect(code).not.toBe(0);expect(child.signalCode).toBe('SIGKILL');
   const current=readCurrent(f.install);expect(current.generation===old.generation).toBe(boundary==='staged');expect(f.delivery.doctor().ok).toBe(true);
   const release=lockInstallation(f.install);release();expect(snapshotInfo(dataFile(f.install,current)).instance).toBe(old.instance);
  }finally{f.cleanup();}
 }
},20000);

test('P3 malformed generation pointer refuses traversal before reading data',()=>{
 const f=fixture();try{f.delivery.install(f.bundle('first'),3737);const c=readCurrent(f.install);durableWrite(path.join(f.install,'current.json'),JSON.stringify({...c,generation:'../../elsewhere'}));expect(()=>readCurrent(f.install)).toThrow();expect(f.delivery.doctor().ok).toBe(false);}finally{f.cleanup();}
});

test('doctor reports verified/stale/wrong-instance/corrupt scheduled backup, pending operations and unknown live checks without mutations',()=>{
 const f=fixture();try{
  const c=f.delivery.install(f.bundle('doctor-ops'),3737),file=dataFile(f.install,c);
  const initial=f.delivery.doctor();expect(initial.status).toBe('incomplete');expect(initial.checks.backup!.status).toBe('unknown');expect(initial.checks.port!.status).toBe('unknown');
  const backup=path.join(f.install,'backups','qoopia-2026-09-06T00-00-00-000Z.backup');f.delivery.backup(backup);
  const before=inventory(f.install);expect(f.delivery.doctor().checks.backup!.status).toBe('pass');expect(inventory(f.install)).toEqual(before);
  const manifest=path.join(backup,'manifest.json'),good=fs.readFileSync(manifest,'utf8'),parsed=JSON.parse(good);
  durableWrite(manifest,JSON.stringify({...parsed,created_at:'2000-01-01T00:00:00.000Z'}));expect(f.delivery.doctor().checks.backup!.reason).toBe('BACKUP_STALE_OR_CLOCK_INVALID');
  durableWrite(manifest,JSON.stringify({...parsed,instance:'wrong-instance'}));expect(f.delivery.doctor().ok).toBe(false);
  durableWrite(manifest,good);fs.appendFileSync(path.join(backup,'snapshot.db'),'corrupt synthetic secret body');
  const corrupt=inventory(f.install),report=f.delivery.doctor();expect(report.checks.backup!.status).toBe('fail');expect(JSON.stringify(report)).not.toContain('synthetic secret body');expect(inventory(f.install)).toEqual(corrupt);
  fs.writeFileSync(file,'corrupt secret database');expect(f.delivery.doctor().checks.stored_state!.status).toBe('fail');
 }finally{f.cleanup();}
});


test('doctor never creates SQLite sidecars in a WAL-mode scheduled backup',()=>{
 const f=fixture();try{
  f.delivery.install(f.bundle('doctor-wal'),3737);
  const folder=path.join(f.install,'backups','qoopia-2026-09-06T00-00-00-000Z.backup');f.delivery.backup(folder);
  const file=path.join(folder,'snapshot.db'),d=new Database(file);d.run('PRAGMA journal_mode=WAL');d.close();
  const manifest=path.join(folder,'manifest.json'),m=JSON.parse(fs.readFileSync(manifest,'utf8'));
  m.sha256=hash(fs.readFileSync(file));m.size=fs.statSync(file).size;durableWrite(manifest,JSON.stringify(m));
  const before=inventory(f.install);expect(f.delivery.doctor().checks.backup!.status).toBe('pass');expect(inventory(f.install)).toEqual(before);
 }finally{f.cleanup();}
});

// Portable recovery uses the same Delivery/snapshot/outbox callers as owner commands.
test('portable operations round-trip preserves pending IDs, confirmations and recurrence without channel secrets',async()=>{
 const {recordMaintenance,readOps,opsFile}=await import('../src/delivery/ops-state.ts');
 const {operationsDirectory}=await import('../src/delivery/operations.ts');
 const {deliverOpsAlerts}=await import('../src/services/ops-alerts.ts');
 const f=fixture();let server: import('node:http').Server | undefined;
 try{
  const bundle=f.bundle('recovery'),current=f.delivery.install(bundle,3737),ops=operationsDirectory(f.install,current);
  const destination={id:'fixture',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:new Uint8Array(32).fill(17)};
  const seen:string[]=[];
  const accept=(body:string)=>{const event=JSON.parse(body);seen.push(event.id);return JSON.stringify({accepted:true,event_id:event.id,payload_sha256:hash(body)});};
  let fetchImpl:typeof fetch=async(_url,init)=>new Response(accept(String(init!.body)),{status:200});
  if(process.env.P3_RECOVERY_LOCAL_RECEIVER==='1'){
   const http=await import('node:http');
   server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(accept(body));});});
   await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});
   const port=(server.address() as {port:number}).port;
   fetchImpl=async(_url,init)=>fetch(`http://127.0.0.1:${port}/alerts`,init);
  }
  const transport={fetchImpl,resolver:async()=>[{address:'93.184.216.34'}]};
  recordMaintenance(ops,current.instance,'BACKUP_FAILED',1000);
  await deliverOpsAlerts(ops,[destination],transport,1001);
  recordMaintenance(ops,current.instance,null,1002);
  recordMaintenance(ops,current.instance,'BACKUP_FAILED',1003);
  // A failed attempt is durable and remains pending even after resolve.
  await deliverOpsAlerts(ops,[destination],{...transport,fetchImpl:async()=>new Response('{}',{status:503})},1004);
  recordMaintenance(ops,current.instance,null,1005);
  const before=readOps(ops),backup=path.join(f.root,'portable');
  durableWrite(path.join(f.install,'ops-channels.json'),'synthetic-private-channel-canary');
  f.delivery.backup(backup);const manifest=verifyBackup(backup,current.instance);
  expect(manifest.format).toBe('qoopia-backup/2');expect(fs.readdirSync(backup).sort()).toEqual(['manifest.json','operations-status.json','snapshot.db']);
  expect(fs.readFileSync(opsFile(backup),'utf8')).not.toContain('synthetic-private-channel-canary');
  const target=new Delivery(path.join(f.root,'Recovered Ж user'),f.trust,true,()=>{});
  const restored=target.restoreNew(backup,bundle,4141);let recovered=operationsDirectory(target.root,restored.current);
  const held={...before,delivery_hold:'RECOVERY_REPLAY_REQUIRES_OWNER'};
  expect(readOps(recovered)).toEqual(held);expect(fs.statSync(opsFile(recovered)).mode&0o777).toBe(0o600);
  expect(fs.statSync(recovered).mode&0o777).toBe(0o700);expect(fs.existsSync(path.join(target.root,'ops-channels.json'))).toBe(false);
  await deliverOpsAlerts(recovered,[],transport,100000);expect(readOps(recovered)).toEqual(held);
  await deliverOpsAlerts(recovered,[destination],transport,100000);expect(readOps(recovered)).toEqual(held);expect(seen).toHaveLength(1);
  const authorization=target.previewOpsReplay();
  recovered=operationsDirectory(target.root,target.authorizeOpsReplay(authorization.confirmation).current);
  await deliverOpsAlerts(recovered,[destination],transport,100000);
  expect(seen).toEqual(before.alerts.map(a=>a.id));
  expect(readOps(recovered).alerts.every(a=>a.state==='confirmed')).toBe(true);
  await deliverOpsAlerts(recovered,[destination],transport,200000);expect(seen).toHaveLength(2);
  recordMaintenance(recovered,current.instance,'BACKUP_FAILED',200001);
  await deliverOpsAlerts(recovered,[destination],transport,200002);expect(seen).toHaveLength(3);expect(new Set(seen).size).toBe(3);
  expect(readOps(ops)).toEqual(before);
  // A published journal reference cannot silently become a fresh empty queue.
  fs.renameSync(opsFile(recovered),opsFile(recovered)+'.held');
  expect(()=>target.backup(path.join(f.root,'missing-selected'))).toThrow('Selected operations journal missing');
  expect(target.doctor().ok).toBe(false);
 }finally{if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));f.cleanup();}
},15000);

test('older restore cannot replay newer confirmation; staged failure preserves original pointer, DB and journal; update rollback retain recovered journal',async()=>{
 const {recordMaintenance,readOps,opsFile}=await import('../src/delivery/ops-state.ts');
 const {operationsDirectory}=await import('../src/delivery/operations.ts');
 const {deliverOpsAlerts}=await import('../src/services/ops-alerts.ts');
 const f=fixture();try{
  const bundle=f.bundle('merge'),c=f.delivery.install(bundle,3737),ops=operationsDirectory(f.install,c);
  recordMaintenance(ops,c.instance,'BACKUP_FAILED',1000);const backup=path.join(f.root,'older');f.delivery.backup(backup);
  const destination={id:'fixture',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:new Uint8Array(32).fill(18)};
  await deliverOpsAlerts(ops,[destination],{resolver:async()=>[{address:'93.184.216.34'}],fetchImpl:async(_url,init)=>new Response(JSON.stringify({accepted:true,event_id:JSON.parse(String(init!.body)).id,payload_sha256:hash(String(init!.body))}))},1001);
  recordMaintenance(ops,c.instance,null,1002);recordMaintenance(ops,c.instance,'DATABASE_FAILED',1003);
  const original=[path.join(f.install,'current.json'),dataFile(f.install,c),opsFile(ops)].map(p=>({p,bytes:fs.readFileSync(p)}));
  const failed=new Delivery(f.install,f.trust,true,()=>{},boundary=>{if(boundary==='staged')throw new Error('injected staged restore failure');});
  expect(()=>failed.restore(backup)).toThrow('injected staged');
  for(const item of original)expect(fs.readFileSync(item.p)).toEqual(item.bytes);
  const beforeCheckpoints=fs.readdirSync(path.join(f.install,'backups')).filter(name=>name.startsWith('pre-restore-'));
  const result=f.delivery.restore(backup),recovered=operationsDirectory(f.install,result.current);
  const checkpoints=fs.readdirSync(path.join(f.install,'backups')).filter(name=>name.startsWith('pre-restore-'));
  expect(checkpoints).toHaveLength(beforeCheckpoints.length+1);
  for(const checkpoint of checkpoints)expect(verifyBackup(path.join(f.install,'backups',checkpoint),c.instance).instance).toBe(c.instance);
  expect(readOps(recovered)).toEqual(readOps(ops));
  const next=f.delivery.update(f.bundle('merge-update'));expect(operationsDirectory(f.install,next)).toBe(recovered);
  recordMaintenance(recovered,c.instance,null,1004);
  const rolled=f.delivery.rollback();expect(operationsDirectory(f.install,rolled)).toBe(recovered);
  expect(readOps(recovered).alerts[0]!.state).toBe('confirmed');expect(readOps(recovered).alerts[1]!.state).toBe('pending');
  expect(fs.readFileSync(opsFile(ops))).toEqual(original[2]!.bytes);
 }finally{f.cleanup();}
});

test('corrupt, missing, wrong-instance and conflicting receipt recovery refuses without replacing original data; legacy recovery is conditional',()=>{
 const {recordMaintenance,readOps,opsFile}=require('../src/delivery/ops-state.ts') as typeof import('../src/delivery/ops-state.ts');
 const {operationsDirectory}=require('../src/delivery/operations.ts') as typeof import('../src/delivery/operations.ts');
 const f=fixture();try{
  const bundle=f.bundle('invalid'),c=f.delivery.install(bundle,3737),ops=operationsDirectory(f.install,c);
  recordMaintenance(ops,c.instance,'BACKUP_FAILED',1000);
  const backup=path.join(f.root,'bad-input');f.delivery.backup(backup);
  const original=[path.join(f.install,'current.json'),dataFile(f.install,c),opsFile(ops)].map(p=>({p,bytes:fs.readFileSync(p)}));
  const originalManifest=fs.readFileSync(path.join(backup,'manifest.json')),originalOps=fs.readFileSync(opsFile(backup));
  const controls=['checksum','missing','wrong-instance','duplicate','false-confirmed','wrong-receipt','unknown-secret'] as const;
  for(const control of controls){
   durableWrite(opsFile(backup),originalOps);durableWrite(path.join(backup,'manifest.json'),originalManifest);
   const state=readOps(backup),a=state.alerts[0]!;
   if(control==='missing')fs.unlinkSync(opsFile(backup));
   else if(control==='checksum')fs.appendFileSync(opsFile(backup),'corrupt');
   else {
    if(control==='wrong-instance')a.installation='wrong-instance';
    if(control==='duplicate')state.alerts.push({...a});
    if(control==='false-confirmed')a.state='confirmed';
    if(control==='wrong-receipt'){a.state='confirmed';a.attempts=1;a.last_error=null;a.receipt={event_id:a.id,accepted:true,payload_sha256:'0'.repeat(64)};}
    if(control==='unknown-secret')Object.assign(a,{signing_key:'synthetic-secret-canary'});
    durableWrite(opsFile(backup),JSON.stringify(state));
    const m=JSON.parse(originalManifest.toString()),bytes=fs.readFileSync(opsFile(backup));m.operations={sha256:hash(bytes),size:bytes.length};durableWrite(path.join(backup,'manifest.json'),JSON.stringify(m));
   }
   const before=inventory(backup);expect(()=>f.delivery.restore(backup)).toThrow();expect(inventory(backup)).toEqual(before);
   const target=new Delivery(path.join(f.root,'refused-'+control),f.trust,true,()=>{});
   expect(()=>target.restoreNew(backup,bundle,4141)).toThrow();expect(fs.existsSync(target.root)).toBe(false);
   for(const item of original)expect(fs.readFileSync(item.p)).toEqual(item.bytes);
  }
  durableWrite(opsFile(backup),originalOps);durableWrite(path.join(backup,'manifest.json'),originalManifest);
  // Capture also refuses a corrupt local journal and leaves the valid backup intact.
  durableWrite(opsFile(ops),'synthetic corrupt status');const before=inventory(backup);
  expect(()=>f.delivery.backup(path.join(f.root,'refused-capture'))).toThrow('OPS_JOURNAL_INVALID');expect(inventory(backup)).toEqual(before);
  expect(fs.readFileSync(opsFile(ops),'utf8')).toBe('synthetic corrupt status');
  durableWrite(opsFile(ops),original[2]!.bytes);
  const legacy=path.join(f.root,'legacy');backupUnified(dataFile(f.install,c),legacy,c.instance);
  const target=new Delivery(path.join(f.root,'legacy-user'),f.trust,true,()=>{});
  expect(target.restoreNew(legacy,bundle,4141).operations_recovery).toContain('CONDITIONAL');
  expect(f.delivery.restore(legacy).operations_recovery).toContain('local journal retained');
 }finally{f.cleanup();}
});

test('process kill at restore publication selects complete old or recovered DB and ops together',async()=>{
 const {recordMaintenance,readOps}=await import('../src/delivery/ops-state.ts');
 const {operationsDirectory}=await import('../src/delivery/operations.ts');
 for(const boundary of ['staged','committed']){
  const f=fixture();try{
   const c=f.delivery.install(f.bundle('restore-kill'),3737),ops=operationsDirectory(f.install,c);
   recordMaintenance(ops,c.instance,'BACKUP_FAILED',1000);const state=readOps(ops),backup=path.join(f.root,'recovery');f.delivery.backup(backup);
   const key=path.join(f.root,'public.pem');durableWrite(key,f.trust);
   const child=Bun.spawn([process.execPath,'tests/helpers/p3-crash.ts',f.install,backup,key,boundary,'restore'],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root,NODE_ENV:'test'}});
   await child.exited;expect(child.signalCode).toBe('SIGKILL');
   const after=readCurrent(f.install);expect(after.generation===c.generation).toBe(boundary==='staged');
   expect(operationsDirectory(f.install,after)===ops).toBe(boundary==='staged');expect(readOps(operationsDirectory(f.install,after))).toEqual(state);
   expect(snapshotInfo(dataFile(f.install,after)).instance).toBe(c.instance);expect(readOps(ops)).toEqual(state);
   const release=lockInstallation(f.install);release();
  }finally{f.cleanup();}
 }
},15000);

test('round1 restoreNew checks post-migration instance and integrity before publishing',()=>{
 const f=fixture();try{
  const bundle=f.bundle('post-migration'),c=f.delivery.install(bundle,3737),backup=path.join(f.root,'backup');f.delivery.backup(backup);
  const before=inventory(backup),source=fs.readFileSync(dataFile(f.install,c));
  for(const kind of ['identity','integrity']){
   const target=new Delivery(path.join(f.root,'refused-post-'+kind),f.trust,true,(_bundle,dir)=>{
    const file=path.join(dir,'data','qoopia.db');
    if(kind==='integrity'){fs.writeFileSync(file,'damaged migrated database');return;}
    const d=new Database(file);try{d.query("UPDATE authority_instance SET instance_id='foreign' WHERE id='local'").run();}finally{d.close();}
   });
   expect(()=>target.restoreNew(backup,bundle,4141)).toThrow();expect(fs.existsSync(path.join(target.root,'current.json'))).toBe(false);
   expect(inventory(backup)).toEqual(before);expect(fs.readFileSync(dataFile(f.install,c))).toEqual(source);
  }
 }finally{f.cleanup();}
});

test('round1 corrupt local journal blocks all recovery capture callers without loss or import callback',()=>{
 const {operationsDirectory}=require('../src/delivery/operations.ts') as typeof import('../src/delivery/operations.ts');
 const {opsFile}=require('../src/delivery/ops-state.ts') as typeof import('../src/delivery/ops-state.ts');
 const f=fixture();try{
  const bundle=f.bundle('local-refusal'),c=f.delivery.install(bundle,3737),backup=path.join(f.root,'good');f.delivery.backup(backup);
  const file=opsFile(operationsDirectory(f.install,c));privateDirectory(path.dirname(file));durableWrite(file,'corrupt private journal');
  const pointer=fs.readFileSync(path.join(f.install,'current.json')),db=fs.readFileSync(dataFile(f.install,c)),saved=inventory(backup);
  let applied=false;
  for(const operation of [()=>f.delivery.backup(path.join(f.root,'refused')),()=>f.delivery.update(bundle),()=>f.delivery.importCopy(()=>{applied=true;}),()=>f.delivery.restore(backup)]){
   expect(operation).toThrow('OPS_JOURNAL_INVALID');expect(applied).toBe(false);
   expect(fs.readFileSync(file,'utf8')).toBe('corrupt private journal');expect(fs.readdirSync(path.dirname(file))).toEqual(['operations-status.json']);
   expect(fs.readFileSync(path.join(f.install,'current.json'))).toEqual(pointer);expect(fs.readFileSync(dataFile(f.install,c))).toEqual(db);expect(inventory(backup)).toEqual(saved);
  }
 }finally{f.cleanup();}
});

test('round1 actual doctor bounds projection and reports journal refusal without mutation',()=>{
 const {operationsDirectory}=require('../src/delivery/operations.ts') as typeof import('../src/delivery/operations.ts');
 const {recordMaintenance,readOps,writeOps,opsFile}=require('../src/delivery/ops-state.ts') as typeof import('../src/delivery/ops-state.ts');
 const f=fixture();try{
  const c=f.delivery.install(f.bundle('bounded-doctor'),3737),ops=operationsDirectory(f.install,c);
  recordMaintenance(ops,c.instance,'BACKUP_FAILED',1000);const state=readOps(ops),first=state.alerts[0]!;
  state.alerts=Array.from({length:80},()=>({...first,id:crypto.randomUUID(),active:false}));state.alerts.at(-1)!.active=true;writeOps(ops,state);
  const before=inventory(f.install),check=f.delivery.doctor().checks.maintenance!;
  expect(check).toMatchObject({status:'fail',pending:80,active:1,total_alerts:80,omitted_alerts:60});expect((check.alerts as unknown[]).length).toBe(20);expect(inventory(f.install)).toEqual(before);
  durableWrite(opsFile(ops),'corrupt private bytes');const corrupt=inventory(f.install);
  expect(f.delivery.doctor().checks.maintenance).toMatchObject({status:'fail',reason:'OPS_JOURNAL_INVALID',error:'OPS_JOURNAL_INVALID'});expect(inventory(f.install)).toEqual(corrupt);
 }finally{f.cleanup();}
});

test('Scope B formerly over-budget full recovery union fits after lossless compaction',()=>{
 const {operationsDirectory}=require('../src/delivery/operations.ts') as typeof import('../src/delivery/operations.ts');
 const {opsFile,writeOps,opsPayload}=require('../src/delivery/ops-state.ts') as typeof import('../src/delivery/ops-state.ts');
 const {MAX_JSON_BYTES}=require('../src/utils/fs.ts') as typeof import('../src/utils/fs.ts');
 const f=fixture();try{
  const c=f.delivery.install(f.bundle('merge-limit'),3737),ops=operationsDirectory(f.install,c);
  const seed:import('../src/delivery/ops-state.ts').OpsAlert={id:crypto.randomUUID(),installation:c.instance,component:'maintenance',subject:'daily',cause:'BACKUP_FAILED',active:false,state:'pending',attempts:0,next_attempt_at:1000,last_error:'NO_CHANNEL',receipt:null};
  const count=Math.ceil(MAX_JSON_BYTES*0.55/(Buffer.byteLength(JSON.stringify(seed))+1));
  const alerts=Array.from({length:count},()=>({...seed,id:crypto.randomUUID()}));
  writeOps(ops,{format:'qoopia-ops/1',last_run:null,alerts});const backup=path.join(f.root,'saved-pending');f.delivery.backup(backup);
  const local:import('../src/delivery/ops-state.ts').OpsAlert[]=alerts.map(a=>({...a,state:'confirmed',attempts:1,last_error:null,receipt:{event_id:a.id,accepted:true,payload_sha256:hash(JSON.stringify({id:a.id,event_type:'operational_alert',payload:opsPayload(a)}))}}));
  // Individually readable journals can exceed the budget when disjoint IDs are merged.
  const retained=local.slice(0,Math.floor(local.length/2));
  const distinct=retained.map(a=>{const id=crypto.randomUUID();return {...a,id,receipt:{event_id:id,accepted:true as const,payload_sha256:hash(JSON.stringify({id,event_type:'operational_alert',payload:opsPayload(a)}))}};});
  writeOps(ops,{format:'qoopia-ops/1',last_run:null,alerts:[...retained,...distinct]});
  const before=[path.join(f.install,'current.json'),dataFile(f.install,c),opsFile(ops)].map(file=>({file,bytes:fs.readFileSync(file)})),saved=inventory(backup);
  const result=f.delivery.restore(backup);
  const {readOps}=require('../src/delivery/ops-state.ts') as typeof import('../src/delivery/ops-state.ts');
  const merged=readOps(operationsDirectory(f.install,result.current));
  expect(merged.receipts).toHaveLength(retained.length+distinct.length);
  expect(merged.alerts.filter(a=>a.state==='pending')).toHaveLength(alerts.length-retained.length);
  for(const item of before.slice(1))expect(fs.readFileSync(item.file)).toEqual(item.bytes);expect(inventory(backup)).toEqual(saved);
 }finally{f.cleanup();}
// Large journal hashing exercises the same limits under x64 CPU emulation.
}, 120_000);

test('round1 documented diagnosis runs read-only against a corrupt selected journal and a valid backup',()=>{
 const {spawnSync}=require('node:child_process') as typeof import('node:child_process');
 const {operationsDirectory}=require('../src/delivery/operations.ts') as typeof import('../src/delivery/operations.ts');
 const {opsFile}=require('../src/delivery/ops-state.ts') as typeof import('../src/delivery/ops-state.ts');
 const f=fixture();try{
  const c=f.delivery.install(f.bundle('runbook'),3737),backup=path.join(f.root,'backup');f.delivery.backup(backup);
  const file=opsFile(operationsDirectory(f.install,c));privateDirectory(path.dirname(file));durableWrite(file,'private corrupt bytes');
  const before=inventory(f.install),saved=inventory(backup);
  const doc=fs.readFileSync('docs/v4/runbooks/backup-restore.md','utf8'),script=doc.split("<<'TS'\n")[1]!.split('\nTS\n')[0]!;
  const result=spawnSync(process.execPath,['-',f.install,backup],{input:script,encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root,NODE_ENV:'test'}});
  expect(result.status).toBe(1);expect(result.stderr).toBe('');expect(result.stdout).toContain('OPS_JOURNAL_INVALID');expect(result.stdout).toContain('VERIFIED');expect(result.stdout).not.toContain('private corrupt bytes');
  expect(inventory(f.install)).toEqual(before);expect(inventory(backup)).toEqual(saved);
 }finally{f.cleanup();}
});

test('version-aware engine refuses old bundle recovery/replay/restore/update/rollback without changing pointer or journal',async()=>{
 const {opsFile,recordMaintenance,RECOVERY_DELIVERY_HOLD}=await import('../src/delivery/ops-state.ts');
 const {operationsDirectory}=await import('../src/delivery/operations.ts');
 const f=fixture();try{
  const legacy=f.bundle('old-no-capability',true,false),current=f.bundle('version-aware');
  const c=f.delivery.install(legacy,3737),file=opsFile(operationsDirectory(f.install,c));
  recordMaintenance(operationsDirectory(f.install,c),c.instance,'BACKUP_FAILED',1000);
  const backup=path.join(f.root,'backup');f.delivery.backup(backup);
  durableWrite(file,'damaged');const pointer=fs.readFileSync(path.join(f.install,'current.json'));
  expect(()=>f.delivery.previewOpsRecovery(backup)).toThrow('OPS_BUNDLE_INCOMPATIBLE');expect(()=>f.delivery.recoverOps(backup,'0'.repeat(64))).toThrow('OPS_BUNDLE_INCOMPATIBLE');
  expect(fs.readFileSync(file,'utf8')).toBe('damaged');expect(fs.existsSync(path.join(f.install,'operations-recovery'))).toBe(false);
  durableWrite(file,JSON.stringify({format:'qoopia-ops/1',last_run:null,alerts:[],delivery_hold:RECOVERY_DELIVERY_HOLD}));const bytes=fs.readFileSync(file);
  expect(()=>f.delivery.previewOpsReplay()).toThrow('OPS_BUNDLE_INCOMPATIBLE');expect(()=>f.delivery.authorizeOpsReplay('0'.repeat(64))).toThrow('OPS_BUNDLE_INCOMPATIBLE');expect(()=>f.delivery.restore(backup)).toThrow('OPS_BUNDLE_INCOMPATIBLE');expect(()=>f.delivery.update(legacy)).toThrow('OPS_BUNDLE_INCOMPATIBLE');
  expect(fs.readFileSync(file)).toEqual(bytes);expect(fs.readFileSync(path.join(f.install,'current.json'))).toEqual(pointer);
  const updated=f.delivery.update(current),nextPointer=fs.readFileSync(path.join(f.install,'current.json'));
  expect(()=>f.delivery.rollback()).toThrow('OPS_BUNDLE_INCOMPATIBLE');expect(fs.readFileSync(path.join(f.install,'current.json'))).toEqual(nextPointer);expect(fs.readFileSync(file)).toEqual(bytes);expect(readCurrent(f.install).generation).toBe(updated.generation);
  const other=new Delivery(path.join(f.root,'other'),f.trust,true,()=>{throw new Error('must not migrate');});expect(()=>other.restoreNew(backup,legacy,3738)).toThrow('OPS_BUNDLE_INCOMPATIBLE');expect(fs.existsSync(path.join(other.root,'current.json'))).toBe(false);
 }finally{f.cleanup();}
});
