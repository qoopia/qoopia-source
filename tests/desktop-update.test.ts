import {prepareDesktopUpdate,DESKTOP_RELEASE} from '../src/delivery/desktop-update.ts';
import {desktopRelease} from '../scripts/desktop-release.ts';
import {updateFeed} from '../scripts/update-feed.ts';
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ownerFixture } from './helpers/p1-fixtures.ts';
import { Delivery, readCurrent, dataFile, lockInstallation } from '../src/delivery/operations.ts';
import { inventory, hash, durableWrite, privateDirectory } from '../src/utils/fs.ts';
import { OPS_READER_MEMBER, OPS_READER_CAPABILITY } from '../src/delivery/bundle.ts';

function fixture() {
  const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-t24-'))),root=path.join(outer,'installation');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),trust=publicKey.export({type:'spki',format:'pem'}).toString();
  const bundle=(name:string,schema=37,script=name!=='first')=>{
    const dir=path.join(outer,name);privateDirectory(dir);
    for(const file of ['qoopia','assets/src/public/dashboard.html', ...(script?['assets/src/public/brand/dashboard.js']:[]),'assets/migrations/037-skill-loop.sql','SBOM.json','THIRD-PARTY-NOTICES.txt','assets/scripts/runtime/codex-seatbelt.py',`assets/native/owner-peer.${process.platform==='darwin'?'dylib':'so'}`]){
      privateDirectory(path.dirname(path.join(dir,file)));durableWrite(path.join(dir,file),name);
    }
    durableWrite(path.join(dir,OPS_READER_MEMBER),JSON.stringify(OPS_READER_CAPABILITY));
    if(name!=='first')durableWrite(path.join(dir,DESKTOP_RELEASE),JSON.stringify(desktopRelease(trust,name==='next'?200:100)));
    const raw=JSON.stringify({format:'qoopia-bundle/1',version:'5.0.0-p3.0',horizon:'QOOPIA-V-1',api_version:1,build_sha:'a'.repeat(40),source_digest:hash(name),target:`${process.platform}-${process.arch}`,bun_version:Bun.version,schema_min:32,schema_max:schema,signing:'test-fixture',publisher_key_sha256:hash(trust),platform_signing:'NOT_RUN',members:inventory(dir)});
    durableWrite(path.join(dir,'manifest.json'),raw);durableWrite(path.join(dir,'manifest.sig'),sign(null,Buffer.from(raw),privateKey));return dir;
  };
  const migrate=(_bundle:string,generationRoot:string)=>{privateDirectory(path.join(generationRoot,'data'));const file=path.join(generationRoot,'data','qoopia.db');if(!fs.existsSync(file)){const f=ownerFixture(37);durableWrite(file,f.database.serialize());f.database.close();}};
  const delivery=new Delivery(root,trust,true,migrate),first=bundle('first'),next=bundle('next'),current=delivery.install(first,3737);
  return {outer,root,trust,delivery,next,current,bundle,cleanup:()=>fs.rmSync(outer,{recursive:true,force:true})};
}

function writeWorkspace(root:string,current:ReturnType<typeof readCurrent>,name:string) {
  const db=new Database(dataFile(root,current));try{db.query('UPDATE workspaces SET name=?').run(name);}finally{db.close();}
}

