import { z } from 'zod';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { db } from '../db/connection.ts';
import type { AuthContext } from '../auth/middleware.ts';
import { QoopiaError } from '../utils/errors.ts';
import { assertNoSecrets } from '../utils/secret-guard.ts';
import { connectionRefSchema } from './connection.ts';
import { canonical, command, digest } from './commands.ts';
import { identifier, hash, mutation, reporter, registration, loadoutOf, entriesOf, currentAssignmentPermission, insertFact,
  type Assignment, type Entry, type Loadout } from './loop.ts';

export interface Claim { loadout_id:string; outbox_id:string; token:number; lease_expires_at_ms:number; }
export const claimSchema=z.object({...mutation,loadout_id:identifier}).strict();
export function checkClaim(database:Database,auth:AuthContext,claim:Claim){
  const l=loadoutOf(database,auth.workspace_id,claim.loadout_id);reporter(database,auth,l.runtime_id);
  const row=database.query("SELECT o.* FROM memory_event_outbox o JOIN authority_commands c ON c.id=o.aggregate_id WHERE o.id=? AND o.workspace_id=? AND c.operation='skill_session_open' AND json_extract(c.response_json,'$.data.loadout_id')=?").get(claim.outbox_id,auth.workspace_id,claim.loadout_id) as {state:string;lease_owner:string;lease_expires_at:string;attempt_count:number}|null;
  if(!row || row.state!=='leased' || row.lease_owner!==auth.agent_id || row.attempt_count!==claim.token || Date.parse(row.lease_expires_at)<=Date.now())throw new QoopiaError('STALE_REVISION','Projection lease expired or fenced');
  for(const e of entriesOf(database,l.id))currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));
  return l;
}
export function claimProjection(auth:AuthContext,input:unknown,database:Database=db){
  const a=claimSchema.parse(input);
  const result=command(database,auth,'report','runtime_claim',a.idempotency_key,a,a.loadout_id,p=>{
    const l=loadoutOf(database,p.workspace_id,a.loadout_id);reporter(database,auth,l.runtime_id);
    for(const e of entriesOf(database,l.id))currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));
  },c=>{
    const outbox=database.query(`SELECT o.* FROM memory_event_outbox o JOIN authority_commands c ON c.id=o.aggregate_id
      WHERE c.workspace_id=? AND c.operation='skill_session_open' AND json_extract(c.response_json,'$.data.loadout_id')=? ORDER BY c.created_at_ms,c.id LIMIT 1`)
      .get(c.principal.workspace_id,a.loadout_id) as {id:string;state:string;attempt_count:number;lease_expires_at:string|null;next_attempt_at:string|null;created_at:string}|null;
    if(!outbox)throw new QoopiaError('NOT_READY','Session-open outbox not found');
    if(outbox.state==='delivered')throw new QoopiaError('CONFLICT','Projection already read back; inspect its observations');
    if(outbox.state==='dead_letter' || outbox.attempt_count>=8 || Date.now()-Date.parse(outbox.created_at)>900_000)throw new QoopiaError('EXPIRED','Projection retry deadline reached; open a new session after inspection');
    if((outbox.state==='leased' && Date.parse(outbox.lease_expires_at??'')>c.now) || Date.parse(outbox.next_attempt_at??'')>c.now)throw new QoopiaError('CONFLICT','Projection is leased or waiting for its retry time');
    const expires=c.now+30_000;
    database.query("UPDATE memory_event_outbox SET state='leased',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=?")
      .run(c.principal.id,new Date(expires).toISOString(),new Date(c.now).toISOString(),outbox.id);
    return {data:{loadout_id:a.loadout_id,outbox_id:outbox.id,token:outbox.attempt_count+1,lease_expires_at_ms:expires},revision:outbox.attempt_count+1};
  });
  checkClaim(database,auth,result.data);return result;
}
/** A local coordinator holds this transaction across stage/swap/readback, fencing concurrent DB writers. */
export function withProjectionClaim<T>(database:Database,auth:AuthContext,claim:Claim,write:()=>T):T {
  return database.transaction(()=>{checkClaim(database,auth,claim);return write();}).immediate();
}
export function failProjection(database:Database,auth:AuthContext,claim:Claim,code:string){
  database.transaction(()=>{
    checkClaim(database,auth,claim);
    const dead=claim.token>=8,delay=[1000,2000,4000,8000,16000,30000][Math.min(claim.token-1,5)]!;
    database.query('UPDATE memory_event_outbox SET state=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code=?,next_attempt_at=?,updated_at=? WHERE id=?')
      .run(dead?'dead_letter':'failed',/^[A-Z_]{1,80}$/.test(code)?code:'PROJECTION_FAILED',new Date(Date.now()+delay+Math.floor(Math.random()*250)).toISOString(),new Date().toISOString(),claim.outbox_id);
  }).immediate();
}
export const nativeOptionsSchema=z.object({auth_mode:z.enum(['subscription','subscription-store','api-key']),
  model:z.string().regex(/^(?:gpt|claude)-[a-z0-9][a-z0-9.-]{0,100}$/),effort:z.enum(['low','medium','high']),
  login_store:z.string().max(4096).refine(path=>path.startsWith('/')&&path.length>1&&[...path].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127)).optional(),
  configured_profile_functional:z.literal(true).optional(),
  connection:connectionRefSchema.optional(),
  outer_seatbelt:z.object({mode:z.literal('macos-seatbelt-only-bookkeeping/1'),outer_root:z.string().startsWith('/').max(4096),profile_digest:hash,
    installation_id:z.string().startsWith('/').max(4096),arg0:z.string().startsWith('/').max(4096)}).strict().optional(),
  task_write_directory:z.string().max(4096).regex(/^\/[A-Za-z0-9_./-]+$/).optional(),
  login_backend:z.enum(['file','keyring','config-dir','default-keychain']).optional()}).strict();
