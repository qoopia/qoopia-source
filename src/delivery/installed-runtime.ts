import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, DB_PATH } from '../db/connection.ts';
import { authorize, requireAgent } from '../auth/policy.ts';
import { issuePairing, redeemPairing } from '../auth/pairings.ts';
import { authorityOperations } from '../api/authority.ts';
import { bindManagedRoot, openManagedSession, materializeSession, prepareCsvTask, runCsvTask, removeSessionProjection, nativeOptions } from '../skills/adapter.ts';
import { configureRuntime, registration, loadoutOf } from '../skills/loop.ts';
import { nativeOptionsSchema, recordOutcome, runOf } from '../skills/runtime.ts';
import { bindNativeConnection, connectionRefSchema } from '../skills/connection.ts';
import { localOwner } from './owner-onboarding.ts';
import { safePath, readJsonBytes, hash } from '../utils/fs.ts';
import type { AuthContext } from '../auth/middleware.ts';
import { agentTaskSchema, runAgentTask } from '../skills/agent-task.ts';

/** Entry owns the installation lifetime lock. No remote route or credential arguments. */
function operator(ownerId?: string) {
  const uid=process.getuid?.(), stat=fs.lstatSync(safePath(DB_PATH));
  if(uid===undefined||uid===0||process.geteuid?.()!==uid||stat.uid!==uid||(stat.mode&0o077))throw new Error('Installed runtime requires private database local OS owner');
  const auth=localOwner(db,ownerId);authorize(db,auth,'owner');return auth;
}
export function reportAuth(owner:AuthContext,runtimeId:string):AuthContext {
  const runtime=registration(db,owner.workspace_id,runtimeId);
  if(!runtime.reporter_id)throw new Error('Bind this installed runtime and its reporter first');
  const p=requireAgent(db,owner.workspace_id,runtime.reporter_id);
  const auth:AuthContext={agent_id:p.id,workspace_id:p.workspace_id,agent_name:p.name,type:p.type,source:'api-key',policy_epoch:p.policy_epoch,session_version:p.session_version};
  authorize(db,auth,'report');return auth;
}
const identifier=z.string().min(1).max(200);
const bindSchema=z.object({connection:connectionRefSchema,runtime_kind:z.enum(['claude_code','codex']),runtime_version:identifier,
  managed_root:z.string().startsWith('/'),expected_revision:z.number().int().positive()}).strict();
const startSchema=z.object({runtime_id:identifier,native_session_ref:identifier,qoopia_session_id:identifier}).strict();
const sessionSchema=z.object({loadout_id:identifier}).strict();
const taskSchema=z.object({loadout_id:identifier,entry_id:identifier,csv_file:z.string().startsWith('/'),
  native:nativeOptionsSchema.omit({task_write_directory:true}).extend({auth_mode:z.enum(['subscription-store','subscription']),connection:connectionRefSchema}),
  allow_task_writes:z.boolean().optional()}).strict();
