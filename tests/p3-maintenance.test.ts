import { expect,test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { env } from '../src/utils/env.ts';
import { runMaintenance } from '../src/services/retention.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { verifyBackup } from '../src/delivery/snapshot.ts';
import { reviseDraft } from '../src/skills/authority.ts';
import { digest } from '../src/skills/commands.ts';
import { listNotes } from '../src/services/notes.ts';
import { completeContent,principalAuth } from './helpers/p1-fixtures.ts';

// Tests the actual scheduled callback, not an independent imitation of retention.
test('P3 maintenance really expires traces, keeps durable feedback and reports verified backup',()=>{
 runMigrations();db.query("INSERT INTO workspaces(id,name,slug) VALUES ('p3-retention-workspace','Retention fixture','p3-retention-fixture')").run();
 const owner=bootstrapOwner(db,'Maintenance fixture',undefined,'p3-retention-workspace');
 db.query("INSERT INTO notes(id,workspace_id,agent_id,type,text) VALUES ('p3-feedback-note',?,?,'memory','retained feedback fixture')").run(owner.workspace_id,owner.agent_id);
 db.query(`INSERT INTO recall_traces(id,workspace_id,caller_agent_id,query_hash,mode,pipeline_version,duration_ms,result_count,expires_at)
 VALUES ('p3-trace',?,?,?,'normal','v4',1,1,'2000-01-01T00:00:00.000Z')`).run(owner.workspace_id,owner.agent_id,'a'.repeat(64));
 db.query(`INSERT INTO recall_feedback(id,workspace_id,note_id,trace_id,actor_agent_id,feedback,idempotency_key)
 VALUES ('p3-feedback',?,'p3-feedback-note','p3-trace',?,'helpful','p3-feedback-key')`).run(owner.workspace_id,owner.agent_id);
 const result=runMaintenance();expect(result.ok).toBe(true);expect((result.report.recall_trace_expiry as {deleted_traces:number}).deleted_traces).toBeGreaterThan(0);
 expect(db.query("SELECT trace_id FROM recall_feedback WHERE id='p3-feedback'").get()).toEqual({trace_id:null});
 expect(db.query("SELECT 1 FROM recall_traces WHERE id='p3-trace'").get()).toBeNull();expect(result.report.backup).toMatchObject({verified:true,schema:47});
 const backups=fs.readdirSync(env.BACKUP_DIR).filter(n=>n.startsWith('qoopia-'));expect(backups.length).toBeGreaterThan(0);
 for(const name of backups){const folder=path.join(env.BACKUP_DIR,name);expect(fs.statSync(folder).mode&0o777).toBe(0o700);expect(verifyBackup(folder).schema).toBe(47);expect(fs.statSync(path.join(folder,'snapshot.db')).mode&0o777).toBe(0o600);}
});

test('P3 task purge keeps only observable tombstones for immutable skill sources',()=>{
 runMigrations();
 db.query("INSERT INTO workspaces(id,name,slug) VALUES ('p3-tombstone-workspace','Tombstone fixture','p3-tombstone-fixture')").run();
 const owner=bootstrapOwner(db,'Tombstone fixture',undefined,'p3-tombstone-workspace'),auth=principalAuth(db,owner.agent_id);
 db.query(`INSERT INTO notes(id,workspace_id,agent_id,type,text,metadata,updated_at)
  VALUES ('p3-old-task',?,?,'task','closed private task','{"status":"done"}','2000-01-01T00:00:00Z')`).run(owner.workspace_id,owner.agent_id);
 for(const [id,text] of [['p3-referenced-note','REFERENCED_NOTE_PRIVATE_CANARY'],['p3-unreferenced-note','UNREFERENCED_NOTE_PRIVATE_CANARY']])
  db.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,metadata,tags,task_bound_id) VALUES (?,?,?,'memory',?,'{\"private\":\"note metadata canary\"}','[\"private-tag\"]','p3-old-task')").run(id,owner.workspace_id,owner.agent_id,text);
 reviseDraft(auth,{slug:'p3-tombstone-skill',expected_revision:0,content:completeContent,
  source_refs:[{kind:'note',id:'p3-referenced-note',digest:digest('REFERENCED_NOTE_PRIVATE_CANARY')}],idempotency_key:'p3-tombstone-draft'},db);

 for(const id of ['p3-capture-session','p3-loadout-session','p3-unreferenced-session']){
  db.query("INSERT INTO sessions(id,workspace_id,agent_id,title,metadata,task_bound_id) VALUES (?,?,?,'PRIVATE SESSION TITLE','{\"private\":\"session metadata canary\"}','p3-old-task')").run(id,owner.workspace_id,owner.agent_id);
  db.query("INSERT INTO session_messages(workspace_id,session_id,agent_id,role,content) VALUES (?,?,?,'user','SESSION_MESSAGE_PRIVATE_CANARY')").run(owner.workspace_id,id,owner.agent_id);
  db.query("INSERT INTO summaries(id,workspace_id,session_id,agent_id,content,msg_start_id,msg_end_id) VALUES (?,?,?,?, 'SUMMARY_PRIVATE_CANARY',1,1)").run(`summary-${id}`,owner.workspace_id,id,owner.agent_id);
 }
 const origin=(db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id,now=Date.now();
 db.query(`INSERT INTO skill_captures(id,workspace_id,actor_id,origin_instance_id,created_at_ms,source_kind,source_digest,source_refs,redaction_report,outcome)
  VALUES ('p3-session-capture',?,?,?,?, 'session',?,?,'[]','drafted')`).run(owner.workspace_id,owner.agent_id,origin,now,digest('capture'),JSON.stringify({source_id:'p3-capture-session',first:1,last:1}));
 db.query(`INSERT INTO runtime_registrations(id,workspace_id,actor_id,origin_instance_id,created_at_ms,updated_at_ms,target_agent_id,runtime_id,runtime_kind,runtime_version,platform,capabilities_json)
  VALUES ('p3-runtime',?,?,?,?,?,?, 'p3-runtime-native','codex','fixture','darwin-arm64','{}')`).run(owner.workspace_id,owner.agent_id,origin,now,now,owner.agent_id);
 db.query(`INSERT INTO session_loadouts(id,workspace_id,actor_id,origin_instance_id,created_at_ms,runtime_id,native_session_ref,qoopia_session_id,runtime_kind,runtime_version,capabilities_digest,policy_snapshot_digest,snapshot_digest)
  VALUES ('p3-loadout',?,?,?,?, 'p3-runtime','native-session','p3-loadout-session','codex','fixture',?,?,?)`).run(owner.workspace_id,owner.agent_id,origin,now,digest('capabilities'),digest('policy'),digest('snapshot'));
 // A same-ID claim from another workspace must not retain this workspace's control session.
 db.query("INSERT INTO workspaces(id,name,slug) VALUES ('p3-other-workspace','Other fixture','p3-other-fixture')").run();
 const other=bootstrapOwner(db,'Other fixture',undefined,'p3-other-workspace');
 db.query(`INSERT INTO skill_captures(id,workspace_id,actor_id,origin_instance_id,created_at_ms,source_kind,source_digest,source_refs,redaction_report,outcome)
  VALUES ('p3-cross-workspace-capture',?,?,?,?, 'session',?,?,'[]','refused')`).run(other.workspace_id,other.agent_id,origin,now,digest('cross'),JSON.stringify({source_id:'p3-unreferenced-session',first:1,last:1}));

 const revisionBefore=db.query("SELECT source_refs,source_digest FROM skill_draft_revisions WHERE source_digest IS NOT NULL AND workspace_id=?").get(owner.workspace_id);
 const captureBefore=db.query("SELECT source_refs,source_digest FROM skill_captures WHERE id='p3-session-capture'").get();
 const loadoutBefore=db.query("SELECT * FROM session_loadouts WHERE id='p3-loadout'").get();
 const result=runMaintenance();expect(result.ok).toBe(true);

 expect(result.report).toMatchObject({notes_purged:1,notes_tombstoned:1,sessions_purged:1,sessions_tombstoned:2,messages_purged:3});
 expect(db.query("SELECT source_refs,source_digest FROM skill_draft_revisions WHERE source_digest IS NOT NULL AND workspace_id=?").get(owner.workspace_id)).toEqual(revisionBefore);
 expect(db.query("SELECT source_refs,source_digest FROM skill_captures WHERE id='p3-session-capture'").get()).toEqual(captureBefore);
 expect(db.query("SELECT * FROM session_loadouts WHERE id='p3-loadout'").get()).toEqual(loadoutBefore);
 expect(listNotes({workspace_id:owner.workspace_id,caller_agent_id:owner.agent_id,is_admin:true}).items.some(n=>n.id==='p3-referenced-note')).toBe(false);
 const deleted=listNotes({workspace_id:owner.workspace_id,caller_agent_id:owner.agent_id,is_admin:true,include_deleted:true}).items.find(n=>n.id==='p3-referenced-note');
 expect(deleted).toMatchObject({text:'',metadata:{source_deleted:true},tags:[],project_id:null,session_id:null,task_bound_id:null});
 expect(db.query("SELECT 1 FROM notes_fts WHERE notes_fts MATCH 'REFERENCED_NOTE_PRIVATE_CANARY'").get()).toBeNull();
 expect(db.query("SELECT 1 FROM notes WHERE id='p3-unreferenced-note'").get()).toBeNull();
 for(const id of ['p3-capture-session','p3-loadout-session']){
  expect(db.query("SELECT title,metadata,task_bound_id FROM sessions WHERE id=?").get(id)).toEqual({title:null,metadata:'{"source_deleted":true}',task_bound_id:null});
  expect(db.query("SELECT 1 FROM session_messages WHERE session_id=?").get(id)).toBeNull();
  expect(db.query("SELECT 1 FROM summaries WHERE session_id=?").get(id)).toBeNull();
 }
 expect(db.query("SELECT 1 FROM sessions WHERE id='p3-unreferenced-session'").get()).toBeNull();
});

test('P3 backup failure returns maintenance failure and preserves previous snapshots',()=>{
 const before=fs.readdirSync(env.BACKUP_DIR),original=env.BACKUP_DIR;
 const blocked=path.join(env.DATA_DIR,'not-a-directory');fs.writeFileSync(blocked,'synthetic blocker');
 try{env.BACKUP_DIR=blocked;expect(runMaintenance().ok).toBe(false);}finally{env.BACKUP_DIR=original;fs.unlinkSync(blocked);}
 expect(fs.readdirSync(env.BACKUP_DIR)).toEqual(before);
});

test('actual maintenance scheduler runs shared operational callback once, persists failure/recovery and stops',async()=>{
 const {startMaintenance,stopMaintenance}=await import('../src/services/retention.ts');
 const {readOps}=await import('../src/delivery/ops-state.ts');
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;
 const callbacks:Array<()=>unknown>=[];
 try{
  globalThis.setTimeout=((callback:()=>unknown,delay:number)=>{if(!callbacks.length)expect(delay).toBeGreaterThanOrEqual(300000);else expect(delay).toBeGreaterThan(0);callbacks.push(callback);return {unref(){}};}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{}) as typeof clearTimeout;
  startMaintenance();startMaintenance();expect(callbacks).toHaveLength(1);
  const backup=env.BACKUP_DIR,blocked=path.join(env.DATA_DIR,'scheduler-blocker');fs.writeFileSync(blocked,'fixture');
  try{env.BACKUP_DIR=blocked;await callbacks[0]!();}finally{env.BACKUP_DIR=backup;fs.unlinkSync(blocked);}
  expect(readOps(env.DATA_DIR).last_run?.ok).toBe(false);expect(readOps(env.DATA_DIR).alerts.some(a=>a.active&&a.state==='pending')).toBe(true);
  expect(callbacks).toHaveLength(2);await callbacks[1]!();expect(readOps(env.DATA_DIR).last_run?.ok).toBe(true);
  expect(readOps(env.DATA_DIR).alerts.some(a=>!a.active&&a.state==='pending')).toBe(true);
  stopMaintenance();const count=callbacks.length;await callbacks.at(-1)!();expect(callbacks.length).toBe(count);
 }finally{stopMaintenance();globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
});

test('round1 scheduled recovery preserves corrupt content and completes status after rotation',async()=>{
 runMigrations();
 const os=await import('node:os');
 const {backupUnified}=await import('../src/delivery/snapshot.ts');
 const {recordMaintenance,readOps,writeOps,compactOps}=await import('../src/delivery/ops-state.ts');
 const {retentionAlert,retentionState}=await import('./helpers/p3-retention-fixtures.ts');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-recovery-rotation-')));
 const original={backup:env.BACKUP_DIR,ops:env.OPS_STATE_DIR};
 try{
  env.BACKUP_DIR=path.join(root,'backups');env.OPS_STATE_DIR=path.join(root,'operations');
  const instance=(db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  recordMaintenance(env.OPS_STATE_DIR,instance,'BACKUP_FAILED',1000);recordMaintenance(env.OPS_STATE_DIR,instance,null,1001);
  writeOps(env.OPS_STATE_DIR,{...readOps(env.OPS_STATE_DIR),receipts:compactOps(retentionState([retentionAlert(99999,true,instance)])).receipts});
  const state=readOps(env.OPS_STATE_DIR);
  const old=path.join(env.BACKUP_DIR,'qoopia-2000-01-01T00-00-00-000Z.backup');
  const held=path.join(env.BACKUP_DIR,'qoopia-2000-01-01T01-00-00-000Z.backup');
  const unknown=path.join(env.BACKUP_DIR,'qoopia-2000-01-01T00-30-00-000Z.backup');
  for(const folder of [old,held,unknown])backupUnified(path.join(env.DATA_DIR,'qoopia.db'),folder,instance,env.OPS_STATE_DIR);
  fs.writeFileSync(path.join(unknown,'manual.txt'),'preserve unknown member');
  const corrupt=path.join(env.BACKUP_DIR,'qoopia-2000-01-01T00-15-00-000Z.backup');
  backupUnified(path.join(env.DATA_DIR,'qoopia.db'),corrupt,instance,env.OPS_STATE_DIR);
  const damaged=path.join(corrupt,'snapshot.db'),bytes=fs.readFileSync(damaged);bytes[100]=bytes[100]!^0xff;fs.writeFileSync(damaged,bytes);
  const preserved=fs.readdirSync(corrupt).map(name=>({name,bytes:fs.readFileSync(path.join(corrupt,name))}));
  const result=runMaintenance();expect(result.ok).toBe(true);
  expect(readOps(env.OPS_STATE_DIR).last_run?.ok).toBe(true);expect(readOps(env.OPS_STATE_DIR).receipts).toEqual(state.receipts);expect(result.report.backups_deleted).toBe(1);
  for(const item of preserved)expect(fs.readFileSync(path.join(corrupt,item.name))).toEqual(item.bytes);
  expect(fs.existsSync(old)).toBe(false);expect(fs.existsSync(held)).toBe(true);expect(fs.readFileSync(path.join(unknown,'manual.txt'),'utf8')).toBe('preserve unknown member');
  const latest=fs.readdirSync(env.BACKUP_DIR).filter(n=>!n.includes('2000-01-01')).map(n=>path.join(env.BACKUP_DIR,n));expect(latest).toHaveLength(1);
  expect(verifyBackup(latest[0]!,instance).format).toBe('qoopia-backup/2');expect(readOps(latest[0]!)).toEqual(state);
 }finally{env.BACKUP_DIR=original.backup;env.OPS_STATE_DIR=original.ops;fs.rmSync(root,{recursive:true,force:true});}
});