export type NativeOptions=z.infer<typeof nativeOptionsSchema>;
export const nativeModelSchema=z.object({source:z.enum(['claude_response','codex_exec']),
  models:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/)).max(32),complete:z.boolean(),rerouted:z.literal(true).optional()}).strict();
export type NativeModelEvidence=z.infer<typeof nativeModelSchema>;
export function nativeModelStatus(expected:string,evidence?:NativeModelEvidence):'verified'|'mismatch'|'unknown'{
  if(evidence?.source==='codex_exec'&&evidence.rerouted)return 'mismatch';
  if(!evidence)return 'unknown';
  if(evidence.models.some(m=>m!==expected))return 'mismatch';
  if(expected.startsWith('gpt-'))return 'unknown';
  return evidence.source==='claude_response'&&evidence.complete&&evidence.models.length>0?'verified':'unknown';
}
export const evaluatorSchema=z.object({
  kind:z.literal('json-artifacts/1'), objective:z.string().min(1).max(2000),
  cases:z.array(z.object({name:identifier,path:z.string().regex(/^[a-zA-Z0-9_-]+\.json$/),expected:z.record(z.unknown()),absent:z.array(z.string().regex(/^[a-zA-Z0-9_-]+\.json$/)).max(10).default([])}).strict()).min(1).max(10),
  comparison:z.object({baseline_run_id:identifier,hypothesis:z.string().min(1).max(1000),dimensions_digest:hash}).strict().optional(),
  native:nativeOptionsSchema.optional(),
}).strict();
export interface Run {id:string;workspace_id:string;actor_id:string;loadout_id:string;entry_id:string;version_id:string;attempt_id:string;evaluator_json:string;environment_digest:string;authorization_expires_at_ms:number;}
export function runOf(database:Database,workspace:string,id:string):Run{
  const r=database.query('SELECT * FROM skill_runs WHERE id=? AND workspace_id=?').get(id,workspace) as Run|null;
  if(!r)throw new QoopiaError('NOT_FOUND','Run not found');return r;
}
export function entryOf(database:Database,l:Loadout,id:string,versionId:string,projectionDigest:string):Entry{
  const e=entriesOf(database,l.id).find(e=>e.id===id);
  if(!e || e.version_id!==versionId || e.projection_digest!==projectionDigest)throw new QoopiaError('CHECKSUM_MISMATCH','Receipt does not match the frozen loadout entry');return e;
}
export const runSchema=z.object({...mutation,loadout_id:identifier,entry_id:identifier,version_id:identifier,projection_digest:hash,
  attempt_id:identifier,evaluator:evaluatorSchema,environment_digest:hash}).strict();
