import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { journalBundleFixture } from './helpers/p3-journal-bundle.ts';
import { Delivery, dataFile, lockInstallation, readCurrent, type Current } from '../src/delivery/operations.ts';
import { durableWrite, hash, inventory, privateDirectory } from '../src/delivery/files.ts';
import { verifyBackup } from '../src/delivery/snapshot.ts';

const inspect = (file:string) => {
  const d=new Database(file,{readonly:true});
  try {
    const canonical={
      workspaces:d.query('SELECT id,name,slug FROM workspaces ORDER BY id').all(),
      agents:d.query('SELECT id,workspace_id,name,type,principal_kind,authority_profile,tool_profile,active FROM agents ORDER BY id').all(),
      owners:d.query('SELECT workspace_id,actor_id,origin_instance_id FROM workspace_owners ORDER BY workspace_id,actor_id').all(),
      notes:d.query('SELECT id,workspace_id,agent_id,type,text,source FROM notes ORDER BY id').all(),
      sessions:d.query('SELECT id,workspace_id,agent_id,title FROM sessions ORDER BY id').all(),
      messages:d.query('SELECT id,workspace_id,session_id,agent_id,role,content FROM session_messages ORDER BY id').all(),
      activity:d.query('SELECT id,workspace_id,agent_id,action,entity_type,entity_id,summary FROM activity ORDER BY id').all(),
      entities:d.query('SELECT id,workspace_id,type,slug,title,summary FROM entity_pages ORDER BY id').all(),
    };
    const fts={
      notes:d.query("SELECT notes.id FROM notes_fts JOIN notes ON notes.rowid=notes_fts.rowid WHERE notes_fts MATCH 'corruptlive' ORDER BY notes.id").all(),
      messages:d.query("SELECT session_messages.id FROM session_messages_fts JOIN session_messages ON session_messages.id=session_messages_fts.rowid WHERE session_messages_fts MATCH 'corruptlive' ORDER BY session_messages.id").all(),
      activity:d.query("SELECT activity.id FROM activity_fts JOIN activity ON activity.rowid=activity_fts.rowid WHERE activity_fts MATCH 'corruptlive' ORDER BY activity.id").all(),
      entities:d.query("SELECT entity_pages.id FROM entity_pages_fts JOIN entity_pages ON entity_pages.rowid=entity_pages_fts.rowid WHERE entity_pages_fts MATCH 'corruptlive' ORDER BY entity_pages.id").all(),
    };
    return {canonical,fts,integrity:d.query('PRAGMA integrity_check').all(),foreignKeys:d.query('PRAGMA foreign_key_check').all()};
  } finally { d.close(); }
};

