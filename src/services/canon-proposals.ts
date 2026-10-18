import {z} from 'zod';
import {ulid} from 'ulid';
import {db} from '../db/connection.ts';
import {hash} from '../utils/fs.ts';
import {QoopiaError,nowIso} from '../utils/errors.ts';
import {assertNoSecrets} from '../utils/secret-guard.ts';
import {isDreamer} from '../auth/principal.ts';
import {assertAutomaticMemoryAllowed,canManagePolicy} from './memory-policy.ts';
import {createCanon,CANON_MAX_CHARS,type Actor} from './canon.ts';
import {logActivity} from './activity.ts';

const draft=z.object({text:z.string().trim().min(1).max(CANON_MAX_CHARS),scope:z.enum(['workspace','agent','project']).default('workspace'),
 agent:z.string().min(1).max(128).optional(),project:z.string().min(1).max(512).optional(),mode:z.enum(['always','contextual']).default('contextual'),
 supersedes_id:z.string().min(1).max(128).optional()}).strict();
export const canonProposalSchema=draft.extend({reason:z.string().trim().min(1).max(1000),source_refs:z.array(z.string().min(1).max(240)).min(1).max(20),
 idempotency_key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)}).strict();
interface Proposal {id:string;workspace_id:string;proposed_by:string;payload:string;reason:string;source_refs:string;status:string;canon_id:string|null;created_at:string;decided_at:string|null}
const publicProposal=(p:Proposal)=>({id:p.id,proposed_by:p.proposed_by,...draft.parse(JSON.parse(p.payload)),reason:p.reason,
 source_refs:JSON.parse(p.source_refs) as string[],source:'dreaming' as const,status:p.status,canon_id:p.canon_id,created_at:p.created_at,decided_at:p.decided_at});
export function proposeCanon(workspace:string,actor:Actor,input:unknown){
 const row=db.query('SELECT 1 FROM agents WHERE id=? AND workspace_id=? AND active=1').get(actor.agent_id,workspace);
 if(!row||!isDreamer(actor.agent_id))throw new QoopiaError('FORBIDDEN','Only the appointed dreamer proposes canons');
 assertAutomaticMemoryAllowed(workspace,actor.agent_id);
 const {reason,source_refs,idempotency_key,...payload}=canonProposalSchema.parse(input);
 assertNoSecrets(JSON.stringify({payload,reason,source_refs}),'canon_proposal');
 const bytes=JSON.stringify(payload),refs=JSON.stringify(source_refs),id=ulid();
 return db.transaction(()=>{
  const prior=db.query('SELECT * FROM canon_proposals WHERE workspace_id=? AND proposed_by=? AND request_key=?').get(workspace,actor.agent_id,idempotency_key) as Proposal|null;
  if(prior){if(hash(JSON.stringify([prior.payload,prior.reason,prior.source_refs]))!==hash(JSON.stringify([bytes,reason,refs])))throw new QoopiaError('CONFLICT','Proposal idempotency key already has different content');return {proposal:publicProposal(prior)};}
  db.query('INSERT INTO canon_proposals(id,workspace_id,proposed_by,request_key,payload,reason,source_refs,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .run(id,workspace,actor.agent_id,idempotency_key,bytes,reason,refs,nowIso());
  return {proposal:publicProposal(db.query('SELECT * FROM canon_proposals WHERE id=?').get(id) as Proposal)};
 }).immediate();
}
export function listCanonProposals(workspace:string,actor:string){
 if(!canManagePolicy(workspace,actor))throw new QoopiaError('FORBIDDEN','Only the workspace owner reviews canon proposals');
 const items=db.query("SELECT * FROM canon_proposals WHERE workspace_id=? AND status='pending' ORDER BY created_at,id LIMIT 100").all(workspace) as Proposal[];
 return {items:items.map(publicProposal)};
}
export function decideCanonProposal(workspace:string,actor:Actor,id:string,accept:boolean){
 if(!canManagePolicy(workspace,actor.agent_id))throw new QoopiaError('FORBIDDEN','Only the workspace owner reviews canon proposals');
 if(typeof accept!=='boolean')throw new QoopiaError('INVALID_INPUT','accept must be true or false');
 return db.transaction(()=>{
  const row=db.query('SELECT * FROM canon_proposals WHERE id=? AND workspace_id=?').get(id,workspace) as Proposal|null;
  if(!row)throw new QoopiaError('NOT_FOUND','Canon proposal unavailable');
  const status=accept?'accepted':'rejected';
  if(row.status!=='pending'){
   if(row.status!==status)throw new QoopiaError('CONFLICT','This canon proposal was already decided');
   return {proposal:publicProposal(row)};
  }
  // Creation still validates holder, project, current supersede head and related-rule conflicts.
  const canon=accept?createCanon({...draft.parse(JSON.parse(row.payload)),workspace_id:workspace,actor,source:'dreaming'}).canon:null;
  db.query('UPDATE canon_proposals SET status=?,canon_id=?,decided_by=?,decided_at=? WHERE id=?').run(status,canon?.id??null,actor.agent_id,nowIso(),id);
  logActivity({workspace_id:workspace,agent_id:actor.agent_id,action:'canon_proposal_decided',entity_type:'canon_proposal',entity_id:id,project_id:null,
   summary:'Canon proposal '+status,details:{event:'canon.proposal.'+status,params:{proposal_id:id,proposed_by:row.proposed_by,canon_id:canon?.id??null}},visibility:'workspace'});
  return {proposal:publicProposal(db.query('SELECT * FROM canon_proposals WHERE id=?').get(id) as Proposal)};
 }).immediate();
}