export function authorizeRun(auth:AuthContext,input:unknown,database:Database=db){
  const a=runSchema.parse(input);assertNoSecrets(canonical(a.evaluator),'run evaluator');
  const result=command(database,auth,'report','skill_run_authorize',a.idempotency_key,a,a.entry_id,p=>{
    const l=loadoutOf(database,p.workspace_id,a.loadout_id);reporter(database,auth,l.runtime_id);
    const e=entryOf(database,l,a.entry_id,a.version_id,a.projection_digest);
    const permission=currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));
    const connection=a.evaluator.native?.connection;
    if(connection){
      if(a.evaluator.native?.auth_mode!=='subscription-store'&&!(l.runtime_kind==='claude_code'&&a.evaluator.native?.auth_mode==='subscription'))
        throw new QoopiaError('FORBIDDEN','Installed connection requires explicit subscription-store or Claude subscription');
      const reg=registration(database,p.workspace_id,l.runtime_id);
      const instance=database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string};
      if(connection.instance!==instance.instance_id||connection.workspace_id!==p.workspace_id||connection.runtime_id!==reg.id||connection.agent_id!==reg.target_agent_id)
        throw new QoopiaError('FORBIDDEN','Native connection does not belong to this installed runtime');
    }
    const taskDirectory=a.evaluator.native?.task_write_directory;
    if(taskDirectory){
      const runtime=registration(database,p.workspace_id,l.runtime_id);
      if(!runtime.managed_root||taskDirectory!==join(runtime.managed_root,'sessions',l.id,`task-${a.attempt_id}`)||
        !permission.descriptor.requested_capabilities.includes('file_write_managed'))
        throw new QoopiaError('FORBIDDEN','Task write scope must match this attempt and its current reviewed file_write_managed capability');
    }
    if(!entriesOf(database,l.id).every(entry=>database.query("SELECT 1 FROM runtime_observations WHERE entry_id=? AND kind='projection_readback' AND stale=0").get(entry.id)))throw new QoopiaError('NOT_READY','Install and read back this frozen entry before a run');
  },c=>{
    if(a.expected_revision!==0)throw new QoopiaError('STALE_REVISION','Run authorization requires revision zero');
    const prior=database.query('SELECT * FROM skill_runs WHERE loadout_id=? AND entry_id=? AND attempt_id=?').get(a.loadout_id,a.entry_id,a.attempt_id) as Run|null;
    if(prior){if(prior.evaluator_json!==canonical(a.evaluator)||prior.environment_digest!==a.environment_digest)throw new QoopiaError('CONFLICT','Attempt is already bound to another evaluator/environment');return {data:{run_id:prior.id,authorization_expires_at_ms:prior.authorization_expires_at_ms},revision:1};}
    if(a.evaluator.comparison){const baseline=runOf(database,c.principal.workspace_id,a.evaluator.comparison.baseline_run_id);
      if(baseline.environment_digest!==a.environment_digest || digest(canonical(JSON.parse(baseline.evaluator_json).cases))!==digest(canonical(a.evaluator.cases)) || a.evaluator.comparison.dimensions_digest!==digest(canonical(a.evaluator.cases)))throw new QoopiaError('CONFLICT','Comparison requires the same predeclared task dimensions and environment');}
    const expires=c.now+60_000;
    const id=insertFact(database,'skill_runs',c,{loadout_id:a.loadout_id,entry_id:a.entry_id,version_id:a.version_id,attempt_id:a.attempt_id,
      objective:a.evaluator.objective,evaluator_json:canonical(a.evaluator),environment_digest:a.environment_digest,authorization_expires_at_ms:expires});
    return {data:{run_id:id,authorization_expires_at_ms:expires},revision:1};
  });
  if(result.data.authorization_expires_at_ms<=Date.now())throw new QoopiaError('EXPIRED','Run authorization expired; inspect the attempt instead of replaying external effects');
  return result;
}
export const observationSchema=z.object({...mutation,loadout_id:identifier,entry_id:identifier,version_id:identifier,projection_digest:hash,
  run_id:identifier.optional(),event_id:identifier,kind:z.enum(['projection_readback','runtime_receipt','observed_execution','closed']),
  observed_at_ms:z.number().int().positive(),evidence:z.object({native_session_ref:identifier.optional(),trace_digest:hash.optional(),
    native_model:nativeModelSchema.optional(),
    native_mcp:z.object({complete:z.boolean(),tools:z.array(z.enum(['qoopia_capabilities','note_create','note_get','recall'])).max(4),note_id:identifier.optional()}).strict().optional(),
    subtype:z.enum(['native_event','echo','readback','close']),exit_code:z.number().int().nullable().optional(),
    claim:z.object({loadout_id:identifier,outbox_id:identifier,token:z.number().int().positive(),lease_expires_at_ms:z.number().int().positive()}).strict().optional()}).strict()}).strict();