test('desktop upgrade adopts legacy installation preserving memory, instance and connection configuration',()=>{
  const f=fixture();try{
    // The old signed installation predates the dashboard script extraction (5.0.4).
    expect(fs.existsSync(path.join(f.root,'bundles',f.current.bundle,'assets/src/public/brand/dashboard.js'))).toBe(false);
    writeWorkspace(f.root,f.current,'Synthetic preserved workspace');
    const config=path.join(f.root,'config','fixture-client.json');privateDirectory(path.dirname(config));durableWrite(config,'synthetic connection configuration');
    const result=prepareDesktopUpdate(f.delivery,f.next,f.trust,true);
    expect(result).toMatchObject({state:'updated',memory_preserved:true,backup_created:true});
    const selected=readCurrent(f.root);expect(selected.instance).toBe(f.current.instance);expect(selected.generation).not.toBe(f.current.generation);
    expect(fs.readFileSync(config,'utf8')).toBe('synthetic connection configuration');
    const database=new Database(dataFile(f.root,selected),{readonly:true});try{expect((database.query('SELECT name FROM workspaces LIMIT 1').get() as {name:string}).name).toBe('Synthetic preserved workspace');}finally{database.close();}
    expect(prepareDesktopUpdate(f.delivery,f.next,f.trust,true)).toEqual({state:'current',binary:result.binary});
    expect(()=>prepareDesktopUpdate(f.delivery,f.bundle('older'),f.trust,true)).toThrow('older');
    expect(readCurrent(f.root)).toEqual(selected);
  }finally{f.cleanup();}
});
test('desktop upgrade still refuses a new bundle without its required dashboard script',()=>{
  const f=fixture();try{
    expect(()=>prepareDesktopUpdate(f.delivery,f.bundle('missing-script',45,false),f.trust,true)).toThrow('Required dashboard script missing');
    expect(readCurrent(f.root)).toEqual(f.current);
  }finally{f.cleanup();}
});
test('legacy inline dashboard remains protected by the signed inventory during upgrade',()=>{
  const f=fixture();try{
    fs.appendFileSync(path.join(f.root,'bundles',f.current.bundle,'assets/src/public/dashboard.html'),'tampered');
    expect(()=>prepareDesktopUpdate(f.delivery,f.next,f.trust,true)).toThrow('Bundle member hashes');
    expect(readCurrent(f.root)).toEqual(f.current);
  }finally{f.cleanup();}
});
test('desktop upgrade refuses a running writer and altered metadata without changing installed data',()=>{
  const f=fixture();try{
    const release=lockInstallation(f.root);try{expect(()=>prepareDesktopUpdate(f.delivery,f.next,f.trust,true)).toThrow('busy');}finally{release();}
    expect(readCurrent(f.root)).toEqual(f.current);
    fs.appendFileSync(path.join(f.next,DESKTOP_RELEASE),' ');
    expect(()=>prepareDesktopUpdate(f.delivery,f.next,f.trust,true)).toThrow();expect(readCurrent(f.root)).toEqual(f.current);
  }finally{f.cleanup();}
});
test('desktop appcast signs exact archive bytes and rejects a different key or non-release URL',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pem=publicKey.export({type:'spki',format:'pem'}).toString();
  const metadata=desktopRelease(pem,200),archive=Buffer.from('synthetic DMG'),signature=sign(null,archive,privateKey),url='https://github.com/qoopia/qoopia-downloads/releases/download/test/Qoopia.dmg';
  const feed=updateFeed(metadata,url,archive,signature,pem);expect(feed).toContain('sparkle:edSignature="'+signature.toString('base64')+'"');expect(feed).toContain('<sparkle:version>200</sparkle:version>');
  expect(()=>updateFeed(metadata,url,Buffer.from('altered'),signature,pem)).toThrow('signature');
  expect(()=>updateFeed({...metadata,public_ed_key:Buffer.alloc(32).toString('base64')},url,archive,signature,pem)).toThrow('metadata');
  expect(()=>updateFeed(metadata,'https://evil.example/Qoopia.dmg',archive,signature,pem)).toThrow('URL');
  expect(()=>updateFeed(metadata,url.replace('github.com','name@github.com'),archive,signature,pem)).toThrow('URL');
});

 test('desktop upgrade accepts a cleanly closed WAL database without sidecars',()=>{
  const f=fixture();try{
    const file=dataFile(f.root,readCurrent(f.root));
    const database=new Database(file);
    database.exec("PRAGMA journal_mode=WAL");
    database.query("UPDATE workspaces SET name=?").run('Closed WAL workspace');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.close();
    // Other SQLite clients remove empty sidecars on clean close (e.g. Python).
    if(fs.existsSync(file+'-wal'))expect(fs.statSync(file+'-wal').size).toBe(0);
    fs.rmSync(file+'-wal',{force:true});fs.rmSync(file+'-shm',{force:true});
    expect(fs.existsSync(file+'-wal')).toBe(false);
    expect(fs.existsSync(file+'-shm')).toBe(false);
    const result=prepareDesktopUpdate(f.delivery,f.next,f.trust,true);
    expect(result.state).toBe('updated');
    const next=new Database(dataFile(f.root,readCurrent(f.root)));
    try{expect((next.query('SELECT name FROM workspaces LIMIT 1').get() as {name:string}).name).toBe('Closed WAL workspace');}finally{next.close();}
  }finally{f.cleanup();}
});
