import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Delivery, dataFile, readCurrent, operationsDirectory } from '../src/delivery/operations.ts';
import { durableWrite, hash, inventory } from '../src/delivery/files.ts';
import { recordMaintenance, readOps, opsFile, RECOVERY_DELIVERY_HOLD } from '../src/delivery/ops-state.ts';
import { verifyBundle } from '../src/delivery/bundle.ts';

const bundle=path.resolve(process.argv[process.argv.indexOf('--bundle')+1]!);
const trust=fs.readFileSync(path.join(bundle,'TEST-PUBLIC-KEY.pem'),'utf8');
verifyBundle(bundle,trust,true);
const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-recovery-cli-'))),root=path.join(outer,'Owner Ж space');
const events:unknown[]=[];
const run=(args:string[],expected=0)=>{
 const result=spawnSync(path.join(bundle,'qoopia'),args,{cwd:outer,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:outer,TMPDIR:outer},timeout:90000});
 events.push({argv:args,exit_code:result.status,stdout_sha256:hash(result.stdout??''),stderr:result.stderr});
 assert.equal(result.status,expected,JSON.stringify({args,stderr:result.stderr}));
 return expected===0?JSON.parse(result.stdout):result.stderr;
};
const command=(name:string,...args:string[])=>[name,'--root',root,'--allow-test-fixture',...args];
try{
 const d=new Delivery(root,trust,true,(b,g)=>{const result=spawnSync(path.join(b,'qoopia'),['_migrate','--root',g],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:outer,TMPDIR:outer},timeout:90000});assert.equal(result.status,0,result.stderr);});
 const installed=d.install(bundle,43737); // engine install avoids socket/OS-user qualification
 recordMaintenance(operationsDirectory(root,installed),installed.instance,'BACKUP_FAILED',1000);
 const backup=path.join(outer,'verified-backup');run(command('backup','--out',backup,'--commit'));
 // Exercise a pointer-selected generation, not only the legacy journal path.
 run(command('restore','--backup',backup,'--commit'));
 const selected=readCurrent(root),original=opsFile(operationsDirectory(root,selected)),db=dataFile(root,selected);
 const saved=readOps(operationsDirectory(root,selected));
 const damage=Buffer.from('private fixture corrupt newer receipts');durableWrite(original,damage);
 const before={pointer:fs.readFileSync(path.join(root,'current.json')),db:fs.readFileSync(db),backup:inventory(backup)};
 // A valid private channel policy exists before recovery. Address is intentionally non-routable
 // by the shared SSRF guard, so even a failed hold assertion cannot contact a real receiver.
 const policy=JSON.stringify({format:'qoopia-alert-channels/1',channels:[{id:'disposable-only',url:'https://127.0.0.1/alerts',allowed_hosts:['127.0.0.1'],signing_key_base64url:Buffer.alloc(32,17).toString('base64url')}]});
 durableWrite(path.join(root,'ops-channels.json'),policy);
 const preview=run(command('recover-ops','--backup',backup));assert.equal(preview.instance,selected.instance);assert(preview.warning.includes('may be lost'));
 assert.deepEqual(fs.readFileSync(path.join(root,'current.json')),before.pointer);
 assert(run(command('recover-ops','--backup',backup,'--commit'),1).includes('confirm-recovery'));
 assert(run(command('recover-ops','--backup',backup,'--commit','--confirm-recovery','0'.repeat(64)),1).includes('RECOVERY_CONFIRMATION_STALE'));
 assert(run(command('restore','--backup',backup,'--commit'),1).includes('OPS_JOURNAL_INVALID'));
 const recovered=run(command('recover-ops','--backup',backup,'--commit','--confirm-recovery',preview.confirmation));
 assert.deepEqual(fs.readFileSync(db),before.db);assert.deepEqual(inventory(backup),before.backup);assert.deepEqual(fs.readFileSync(original),damage);
 assert.deepEqual(fs.readFileSync(path.join(recovered.preserved,'damaged-operations-status.bin')),damage);
 assert.deepEqual(readOps(operationsDirectory(root,recovered.current)),{...saved,delivery_hold:RECOVERY_DELIVERY_HOLD});
 assert.equal(recovered.current.generation,selected.generation);assert.equal(recovered.history_merged,false);
 const maintenance=run(command('maintenance','--commit'));assert.equal(maintenance.report.operations.delivery_hold,RECOVERY_DELIVERY_HOLD);
 assert.equal(readOps(operationsDirectory(root,readCurrent(root))).alerts[0]!.attempts,0);
 assert.equal(fs.readFileSync(path.join(root,'ops-channels.json'),'utf8'),policy);
 // Doctor's real CLI projection reports a fail/hold without exposing private damaged content.
 const doctor=spawnSync(path.join(bundle,'qoopia'),command('doctor'),{cwd:outer,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:outer,TMPDIR:outer}});
 events.push({argv:command('doctor'),exit_code:doctor.status,stdout_sha256:hash(doctor.stdout),stderr:doctor.stderr});
 assert.equal(doctor.status,1);assert.equal(JSON.parse(doctor.stdout).checks.maintenance.reason,RECOVERY_DELIVERY_HOLD);assert(!doctor.stdout.includes(damage.toString()));
 run(command('update','--bundle',bundle,'--commit'));run(command('rollback','--commit'));
 assert.equal(readOps(operationsDirectory(root,readCurrent(root))).delivery_hold,RECOVERY_DELIVERY_HOLD);
 const held=path.join(outer,'held-backup');run(command('backup','--out',held,'--commit'));
 const other=new Delivery(path.join(outer,'new machine fixture'),trust,true,()=>{}).restoreNew(held,bundle,43738);
 assert.equal(readOps(operationsDirectory(path.join(outer,'new machine fixture'),other.current)).delivery_hold,RECOVERY_DELIVERY_HOLD);
 const replay=run(command('authorize-ops-replay'));
 assert(run(command('authorize-ops-replay','--commit'),1).includes('confirm-replay'));
 assert(run(command('authorize-ops-replay','--commit','--confirm-replay',preview.confirmation),1).includes('REPLAY_CONFIRMATION_STALE'));
 const authorized=run(command('authorize-ops-replay','--commit','--confirm-replay',replay.confirmation));
 assert.equal(authorized.sends_performed,0);assert.equal(readOps(operationsDirectory(root,readCurrent(root))).alerts[0]!.attempts,0);
 assert.equal(readOps(operationsDirectory(root,readCurrent(root))).delivery_hold,undefined);
 assert.deepEqual(fs.readFileSync(original),damage);assert.deepEqual(inventory(backup),before.backup);
 console.log(JSON.stringify({ok:true,fixture_only:true,no_receiver_contact:true,commands:events},null,2));
}finally{fs.rmSync(outer,{recursive:true,force:true});}
