import { randomUUID } from 'node:crypto';
import { bootstrapOwner, issuePairing, redeemPairing } from '../../src/auth/pairings.ts';
import { p1Database, principalAuth, completeContent } from './p1-fixtures.ts';
import { captureSkill } from '../../src/skills/capture.ts';
import { compileDraft, versionOf } from '../../src/skills/authority.ts';
import { configureRuntime, acceptLocalSkill, assignSkill, sessionOpen, entriesOf, type RuntimeKind, RUNTIMES } from '../../src/skills/loop.ts';
export function loopFixture(kind:RuntimeKind='codex'){
  const database=p1Database(46),owner=bootstrapOwner(database,'Owner','P2 fixture'),auth=principalAuth(database,owner.agent_id);
  const pair=(profile:string,name:string,target_agent_id?:string)=>redeemPairing(issuePairing(auth,{profile,name,runtime_id:kind,...(target_agent_id?{target_agent_id}:{}),expected_revision:1,idempotency_key:randomUUID()},database).one_time_code!,database);
  const target=pair('memory-worker','Runtime target'),rep=pair('runtime-reporter','Reporter',target.data.agent_id),runtimeId=target.data.runtime_registration_id;
  const reportAuth=principalAuth(database,rep.data.agent_id);
  configureRuntime(auth,{runtime_id:runtimeId,runtime_kind:kind,runtime_version:RUNTIMES[kind].version,platform:'darwin-arm64',expected_revision:2,idempotency_key:randomUUID()},database);
  return {database,owner,auth,target,reportAuth,runtimeId};
}
export const csvContent={...completeContent,title:'Summarize category amounts',purpose:'Validate category,amount CSV and write a deterministic JSON summary inside this task directory.',
  outputs_schema:{type:'object',required:['summary.json','refusal.json'],additionalProperties:false,properties:{
    'summary.json':{type:'object',required:['counts','totals','overall'],additionalProperties:false,properties:{
      counts:{type:'object',minProperties:1,additionalProperties:{type:'integer',minimum:1}},
      totals:{type:'object',minProperties:1,additionalProperties:{type:'number'}},overall:{type:'number'}}},
    'refusal.json':{type:'object',required:['status','reason'],additionalProperties:false,
      properties:{status:{const:'refused'},reason:{const:'invalid_amount'}}}}},
  procedure:['Read input.csv. Require the exact category,amount header and finite decimal amounts. Reject invalid rows without writing a summary.',
    'The Outputs schema maps filenames to their separate JSON contents. Write each file independently, not a combined wrapper or Markdown.',
    'For input.csv, write summary.json with exactly counts, totals and overall. counts is an object mapping every input category to its integer row count. totals is an object mapping the same categories to their numeric amount sums. overall is the numeric sum of all amounts, not an object. Compute every category and value from the input; never hardcode dataset answers.',
    'Do not add source, status, detail, categories or any other keys to summary.json. Do not use a categories array.',
    'For invalid.csv, write refusal.json with exactly {"status":"refused","reason":"invalid_amount"}, with no additional fields. Do not create invalid-summary.json; preserve the valid-input summary.json.'],
  verification:['Check each output against its per-file JSON schema, including required keys, value types and no additional fields. Check counts and totals against every input row. Confirm no writes outside the task directory.'],
  requested_capabilities:['file_read','file_write_managed'],compatibility:[],rollback:'Remove only the generated task outputs, preserving inputs.'};
export function accepted(f:ReturnType<typeof loopFixture>,label='1',draft_id?:string,revision=0,slug='csv-summary'){
  const d=captureSkill(f.auth,{kind:'manual',title:csvContent.title,slug,text:'1. Validate input.\n2. Group and sum.',content:csvContent,
    choice:draft_id?'update':'new',...(draft_id?{draft_id}:{}),expected_revision:revision,idempotency_key:randomUUID(),metadata:{variant:label}},f.database);
  const id=String(d.data.draft_id),c=compileDraft(f.auth,{draft_id:id,expected_revision:revision+1,version_label:label,license:'MIT',native_name:slug,idempotency_key:randomUUID()},f.database);
  const a=acceptLocalSkill(f.auth,{version_id:c.data.version_id,expected_digest:c.data.candidate_digest,target_scope:'project',expires_at_ms:Date.now()+3600_000,expected_revision:0,idempotency_key:randomUUID()},f.database);
  return {draft_id:id,version:versionOf(f.database,f.auth.workspace_id,c.data.version_id),approval:a.data.approval_id};
}
export function assigned(f:ReturnType<typeof loopFixture>,v:ReturnType<typeof accepted>,assignment_id?:string,revision=0,reason='assign'){
  return assignSkill(f.auth,{runtime_id:f.runtimeId,version_id:v.version.id,package_digest:v.version.package_digest,approval_id:v.approval,
    adoption_operation_id:randomUUID(),target_scope:'project',expires_at_ms:Date.now()+600_000,...(assignment_id?{assignment_id}:{}),expected_revision:revision,reason,idempotency_key:randomUUID()},f.database);
}
export function opened(f:ReturnType<typeof loopFixture>,nativeRef=randomUUID()){
  const a={runtime_id:f.runtimeId,native_session_ref:nativeRef,qoopia_session_id:randomUUID(),expected_revision:0,idempotency_key:randomUUID()};
  const l=sessionOpen(f.reportAuth,a,f.database);return {args:a,id:l.data.loadout_id,entries:entriesOf(f.database,l.data.loadout_id)};
}
