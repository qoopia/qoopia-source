import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { db } from '../db/connection.ts';
import type { AuthContext } from '../auth/middleware.ts';
import { authorize, requireAgent } from '../auth/policy.ts';
import { QoopiaError } from '../utils/errors.ts';
import { assertNoSecrets } from '../utils/secret-guard.ts';
import { canonical, command, digest, type CommandContext } from './commands.ts';
import { versionOf, requireSkillRead, requireExactConsent, reviewSkill, registerPublisherKey, sealSkill } from './authority.ts';
import { NATIVE_RENDERER, assertPortableMembers, signaturePayload, type Descriptor } from './format.ts';
import { signManifest } from './legacy/signing.ts';

export const identifier = z.string().min(1).max(200);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const mutation = { expected_revision: z.number().int().nonnegative(), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) };
const safeText = z.string().max(4000);
import { RUNTIMES } from '../delivery/runtime-versions.ts';
export { RUNTIMES };
export type RuntimeKind = keyof typeof RUNTIMES;
export const runtimeCapabilities = { native_projection: true, load_observation: false, run_authorization_enforced: false,
  revocation_enforced: false, safe_cancel: false, hot_reload: false, offline_run: false,
  limitation: 'Qoopia checks each managed launch online. Direct native launches and instructions already read are outside revoke enforcement. High-risk activation is refused.' };
export function compatibility(kind: string, version: string, platform: string) {
  if (!(kind in RUNTIMES) || !['darwin-arm64','linux-x64'].includes(platform)) return { status: 'unsupported', reason: 'Runtime or OS/architecture is outside the P2 adapter matrix' };
  if (RUNTIMES[kind as RuntimeKind].version !== version) return { status: 'unknown', reason: 'This exact runtime version needs qualification before projection' };
  return { status: 'supported', qualification: 'native useful-task qualification is a separate gate', capabilities: runtimeCapabilities };
}
export interface Registration { id: string; workspace_id: string; actor_id: string; target_agent_id: string; reporter_id: string | null;
  runtime_kind: RuntimeKind; runtime_version: string; platform: string; revision: number; capabilities_json: string; managed_root: string | null; }
export interface Assignment { id: string; workspace_id: string; actor_id: string; runtime_id: string; target_agent_id: string; target_scope: string;
  slot: string; version_id: string; package_digest: string; desired_state: string; revision: number; epoch: number; approval_id: string;
  consent_id: string | null; adoption_operation_id: string; expires_at_ms: number; owner_epoch: number; }
export interface Loadout { id: string; workspace_id: string; actor_id: string; runtime_id: string; native_session_ref: string; qoopia_session_id: string;
  runtime_kind: RuntimeKind; runtime_version: string; snapshot_digest: string; capabilities_digest: string; policy_snapshot_digest: string; }
export interface Entry { id: string; workspace_id: string; loadout_id: string; assignment_id: string; version_id: string; candidate_digest: string;
  package_digest: string; projection_digest: string; renderer_version: string; slot: string; assignment_snapshot: string; }
