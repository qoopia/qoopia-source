#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { lockInstallation } from '../src/delivery/operations.ts';

const argv=process.argv.slice(2),value=(name:string)=>argv[argv.indexOf(name)+1];
const bundle=value('--bundle'),root=value('--root');
if(!bundle||!root||!path.isAbsolute(bundle)||!path.isAbsolute(root))throw new Error('--bundle and --root must be absolute');
if(fs.existsSync(root))throw new Error('--root must be new');
const sha=(input:Buffer|string)=>createHash('sha256').update(input).digest('hex');
const launcher=path.join(bundle,'qoopia'),manifestFile=path.join(bundle,'manifest.json'),outer=path.dirname(root);
const env={PATH:'/usr/bin:/bin',HOME:outer,TMPDIR:outer,XDG_CONFIG_HOME:outer,XDG_CACHE_HOME:outer,XDG_DATA_HOME:outer};
const commands:Array<{operation:string;exit_code:number}>=[];
const run=(operation:string,args:string[],expected=0)=>{
  const result=spawnSync(args[0]!,args.slice(1),{encoding:'utf8',env});commands.push({operation,exit_code:result.status??1});
  assert.equal(result.status,expected,`${operation}: ${result.stderr}`);return result;
};
const json=(result:ReturnType<typeof run>)=>JSON.parse(result.stdout.trim());
const install=json(run('install',[launcher,'install','--root',root,'--bundle',bundle,'--commit','--allow-test-fixture']));
const pointerFile=path.join(root,'current.json'),current=JSON.parse(fs.readFileSync(pointerFile,'utf8'));
const installedBinary=path.join(root,'bundles',current.bundle,'qoopia');
assert.equal(sha(fs.readFileSync(installedBinary)),sha(fs.readFileSync(launcher)));
const writeNote=(selected:any,id:string,text:string)=>{
  const db=new Database(path.join(root,'generations',selected.generation,'data','qoopia.db'));
  try{
    let owner=db.query('SELECT id,workspace_id FROM agents LIMIT 1').get() as {id:string;workspace_id:string}|null;
    if(!owner){const made=bootstrapOwner(db,'T24 compiled fixture','T24 compiled fixture');owner={id:made.agent_id,workspace_id:made.workspace_id};}
    db.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,metadata,updated_at) VALUES (?,?,?,'memory',?,'{}',?)").run(id,owner.workspace_id,owner.id,text,new Date().toISOString());
  }finally{db.close();}
};
writeNote(current,'t24-a','A before preview');
const preview=json(run('preview',[installedBinary,'update','--root',root,'--bundle',bundle,'--allow-test-fixture']));
assert.equal(preview.format,'qoopia-update-plan/1');
const planFile=path.join(outer,'t24-plan.json');fs.writeFileSync(planFile,JSON.stringify(preview),{mode:0o600});
run('wrong-confirmation',[installedBinary,'update','--root',root,'--bundle',bundle,'--plan',planFile,'--approve','0'.repeat(64),'--commit','--allow-test-fixture'],1);
const wrong={...preview,target:{...preview.target,bundle_digest:'f'.repeat(64)}};delete wrong.plan_digest;wrong.plan_digest=sha(JSON.stringify(wrong));
const wrongFile=path.join(outer,'t24-wrong-bundle-plan.json');fs.writeFileSync(wrongFile,JSON.stringify(wrong),{mode:0o600});
run('wrong-bundle-plan',[installedBinary,'update','--root',root,'--bundle',bundle,'--plan',wrongFile,'--approve',wrong.plan_digest,'--commit','--allow-test-fixture'],1);
const release=lockInstallation(root);try{run('lock-busy',[installedBinary,'update','--root',root,'--bundle',bundle,'--plan',planFile,'--approve',preview.plan_digest,'--commit','--allow-test-fixture'],1);}finally{release();}
writeNote(current,'t24-b','B after preview before barrier');
const oldDb=path.join(root,'generations',current.generation,'data','qoopia.db'),oldAtBarrier=sha(fs.readFileSync(oldDb));
const updated=json(run('commit',[installedBinary,'update','--root',root,'--bundle',bundle,'--plan',planFile,'--approve',preview.plan_digest,'--commit','--allow-test-fixture']));
assert.equal(updated.update_report.source_writes_caught_up,true);
assert.equal(updated.update_report.barrier_sequence,1);
assert.equal(updated.update_report.barrier_sequence_semantics,'local_cutover_event_ordinal_not_source_audit_sequence');
assert.deepEqual(updated.update_report.timeline.map((event:any)=>event.stage),['preview','writer_barrier','final_snapshot','target_staged','atomic_pointer']);
let targetDb=new Database(path.join(root,'generations',updated.generation,'data','qoopia.db'),{readonly:true});
try{assert.deepEqual((targetDb.query("SELECT id FROM notes WHERE id IN ('t24-a','t24-b') ORDER BY id").all() as {id:string}[]).map(row=>row.id),['t24-a','t24-b']);}finally{targetDb.close();}
const rolled=json(run('rollback-before-write',[installedBinary,'rollback','--root',root,'--commit','--allow-test-fixture']));assert.equal(rolled.generation,current.generation);
const preview2=json(run('preview-2',[installedBinary,'update','--root',root,'--bundle',bundle,'--allow-test-fixture']));
const planFile2=path.join(outer,'t24-plan-2.json');fs.writeFileSync(planFile2,JSON.stringify(preview2),{mode:0o600});
const updated2=json(run('commit-2',[installedBinary,'update','--root',root,'--bundle',bundle,'--plan',planFile2,'--approve',preview2.plan_digest,'--commit','--allow-test-fixture']));
writeNote(updated2,'t24-c','C after target selected');
run('rollback-after-write-refused',[installedBinary,'rollback','--root',root,'--commit','--allow-test-fixture'],1);
run('stale-generation-plan',[installedBinary,'update','--root',root,'--bundle',bundle,'--plan',planFile,'--approve',preview.plan_digest,'--commit','--allow-test-fixture'],1);
const selected=JSON.parse(fs.readFileSync(pointerFile,'utf8'));
assert.equal(selected.generation,updated2.generation);assert.equal(sha(fs.readFileSync(oldDb)),oldAtBarrier);
console.log(JSON.stringify({status:'PASS_LOCAL_T24_UPDATE_BARRIER',scope:'local managed installation only; not external Qoopia32/35/Skillonomia19 cutover qualification',candidate:{binary_sha256:sha(fs.readFileSync(launcher)),manifest_sha256:sha(fs.readFileSync(manifestFile)),installed_binary_sha256:sha(fs.readFileSync(installedBinary))},installation:{instance:install.instance,source_generation:current.generation,selected_writer_generation:selected.generation},snapshot:{s0:preview.source.logical_hash,s1:updated.update_report.barrier_source_hash,source_writes_caught_up:updated.update_report.source_writes_caught_up},barrier:{barrier_sequence:1,semantics:updated.update_report.barrier_sequence_semantics,source_audit_sequence:'NOT_AVAILABLE_AND_NOT_CLAIMED'},timeline:updated.update_report.timeline,rollback:{before_target_write:'selected_previous_generation',after_target_write:'REFUSED_PRESERVED_TARGET'},old_generation_changed_after_barrier:false,commands}));
