import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { db } from '../db/connection.ts';
import type { AuthContext } from '../auth/middleware.ts';
import { authorize } from '../auth/policy.ts';
import { QoopiaError } from '../utils/errors.ts';
import { canonical, command, digest } from './commands.ts';
import { identifier, hash, mutation, assignSchema, assignSkill } from './loop.ts';
import { versionOf } from './authority.ts';
export const importPreviewSchema=z.object({origin:identifier}).strict();
interface OriginRow{source_type:string;source_id:string;local_id:string;row_digest:string;original_row:Uint8Array;}
function originals(database:Database,workspace:string,origin:string){
  return database.query('SELECT * FROM migration_origins WHERE workspace_id=? AND origin_instance_id=? ORDER BY source_type,source_id').all(workspace,origin) as OriginRow[];
}
function decoded(row:OriginRow):Record<string,unknown>{return JSON.parse(Buffer.from(row.original_row).toString());}
export function importPreview(auth:AuthContext,input:unknown,database:Database=db){
  const a=importPreviewSchema.parse(input),p=authorize(database,auth,'owner'),rows=originals(database,p.workspace_id,a.origin);
  if(!rows.length)throw new QoopiaError('NOT_FOUND','Imported source not found');
  const items=rows.filter(r=>['assignments','skill_assignments'].includes(r.source_type)).map(r=>{
    const old=decoded(r),events=rows.filter(e=>['assignment_events','skill_assignment_events'].includes(e.source_type)&&decoded(e).assignment_id===r.source_id).map(decoded).sort((a,b)=>Number(a.event_seq)-Number(b.event_seq));
    const head=events.at(-1),resolution=database.query('SELECT assignment_id,decision FROM skill_import_resolutions WHERE origin_instance_id=? AND source_type=? AND source_id=?').get(a.origin,r.source_type,r.source_id);
    return {source_type:r.source_type,source_id:r.source_id,source_digest:r.row_digest,source_agent_id:old.agent_id,source_draft_id:old.draft_id??null,
      source_version_id:head?.desired_revision_id??old.skill_version_id??null,source_scope:'agent',source_state:head?.desired_state??head?.event??'unknown',
      recipient_kind:old.recipient_kind??'local_agent',current_state:resolution??'paused_migration_review_required',
      conflict:rows.some(other=>other!==r&&['assignments','skill_assignments'].includes(other.source_type)&&decoded(other).agent_id===old.agent_id)};
  });
  return {origin:a.origin,items,approval_history:rows.filter(r=>['revision_approvals','draft_decisions','reviews'].includes(r.source_type)).map(r=>({source_type:r.source_type,source_id:r.source_id,digest:r.row_digest,original_scope_preserved:true,evidence_class:'legacy_history'})),
    preview_digest:digest(canonical(items)),executable_authority:'none_until_explicit_resolution_and_current_exact_review'};
}
export const resolveImportSchema=z.object({...mutation,origin:identifier,source_type:z.enum(['assignments','skill_assignments']),source_id:identifier,
  source_digest:hash,confirmed_source_agent_id:identifier,decision:z.enum(['keep_paused','assign']),assignment:assignSchema.optional()}).strict();
export function resolveImport(auth:AuthContext,input:unknown,database:Database=db){
  const a=resolveImportSchema.parse(input);
  return command(database,auth,'owner','skill_import_resolve',a.idempotency_key,a,a.source_id,p=>{
    const row=originals(database,p.workspace_id,a.origin).find(r=>r.source_type===a.source_type&&r.source_id===a.source_id);
    if(!row||row.row_digest!==a.source_digest)throw new QoopiaError('STALE_REVISION','Exact imported source scope must be reviewed');
    if(decoded(row).agent_id!==a.confirmed_source_agent_id)throw new QoopiaError('FORBIDDEN','Confirm the original source agent');
    if(a.assignment){const old=decoded(row);if(a.assignment.target_scope!=='agent'||old.recipient_kind==='remote_fleet')throw new QoopiaError('FORBIDDEN','Imported agent-only scope cannot widen or become a remote transfer');}
  },c=>{
    if(a.expected_revision!==0||database.query('SELECT 1 FROM skill_import_resolutions WHERE origin_instance_id=? AND source_type=? AND source_id=?').get(a.origin,a.source_type,a.source_id))throw new QoopiaError('CONFLICT','Imported assignment already resolved; use its canonical assignment to update');
    let assignmentId:string|null=null;
    if(a.decision==='assign'){
      if(!a.assignment)throw new QoopiaError('INVALID_INPUT','Exact reviewed assignment required');
      const rows=originals(database,c.principal.workspace_id,a.origin),old=decoded(rows.find(r=>r.source_type===a.source_type&&r.source_id===a.source_id)!);
      const version=versionOf(database,c.principal.workspace_id,a.assignment.version_id);
      const legacySkill=a.source_type==='skill_assignments'?`native-${a.origin}-${old.draft_id}`:rows.find(r=>r.source_type==='skills'&&r.source_id===old.skill_id)?.local_id;
      if(!legacySkill||version.skill_id!==legacySkill)throw new QoopiaError('FORBIDDEN','Resolution must keep the imported skill lineage');
      assignmentId=assignSkill(auth,a.assignment,database).data.assignment_id;
    }
    database.query('INSERT INTO skill_import_resolutions(origin_instance_id,source_type,source_id,workspace_id,assignment_id,decision,command_id) VALUES (?,?,?,?,?,?,?)')
      .run(a.origin,a.source_type,a.source_id,c.principal.workspace_id,assignmentId,a.decision,c.id);
    return {data:{assignment_id:assignmentId,decision:a.decision,original_history:'unchanged'},revision:1};
  });
}