const auditSchema=z.object({run_id:identifier,outside_writes:z.enum(['none','detected','unknown']),
  method:z.enum(['native_sandbox_trace','os_write_trace']),trace_file:z.string().startsWith('/'),trace_digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();

export function installedSkill(operation:string,input:unknown,ownerId?:string){
  const owner=operator(ownerId);
  // Reuse the exact authority registry/schema/handler. No generic remote or shell dispatch.
  if(!['capture','compile','accept','assign','get','loop','draft_revise','assignment_update','lifecycle'].includes(operation))throw new Error('Unsupported installed skill operation');
  const entry=authorityOperations.find(item=>item.name==='skill_'+operation);
  if(!entry)throw new Error('Installed skill operation unavailable');
  return entry.handler(owner,entry.schema.parse(input),db);
}

export async function installedRuntime(operation:string,input:unknown,installationRoot:string,ownerId?:string,nativeSource:NodeJS.ProcessEnv=process.env){
  const owner=operator(ownerId);
  if(operation==='task'){
    const a=agentTaskSchema.parse(input),auth=reportAuth(owner,a.runtime_id);
    bindNativeConnection(db,a.native.connection,{runtime_id:a.runtime_id,runtime_kind:registration(db,owner.workspace_id,a.runtime_id).runtime_kind,workspace_id:owner.workspace_id});
    const {startHttpServer}=await import('../http.ts'),server=startHttpServer();
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      return await runAgentTask(db,auth,a,nativeSource);
    }finally{
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  }
  if(operation==='bind'){
    const a=bindSchema.parse(input),r=registration(db,owner.workspace_id,a.connection.runtime_id);
    bindNativeConnection(db,a.connection,{runtime_id:r.id,runtime_kind:a.runtime_kind,workspace_id:owner.workspace_id});
    if(r.revision!==a.expected_revision)throw new Error('Runtime revision changed; inspect current registration');
    const managed=safePath(a.managed_root),relative=path.relative(installationRoot,managed);
    if(!relative||!relative.startsWith('..')&&!path.isAbsolute(relative))throw new Error('Managed task root must be outside the installation');
    return db.transaction(()=>{
      if(!r.reporter_id){
        const row=db.query('SELECT runtime_id FROM runtime_registrations WHERE id=?').get(r.id) as {runtime_id:string};
        const pair=issuePairing(owner,{name:'Native reporter '+r.target_agent_id,runtime_id:row.runtime_id,profile:'runtime-reporter',target_agent_id:r.target_agent_id,
          expected_revision:owner.policy_epoch!,idempotency_key:randomUUID()},db);
        // The owner-authorized local reporter is never exposed to the model or written as a credential.
        redeemPairing(pair.one_time_code!,db);
      }
      const configured=configureRuntime(owner,{runtime_id:r.id,runtime_kind:a.runtime_kind,runtime_version:a.runtime_version,
        platform:`${process.platform}-${process.arch}`,expected_revision:registration(db,owner.workspace_id,r.id).revision,idempotency_key:randomUUID()},db);
      const bound=bindManagedRoot(db,owner,r.id,managed);
      return {...bound,state:'INSTALLED_RUNTIME_BOUND',revision:configured.revision,workspace_id:owner.workspace_id,connection:a.connection};
    }).immediate();
  }
  if(operation==='start'){
    const a=startSchema.parse(input);
    return openManagedSession(db,reportAuth(owner,a.runtime_id),a.runtime_id,a.native_session_ref,a.qoopia_session_id);
  }
  if(operation==='sync'||operation==='cleanup'){
    const a=sessionSchema.parse(input),l=loadoutOf(db,owner.workspace_id,a.loadout_id),auth=reportAuth(owner,l.runtime_id);
    return operation==='sync'?materializeSession(db,auth,l.id):removeSessionProjection(db,auth,l.id);
  }
  if(operation==='audit'){
    // Existing P2 offline finalization protocol, applied to the installed DB and its registered task root.
    // This verifies the supplied trace hash and records the owner's audit decision; it does not collect/interpret an OS trace.
    const a=auditSchema.parse(input),r=runOf(db,owner.workspace_id,a.run_id),l=loadoutOf(db,owner.workspace_id,r.loadout_id);
    const auth=reportAuth(owner,l.runtime_id),reg=registration(db,owner.workspace_id,l.runtime_id);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.attempt_id))throw new Error('Audit requires an actual generated native task');
    const trace=readJsonBytes(safePath(a.trace_file));if(!trace.length||hash(trace)!==a.trace_digest)throw new Error('Audit trace hash mismatch');
    const observation=db.query("SELECT id FROM runtime_observations WHERE run_id=? AND actor_id=? AND kind='observed_execution' ORDER BY event_seq DESC LIMIT 1")
      .get(r.id,auth.agent_id) as {id:string}|null;
    if(!observation||!reg.managed_root)throw new Error('No installed native execution for this audit');
    const previous=db.query('SELECT id,revision FROM skill_outcomes WHERE run_id=? AND actor_id=? ORDER BY revision DESC LIMIT 1')
      .get(r.id,auth.agent_id) as {id:string;revision:number}|null;
    const task=safePath(path.join(reg.managed_root,'sessions',l.id,'task-'+r.attempt_id)),artifacts:Record<string,string>={};
    for(const name of ['summary.json','refusal.json','invalid-summary.json']){
      const file=path.join(task,name);
      if(fs.existsSync(file)){
        const bytes=readJsonBytes(file);if(bytes.length>100000)throw new Error('Task artifact too large');artifacts[name]=bytes.toString('utf8');
      }
    }
    const result=recordOutcome(auth,{run_id:r.id,version_id:r.version_id,evidence_class:'verified_outcome',artifacts,outside_writes:a.outside_writes,
      execution_observation_id:observation.id,expected_revision:previous?.revision??0,...(previous?{supersedes_id:previous.id}:{}),idempotency_key:randomUUID()},db);
    return {audit_method:a.method,audit_trace_digest:a.trace_digest,...result};
  }
  if(operation!=='inspect'&&operation!=='run')throw new Error('Unsupported installed runtime operation');
  const a=taskSchema.parse(input),l=loadoutOf(db,owner.workspace_id,a.loadout_id),auth=reportAuth(owner,l.runtime_id);
  nativeOptions(l.runtime_kind,a.native); // Validate explicit auth/runtime combination before any listener or native probe.
  if(a.native.configured_profile_functional&&!a.native.outer_seatbelt)throw new Error('Installed configured Codex requires its explicit guarded outer Seatbelt');
  if(l.runtime_kind==='claude_code'&&a.native.outer_seatbelt)throw new Error('Claude cannot use the Codex boundary');
  const csv=readJsonBytes(safePath(a.csv_file)).toString('utf8');
  const task={loadout_id:a.loadout_id,entry_id:a.entry_id,csv,...a.native,...(a.allow_task_writes!==undefined?{allow_task_writes:a.allow_task_writes}:{})};
  if(operation==='inspect'){
    const p=prepareCsvTask(db,auth,task,nativeSource);
    return {state:'PREPARED_NOT_RUN',loadout_id:l.id,entry_id:p.entry.id,version_id:p.entry.version_id,task_directory:p.taskDir,
      native:p.options,evaluator:p.evaluator,launch:{binary:p.launch.binary,args:p.launch.args},projection_digest:p.entry.projection_digest,
      native_invocations:0,auth_status:'NOT RUN',actual_model:'unknown'};
  }
  // A stopped installation runs its existing HTTP handler only for this explicitly requested local task.
  // Binding and grants are checked before listening, then again in adapter immediately before native spawn.
  bindNativeConnection(db,a.native.connection,{runtime_id:l.runtime_id,runtime_kind:l.runtime_kind,workspace_id:owner.workspace_id});
  const {startHttpServer}=await import('../http.ts');
  const server=startHttpServer();
  try{
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    return await runCsvTask(db,auth,task,nativeSource);
  }finally{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}
