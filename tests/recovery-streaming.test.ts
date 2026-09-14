import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { journalBundleFixture } from './helpers/p3-journal-bundle.ts';
import { backupUnified, verifyBackup } from '../src/delivery/snapshot.ts';
import { Delivery, dataFile } from '../src/delivery/operations.ts';
import { durableWrite, hash } from '../src/delivery/files.ts';
import { computeLogicalDatabaseHash } from '../src/db/v4-migrations.ts';

function legacyLogicalHash(db: Database): string {
  const digest=createHash('sha256');
  const tables=db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string|null}[];
  for(const table of tables){
    digest.update(`table\0${table.name}\0${table.sql??''}\n`);
    const names=(db.query(`PRAGMA table_info("${table.name.replaceAll('"','""')}")`).all() as {name:string}[]).map(column=>column.name);
    const encoded=(db.query(`SELECT * FROM "${table.name.replaceAll('"','""')}"`).all() as Record<string,unknown>[]).map(row=>JSON.stringify(names.map(name=>{
      const value=row[name];
      return value instanceof Uint8Array ? {blob_sha256:createHash('sha256').update(value).digest('hex')} : typeof value==='bigint' ? value.toString() : value;
    }))).sort();
    for(const row of encoded)digest.update(`${row}\n`);
  }
  return digest.digest('hex');
}

test('recovery streams snapshot files and BLOB scans while preserving legacy digest semantics',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-recovery-streaming-')));
  try{
    const fixture=ownerFixture(37),source=path.join(root,'source.db'),chunk=Buffer.alloc(1024*1024,0x5a);
    for(let i=0;i<4;i++)fixture.database.query("INSERT INTO files(id,workspace_id,owner_agent_id,folder,filename,mime,size,sha256,content,uploaded_by_agent_id,created_at) VALUES (?,?,?,?,?,'application/octet-stream',?,?,?,?,?)")
      .run(`stream-${i}`,fixture.owner.workspace_id,fixture.owner.agent_id,'streaming',`chunk-${i}.bin`,chunk.length,hash(chunk),chunk,fixture.owner.agent_id,'2026-09-07T00:00:00Z');
    const oracle=legacyLogicalHash(fixture.database);
    expect(computeLogicalDatabaseHash(fixture.database)).toBe(oracle);
    durableWrite(source,fixture.database.serialize());fixture.database.close();
    const backup=path.join(root,'backup'),manifest=backupUnified(source,backup);
    expect(manifest.logical_hash).toBe(oracle);

    const originalRead=fs.readFileSync,originalQuery=Database.prototype.query;
    (fs as unknown as {readFileSync:typeof fs.readFileSync}).readFileSync=((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
      if(typeof file==='string'&&path.basename(file)==='snapshot.db')throw new Error('FULL_SNAPSHOT_READ_FORBIDDEN');
      return (originalRead as (...values:unknown[])=>unknown)(file,...args);
    }) as typeof fs.readFileSync;
    Database.prototype.query=function(sql:string){
      const statement=originalQuery.call(this,sql),normalized=sql.replace(/\s+/g,' ').trim().toUpperCase();
      if(/^SELECT \* FROM /.test(normalized)||(/^SELECT /.test(normalized)&&/\bCONTENT\b/.test(normalized))){
        statement.all=()=>{throw new Error('BULK_BLOB_ALL_FORBIDDEN');};
      }
      return statement;
    } as typeof Database.prototype.query;
    try{
      expect(verifyBackup(backup).logical_hash).toBe(oracle);
      const bundle=journalBundleFixture(root),target=new Delivery(path.join(root,'restored'),bundle.trust,true,()=>{});
      const restored=target.restoreNew(backup,bundle.bundle,4141);
      const restoredFile=dataFile(target.root,restored.current),db=new Database(restoredFile,{readonly:true});
      try{
        const rows=[...db.query('SELECT id,content,size,sha256 FROM files ORDER BY id').iterate()] as {id:string;content:Uint8Array;size:number;sha256:string}[];
        expect(rows).toHaveLength(4);for(const row of rows){expect(row.content.byteLength).toBe(row.size);expect(hash(row.content)).toBe(row.sha256);}
      }finally{db.close();}
      expect(fs.statSync(restoredFile).mode&0o777).toBe(0o600);
      expect(target.doctor().checks.maintenance!.reason).toBe('RECOVERY_REPLAY_REQUIRES_OWNER');
    }finally{
      (fs as unknown as {readFileSync:typeof fs.readFileSync}).readFileSync=originalRead;
      Database.prototype.query=originalQuery;
    }

    const tampered=path.join(root,'tampered');fs.cpSync(backup,tampered,{recursive:true});fs.appendFileSync(path.join(tampered,'snapshot.db'),'tamper');
    const refusedRoot=path.join(root,'tampered-target'),bundle=journalBundleFixture(path.join(root,'tampered-bundle-root'));
    expect(()=>new Delivery(refusedRoot,bundle.trust,true,()=>{}).restoreNew(tampered,bundle.bundle,4142)).toThrow('checksum mismatch');
    expect(fs.existsSync(refusedRoot)).toBe(false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},30000);

test('failed staged streaming copy publishes no destination and removes its stage',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-stream-copy-failure-')));
  try{
    const source=path.join(root,'source.db'),destination=path.join(root,'final.db'),bytes=Buffer.alloc(1024*1024,7);durableWrite(source,bytes);
    const {durableCopyFile}=await import('../src/delivery/files.ts');
    const original=fs.fsyncSync;(fs as unknown as {fsyncSync:typeof fs.fsyncSync}).fsyncSync=()=>{throw new Error('injected staged fsync failure');};
    try{expect(()=>durableCopyFile(source,destination,bytes.length,hash(bytes))).toThrow('injected staged fsync failure');}
    finally{(fs as unknown as {fsyncSync:typeof fs.fsyncSync}).fsyncSync=original;}
    expect(fs.existsSync(destination)).toBe(false);expect(fs.readdirSync(root).filter(name=>name.includes('.stage-'))).toEqual([]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