export function registration(database: Database, workspace: string, id: string): Registration {
  const r = database.query('SELECT * FROM runtime_registrations WHERE id=? AND workspace_id=?').get(id, workspace) as Registration | null;
  if (!r) throw new QoopiaError('NOT_FOUND', 'Runtime registration not found');
  requireAgent(database, workspace, r.target_agent_id); return r;
}
export function reporter(database: Database, auth: AuthContext, runtimeId: string): Registration {
  const p = authorize(database, auth, 'report'), r = registration(database, p.workspace_id, runtimeId);
  if (r.reporter_id !== p.id) throw new QoopiaError('FORBIDDEN', 'Only the enrolled reporter for this runtime may report or launch');
  return r;
}
export function assignmentOf(database: Database, workspace: string, id: string): Assignment {
  const a = database.query('SELECT * FROM skill_assignments WHERE id=? AND workspace_id=?').get(id, workspace) as Assignment | null;
  if (!a) throw new QoopiaError('NOT_FOUND', 'Assignment not found'); return a;
}
export function notRevoked(database: Database, workspace: string, versionId: string) {
  if (database.query("SELECT 1 FROM skill_lifecycle_events WHERE workspace_id=? AND version_id=? AND kind='revoke'").get(workspace, versionId)) throw new QoopiaError('REVOKED', 'Version is revoked');
}
export function projection(database: Database, workspace: string, versionId: string) {
  const v = versionOf(database, workspace, versionId);
  if (v.status !== 'sealed') throw new QoopiaError('APPROVAL_REQUIRED', 'Compile and accept an exact native version before activation');
  const descriptor = JSON.parse(v.descriptor_json) as Descriptor;
  if (descriptor.renderer !== NATIVE_RENDERER) throw new QoopiaError('UNSUPPORTED', 'Compile a native candidate and review its final bytes first');
  const members = new Map<string, Buffer>(Object.entries(JSON.parse(v.members_json) as Record<string,string>).map(([n,b]) => [n,Buffer.from(b,'base64')]));
  if (digest(canonical(descriptor)) !== v.candidate_digest || !v.package_bytes || digest(v.package_bytes) !== v.package_digest) throw new QoopiaError('CHECKSUM_MISMATCH', 'Frozen package integrity failed');
  if (canonical(Object.keys(descriptor.members).sort()) !== canonical([...members.keys()].sort())) throw new QoopiaError('CHECKSUM_MISMATCH', 'Member map changed');
  for (const [name, bytes] of members) if (descriptor.members[name]?.sha256 !== digest(bytes) || descriptor.members[name]?.size !== bytes.length) throw new QoopiaError('CHECKSUM_MISMATCH', 'Frozen member bytes changed');
  assertPortableMembers(members);
  const slot = /^name: ([a-z0-9][a-z0-9-]{0,62})$/m.exec(members.get('SKILL.md')?.toString() ?? '')?.[1];
  if (!slot) throw new QoopiaError('UNSUPPORTED', 'Native frontmatter name is missing');
  return { v, descriptor, members, slot, projection_digest: digest(canonical(descriptor.members)) };
}
function lowRisk(descriptor: Descriptor, members: Map<string,Buffer>) {
  return descriptor.requested_capabilities.every(c => ['file_read','file_write_managed'].includes(c)) &&
    !descriptor.secret_placeholders.length && [...members.keys()].every(n => /\.(md|json|txt|csv)$/i.test(n));
}
function requireReview(database: Database, workspace: string, versionId: string, approvalId: string, targetScope: string) {
  const v = versionOf(database, workspace, versionId);
  const a = database.query(`SELECT a.* FROM skill_approvals a JOIN agents p ON p.id=a.actor_id AND p.workspace_id=a.workspace_id
    JOIN workspace_owners o ON o.actor_id=p.id AND o.workspace_id=p.workspace_id
    WHERE a.id=? AND a.workspace_id=? AND a.version_id=? AND p.active=1 AND p.principal_kind='human'
    AND p.policy_epoch=a.policy_version AND a.kind IN ('content_review','local_use')
    AND NOT EXISTS(SELECT 1 FROM skill_approvals n WHERE n.version_id=a.version_id AND n.actor_id=a.actor_id AND n.kind=a.kind AND n.decision_revision>a.decision_revision)`)
    .get(approvalId, workspace, versionId) as { decision: string; candidate_digest: string; expires_at_ms: number; target_scope: string } | null;
  if (!a || a.decision !== 'approve' || a.candidate_digest !== v.candidate_digest || a.expires_at_ms <= Date.now() || a.target_scope !== targetScope) throw new QoopiaError('APPROVAL_REQUIRED', 'Current human review for the exact bytes and target scope is required');
}
export function currentAssignmentPermission(database: Database, snapshot: Assignment, forActivation = false) {
  const current = assignmentOf(database, snapshot.workspace_id, snapshot.id);
  if (current.desired_state !== 'active') throw new QoopiaError('REVOKED', 'Assignment is paused or revoked');
  if (forActivation && current.epoch !== snapshot.epoch) throw new QoopiaError('STALE_REVISION', 'Assignment epoch changed before activation');
  const owner = requireAgent(database, snapshot.workspace_id, snapshot.actor_id);
  const ownerAuth: AuthContext = { agent_id: owner.id, workspace_id: owner.workspace_id, agent_name: owner.name, type: owner.type, source: 'api-key', policy_epoch: snapshot.owner_epoch };
  authorize(database, ownerAuth, 'owner');
  const r = registration(database, snapshot.workspace_id, snapshot.runtime_id);
  if (compatibility(r.runtime_kind, r.runtime_version, r.platform).status !== 'supported') throw new QoopiaError('UNSUPPORTED', 'Runtime compatibility changed');
  if (snapshot.expires_at_ms <= Date.now()) throw new QoopiaError('EXPIRED', 'Pinned grant expired; a new session and authorization are required');
  notRevoked(database, snapshot.workspace_id, snapshot.version_id);
  requireSkillRead(database, owner, versionOf(database, snapshot.workspace_id, snapshot.version_id).skill_id);
  // Owner assignment grants only these exact native bytes to the target. It
  // does not grant general reads of private source drafts, memory or other versions.
  requireReview(database, snapshot.workspace_id, snapshot.version_id, snapshot.approval_id, snapshot.target_scope);
  const projected = projection(database, snapshot.workspace_id, snapshot.version_id);
  if (snapshot.package_digest !== projected.v.package_digest) throw new QoopiaError('CHECKSUM_MISMATCH', 'Pinned package digest mismatch');
  if (!lowRisk(projected.descriptor, projected.members)) {
    if (!snapshot.consent_id) throw new QoopiaError('APPROVAL_REQUIRED', 'Separate exact human adoption consent required');
    requireExactConsent(database, ownerAuth, { approval_id: snapshot.consent_id, version_id: snapshot.version_id, package_digest: snapshot.package_digest,
      target_agent_id: snapshot.target_agent_id, runtime_id: snapshot.runtime_id, target_scope: snapshot.target_scope,
      operation_id: snapshot.adoption_operation_id, capabilities: projected.descriptor.requested_capabilities, policy_epoch: snapshot.owner_epoch });
    throw new QoopiaError('UNSUPPORTED', 'These native adapters cannot enforce fresh authorization on direct native launches; high-risk activation is refused');
  }
  return projected;
}
export function insertFact(database: Database, table: string, c: CommandContext, values: Record<string, string | number | null>) {
  // Table/column names are internal constants, never payload identifiers.
  const row = { id: randomUUID(), workspace_id: c.principal.workspace_id, actor_id: c.principal.id,
    origin_instance_id: (database.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id, created_at_ms: c.now, ...values };
  database.query(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return row.id;
}

export const acceptSchema = z.object({ version_id: identifier, expected_digest: hash, ...mutation,
  target_scope: identifier, expires_at_ms: z.number().int().positive() }).strict();
/** One human review; an ephemeral package attestation key never leaves this transaction. It is not an author identity. */
export function acceptLocalSkill(auth: AuthContext, input: unknown, database: Database = db) {
  const a = acceptSchema.parse(input);
  return command(database, auth, 'owner', 'skill_accept', a.idempotency_key, a, a.version_id,
    p => { requireSkillRead(database,p,versionOf(database,p.workspace_id,a.version_id).skill_id); notRevoked(database,p.workspace_id,a.version_id); }, c => {
      const v = versionOf(database,c.principal.workspace_id,a.version_id), descriptor = JSON.parse(v.descriptor_json) as Descriptor;
      if (v.candidate_digest !== a.expected_digest || v.status !== 'candidate') throw new QoopiaError('STALE_REVISION','Review requires the exact current candidate');
      const approved = reviewSkill(auth, { version_id: v.id, expected_digest: a.expected_digest, expected_revision: a.expected_revision,
        kind:'content_review', decision:'approve', evidence_class:'human_accepted', target_scope:a.target_scope,
        capabilities:descriptor.requested_capabilities, expires_at_ms:a.expires_at_ms, policy_epoch:c.principal.policy_epoch,
        idempotency_key:`${c.id}-review` },database);
      const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ type:'spki',format:'der' }).subarray(-32).toString('base64url');
      const kid = `local-accept-${c.id}`;
      registerPublisherKey(auth,{kid,public_key:publicKey,expected_revision:0,idempotency_key:`${c.id}-key`},database);
      const sealed = sealSkill(auth,{version_id:v.id,expected_digest:a.expected_digest,approval_ids:[approved.data.approval_id],
        publisher_key_id:kid,signature:signManifest(signaturePayload(descriptor),pair.privateKey,kid).jws,idempotency_key:`${c.id}-seal`},database);
      return { data:{...sealed.data,approval_id:approved.data.approval_id,provenance:'local_human_acceptance_ephemeral_attestation'},revision:1 };
    });
}
export const configureSchema = z.object({ runtime_id:identifier, runtime_kind:z.enum(['codex','claude_code']), runtime_version:identifier,
  platform:z.enum(['darwin-arm64','linux-x64','win32-x64']), ...mutation }).strict();
