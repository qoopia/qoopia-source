import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {loopFixture,csvContent,accepted,assigned,opened} from './helpers/p2-fixtures.ts';
import {captureSkill} from '../src/skills/capture.ts';
import {compileDraft} from '../src/skills/authority.ts';
import {assignSkill,updateAssignment,projection} from '../src/skills/loop.ts';
import {claimProjection,checkClaim,observeRuntime,failProjection} from '../src/skills/runtime.ts';
import {compileContent,assertPortableMembers} from '../src/skills/format.ts';
import {writeTar} from '../src/skills/legacy/archive.ts';
const mutation=()=>({expected_revision:0,idempotency_key:randomUUID()});
test('T-08 native consent changes with license/renderer/script; high risk and synthetic nested credential refuse',()=>{
 const f=loopFixture();try{
  const first=accepted(f),base=compileContent(csvContent,'1','MIT',{},'csv-summary');
  expect(base.candidate_digest).not.toBe(compileContent(csvContent,'1','Apache-2.0',{},'csv-summary').candidate_digest);
  expect(base.candidate_digest).not.toBe(compileContent(csvContent,'1','MIT').candidate_digest);
  expect(base.candidate_digest).not.toBe(compileContent(csvContent,'1','MIT',{'scripts/task.sh':Buffer.from('echo synthetic').toString('base64')},'csv-summary').candidate_digest);
  const draft=captureSkill(f.auth,{kind:'manual',title:csvContent.title,slug:'high-risk',content:{...csvContent,requested_capabilities:['shell']},text:'1. Run.\n2. Verify.',...mutation()},f.database);
  const candidate=compileDraft(f.auth,{draft_id:draft.data.draft_id,expected_revision:1,version_label:'risk',license:'MIT',native_name:'high-risk',idempotency_key:randomUUID()},f.database);
  expect(()=>assignSkill(f.auth,{runtime_id:f.runtimeId,version_id:candidate.data.version_id,package_digest:first.version.package_digest,approval_id:first.approval,adoption_operation_id:'risk',target_scope:'project',expires_at_ms:Date.now()+10000,...mutation()},f.database)).toThrow();
  const original=csvContent.requested_capabilities;csvContent.requested_capabilities=['shell'];
  let high:ReturnType<typeof accepted>;try{high=accepted(f,'1',undefined,0,'high-accepted');}finally{csvContent.requested_capabilities=original;}
  expect(()=>assigned(f,high!),).toThrow('Separate exact human adoption consent');
  expect(f.database.query('SELECT count(*) n FROM skill_assignments').get()).toEqual({n:0});
  const secret='ghp_'+'Z9'.repeat(20),nested=writeTar(new Map([['inside.txt',Buffer.from(secret)]]));
  expect(()=>assertPortableMembers(new Map([['nested.tar',nested]]))).toThrow();
  expect(()=>assertPortableMembers(new Map([['/absolute.txt',Buffer.from('fixture')]]))).toThrow();
  expect(projection(f.database,f.auth.workspace_id,first.version.id).descriptor.members['SKILL.md']).toBeTruthy();
 }finally{f.database.close();}
});
test('T-07/T-18 lease expiry/retry fencing and paused assignment replay cannot authorize projection',()=>{
 const f=loopFixture();try{
  const v=accepted(f),a=assigned(f,v),s=opened(f),e=s.entries[0]!;
  const args={loadout_id:s.id,...mutation()},old=claimProjection(f.reportAuth,args,f.database).data;
  f.database.query('UPDATE memory_event_outbox SET lease_expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),old.outbox_id);
  expect(()=>claimProjection(f.reportAuth,args,f.database)).toThrow('expired');
  const next=claimProjection(f.reportAuth,{...args,idempotency_key:randomUUID()},f.database).data;expect(next.token).toBe(old.token+1);
  expect(()=>checkClaim(f.database,f.reportAuth,old)).toThrow('fenced');
  const stale=observeRuntime(f.reportAuth,{loadout_id:s.id,entry_id:e.id,version_id:e.version_id,projection_digest:e.projection_digest,kind:'projection_readback',event_id:'old-worker',observed_at_ms:Date.now(),evidence:{subtype:'readback',claim:old},...mutation()},f.database);
  expect(stale.data.stale).toBe(true);
  failProjection(f.database,f.reportAuth,next,'MANUAL_DRIFT');expect(()=>claimProjection(f.reportAuth,{...args,idempotency_key:randomUUID()},f.database)).toThrow('retry time');
  updateAssignment(f.auth,{assignment_id:a.data.assignment_id,desired_state:'paused',reason:'owner pause',expected_revision:1,idempotency_key:randomUUID()},f.database);
  expect(()=>claimProjection(f.reportAuth,{...args,idempotency_key:randomUUID()},f.database)).toThrow('paused');
  expect(f.database.query('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{f.database.close();}
});