function fixture(corruption:'header'|'page'='header') {
  const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-corrupt-live-'))),root=path.join(outer,'installation');
  privateDirectory(root);
  const source=ownerFixture(37),instance=(source.database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  const bundle=journalBundleFixture(outer);privateDirectory(path.join(root,'bundles'));fs.renameSync(bundle.bundle,path.join(root,'bundles',bundle.digest));
  const current:Current={format:'qoopia-installation/1',generation:'generation-'+randomUUID(),bundle:bundle.digest,bundle_digest:bundle.digest,instance,port:3737};
  const file=dataFile(root,current);privateDirectory(path.dirname(file));durableWrite(file,source.database.serialize());source.database.close();durableWrite(path.join(root,'current.json'),JSON.stringify(current));
  const d=new Database(file),workspace=randomUUID(),owner=randomUUID(),now=Date.now();
  d.transaction(()=>{
    d.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Corrupt live','corrupt-live');
    d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,principal_kind,authority_profile,tool_profile) VALUES (?,?,?,'owner',?,'human','owner','full')").run(owner,workspace,'Recovery owner','0'.repeat(64));
    d.query("INSERT INTO workspace_owners(id,workspace_id,actor_id,origin_instance_id,created_at_ms) VALUES (?,?,?,(SELECT instance_id FROM authority_instance WHERE id='local'),?)").run(randomUUID(),workspace,owner,now);
    d.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,source) VALUES ('corrupt-note',?,?, 'memory','corruptlive note','manual')").run(workspace,owner);
    d.query("INSERT INTO sessions(id,workspace_id,agent_id,title) VALUES ('corrupt-session',?,?,'Corrupt live')").run(workspace,owner);
    d.query("INSERT INTO session_messages(workspace_id,session_id,agent_id,role,content) VALUES (?,'corrupt-session',?,'user','corruptlive message')").run(workspace,owner);
    d.query("INSERT INTO activity(id,workspace_id,agent_id,action,entity_type,entity_id,summary) VALUES ('corrupt-activity',?,?,'fixture','note','corrupt-note','corruptlive activity')").run(workspace,owner);
    d.query("INSERT INTO entity_pages(id,workspace_id,type,slug,title,summary) VALUES ('corrupt-entity',?,'knowledge','corrupt-live','Corruptlive entity','preserved')").run(workspace);
  }).immediate();d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize=(d.query('PRAGMA page_size').get() as {page_size:number}).page_size;
  const activityRoot=(d.query("SELECT rootpage FROM sqlite_master WHERE name='activity'").get() as {rootpage:number}).rootpage;
  d.close();
  const delivery=new Delivery(root,bundle.trust,true,()=>{}),backup=path.join(outer,'known-good');delivery.backup(backup);
  const expected=inspect(path.join(backup,'snapshot.db'));expect(Object.values(expected.fts).every(rows=>rows.length>0)).toBe(true);expect(fs.statSync(file).size).toBeLessThanOrEqual(2*1024*1024);
  const header=fs.readFileSync(file).subarray(0,100),offset=corruption==='header'?18:(activityRoot-1)*pageSize+3;
  const fd=fs.openSync(file,'r+');fs.writeSync(fd,Buffer.from([0xff,0xff]),0,2,offset);fs.fsyncSync(fd);fs.closeSync(fd);
  if(corruption==='page')expect(fs.readFileSync(file).subarray(0,100)).toEqual(header);
  durableWrite(file+'-wal','');durableWrite(file+'-shm','');
  const old={db:fs.readFileSync(file),wal:fs.readFileSync(file+'-wal'),shm:fs.readFileSync(file+'-shm')},pointer=fs.readFileSync(path.join(root,'current.json'));
  return {outer,root,file,current,delivery,backup,expected,old,pointer,trust:bundle.trust,cleanup:()=>fs.rmSync(outer,{recursive:true,force:true})};
}

function expectOldExact(f:ReturnType<typeof fixture>) {
  expect(fs.readFileSync(f.file)).toEqual(f.old.db);expect(fs.readFileSync(f.file+'-wal')).toEqual(f.old.wal);expect(fs.readFileSync(f.file+'-shm')).toEqual(f.old.shm);
}

test('same-instance restore recovers explicit SQLite header corruption while retaining exact old generation',()=>{
  const f=fixture();try {
    const result=f.delivery.restore(f.backup),selected=readCurrent(f.root);
    expect(selected.generation).toBe(result.current.generation);expect(selected.generation).not.toBe(f.current.generation);expectOldExact(f);
    const after=inspect(dataFile(f.root,selected));expect(after).toEqual(f.expected);expect(after.integrity).toEqual([{integrity_check:'ok'}]);expect(after.foreignKeys).toEqual([]);
    expect(result).toMatchObject({corrupt_live_recovery:true,retained_generation:f.current.generation});
  } finally { f.cleanup(); }
});

test('same-instance restore recovers deterministic valid-header page corruption',()=>{
  const f=fixture('page');try {
    const result=f.delivery.restore(f.backup),selected=readCurrent(f.root);
    expect(result).toMatchObject({corrupt_live_recovery:true,retained_generation:f.current.generation});expectOldExact(f);
    expect(inspect(dataFile(f.root,selected))).toEqual(f.expected);
  } finally { f.cleanup(); }
});