export function configureRuntime(auth: AuthContext,input:unknown,database:Database=db) {
  const a=configureSchema.parse(input);
  return command(database,auth,'owner','runtime_configure',a.idempotency_key,a,a.runtime_id,p=>{registration(database,p.workspace_id,a.runtime_id);},c=>{
    const r=registration(database,c.principal.workspace_id,a.runtime_id);
    if(r.revision!==a.expected_revision) throw new QoopiaError('STALE_REVISION','Runtime registration changed');
    if(database.query('SELECT 1 FROM session_loadouts WHERE runtime_id=?').get(r.id)) throw new QoopiaError('CONFLICT','Runtime identity is pinned by sessions; enroll a new registration for a different environment');
    const result=compatibility(a.runtime_kind,a.runtime_version,a.platform);
    if(result.status!=='supported') throw new QoopiaError('UNSUPPORTED',`${result.status}: ${result.reason}`);
    database.query('UPDATE runtime_registrations SET runtime_kind=?,runtime_version=?,platform=?,capabilities_json=?,revision=revision+1,updated_at_ms=? WHERE id=?')
      .run(a.runtime_kind,a.runtime_version,a.platform,canonical(runtimeCapabilities),c.now,r.id);
    return {data:{runtime_id:r.id,...result},revision:r.revision+1};
  });
}
export const assignSchema=z.object({ ...mutation, assignment_id:identifier.optional(), runtime_id:identifier, version_id:identifier,
  package_digest:hash, approval_id:identifier, consent_id:identifier.optional(), adoption_operation_id:identifier,
  target_scope:identifier, expires_at_ms:z.number().int().positive(), reason:z.enum(['assign','replace','rollback']).default('assign') }).strict();
