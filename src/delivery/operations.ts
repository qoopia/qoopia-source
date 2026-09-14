import { inspectManagedLogs, previewManagedEvents } from '../utils/managed-logs.ts';
import { inspectDoctorDatabase, inspectScheduledBackups, type Check } from './doctor-checks.ts';
import { opsSummary, readRecoveryOps, mergeRecoveryOps, writeOps, opsFile, validateRecoveryOps, OpsJournalError, RECOVERY_DELIVERY_HOLD, RECOVERY_WARNING, serializeOps, OPS_JOURNAL_FORMAT } from './ops-state.ts';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { verifyBundle, requireOpsJournalV3 } from './bundle.ts';
import { safePath, privateDirectory, readJson, readJsonBytes, durableWrite, durableCopyFile, inventory, copyInventory, hash, syncDirectory, preflightSpace, MAX_JSON_BYTES } from './files.ts';
import { backupUnified, verifyBackup, snapshotInfo, invalidateRestoredAccess, backupOperations, snapshotExtent } from './snapshot.ts';
import { disabledAutostart, type AutostartLifecycle } from './autostart.ts';
const hex=z.string().regex(/^[a-f0-9]{64}$/),generationId=z.string().regex(/^generation-[a-f0-9-]{36}$/);
const updatePlanBody=z.object({format:z.literal('qoopia-update-plan/1'),created_at:z.string().datetime(),source:z.object({generation:generationId,bundle:hex,instance:z.string().min(1).max(200),schema:z.number().int(),logical_hash:hex}).strict(),target:z.object({bundle_digest:hex,build_sha:z.string().regex(/^[a-f0-9]{40}$/),source_digest:hex,schema_min:z.number().int(),schema_max:z.number().int()}).strict()}).strict();
const updatePlan=updatePlanBody.extend({plan_digest:hex}).strict();
export type UpdatePlan=z.infer<typeof updatePlan>;
const updateReport=z.object({format:z.literal('qoopia-update-cutover/1'),run_id:z.string().uuid(),plan_digest:hex,source_generation:generationId,source_plan_hash:hex,barrier_sequence:z.literal(1),barrier_sequence_semantics:z.literal('local_cutover_event_ordinal_not_source_audit_sequence'),barrier_source_hash:hex,source_writes_caught_up:z.boolean(),target_generation:generationId,target_hash:hex,timeline:z.array(z.object({stage:z.enum(['preview','writer_barrier','final_snapshot','target_staged','atomic_pointer']),at:z.string().datetime()}).strict()).length(5),rollback_disposition:z.literal('eligible_until_first_target_write; automatic_refusal_after_target_write'),key_recovery:z.object({public_trust_preserved:z.boolean(),private_keys:z.string(),registered_public_keys:z.number().int().nonnegative(),signing_continuity:z.string(),live_access:z.string()}).strict()}).strict();
export type UpdateReport=z.infer<typeof updateReport>;
export interface Current { format:'qoopia-installation/1'; generation:string; bundle:string; bundle_digest:string; instance:string; port:number; operations_generation?:string; previous?:Current; cutover_hash?:string; update_report?:UpdateReport; }
const generation = () => 'generation-' + randomUUID();
const pointer = z.object({format:z.literal('qoopia-installation/1'),generation:generationId,
 bundle:hex,bundle_digest:hex,instance:z.string().min(1).max(200),
 operations_generation:generationId.optional(),update_report:updateReport.optional(),
 port:z.number().int().min(1).max(65535),cutover_hash:hex.optional()});
export function readCurrent(root: string): Current {
 const c=pointer.extend({previous:pointer.strict().optional()}).strict().parse(readJson(path.join(root,'current.json')));
 if(c.bundle!==c.bundle_digest || (c.previous && (c.previous.bundle!==c.previous.bundle_digest || c.previous.instance!==c.instance)))throw new Error('Installation pointer invalid');
 if(c.operations_generation && !fs.existsSync(safePath(path.join(root,'operations',c.operations_generation,'operations-status.json'))))throw new Error('Selected operations journal missing');
 return c;
}
export const dataFile = (root:string,c:Current) => safePath(path.join(root,'generations',c.generation,'data','qoopia.db'));
export const operationsDirectory = (root:string,c:Current) => safePath(c.operations_generation
  ? path.join(root,'operations',c.operations_generation) : path.join(root,'operations'));
