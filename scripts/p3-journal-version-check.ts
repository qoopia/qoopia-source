import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Delivery, readCurrent, dataFile, operationsDirectory } from '../src/delivery/operations.ts';
import { opsFile, recordMaintenance, RECOVERY_DELIVERY_HOLD } from '../src/delivery/ops-state.ts';
import { durableWrite, hash, inventory } from '../src/delivery/files.ts';
import { verifyBundle } from '../src/delivery/bundle.ts';
const arg=(name:string)=>{const i=process.argv.indexOf(name);assert(i>=0,name);return path.resolve(process.argv[i+1]!);};
const bundle=arg('--bundle'),legacy=arg('--legacy-bundle');
const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-version-cli-')));
const env={PATH:process.env.PATH!,HOME:outer,TMPDIR:outer};
const commands:unknown[]=[];
const invoke=(exe:string,args:string[],expected:number)=>{
 const r=spawnSync(exe,args,{cwd:outer,env,encoding:'utf8',timeout:90000});commands.push({executable:exe,argv:args,exit_code:r.status,stdout_sha256:hash(r.stdout??''),stderr:r.stderr});assert.equal(r.status,expected,r.stderr);return r;
};
const setup=(source:string,name:string)=>{
 const trust=fs.readFileSync(path.join(source,'TEST-PUBLIC-KEY.pem'),'utf8');verifyBundle(source,trust,true);
 const root=path.join(outer,name),d=new Delivery(root,trust,true,(b,g)=>{invoke(path.join(b,'qoopia'),['_migrate','--root',g],0);});
 const c=d.install(source,43737);recordMaintenance(operationsDirectory(root,c),c.instance,'BACKUP_FAILED',1000);
 const backup=path.join(outer,name+'-backup');d.backup(backup);
 return {root,d,c,backup,file:opsFile(operationsDirectory(root,c)),trust};
};
try{
 const f=setup(bundle,'current'),exe=path.join(bundle,'qoopia');
 const cmd=(name:string,...args:string[])=>[name,'--root',f.root,'--allow-test-fixture',...args];
 const pointer=fs.readFileSync(path.join(f.root,'current.json')),db=fs.readFileSync(dataFile(f.root,f.c)),saved=inventory(f.backup);
 durableWrite(f.file,'damaged');const preview=JSON.parse(invoke(exe,cmd('recover-ops','--backup',f.backup),0).stdout);
 for(const format of ['qoopia-ops/4','qoopia-ops/999']){
  const bytes=JSON.stringify({format,alerts:'future body',delivery_hold:'future hold'},null,2)+'\n';durableWrite(f.file,bytes);
  for(const args of [cmd('recover-ops','--backup',f.backup),cmd('recover-ops','--backup',f.backup,'--commit','--confirm-recovery',preview.confirmation),cmd('authorize-ops-replay'),cmd('authorize-ops-replay','--commit','--confirm-replay',preview.confirmation),cmd('backup','--out',path.join(outer,'refused'),'--commit'),cmd('restore','--backup',f.backup,'--commit'),cmd('update','--bundle',bundle,'--commit')])assert(invoke(exe,args,1).stderr.includes('OPS_JOURNAL_UNSUPPORTED_VERSION'));
  assert.equal(fs.readFileSync(f.file,'utf8'),bytes);assert.deepEqual(fs.readFileSync(path.join(f.root,'current.json')),pointer);assert.deepEqual(fs.readFileSync(dataFile(f.root,f.c)),db);assert.deepEqual(inventory(f.backup),saved);assert(!fs.existsSync(path.join(f.root,'operations-recovery')));
 }
 // This separately compiled new launcher trusts the existing OLD fixture's PUBLIC
 // key. The old signed bundle is copied intact, never relabelled or re-signed.
 const old=setup(legacy,'legacy'),launcher=path.join(outer,'new-launcher-old-public-trust');
 const compile=spawnSync(process.execPath,['build','src/delivery/entry.ts','--compile','--no-compile-autoload-dotenv','--no-compile-autoload-bunfig','--no-compile-autoload-tsconfig','--no-compile-autoload-package-json','--define',`QOOPIA_PINNED_KEY=${JSON.stringify(old.trust)}`,'--define',`QOOPIA_BUILD_SHA=${JSON.stringify('a'.repeat(40))}`,'--outfile',launcher],{env,encoding:'utf8',timeout:120000});assert.equal(compile.status,0,compile.stderr);
 commands.push({operation:'compile-new-launcher-with-old-fixture-public-trust',exit_code:compile.status});
 const oldPointer=fs.readFileSync(path.join(old.root,'current.json')),oldDb=fs.readFileSync(dataFile(old.root,old.c));
 for(const journal of ['damaged',JSON.stringify({format:'qoopia-ops/1',last_run:null,alerts:[],delivery_hold:RECOVERY_DELIVERY_HOLD})]){
  durableWrite(old.file,journal);
  for(const args of [['recover-ops','--backup',old.backup],['recover-ops','--backup',old.backup,'--commit','--confirm-recovery','0'.repeat(64)],['authorize-ops-replay'],['authorize-ops-replay','--commit','--confirm-replay','0'.repeat(64)]])assert(invoke(launcher,[...args,'--root',old.root,'--allow-test-fixture'],1).stderr.includes('OPS_BUNDLE_INCOMPATIBLE'));
  assert.equal(fs.readFileSync(old.file,'utf8'),journal);assert.deepEqual(fs.readFileSync(path.join(old.root,'current.json')),oldPointer);assert.deepEqual(fs.readFileSync(dataFile(old.root,old.c)),oldDb);assert(!fs.existsSync(path.join(old.root,'operations-recovery')));
 }
 assert.equal(readCurrent(old.root).bundle,old.c.bundle);
 console.log(JSON.stringify({ok:true,fixture_only:true,no_services_or_network:true,old_binary_not_modified:true,commands},null,2));
}finally{fs.rmSync(outer,{recursive:true,force:true});}