export function assignSkill(auth:AuthContext,input:unknown,database:Database=db){
  const a=assignSchema.parse(input);
  const result=command(database,auth,'owner','skill_assign',a.idempotency_key,a,a.assignment_id??a.version_id,p=>{
    if(a.expires_at_ms<=Date.now())throw new QoopiaError('EXPIRED','Assignment authorization expired');
    const v=versionOf(database,p.workspace_id,a.version_id);requireSkillRead(database,p,v.skill_id);notRevoked(database,p.workspace_id,v.id);
    registration(database,p.workspace_id,a.runtime_id);
    requireReview(database,p.workspace_id,v.id,a.approval_id,a.target_scope);
    if(a.assignment_id) {const old=assignmentOf(database,p.workspace_id,a.assignment_id); if(old.runtime_id!==a.runtime_id || old.target_scope!==a.target_scope)throw new QoopiaError('CONFLICT','Target identity cannot change');}
  },c=>{
    const r=registration(database,c.principal.workspace_id,a.runtime_id), projected=projection(database,c.principal.workspace_id,a.version_id);
    if(a.package_digest!==projected.v.package_digest)throw new QoopiaError('STALE_REVISION','Exact package digest required');
    if(a.expires_at_ms<=c.now || a.expires_at_ms>c.now+86400_000)throw new QoopiaError('EXPIRED','Assignment expiry must be within 24 hours');
    const old=a.assignment_id?assignmentOf(database,c.principal.workspace_id,a.assignment_id):null;
    if((old?.revision??0)!==a.expected_revision)throw new QoopiaError('STALE_REVISION','Assignment revision changed');
    if(old && (old.slot!==projected.slot || versionOf(database,old.workspace_id,old.version_id).skill_id!==projected.v.skill_id))throw new QoopiaError('CONFLICT','Replacement must preserve skill identity and native name');
    if(a.reason==='rollback' && (!old || !database.query("SELECT 1 FROM skill_assignment_revisions WHERE assignment_id=? AND json_extract(snapshot_json,'$.version_id')=?").get(old.id,a.version_id)))throw new QoopiaError('INVALID_INPUT','Rollback must name an earlier assigned version');
    const id=old?.id??randomUUID(), revision=(old?.revision??0)+1;
    const values={runtime_id:r.id,target_agent_id:r.target_agent_id,target_scope:a.target_scope,slot:projected.slot,version_id:a.version_id,package_digest:a.package_digest,
      desired_state:'active',approval_id:a.approval_id,consent_id:a.consent_id??null,adoption_operation_id:a.adoption_operation_id,expires_at_ms:a.expires_at_ms,owner_epoch:c.principal.policy_epoch,
      revision,epoch:(old?.epoch??0)+1,updated_at_ms:c.now};
    if(old)database.query(`UPDATE skill_assignments SET ${Object.keys(values).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(values),id);
    else {if(database.query('SELECT 1 FROM skill_assignments WHERE runtime_id=? AND target_scope=? AND slot=?').get(r.id,a.target_scope,projected.slot))throw new QoopiaError('CONFLICT','Native slot is already assigned; choose an explicit replacement');insertFact(database,'skill_assignments',c,{id,...values});}
    const assigned=assignmentOf(database,c.principal.workspace_id,id);
    currentAssignmentPermission(database,assigned,true);
    insertFact(database,'skill_assignment_revisions',c,{assignment_id:id,revision,snapshot_json:canonical(assigned),command_id:c.id,reason:a.reason});
    return {data:{assignment_id:id,epoch:assigned.epoch,desired_state:'active',actual_state:'waiting_for_next_session',effective_from:'next_session'},revision};
  });
  const current=assignmentOf(database,auth.workspace_id,result.data.assignment_id);
  if(current.revision!==result.revision)throw new QoopiaError('STALE_REVISION','Assignment changed after this command; inspect its current state');
  currentAssignmentPermission(database,current,true);return result;
}
export const updateSchema=z.object({...mutation,assignment_id:identifier,desired_state:z.enum(['paused','revoked']),reason:safeText}).strict();
export function updateAssignment(auth:AuthContext,input:unknown,database:Database=db){
  const a=updateSchema.parse(input);assertNoSecrets(a.reason,'assignment reason');
  return command(database,auth,'owner','skill_assignment_update',a.idempotency_key,a,a.assignment_id,p=>{assignmentOf(database,p.workspace_id,a.assignment_id);},c=>{
    const old=assignmentOf(database,c.principal.workspace_id,a.assignment_id);
    if(old.revision!==a.expected_revision)throw new QoopiaError('STALE_REVISION','Assignment changed');
    database.query('UPDATE skill_assignments SET desired_state=?,revision=revision+1,epoch=epoch+1,updated_at_ms=? WHERE id=?').run(a.desired_state,c.now,old.id);
    const next=assignmentOf(database,c.principal.workspace_id,old.id);
    insertFact(database,'skill_assignment_revisions',c,{assignment_id:old.id,revision:next.revision,snapshot_json:canonical(next),command_id:c.id,reason:a.reason});
    return {data:{assignment_id:old.id,desired_state:a.desired_state,limitation:runtimeCapabilities.limitation},revision:next.revision};
  });
}
export const lifecycleSchema=z.object({...mutation,version_id:identifier,kind:z.enum(['deprecate','revoke','supersede']),successor_id:identifier.optional(),reason:safeText}).strict();
export function skillLifecycle(auth:AuthContext,input:unknown,database:Database=db){
  const a=lifecycleSchema.parse(input);assertNoSecrets(a.reason,'lifecycle reason');
  return command(database,auth,'owner','skill_lifecycle',a.idempotency_key,a,a.version_id,p=>requireSkillRead(database,p,versionOf(database,p.workspace_id,a.version_id).skill_id),c=>{
    const v=versionOf(database,c.principal.workspace_id,a.version_id);
    const n=(database.query('SELECT count(*) n FROM skill_lifecycle_events WHERE version_id=?').get(v.id) as {n:number}).n;
    if(n!==a.expected_revision)throw new QoopiaError('STALE_REVISION','Lifecycle changed');
    if(a.kind==='supersede'){
      if(!a.successor_id || a.successor_id===v.id || versionOf(database,v.workspace_id,a.successor_id).skill_id!==v.skill_id)throw new QoopiaError('INVALID_INPUT','Same-skill successor required');
      if(database.query(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT e.successor_id FROM skill_lifecycle_events e JOIN chain c ON e.version_id=c.id WHERE e.kind='supersede') SELECT 1 FROM chain WHERE id=?`).get(a.successor_id,v.id))throw new QoopiaError('CONFLICT','Supersession cycle');
    }
    const id=insertFact(database,'skill_lifecycle_events',c,{version_id:v.id,kind:a.kind,successor_id:a.successor_id??null,reason:a.reason});
    return {data:{event_id:id,kind:a.kind},revision:n+1};
  });
}