export function observeRuntime(auth:AuthContext,input:unknown,database:Database=db){
  const a=observationSchema.parse(input);assertNoSecrets(canonical(a.evidence),'runtime evidence');
  return command<{observation_id:string;stale?:boolean;evidence_class?:string}>(database,auth,'report','skill_observe',a.idempotency_key,a,a.entry_id,p=>{
    const l=loadoutOf(database,p.workspace_id,a.loadout_id);reporter(database,auth,l.runtime_id);entryOf(database,l,a.entry_id,a.version_id,a.projection_digest);
    if(a.run_id){const r=runOf(database,p.workspace_id,a.run_id);if(r.entry_id!==a.entry_id||r.loadout_id!==l.id||r.version_id!==a.version_id)throw new QoopiaError('CHECKSUM_MISMATCH','Run linkage mismatch');}
  },c=>{
    const l=loadoutOf(database,c.principal.workspace_id,a.loadout_id),e=entryOf(database,l,a.entry_id,a.version_id,a.projection_digest);
    const existing=database.query('SELECT id,evidence_digest FROM runtime_observations WHERE actor_id=? AND event_id=?').get(c.principal.id,a.event_id) as {id:string;evidence_digest:string}|null;
    const evidenceDigest=digest(canonical({loadout_id:l.id,entry_id:e.id,run_id:a.run_id??null,kind:a.kind,evidence:a.evidence,observed_at_ms:a.observed_at_ms}));
    if(existing){if(existing.evidence_digest!==evidenceDigest)throw new QoopiaError('CONFLICT','Observation event ID has different facts');return {data:{observation_id:existing.id},revision:1};}
    if(a.observed_at_ms>c.now+120_000)throw new QoopiaError('INVALID_INPUT','Observation timestamp is in the future');
    if(a.kind==='observed_execution' && (!a.run_id||a.evidence.subtype!=='native_event'||!a.evidence.trace_digest||!a.evidence.native_session_ref))throw new QoopiaError('INVALID_INPUT','Execution requires an authenticated native event trace and exact run');
    let stale=0;try{currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));}catch{stale=1;}
    if(a.kind==='projection_readback'){
      if(a.evidence.subtype!=='readback'||!a.evidence.claim||a.evidence.claim.loadout_id!==l.id)throw new QoopiaError('INVALID_INPUT','Readback requires the claimed operation');
      const bound=database.query("SELECT 1 FROM memory_event_outbox o JOIN authority_commands c ON c.id=o.aggregate_id WHERE o.id=? AND c.operation='skill_session_open' AND json_extract(c.response_json,'$.data.loadout_id')=?").get(a.evidence.claim.outbox_id,l.id);
      if(!bound)throw new QoopiaError('FORBIDDEN','Claim belongs to another loadout');
      try{checkClaim(database,auth,a.evidence.claim);}catch{stale=1;}
    }
    const id=insertFact(database,'runtime_observations',c,{loadout_id:l.id,entry_id:e.id,run_id:a.run_id??null,event_id:a.event_id,kind:a.kind,evidence_json:canonical(a.evidence),evidence_digest:evidenceDigest,stale,observed_at_ms:a.observed_at_ms});
    if(!stale && a.kind==='projection_readback' && entriesOf(database,l.id).every(x=>x.id===e.id||database.query("SELECT 1 FROM runtime_observations WHERE entry_id=? AND kind='projection_readback' AND stale=0").get(x.id))){
      database.query("UPDATE memory_event_outbox SET state='delivered',delivered_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND attempt_count=?")
        .run(new Date(c.now).toISOString(),new Date(c.now).toISOString(),a.evidence.claim!.outbox_id,a.evidence.claim!.token);
    }
    return {data:{observation_id:id,stale:!!stale,evidence_class:a.kind},revision:1};
  });
}
export const outcomeSchema=z.object({...mutation,run_id:identifier,version_id:identifier,evidence_class:z.enum(['self_report','verified_outcome']),
  reported_status:z.enum(['succeeded','failed','partial','unknown','cancelled']).optional(),
  artifacts:z.record(z.string().max(100_000)).default({}),outside_writes:z.enum(['none','detected','unknown']).default('unknown'),
  execution_observation_id:identifier.optional(),supersedes_id:identifier.optional()}).strict();