test('corrupt-live restore refuses tamper, instance mismatch and busy install without publication',()=>{
  for(const control of ['tamper','mismatch','busy'] as const){
    const f=fixture();let release:(()=>void)|undefined;try {
      let candidate=f.backup;
      if(control==='tamper')fs.appendFileSync(path.join(candidate,'snapshot.db'),'tamper');
      if(control==='mismatch'){candidate=path.join(f.outer,'mismatch');fs.cpSync(f.backup,candidate,{recursive:true});const manifest=path.join(candidate,'manifest.json'),m=JSON.parse(fs.readFileSync(manifest,'utf8'));m.instance='foreign';durableWrite(manifest,JSON.stringify(m));}
      if(control==='busy')release=lockInstallation(f.root);
      expect(()=>f.delivery.restore(candidate)).toThrow();expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);expectOldExact(f);
    } finally { release?.();f.cleanup(); }
  }
});

test('corrupt-live staged failure retains selected corrupt generation and exact bytes',()=>{
  const f=fixture();try {
    const backupBefore=inventory(f.backup);
    const failed=new Delivery(f.root,f.trust,true,()=>{},boundary=>{if(boundary==='staged')throw new Error('injected staged failure');});
    expect(()=>failed.restore(f.backup)).toThrow('injected staged failure');expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);expectOldExact(f);
    expect(inventory(f.backup)).toEqual(backupBefore);
  } finally { f.cleanup(); }
});

test('live header I/O failure is not classified as recoverable corruption',()=>{
  const f=fixture(),read=fs.readSync;try {
    const io=spyOn(fs,'readSync').mockImplementation(((fd,buffer,offset,length,position)=>{
      if(length===100&&position===0)throw Object.assign(new Error('fixture I/O failure'),{code:'EIO'});
      return read(fd,buffer,offset,length,position);
    }) as typeof fs.readSync);
    try { expect(()=>f.delivery.restore(f.backup)).toThrow('fixture I/O failure'); }
    finally { io.mockRestore(); }
    expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);expectOldExact(f);
  } finally { f.cleanup(); }
});

test('valid live header is filled after a short positive read and keeps the mandatory checkpoint',()=>{
  const f=fixture(),read=fs.readSync;try {
    const live=fs.openSync(f.file,'r+');fs.writeSync(live,Buffer.from([1,1]),0,2,18);fs.fsyncSync(live);fs.closeSync(live);
    let first=true;const partial=spyOn(fs,'readSync').mockImplementation(((fd,buffer,offset,length,position)=>{
      if(first&&length===100&&position===0){first=false;return read(fd,buffer,offset,8,position);}
      return read(fd,buffer,offset,length,position);
    }) as typeof fs.readSync);
    let result:ReturnType<Delivery['restore']>;try { result=f.delivery.restore(f.backup); } finally { partial.mockRestore(); }
    expect(result.corrupt_live_recovery).toBeUndefined();
    const checkpoints=fs.readdirSync(path.join(f.root,'backups')).filter(name=>name.startsWith('pre-restore-'));
    expect(checkpoints).toHaveLength(1);verifyBackup(path.join(f.root,'backups',checkpoints[0]!),f.current.instance);
  } finally { f.cleanup(); }
});

test('stable truly short live file remains recoverable corruption',()=>{
  const f=fixture();try {
    fs.truncateSync(f.file,8);const short=fs.readFileSync(f.file);
    const result=f.delivery.restore(f.backup);
    expect(result).toMatchObject({corrupt_live_recovery:true,retained_generation:f.current.generation});
    expect(fs.readFileSync(f.file)).toEqual(short);
  } finally { f.cleanup(); }
});

test('unexpected header EOF with a live file size at least 100 refuses',()=>{
  const f=fixture(),read=fs.readSync;try {
    const live=fs.openSync(f.file,'r+');fs.writeSync(live,Buffer.from([1,1]),0,2,18);fs.fsyncSync(live);fs.closeSync(live);
    const before=fs.readFileSync(f.file);let first=true;const premature=spyOn(fs,'readSync').mockImplementation(((fd,buffer,offset,length,position)=>{
      if(first&&length===100&&position===0){first=false;return read(fd,buffer,offset,8,position);}
      if(length===92&&position===8)return 0;
      return read(fd,buffer,offset,length,position);
    }) as typeof fs.readSync);
    try { expect(()=>f.delivery.restore(f.backup)).toThrow('Live database changed or header read ended early'); }
    finally { premature.mockRestore(); }
    expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(f.pointer);expect(fs.readFileSync(f.file)).toEqual(before);
  } finally { f.cleanup(); }
});