export const sessionSchema=z.object({...mutation,runtime_id:identifier,native_session_ref:identifier,qoopia_session_id:identifier}).strict();
export function entriesOf(database:Database,loadoutId:string):Entry[]{return database.query('SELECT * FROM session_loadout_entries WHERE loadout_id=? ORDER BY slot,id').all(loadoutId) as Entry[];}
export function loadoutOf(database:Database,workspace:string,id:string):Loadout{
  const l=database.query('SELECT * FROM session_loadouts WHERE id=? AND workspace_id=?').get(id,workspace) as Loadout|null;
  if(!l)throw new QoopiaError('NOT_FOUND','Loadout not found');return l;
}
export function sessionOpen(auth:AuthContext,input:unknown,database:Database=db){
  const a=sessionSchema.parse(input);
  return command(database,auth,'report','skill_session_open',a.idempotency_key,a,a.native_session_ref,p=>{
    const r=reporter(database,auth,a.runtime_id);
    const existing=database.query('SELECT * FROM session_loadouts WHERE runtime_id=? AND native_session_ref=?').get(r.id,a.native_session_ref) as Loadout|null;
    if(existing){if(existing.qoopia_session_id!==a.qoopia_session_id)throw new QoopiaError('CONFLICT','Native session is bound to another Qoopia session');return;}
    const source=database.query('SELECT * FROM sessions WHERE id=?').get(a.qoopia_session_id) as {workspace_id:string;agent_id:string}|null;
    if(source && (source.workspace_id!==p.workspace_id || source.agent_id!==r.target_agent_id))throw new QoopiaError('NOT_FOUND','Session not in runtime target scope');
  },c=>{
    const r=reporter(database,auth,a.runtime_id);
    const prior=database.query('SELECT * FROM session_loadouts WHERE runtime_id=? AND native_session_ref=?').get(r.id,a.native_session_ref) as Loadout|null;
    if(prior)return {data:{loadout_id:prior.id,snapshot_digest:prior.snapshot_digest},revision:1};
    if(a.expected_revision!==0)throw new QoopiaError('STALE_REVISION','New session requires revision zero');
    if(compatibility(r.runtime_kind,r.runtime_version,r.platform).status!=='supported')throw new QoopiaError('UNSUPPORTED','Runtime requires exact-version configuration');
    const assignments=database.query("SELECT * FROM skill_assignments WHERE runtime_id=? AND desired_state='active' ORDER BY slot,id").all(r.id) as Assignment[];
    if(assignments.length>64)throw new QoopiaError('SIZE_LIMIT','At most 64 skills per session');
    const selected=assignments.map(s=>({s,p:currentAssignmentPermission(database,s,true)}));
    if(new Set(selected.map(({s})=>s.slot)).size!==selected.length)throw new QoopiaError('CONFLICT','Multiple scopes claim one native name');
    const id=randomUUID(),snapshot=selected.map(({s,p})=>({assignment:s,projection_digest:p.projection_digest}));
    database.query('INSERT OR IGNORE INTO sessions(id,workspace_id,agent_id,title) VALUES (?,?,?,?)').run(a.qoopia_session_id,c.principal.workspace_id,r.target_agent_id,'Managed runtime session');
    insertFact(database,'session_loadouts',c,{id,runtime_id:r.id,native_session_ref:a.native_session_ref,qoopia_session_id:a.qoopia_session_id,
      runtime_kind:r.runtime_kind,runtime_version:r.runtime_version,capabilities_digest:digest(r.capabilities_json),policy_snapshot_digest:digest(canonical(assignments)),snapshot_digest:digest(canonical(snapshot))});
    for(const {s,p} of selected)insertFact(database,'session_loadout_entries',c,{loadout_id:id,assignment_id:s.id,version_id:s.version_id,candidate_digest:p.v.candidate_digest,
      package_digest:s.package_digest,projection_digest:p.projection_digest,renderer_version:p.descriptor.renderer,slot:s.slot,assignment_snapshot:canonical(s)});
    return {data:{loadout_id:id,snapshot_digest:digest(canonical(snapshot))},revision:1};
  });
}
export const loadoutSchema=z.object({loadout_id:identifier}).strict();
export function sessionGet(auth:AuthContext,input:unknown,database:Database=db){
  const a=loadoutSchema.parse(input),p=authorize(database,auth,'report'),l=loadoutOf(database,p.workspace_id,a.loadout_id);reporter(database,auth,l.runtime_id);
  return {loadout:l,entries:entriesOf(database,l.id).map(e=>{let status='authorized';try{currentAssignmentPermission(database,JSON.parse(e.assignment_snapshot));}catch(error){status=error instanceof QoopiaError?error.code:'NOT_READY';}return {...e,current_authorization:status};}),capabilities:runtimeCapabilities};
}
export const viewSchema=z.object({skill_id:identifier.optional()}).strict();

