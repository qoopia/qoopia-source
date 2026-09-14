import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Delivery, readCurrent, operationsDirectory } from '../src/delivery/operations.ts';
import { exactPendingBoundary, retentionAlert, retentionState } from '../tests/helpers/p3-retention-fixtures.ts';
import { compactOps, writeOps, readOps, opsFile, RECOVERY_DELIVERY_HOLD } from '../src/delivery/ops-state.ts';
import { verifyBundle } from '../src/delivery/bundle.ts';
import { hash, durableWrite, inventory, MAX_JSON_BYTES } from '../src/delivery/files.ts';
const bundle=path.resolve(process.argv[process.argv.indexOf('--bundle')+1]!);
const trust=fs.readFileSync(path.join(bundle,'TEST-PUBLIC-KEY.pem'),'utf8');verifyBundle(bundle,trust,true);
const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-retention-cli-'))),root=path.join(outer,'fixture installation');
const commands:unknown[]=[];
const invoke=(args:string[],expected=0)=>{
 const child=spawnSync(path.join(bundle,'qoopia'),args,{cwd:outer,env:{PATH:'/usr/bin:/bin',HOME:outer,TMPDIR:outer},encoding:'utf8',timeout:120000});
 commands.push({argv:args,exit_code:child.status,stdout_sha256:hash(child.stdout??''),stderr:child.stderr});assert.equal(child.status,expected,child.stderr);return child;
};
const command=(name:string,...args:string[])=>[name,'--root',root,'--allow-test-fixture',...args];
try{
 const d=new Delivery(root,trust,true,(_b,g)=>{invoke(['_migrate','--root',g]);}),c=d.install(bundle,43737),ops=operationsDirectory(root,c);
 const pending=retentionState([retentionAlert(1,false,c.instance)]);writeOps(ops,pending);
 const backup=path.join(outer,'old-pending');invoke(command('backup','--out',backup,'--commit'));
 // The real compiled maintenance command crosses the exact boundary and compacts.
 const boundary=exactPendingBoundary(0,true,c.instance);writeOps(ops,boundary);assert.equal(fs.statSync(opsFile(ops)).size,MAX_JSON_BYTES);
 const maintained=JSON.parse(invoke(command('maintenance','--commit')).stdout);assert.equal(maintained.report.operations.compact_receipts,boundary.alerts.length);assert.equal(readOps(ops).alerts.length,0);
 const local=fs.readFileSync(opsFile(ops)),saved=inventory(backup);
 invoke(command('restore','--backup',backup,'--commit'));
 const current=readCurrent(root),selected=operationsDirectory(root,current);assert.equal(readOps(selected).receipts?.length,boundary.alerts.length);assert.deepEqual(readOps(selected).alerts,[]);
 assert.deepEqual(fs.readFileSync(opsFile(ops)),local);assert.deepEqual(inventory(backup),saved);
 // Engine new-machine restore avoids the socket gate; subsequent CLI dispatch is real.
 const otherRoot=path.join(outer,'new machine'),other=new Delivery(otherRoot,trust,true,()=>{});const restored=other.restoreNew(backup,bundle,43738);
 const heldDir=operationsDirectory(otherRoot,restored.current);assert.equal(readOps(heldDir).delivery_hold,RECOVERY_DELIVERY_HOLD);
 // A strictly private disposable policy exists, but the hold prevents any attempt.
 durableWrite(path.join(otherRoot,'ops-channels.json'),JSON.stringify({format:'qoopia-alert-channels/1',channels:[{id:'fixture',url:'https://127.0.0.1/alerts',allowed_hosts:['127.0.0.1'],signing_key_base64url:Buffer.alloc(32,17).toString('base64url')}]}));
 const otherCommand=(name:string,...args:string[])=>[name,'--root',otherRoot,'--allow-test-fixture',...args];
 invoke(otherCommand('maintenance','--commit'));assert.equal(readOps(heldDir).alerts[0]!.attempts,0);
 invoke(otherCommand('restore','--backup',backup,'--commit'));const heldCurrent=operationsDirectory(otherRoot,readCurrent(otherRoot));assert.equal(readOps(heldCurrent).delivery_hold,RECOVERY_DELIVERY_HOLD);
 const doctor=JSON.parse(invoke(otherCommand('doctor'),1).stdout);assert.equal(doctor.checks.maintenance.reason,RECOVERY_DELIVERY_HOLD);
 const preview=JSON.parse(invoke(otherCommand('authorize-ops-replay')).stdout);const authorized=JSON.parse(invoke(otherCommand('authorize-ops-replay','--commit','--confirm-replay',preview.confirmation)).stdout);
 assert.equal(authorized.sends_performed,0);assert.equal(readOps(operationsDirectory(otherRoot,authorized.current)).alerts[0]!.attempts,0);
 // No post-authorization maintenance/delivery call; no real receiver is ever contacted.
 const conflicting=retentionState([{...retentionAlert(1,false,c.instance),cause:'DATABASE_FAILED'}]);writeOps(selected,compactOps(retentionState([retentionAlert(1,true,c.instance)])));
 const conflictPath=path.join(outer,'conflict');
 // Capture a valid manifest using the same engine; payload mismatch is detected by restore union.
 writeOps(selected,conflicting);d.backup(conflictPath);writeOps(selected,compactOps(retentionState([retentionAlert(1,true,c.instance)])));
 const pointer=fs.readFileSync(path.join(root,'current.json')),before=fs.readFileSync(opsFile(selected));
 assert(invoke(command('restore','--backup',conflictPath,'--commit'),1).stderr.includes('event conflict'));
 assert.deepEqual(fs.readFileSync(path.join(root,'current.json')),pointer);assert.deepEqual(fs.readFileSync(opsFile(selected)),before);
 console.log(JSON.stringify({ok:true,fixture_only:true,no_receiver_contact:true,new_machine_engine_socket_gate_deferred:true,boundary_events:boundary.alerts.length,commands},null,2));
}finally{fs.rmSync(outer,{recursive:true,force:true});}