function deterministicSqliteCorruption(file:string) {
  let database:Database|undefined;
  try {
    database=new Database(file,{readonly:true});
    const rows=(database.query('PRAGMA integrity_check').all() as Array<{integrity_check:string}>).map(row=>row.integrity_check);
    return rows.length!==1 || rows[0]!=='ok';
  } catch(error) {
    const code=(error as {code?:unknown}).code;
    if(code==='SQLITE_CORRUPT'||code==='SQLITE_NOTADB')return true;
    throw error;
  } finally { database?.close(); }
}
/** Same OS-backed SQLite lock pattern as native projection coordinator. Held for the whole server lifetime or local operation. */
export function lockInstallation(root: string) {
  privateDirectory(root);
  const filename = safePath(path.join(root,'operations.sqlite'));
  const d = new Database(filename,{create:true}); fs.chmodSync(filename,0o600);
  try { d.run('PRAGMA busy_timeout=0'); d.run('CREATE TABLE IF NOT EXISTS lock_state(id INTEGER PRIMARY KEY)'); d.run('BEGIN IMMEDIATE'); }
  catch { d.close(); throw new Error('Installation is busy; stop the server/other owner operation first'); }
  return () => { try { d.run('ROLLBACK'); } finally { d.close(); } };
}
export type MigrationRunner = (bundle:string, generationRoot:string) => void;
export class Delivery {
  constructor(readonly root:string,readonly trust:string,readonly allowTest:boolean,readonly migrate:MigrationRunner,readonly fault?:(boundary:'preserved'|'staged'|'committed')=>void,
    readonly autostart:((installation:string)=>AutostartLifecycle)=()=>disabledAutostart) { safePath(root); }
  locked<T>(f:()=>T):T { const release=lockInstallation(this.root);try{return f();}finally{release();} }
  private commit(current:Current) {
    const file=dataFile(this.root,current),fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    syncDirectory(path.dirname(file));syncDirectory(path.dirname(path.dirname(file)));syncDirectory(path.join(this.root,'generations'));
    this.fault?.('staged');
    durableWrite(path.join(this.root,'current.json'),JSON.stringify(current));
    this.fault?.('committed');
  }
  private stageBundle(source:string) {
    const verified = verifyBundle(source,this.trust,this.allowTest), final = path.join(this.root,'bundles',verified.digest);
    if (!fs.existsSync(final)) {
      const stage=path.join(this.root,'bundles','stage-'+randomUUID());
      copyInventory(source,stage,inventory(source)); verifyBundle(stage,this.trust,this.allowTest);
      fs.renameSync(stage,final);syncDirectory(path.dirname(final));
    } else verifyBundle(final,this.trust,this.allowTest);
    return { ...verified, root:final };
  }
  install(bundle:string,port:number) {
    // Port is reserved by launcher BEFORE this method, with no initial data writes.
    if (fs.existsSync(path.join(this.root,'current.json'))) throw new Error('Already installed');
    if (fs.existsSync(this.root) && fs.readdirSync(this.root).length) throw new Error('Fresh installation requires an empty root');
    return this.locked(()=>{
      const b=this.stageBundle(bundle), id=generation(), dir=path.join(this.root,'generations',id);
      privateDirectory(dir); this.migrate(b.root,dir);
      const info=snapshotInfo(path.join(dir,'data','qoopia.db'));
      const c:Current={format:'qoopia-installation/1',generation:id,bundle:b.digest,bundle_digest:b.digest,instance:info.instance,port};
      this.commit(c); return c;
    });
  }
  backup(output:string) { return this.locked(()=>{const c=readCurrent(this.root);return backupUnified(dataFile(this.root,c),output,c.instance,operationsDirectory(this.root,c));}); }
  /** Exact local OS-owner preview binding, not a bearer credential or a new auth surface. */
  private journalSelection() {
    const current=readCurrent(this.root), file=opsFile(operationsDirectory(this.root,current));
    if(snapshotInfo(dataFile(this.root,current)).instance!==current.instance)throw new OpsJournalError('OPS_JOURNAL_INSTANCE_MISMATCH');
    const identity=()=>{
      const s=fs.lstatSync(safePath(file));
      if(!s.isFile() || s.nlink!==1 || s.uid!==process.getuid?.() || (s.mode&0o077))throw new Error('OPS_JOURNAL_UNSAFE');
      return {dev:s.dev,ino:s.ino,size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs};
    };
    const before=identity(), bytes=readJsonBytes(file), after=identity();
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('OPS_JOURNAL_CHANGED');
    const binding={root:safePath(this.root),instance:current.instance,pointer_sha256:hash(readJsonBytes(path.join(this.root,'current.json'))),
      journal:file,journal_sha256:hash(bytes),identity:after};
    return {current,bytes,binding};
  }
  private recoveryPlan(backup:string) {
    const selected=this.journalSelection();
    try {
      let value:unknown;
      try { value=JSON.parse(selected.bytes.toString('utf8')); } catch { throw new OpsJournalError('OPS_JOURNAL_INVALID'); }
      validateRecoveryOps(value,selected.current.instance);
      throw new Error('OPS_JOURNAL_NOT_DAMAGED');
    } catch(error) {
      // Unsupported versions, wrong instance, IO, unsafe/oversized input and healthy history are never reset here.
      if(!(error instanceof OpsJournalError) || error.code!=='OPS_JOURNAL_INVALID')throw error;
    }
    const candidate=safePath(backup), manifestFile=path.join(candidate,'manifest.json'), manifestBytes=readJsonBytes(manifestFile);
    const verified=verifyBackup(candidate,selected.current.instance), saved=backupOperations(candidate,verified);
    if(!saved)throw new Error('RECOVERY_REQUIRES_BACKUP_OPERATIONS');
    requireOpsJournalV3(verifyBundle(path.join(this.root,'bundles',selected.current.bundle),this.trust,this.allowTest));
    if(hash(readJsonBytes(manifestFile))!==hash(manifestBytes))throw new Error('RECOVERY_BACKUP_CHANGED');
    const binding={...selected.binding,backup:candidate,backup_manifest_sha256:hash(manifestBytes)};
    const preview={operation:'recover-ops',...binding,confirmation:hash(JSON.stringify({operation:'recover-ops',...binding})),
      warning:RECOVERY_WARNING,restored_pending:saved.alerts.filter(a=>a.state==='pending').length,delivery_hold:RECOVERY_DELIVERY_HOLD};
    return {...selected,saved,preview};
  }
  previewOpsRecovery(backup:string) { return this.locked(()=>this.recoveryPlan(backup).preview); }
  recoverOps(backup:string,confirmation?:string) {
    if(!confirmation)throw new Error('RECOVERY_CONFIRMATION_REQUIRED');
    return this.locked(()=>{
      const plan=this.recoveryPlan(backup);
      if(confirmation!==plan.preview.confirmation)throw new Error('RECOVERY_CONFIRMATION_STALE');
      const id=generation(), preserved=path.join(this.root,'operations-recovery',id);
      const heldBytes=serializeOps({...plan.saved,delivery_hold:RECOVERY_DELIVERY_HOLD});
      const preservationManifest=JSON.stringify({format:'qoopia-ops-recovery/1',...plan.preview,
        original_preserved:true,history_merged:false,database_restored:false,operations_generation:id});
      preflightSpace(this.root,[plan.bytes.length,Buffer.byteLength(heldBytes),Buffer.byteLength(preservationManifest),Buffer.byteLength(JSON.stringify({...plan.current,operations_generation:id}))]);
      privateDirectory(preserved);
      // Both the original path and a durable exact-byte archive survive every publication boundary.
      durableWrite(path.join(preserved,'damaged-operations-status.bin'),plan.bytes);
      if(hash(readJsonBytes(path.join(preserved,'damaged-operations-status.bin')))!==plan.binding.journal_sha256)throw new Error('RECOVERY_PRESERVATION_FAILED');
      durableWrite(path.join(preserved,'manifest.json'),preservationManifest);
      this.fault?.('preserved');
      const result:Current={...plan.current,operations_generation:id};
      writeOps(operationsDirectory(this.root,result),{...plan.saved,delivery_hold:RECOVERY_DELIVERY_HOLD});
      // A cooperating writer is excluded by the installation lock; detect drift before publishing.
      if(this.recoveryPlan(backup).preview.confirmation!==confirmation)throw new Error('RECOVERY_CONFIRMATION_STALE');
      this.commit(result);
      return {current:result,preserved,warning:RECOVERY_WARNING,history_merged:false,database_restored:false,delivery_hold:RECOVERY_DELIVERY_HOLD};
    });
  }
  private replayPlan() {
    const selected=this.journalSelection(), state=validateRecoveryOps(JSON.parse(selected.bytes.toString('utf8')),selected.current.instance);
    if(!state.delivery_hold)throw new Error('RECOVERY_DELIVERY_NOT_HELD');
    requireOpsJournalV3(verifyBundle(path.join(this.root,'bundles',selected.current.bundle),this.trust,this.allowTest));
    const preview={operation:'authorize-ops-replay',...selected.binding,
      confirmation:hash(JSON.stringify({operation:'authorize-ops-replay',...selected.binding})),warning:RECOVERY_WARNING,
      pending:state.alerts.filter(a=>a.state==='pending').length,
      effect:'Allow subsequent scheduled or explicit delivery through separately configured owner channels, including future alerts.'};
    return {...selected,state,preview};
  }
  previewOpsReplay() { return this.locked(()=>this.replayPlan().preview); }
  authorizeOpsReplay(confirmation?:string) {
    if(!confirmation)throw new Error('REPLAY_CONFIRMATION_REQUIRED');
    return this.locked(()=>{
      const plan=this.replayPlan();
      if(plan.preview.confirmation!==confirmation)throw new Error('REPLAY_CONFIRMATION_STALE');
      const id=generation(), result:Current={...plan.current,operations_generation:id};
      const state={...plan.state};delete state.delivery_hold;
      preflightSpace(this.root,[Buffer.byteLength(serializeOps(state)),Buffer.byteLength(JSON.stringify(plan.preview)),Buffer.byteLength(JSON.stringify(result))]);
      writeOps(operationsDirectory(this.root,result),state);
      durableWrite(path.join(operationsDirectory(this.root,result),'replay-authorization.json'),JSON.stringify(plan.preview));
      if(this.replayPlan().preview.confirmation!==confirmation)throw new Error('REPLAY_CONFIRMATION_STALE');
      this.commit(result);
      return {current:result,warning:RECOVERY_WARNING,delivery_authorized:true,sends_performed:0};
    });
  }
  previewUpdate(bundle:string):UpdatePlan {
    const c=readCurrent(this.root),source=snapshotInfo(dataFile(this.root,c)),target=verifyBundle(bundle,this.trust,this.allowTest);
    requireOpsJournalV3(target);
    if(source.schema>target.manifest.schema_max || source.schema<target.manifest.schema_min)throw new Error('Schema downgrade refused');
    const body={format:'qoopia-update-plan/1' as const,created_at:new Date().toISOString(),source:{generation:c.generation,bundle:c.bundle,instance:c.instance,schema:source.schema,logical_hash:source.logical_hash},target:{bundle_digest:target.digest,build_sha:target.manifest.build_sha,source_digest:target.manifest.source_digest,schema_min:target.manifest.schema_min,schema_max:target.manifest.schema_max}};
    return {...body,plan_digest:hash(JSON.stringify(body))};
  }
  update(bundle:string,requested?:unknown,confirmation?:string):Current {
    // Backward-compatible in-process helper; the shipped command always supplies the explicit plan and digest.
    if(requested===undefined){const plan=this.previewUpdate(bundle);return this.update(bundle,plan,plan.plan_digest);}
    return this.locked(()=>{
      let plan:UpdatePlan;
      try { plan=updatePlan.parse(requested); } catch { throw new Error('UPDATE_PLAN_INVALID'); }
      const {plan_digest,...body}=plan;
      if(hash(JSON.stringify(body))!==plan_digest)throw new Error('UPDATE_PLAN_INVALID');
      if(confirmation!==plan_digest)throw new Error('UPDATE_CONFIRMATION_STALE');
      const c=readCurrent(this.root),source=snapshotInfo(dataFile(this.root,c)),verified=verifyBundle(bundle,this.trust,this.allowTest);
      if(c.generation!==plan.source.generation || c.bundle!==plan.source.bundle || c.instance!==plan.source.instance || source.schema!==plan.source.schema)throw new Error('UPDATE_PLAN_STALE');
      if(verified.digest!==plan.target.bundle_digest || verified.manifest.build_sha!==plan.target.build_sha || verified.manifest.source_digest!==plan.target.source_digest || verified.manifest.schema_min!==plan.target.schema_min || verified.manifest.schema_max!==plan.target.schema_max)throw new Error('UPDATE_BUNDLE_STALE');
      const b=this.stageBundle(bundle), old=source;
      readRecoveryOps(operationsDirectory(this.root,c),c.instance);
      requireOpsJournalV3(b);
      if(old.schema>b.manifest.schema_max || old.schema<b.manifest.schema_min)throw new Error('Schema outside target range refused');
      const id=generation(), dir=path.join(this.root,'generations',id);privateDirectory(path.join(dir,'data'));
      const checkpoint=path.join(this.root,'backups','pre-update-'+randomUUID());
      const barrierAt=new Date().toISOString(),finalSnapshot=backupUnified(dataFile(this.root,c),checkpoint,c.instance,operationsDirectory(this.root,c));
      copyInventory(checkpoint,path.join(dir,'checkpoint'),inventory(checkpoint));
      durableCopyFile(path.join(checkpoint,'snapshot.db'),path.join(dir,'data','qoopia.db'),finalSnapshot.size,finalSnapshot.sha256);
      this.migrate(b.root,dir);const next=snapshotInfo(path.join(dir,'data','qoopia.db'));
      if(next.schema>b.manifest.schema_max || next.schema<b.manifest.schema_min)throw new Error('Migrated schema outside target range');
      if(next.instance!==c.instance)throw new Error('Update instance mismatch');
      const stagedAt=new Date().toISOString(),update_report:UpdateReport={format:'qoopia-update-cutover/1',run_id:randomUUID(),plan_digest,source_generation:c.generation,source_plan_hash:plan.source.logical_hash,barrier_sequence:1,barrier_sequence_semantics:'local_cutover_event_ordinal_not_source_audit_sequence',barrier_source_hash:finalSnapshot.logical_hash,source_writes_caught_up:finalSnapshot.logical_hash!==plan.source.logical_hash,target_generation:id,target_hash:next.logical_hash,timeline:[{stage:'preview',at:plan.created_at},{stage:'writer_barrier',at:barrierAt},{stage:'final_snapshot',at:finalSnapshot.created_at},{stage:'target_staged',at:stagedAt},{stage:'atomic_pointer',at:new Date().toISOString()}],rollback_disposition:'eligible_until_first_target_write; automatic_refusal_after_target_write',key_recovery:next.key_recovery};
      const result:Current={...c,generation:id,bundle:b.digest,bundle_digest:b.digest,previous:{...c,previous:undefined},cutover_hash:next.logical_hash,update_report};
      this.commit(result);return result;
    });
  }
  importCopy(apply:(generationRoot:string)=>unknown) {
    return this.locked(()=>{
      const c=readCurrent(this.root),id=generation(),dir=path.join(this.root,'generations',id);
      const checkpoint=path.join(this.root,'backups','pre-import-'+randomUUID());
      const snapshot=backupUnified(dataFile(this.root,c),checkpoint,c.instance,operationsDirectory(this.root,c));
      privateDirectory(path.join(dir,'data'));durableCopyFile(path.join(checkpoint,'snapshot.db'),path.join(dir,'data','qoopia.db'),snapshot.size,snapshot.sha256);
      const report=apply(dir),next=snapshotInfo(path.join(dir,'data','qoopia.db'));
      if(next.instance!==c.instance)throw new Error('Import changed target identity');
      const result:Current={...c,generation:id,previous:{...c,previous:undefined},cutover_hash:next.logical_hash};
      this.commit(result);return {current:result,report};
    });
  }
  rollback() {
    return this.locked(()=>{
      const c=readCurrent(this.root);if(!c.previous)throw new Error('No matching previous generation');
      if(snapshotInfo(dataFile(this.root,c)).logical_hash!==c.cutover_hash)throw new Error('Post-cutover writes exist; automatic rollback refused. Preserve new events and obtain an explicit owner plan');
      const old={...c.previous,...(c.operations_generation ? {operations_generation:c.operations_generation} : {})};
      readRecoveryOps(operationsDirectory(this.root,c),c.instance);
      requireOpsJournalV3(verifyBundle(path.join(this.root,'bundles',old.bundle),this.trust,this.allowTest));
      if(snapshotInfo(dataFile(this.root,old)).instance!==c.instance)throw new Error('Rollback instance mismatch');
      this.commit(old);return old;
    });
  }
  restore(backup:string) {
    return this.locked(()=>{
      const c=readCurrent(this.root), verified=verifyBackup(backup,c.instance), id=generation(), dir=path.join(this.root,'generations',id);
      const local=readRecoveryOps(operationsDirectory(this.root,c),c.instance),saved=backupOperations(backup,verified);
      requireOpsJournalV3(verifyBundle(path.join(this.root,'bundles',c.bundle),this.trust,this.allowTest));
      const merged=saved ? mergeRecoveryOps(saved,local,c.instance) : local;
      const mergedBytes=serializeOps(merged),live=dataFile(this.root,c);
      const fd=fs.openSync(live,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),header=Buffer.alloc(100);
      let headerBytes=0;
      try {
        const identity=()=>{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new Error('Live database unsafe');return {dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs};};
        const before=identity();let eof=false;
        while(headerBytes<header.length){const bytes=fs.readSync(fd,header,headerBytes,header.length-headerBytes,headerBytes);if(!bytes){eof=true;break;}headerBytes+=bytes;}
        const after=identity();
        if(JSON.stringify(after)!==JSON.stringify(before)||(headerBytes<header.length&&(!eof||headerBytes!==before.size)))throw new Error('Live database changed or header read ended early');
      } finally { fs.closeSync(fd); }
      let corruptLive=headerBytes!==header.length || header.subarray(0,16).toString('binary')!=='SQLite format 3\0' ||
        ![1,2].includes(header[18]!) || ![1,2].includes(header[19]!);
      if(!corruptLive)corruptLive=deterministicSqliteCorruption(live);
      const liveExtent=corruptLive?undefined:snapshotExtent(live);
      // A valid live DB keeps the mandatory checkpoint. Explicit SQLite corruption instead
      // retains the complete old generation byte-for-byte; pointer, backup and ops metadata
      // independently bind the instance, so corrupt DB contents grant no recovery authority.
      preflightSpace(this.root,[...(corruptLive?[]:[liveExtent!,Buffer.byteLength(serializeOps(local)),MAX_JSON_BYTES]),
        verified.size,verified.size,Buffer.byteLength(mergedBytes),MAX_JSON_BYTES]);
      if(!corruptLive)backupUnified(live,path.join(this.root,'backups','pre-restore-'+randomUUID()),c.instance,operationsDirectory(this.root,c));
      privateDirectory(path.join(dir,'data'));durableCopyFile(path.join(backup,'snapshot.db'),path.join(dir,'data','qoopia.db'),verified.size,verified.sha256);
      invalidateRestoredAccess(path.join(dir,'data','qoopia.db'));
      const info=snapshotInfo(path.join(dir,'data','qoopia.db'));
      const result:Current={...c,generation:id,previous:undefined,cutover_hash:undefined,operations_generation:id};
      writeOps(operationsDirectory(this.root,result),merged);
      this.commit(result);
      return {current:result,operations_recovery:verified.operations?'restored; known confirmations retained':'CONDITIONAL: legacy backup has no operations; local journal retained',recovery:verified.key_recovery,live_access:'invalidated; local human owner recovery and agent re-pair required',counts:info.counts,
        ...(corruptLive?{corrupt_live_recovery:true,retained_generation:c.generation}:{})};
    });
  }
  restoreNew(backup:string,bundle:string,port:number) {
    verifyBackup(backup);
    if(fs.existsSync(this.root)&&fs.readdirSync(this.root).length)throw new Error('New-machine restore requires empty root');
    return this.locked(()=>{
      const b=this.stageBundle(bundle), m=verifyBackup(backup), id=generation(), dir=path.join(this.root,'generations',id);
      requireOpsJournalV3(b);
      const saved=backupOperations(backup,m);
      const held={...(saved ?? {format:OPS_JOURNAL_FORMAT,last_run:null,alerts:[]}),delivery_hold:RECOVERY_DELIVERY_HOLD};
      preflightSpace(this.root,[m.size,m.size,Buffer.byteLength(serializeOps(held)),MAX_JSON_BYTES]);
      privateDirectory(path.join(dir,'data'));durableCopyFile(path.join(backup,'snapshot.db'),path.join(dir,'data','qoopia.db'),m.size,m.sha256);
      invalidateRestoredAccess(path.join(dir,'data','qoopia.db'));this.migrate(b.root,dir);
      if(snapshotInfo(path.join(dir,'data','qoopia.db')).instance!==m.instance)throw new Error('Restore instance mismatch');
      const c:Current={format:'qoopia-installation/1',generation:id,bundle:b.digest,bundle_digest:b.digest,instance:m.instance,port,operations_generation:id};
      writeOps(operationsDirectory(this.root,c),held);
      this.commit(c);return {current:c,delivery_hold:RECOVERY_DELIVERY_HOLD,sends_performed:0,operations_recovery:saved?'restored; replay held until separate owner authorization':'CONDITIONAL: legacy backup has no operations history',recovery:m.key_recovery,live_access:'invalidated; recover existing human owner locally'};
    });
  }
  uninstall() {
    return this.locked(()=>{
      const c=readCurrent(this.root),bundles=path.join(this.root,'bundles');
      // Verify every content-addressed owned bundle BEFORE any deletion. Unknown names remain untouched.
      const owned=fs.readdirSync(bundles).filter(n=>/^[a-f0-9]{64}$/.test(n)).map(name=>{
        const b=safePath(path.join(bundles,name)),verified=verifyBundle(b,this.trust,this.allowTest);
        if(verified.digest!==name)throw new Error('Bundle directory identity mismatch');
        return {b,records:inventory(b)};
      });
      // Native cleanup is then fail-closed: changed/foreign config blocks bundle deletion.
      const lifecycle=this.autostart(c.instance).remove();
      for(const {b,records} of owned){
        for(const name of Object.keys(records))fs.unlinkSync(safePath(path.join(b,name)));
        const prune=(dir:string)=>{for(const name of fs.readdirSync(dir))prune(path.join(dir,name));fs.rmdirSync(dir);};prune(b);
      }
      syncDirectory(bundles);
      durableWrite(path.join(this.root,'uninstalled.json'),JSON.stringify({...c,data_preserved:true}));
      fs.unlinkSync(path.join(this.root,'current.json'));syncDirectory(this.root);
      return {bundles_removed:owned.length,data_preserved:true,backups_preserved:true,...lifecycle};
    });
  }
  supportPreview(logRoot = path.join(this.root,'logs')) {
    const report=this.doctor(logRoot);
    let events: ReturnType<typeof previewManagedEvents>=[];
    try { events=previewManagedEvents(logRoot); } catch { /* doctor already reports log inspection failure */ }
    return {format:'qoopia-support-preview/1',preview:true,automatic_send:false,platform:report.platform,
      build:report.checks.build,schema:report.schema,counts:report.counts,state_fingerprint:report.state_fingerprint,
      config_names:['QOOPIA_PORT','QOOPIA_SERVER_ROLE','QOOPIA_DATA_DIR','QOOPIA_LOG_DIR','QOOPIA_BACKUP_DIR'],
      findings:report.findings,unknown_checks:report.not_checked,events,strict_codex_model:'unknown',native_qualification:'NOT_RUN'};
  }
  doctor(logRoot = path.join(this.root,'logs')) {
    const checks: Record<string, Check> = {};
    let stage='POINTER';
    let current: Current | undefined, summary: ReturnType<typeof snapshotInfo> | undefined;
    const unknown = (reason:string, action:string):Check => ({status:'unknown',reason,action});
    try {
      current = readCurrent(this.root);
      stage='BUILD';
      const bundle = verifyBundle(path.join(this.root,'bundles',current.bundle),this.trust,this.allowTest);
      checks.build = {status:'pass',reason:'PINNED_MANIFEST_VERIFIED',action:'No repair needed.',version:bundle.manifest.version};
      stage='DATA_PATH';
      const file = dataFile(this.root,current);
      for (const p of [this.root,path.dirname(file),file]) {
        const stat=fs.lstatSync(safePath(p));
        if(stat.uid!==process.getuid?.() || (stat.mode&0o077)) throw new Error('DATA_PERMISSIONS');
      }
      checks.data_path = {status:'pass',reason:'OWNED_PRIVATE_PATH',action:'No permission repair needed.'};
      stage='DATABASE';
      const inspected=inspectDoctorDatabase(file);summary=inspected.summary;
      if(summary.instance!==current.instance)throw new Error('INSTANCE_MISMATCH');
      checks.schema = {status:'pass',reason:'INTEGRITY_AND_SCHEMA_VERIFIED',action:'No migration needed.',schema:summary.schema};
      checks.auth = inspected.owners ? {status:'pass',reason:'STORED_OWNER_PRESENT',action:'Use owner-login for an explicit live IPC check.',owners:inspected.owners}
        : unknown('OWNER_NOT_BOUND','Run owner-login from the owner OS session.');
      checks.native_adapter = unknown(inspected.runtimes ? 'STORED_REGISTRATIONS_NOT_LIVE_QUALIFICATION' : 'NO_RUNTIME_REGISTRATION','Connect an owner-selected runtime; qualify separately.');
      checks.index = {status:'pass',reason:'FTS_READ_QUERY_EXECUTED',action:'Rebuild equality remains unverified; no rebuild performed.'};
      checks.backup = inspectScheduledBackups(path.join(this.root,'backups'),current.instance) as Check;
      const operations=opsSummary(operationsDirectory(this.root,current),current.instance);
      checks.maintenance = {reason:operations.error??operations.delivery_hold??'PERSISTED_MAINTENANCE_STATUS',action:operations.error==='OPS_JOURNAL_UNSUPPORTED_VERSION'?'Preserve the journal and use a compatible reader; recover-ops is forbidden for unsupported versions.':operations.error==='OPS_JOURNAL_TOO_LARGE'?'Preserve all journal IDs and backups. Lossless compaction cannot fit; obtain a scoped storage decision. recover-ops cannot bypass capacity.':operations.error?'Preserve the selected journal; follow docs/v4/runbooks/backup-restore.md for separately confirmed recover-ops.':operations.delivery_hold?'Review replay risk with authorize-ops-replay; delivery requires separate owner confirmation.':'Inspect pending alerts; run maintenance explicitly if needed.',...operations, status:operations.status==='degraded'||(operations.pending??0)>0?'fail':operations.status==='ok'?'pass':'unknown'};
      const space=fs.statfsSync(path.dirname(file));
      checks.storage={status:space.bavail===0?'fail':'pass',reason:space.bavail===0?'NO_AVAILABLE_BLOCKS':'AVAILABLE_BLOCKS_REPORTED',action:'Write capability is unknown: doctor does not write a probe.',available_bytes:space.bavail*space.bsize};
      checks.config_drift = {status:'pass',reason:'VALIDATED_INSTALLATION_POINTER_AND_BUNDLE',action:'Live effective configuration drift remains unknown; no config values exported.'};
    } catch {
      checks.stored_state={status:'fail',reason:stage+'_INSPECTION_FAILED',action:'Preserve data; inspect permissions, corruption, or concurrent writer, then rerun doctor. No repair was attempted.'};
    }
    for(const name of ['build','schema','data_path','auth','native_adapter','backup','index','config_drift','storage','maintenance'])
      checks[name]??=unknown('NOT_INSPECTED','Resolve the stored-state finding and rerun doctor.');
    checks.application_logs=inspectManagedLogs(logRoot) as Check;
    checks.port=unknown('NO_LISTENER_IDENTITY_PROBE','Start explicitly and use the functional fixture probe; an occupied port or health200 alone is insufficient.');
    checks.live_auth=unknown('NO_LIVE_UID_OR_HTTP_PROBE','Run separately authorized owner IPC and HTTP qualification.');
    checks.functional=unknown('NO_WRITE_ROUNDTRIP','Run deterministic isolated fixture probe; doctor never mutates user data.');
    checks.live_config=unknown('LIVE_CONFIG_NOT_ATTESTED','Compare a separately collected effective config fingerprint.');
    const findings=Object.entries(checks).filter(([,v])=>v.status==='fail').map(([k,v])=>k+':'+v.reason);
    return {ok:findings.length===0,status:findings.length?'degraded':'incomplete',read_only:true,
      scope:'read-only stored-state checks; unknown checks prevent a healthy claim',qualification:'INCOMPLETE',checks,
      not_checked:Object.entries(checks).filter(([,v])=>v.status==='unknown').map(([k])=>k),findings,
      platform:`${process.platform}-${process.arch}`,schema:summary?.schema,counts:summary?.counts,
      state_fingerprint:summary?hash(JSON.stringify(summary)):undefined,key_recovery:summary?.key_recovery,
      native_qualification:'NOT_RUN',strict_codex_model:'unknown',support:'preview only; no bodies, config values, keys, paths or transcripts; no automatic send'};
  }
}