export function evaluateArtifacts(evaluator:z.infer<typeof evaluatorSchema>,artifacts:Record<string,string>,outside:string){
  const assertions=evaluator.cases.map(c=>{let matches=false;try{matches=canonical(JSON.parse(artifacts[c.path]??''))===canonical(c.expected);}catch{/* Invalid or missing artifact is a failed assertion. */}
    return {name:c.name,passed:matches && c.absent.every(n=>!(n in artifacts)),artifact_digest:artifacts[c.path]===undefined?null:digest(artifacts[c.path])};});
  const passed=assertions.filter(a=>a.passed).length;
  const status=outside==='detected'?'failed':outside==='unknown'?'unknown':passed===assertions.length?'succeeded':passed>0?'partial':Object.keys(artifacts).length?'failed':'unknown';
  return {status,assertions:[...assertions,{name:'writes_stayed_inside_managed_roots',passed:outside==='none',artifact_digest:null}]};
}
export function recordOutcome(auth:AuthContext,input:unknown,database:Database=db){
  const a=outcomeSchema.parse(input);assertNoSecrets(canonical(a.artifacts),'outcome artifacts');
  const action=a.evidence_class==='self_report'?'feedback':'report';
  return command(database,auth,action,'skill_outcome',a.idempotency_key,a,a.run_id,p=>{
    const r=runOf(database,p.workspace_id,a.run_id),l=loadoutOf(database,p.workspace_id,r.loadout_id),reg=registration(database,p.workspace_id,l.runtime_id);
    if(a.version_id!==r.version_id)throw new QoopiaError('CHECKSUM_MISMATCH','Outcome version differs from run');
    if(action==='report')reporter(database,auth,l.runtime_id);
    else if(p.id!==reg.target_agent_id&&p.authority_profile!=='owner')throw new QoopiaError('FORBIDDEN','Only run participant or owner may give feedback');
  },c=>{
    const r=runOf(database,c.principal.workspace_id,a.run_id),l=loadoutOf(database,c.principal.workspace_id,r.loadout_id),e=entriesOf(database,l.id).find(e=>e.id===r.entry_id)!;
    const previous=database.query('SELECT id,revision FROM skill_outcomes WHERE run_id=? AND actor_id=? ORDER BY revision DESC LIMIT 1').get(r.id,c.principal.id) as {id:string;revision:number}|null;
    if((previous?.revision??0)!==a.expected_revision || (previous?.id??undefined)!==a.supersedes_id)throw new QoopiaError('STALE_REVISION','Outcome revision/superseding reference changed');
    const evaluated=evaluateArtifacts(evaluatorSchema.parse(JSON.parse(r.evaluator_json)),a.artifacts,a.outside_writes);
    let status=a.reported_status??'unknown';
    if(a.evidence_class==='verified_outcome'){
      const observation=database.query("SELECT * FROM runtime_observations WHERE id=? AND run_id=? AND actor_id=? AND kind='observed_execution'").get(a.execution_observation_id??'',r.id,c.principal.id) as {evidence_json:string}|null;
      if(!observation)throw new QoopiaError('APPROVAL_REQUIRED','Marker/self-report is not native execution evidence');
      status=evaluated.status as typeof status;
      const native=JSON.parse(r.evaluator_json).native as NativeOptions|undefined;
      if(native){
        const proof=JSON.parse(observation.evidence_json),modelStatus=nativeModelStatus(native.model,proof.native_model);
        evaluated.assertions.push({name:'native_model_matches',passed:modelStatus==='verified',artifact_digest:proof.trace_digest??null});
        if(modelStatus!=='verified'&&status!=='failed')status=modelStatus==='mismatch'?'failed':'unknown';
        if(native.connection){
          const used=proof.native_mcp?.complete===true&&['qoopia_capabilities','note_create','note_get','recall'].every(name=>proof.native_mcp.tools.includes(name));
          evaluated.assertions.push({name:'native_connection_used',passed:used,artifact_digest:proof.trace_digest??null});
          if(!used&&status!=='failed')status='unknown';
        }
      }
    }
    let stale=0;try{currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot) as Assignment);}catch{stale=1;}
    const id=insertFact(database,'skill_outcomes',c,{run_id:r.id,version_id:r.version_id,revision:a.expected_revision+1,supersedes_id:previous?.id??null,status,
      evidence_class:a.evidence_class,assertions_json:canonical(evaluated.assertions),evidence_digest:digest(canonical(a.artifacts)),stale});
    return {data:{outcome_id:id,status,evidence_class:a.evidence_class,stale:!!stale},revision:a.expected_revision+1};
  });
}
export const ratingSchema=z.object({...mutation,run_id:identifier,version_id:identifier,score:z.number().int().min(1).max(5),reason:z.string().max(2000)}).strict();
export function rateSkill(auth:AuthContext,input:unknown,database:Database=db){
  const a=ratingSchema.parse(input);assertNoSecrets(a.reason,'rating reason');
  return command(database,auth,'feedback','skill_rate',a.idempotency_key,a,a.run_id,p=>{
    const r=runOf(database,p.workspace_id,a.run_id),l=loadoutOf(database,p.workspace_id,r.loadout_id),reg=registration(database,p.workspace_id,l.runtime_id);
    if(r.version_id!==a.version_id || (p.id!==reg.target_agent_id&&p.authority_profile!=='owner'))throw new QoopiaError('FORBIDDEN','Rating requires run participation and exact version');
  },c=>{
    const n=(database.query('SELECT count(*) n FROM skill_ratings WHERE actor_id=? AND run_id=? AND version_id=?').get(c.principal.id,a.run_id,a.version_id) as {n:number}).n;
    if(n!==a.expected_revision)throw new QoopiaError('STALE_REVISION','Rating changed');
    const id=insertFact(database,'skill_ratings',c,{run_id:a.run_id,version_id:a.version_id,revision:n+1,score:a.score,reason:a.reason});
    return {data:{rating_id:id,evidence_class:'self_report',independent_reputation_weight:0},revision:n+1};
  });
}