type Readiness = { ready:boolean; blockers:string[] };
function readinessError(error:unknown):string {
  return error instanceof QoopiaError ? `${error.code}: ${error.message}` : 'NOT_READY: Current authority could not be verified';
}
export function assignmentReadiness(database:Database,assignment:Assignment):Readiness {
  try { currentAssignmentPermission(database,assignment,true); return {ready:true,blockers:[]}; }
  catch(error) { return {ready:false,blockers:[readinessError(error)]}; }
}
function approvalReadiness(database:Database,workspace:string,approval:any,now=Date.now()):Readiness {
  const blockers:string[]=[];
  if(!['content_review','local_use'].includes(approval.kind))blockers.push('Approval kind cannot authorize local use');
  if(approval.decision!=='approve')blockers.push(`Approval is ${approval.decision}`);
  if(approval.expires_at_ms<=now)blockers.push('Approval expired');
  if(database.query(`SELECT 1 FROM skill_approvals WHERE workspace_id=? AND version_id=? AND actor_id=? AND kind=? AND decision_revision>?`).get(
    workspace,approval.version_id,approval.actor_id,approval.kind,approval.decision_revision))blockers.push('A newer review supersedes this approval');
  if(!database.query(`SELECT 1 FROM agents a JOIN workspace_owners o ON o.workspace_id=a.workspace_id AND o.actor_id=a.id
    WHERE a.workspace_id=? AND a.id=? AND a.active=1 AND a.principal_kind='human' AND a.policy_epoch=?`).get(workspace,approval.actor_id,approval.policy_version))
    blockers.push('Approving owner authority changed');
  return {ready:!blockers.length,blockers};
}
export function loopView(auth:AuthContext,input:unknown,database:Database=db){
  const a=viewSchema.parse(input),p=authorize(database,auth,'read');
  if(a.skill_id)requireSkillRead(database,p,a.skill_id);
  const visible=(skillId:string)=>{try{requireSkillRead(database,p,skillId);return true;}catch{return false;}};
  const versions=(database.query('SELECT id,skill_id,version_label,candidate_digest,package_digest,status,license,created_at_ms FROM skill_versions WHERE workspace_id=? ORDER BY created_at_ms,id').all(p.workspace_id) as {id:string;skill_id:string}[]).filter(v=>(!a.skill_id||a.skill_id===v.skill_id)&&visible(v.skill_id));
  const ids=new Set(versions.map(v=>v.id));
  const rawAssignments=(database.query('SELECT * FROM skill_assignments WHERE workspace_id=? ORDER BY slot,id').all(p.workspace_id) as Assignment[]).filter(s=>ids.has(s.version_id));
  const assignments=rawAssignments.map(assignment=>({...assignment,readiness:assignmentReadiness(database,assignment)}));
  const runs=(database.query('SELECT * FROM skill_runs WHERE workspace_id=? ORDER BY created_at_ms,id').all(p.workspace_id) as Array<Record<string,any>&{id:string;version_id:string}>).filter(r=>ids.has(r.version_id));
  const runIds=new Set(runs.map(r=>r.id));
  const outcomes=(database.query('SELECT * FROM skill_outcomes WHERE workspace_id=? ORDER BY created_at_ms,id').all(p.workspace_id) as Array<Record<string,any>&{run_id:string;actor_id:string;revision:number}>).filter(o=>runIds.has(o.run_id));
  const latestOutcomes=new Map<string,typeof outcomes[number]>();for(const outcome of outcomes)latestOutcomes.set(`${outcome.actor_id}:${outcome.run_id}`,outcome);
  const rawRegistrations=database.query('SELECT id,target_agent_id,reporter_id,runtime_id,runtime_kind,runtime_version,platform,managed_root,revision FROM runtime_registrations WHERE workspace_id=?').all(p.workspace_id) as any[];
  const registrations=rawRegistrations.map(registration=>{
    const result=compatibility(registration.runtime_kind,registration.runtime_version,registration.platform),blockers:string[]=[];
    if(result.status!=='supported')blockers.push(result.reason??'Runtime is not compatible');
    const run_blockers=[...blockers];if(!registration.reporter_id)run_blockers.push('No enrolled runtime reporter');if(!registration.managed_root)run_blockers.push('Runtime is not bound to a managed root');
    return {...registration,readiness:{assignable:!blockers.length,runnable:!run_blockers.length,blockers,run_blockers}};
  });
  const rawApprovals=(database.query('SELECT id,version_id,actor_id,kind,decision,decision_revision,target_scope,expires_at_ms,policy_version FROM skill_approvals WHERE workspace_id=? ORDER BY created_at_ms,id').all(p.workspace_id) as Array<Record<string,any>&{version_id:string}>).filter(a=>ids.has(a.version_id));
  const approvals=rawApprovals.map(approval=>({...approval,readiness:approvalReadiness(database,p.workspace_id,approval)}));
  const ratings=(database.query('SELECT * FROM skill_ratings WHERE workspace_id=? ORDER BY created_at_ms,id').all(p.workspace_id) as Array<Record<string,any>&{run_id:string;actor_id:string;version_id:string;revision:number;score:number}>).filter(r=>runIds.has(r.run_id));
  const latestRatings=new Map<string,typeof ratings[number]>();for(const rating of ratings)latestRatings.set(`${rating.actor_id}:${rating.run_id}:${rating.version_id}`,rating);
  const observations=(database.query('SELECT o.*,e.version_id FROM runtime_observations o JOIN session_loadout_entries e ON e.id=o.entry_id WHERE o.workspace_id=? ORDER BY o.event_seq').all(p.workspace_id) as {entry_id:string}[]).filter(o=>{const e=database.query('SELECT version_id FROM session_loadout_entries WHERE id=?').get(o.entry_id) as {version_id:string}|null;return e&&ids.has(e.version_id);});
  return {versions,assignments,approvals,observations,ratings,latest_ratings:[...latestRatings.values()],feedback_aggregate:{eligible_votes:latestRatings.size,self_report_average:latestRatings.size?[...latestRatings.values()].reduce((n,r)=>n+r.score,0)/latestRatings.size:null,independent_reputation_weight:0},runs:runs.map(run=>{const latest=[...latestOutcomes.values()].filter(outcome=>outcome.run_id===run.id);return {...run,latest_outcomes:latest,ratings:[...latestRatings.values()].filter(rating=>rating.run_id===run.id),closure_status:latest.length?'reported':'nothing_reported'};}),outcomes,latest_outcomes:[...latestOutcomes.values()],registrations,
    lifecycle:database.query('SELECT * FROM skill_lifecycle_events WHERE workspace_id=?').all(p.workspace_id).filter((r:any)=>ids.has(r.version_id)),
    capabilities:runtimeCapabilities};
}
