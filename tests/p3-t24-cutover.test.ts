import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { Delivery, readCurrent, dataFile, lockInstallation } from '../src/delivery/operations.ts';
import { inventory, hash, durableWrite, privateDirectory } from '../src/delivery/files.ts';
import { OPS_READER_MEMBER, OPS_READER_CAPABILITY } from '../src/delivery/bundle.ts';
import { snapshotInfo } from '../src/delivery/snapshot.ts';

function fixture() {
  const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-t24-'))),root=path.join(outer,'installation');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),trust=publicKey.export({type:'spki',format:'pem'}).toString();
  const bundle=(name:string)=>{
    const dir=path.join(outer,name);privateDirectory(dir);
    for(const file of ['qoopia','assets/src/public/dashboard.html','assets/migrations/037-skill-loop.sql','SBOM.json','THIRD-PARTY-NOTICES.txt','assets/scripts/runtime/codex-seatbelt.py',`assets/native/owner-peer.${process.platform==='darwin'?'dylib':'so'}`]){
      privateDirectory(path.dirname(path.join(dir,file)));durableWrite(path.join(dir,file),name);
    }
    durableWrite(path.join(dir,OPS_READER_MEMBER),JSON.stringify(OPS_READER_CAPABILITY));
    const raw=JSON.stringify({format:'qoopia-bundle/1',version:'5.0.0-p3.0',horizon:'QOOPIA-V-1',api_version:1,build_sha:'a'.repeat(40),source_digest:hash(name),target:`${process.platform}-${process.arch}`,bun_version:Bun.version,schema_min:32,schema_max:37,signing:'test-fixture',publisher_key_sha256:hash(trust),platform_signing:'NOT_RUN',members:inventory(dir)});
    durableWrite(path.join(dir,'manifest.json'),raw);durableWrite(path.join(dir,'manifest.sig'),sign(null,Buffer.from(raw),privateKey));return dir;
  };
  const migrate=(_bundle:string,generationRoot:string)=>{privateDirectory(path.join(generationRoot,'data'));const file=path.join(generationRoot,'data','qoopia.db');if(!fs.existsSync(file)){const f=ownerFixture(37);durableWrite(file,f.database.serialize());f.database.close();}};
  const delivery=new Delivery(root,trust,true,migrate),first=bundle('first'),next=bundle('next'),current=delivery.install(first,3737);
  return {outer,root,trust,delivery,next,current,cleanup:()=>fs.rmSync(outer,{recursive:true,force:true})};
}

function writeWorkspace(root:string,current:ReturnType<typeof readCurrent>,name:string) {
  const db=new Database(dataFile(root,current));try{db.query('UPDATE workspaces SET name=?').run(name);}finally{db.close();}
}

test('T24 exact update plan catches up legitimate writes made after preview',()=>{
  const f=fixture();try{
    writeWorkspace(f.root,f.current,'S0');
    const plan=f.delivery.previewUpdate(f.next);
    writeWorkspace(f.root,f.current,'S1-after-preview');
    const oldBytes=fs.readFileSync(dataFile(f.root,f.current));
    const result=f.delivery.update(f.next,plan,plan.plan_digest);
    const selected=readCurrent(f.root),db=new Database(dataFile(f.root,selected),{readonly:true});
    try{expect((db.query('SELECT name FROM workspaces LIMIT 1').get() as {name:string}).name).toBe('S1-after-preview');}finally{db.close();}
    expect(result.update_report).toMatchObject({format:'qoopia-update-cutover/1',plan_digest:plan.plan_digest,source_generation:f.current.generation,source_plan_hash:plan.source.logical_hash,barrier_sequence:1,barrier_sequence_semantics:'local_cutover_event_ordinal_not_source_audit_sequence',source_writes_caught_up:true,target_generation:selected.generation,rollback_disposition:'eligible_until_first_target_write; automatic_refusal_after_target_write'});
    expect(result.update_report.barrier_source_hash).not.toBe(plan.source.logical_hash);
    expect(result.update_report.timeline.map(event=>event.stage)).toEqual(['preview','writer_barrier','final_snapshot','target_staged','atomic_pointer']);
    expect(fs.readFileSync(dataFile(f.root,f.current))).toEqual(oldBytes);
  }finally{f.cleanup();}
});

test('T24 update refuses altered, stale generation and wrong bundle plans while preserving pointer',()=>{
  const f=fixture();try{
    const plan=f.delivery.previewUpdate(f.next),pointer=fs.readFileSync(path.join(f.root,'current.json'));
    expect(()=>f.delivery.update(f.next,{...plan,source:{...plan.source,generation:'generation-'+crypto.randomUUID()}},plan.plan_digest)).toThrow('UPDATE_PLAN_INVALID');
    expect(()=>f.delivery.update(f.next,plan,'0'.repeat(64))).toThrow('UPDATE_CONFIRMATION_STALE');
    expect(fs.readFileSync(path.join(f.root,'current.json'))).toEqual(pointer);
    const newer=f.delivery.update(f.next);
    expect(()=>f.delivery.update(f.next,plan,plan.plan_digest)).toThrow('UPDATE_PLAN_STALE');
    expect(readCurrent(f.root).generation).toBe(newer.generation);
  }finally{f.cleanup();}
});

test('T24 lifetime installation lock is the update writer barrier',()=>{
  const f=fixture();try{const plan=f.delivery.previewUpdate(f.next),release=lockInstallation(f.root);try{expect(()=>f.delivery.update(f.next,plan,plan.plan_digest)).toThrow('busy');}finally{release();}}
  finally{f.cleanup();}
});

test('T24 rollback selects old before target writes and refuses unchanged rollback after target writes',()=>{
  const f=fixture();try{
    let plan=f.delivery.previewUpdate(f.next),updated=f.delivery.update(f.next,plan,plan.plan_digest);
    expect(f.delivery.rollback().generation).toBe(f.current.generation);
    plan=f.delivery.previewUpdate(f.next);updated=f.delivery.update(f.next,plan,plan.plan_digest);writeWorkspace(f.root,updated,'post-target-write');
    expect(()=>f.delivery.rollback()).toThrow('Post-cutover');expect(readCurrent(f.root).generation).toBe(updated.generation);
  }finally{f.cleanup();}
});

test('T24 staged and committed crash boundaries select one whole generation',()=>{
  for(const boundary of ['staged','committed'] as const){
    const f=fixture();try{
      const plan=f.delivery.previewUpdate(f.next),delivery=new Delivery(f.root,f.trust,true,()=>{},point=>{if(point===boundary)throw new Error('fixture crash '+point);});
      expect(()=>delivery.update(f.next,plan,plan.plan_digest)).toThrow('fixture crash');
      const selected=readCurrent(f.root);expect(selected.generation===f.current.generation).toBe(boundary==='staged');
      expect(snapshotInfo(dataFile(f.root,selected)).instance).toBe(f.current.instance);
      const release=lockInstallation(f.root);release();
    }finally{f.cleanup();}
  }
});
