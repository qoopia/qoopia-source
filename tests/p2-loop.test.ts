import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loopFixture, accepted, assigned, opened, csvContent } from './helpers/p2-fixtures.ts';
import { captureSkill } from '../src/skills/capture.ts';
import { sessionOpen, sessionGet, currentAssignmentPermission, skillLifecycle, assignSkill, compatibility } from '../src/skills/loop.ts';
import { digest } from '../src/skills/commands.ts';

test('T-35 frozen loadout survives assignment replacement and reopen; revoke overlays history',()=>{
  const f=loopFixture();try{
    const v1=accepted(f),a=assigned(f,v1),s1=opened(f),saved=JSON.stringify(s1.entries);
    // An actual revision changes the content, while the first native generation stays frozen.
    const old=csvContent.procedure[1];csvContent.procedure[1]+=' Preserve sorted categories.';
    const v2=accepted(f,'2',v1.draft_id,1);csvContent.procedure[1]=old;
    assigned(f,v2,a.data.assignment_id,1,'replace');const s2=opened(f);
    expect(s2.entries[0].version_id).toBe(v2.version.id);expect(s1.entries[0].version_id).toBe(v1.version.id);
    expect(sessionOpen(f.reportAuth,{...s1.args,idempotency_key:randomUUID()},f.database).data.loadout_id).toBe(s1.id);
    expect(JSON.stringify(sessionGet(f.reportAuth,{loadout_id:s1.id},f.database).entries.map(({current_authorization:_current,...e})=>e))).toBe(saved);
    expect(()=>currentAssignmentPermission(f.database,JSON.parse(s1.entries[0].assignment_snapshot))).not.toThrow();
    skillLifecycle(f.auth,{version_id:v1.version.id,kind:'revoke',reason:'fixture revoke',expected_revision:0,idempotency_key:randomUUID()},f.database);
    expect(sessionGet(f.reportAuth,{loadout_id:s1.id},f.database).entries[0].current_authorization).toBe('REVOKED');
    expect(JSON.stringify(sessionGet(f.reportAuth,{loadout_id:s1.id},f.database).entries.map(({current_authorization:_current,...e})=>e))).toBe(saved);
    expect(()=>assigned(f,v1,a.data.assignment_id,2,'rollback')).toThrow('revoked');
    expect(f.database.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{f.database.close();}
});
test('T-04 RU/EN deterministic redaction, one-off refusal, dedupe and no portable credential',()=>{
  const f=loopFixture();try{
    const secret='ghp_'+'Z9'.repeat(20);
    const args={kind:'manual',locale:'ru',title:'Проверить CSV '+secret,slug:'redacted',text:'1. Прочитать CSV.\n2. Сложить суммы. '+secret,metadata:{private:secret},filename:'/Users/owner/'+secret+'.md',expected_revision:0,idempotency_key:randomUUID()};
    const d=captureSkill(f.auth,args,f.database);
    expect(d.data.outcome).toBe('drafted');expect(JSON.stringify(d)).not.toContain(secret);expect(d.data.findings.length).toBeGreaterThan(0);
    expect(captureSkill(f.auth,{...args,idempotency_key:randomUUID()},f.database).data.reused).toBe(true);
    expect(captureSkill(f.auth,{...args,slug:'oneoff',text:'Только один раз. 1. Restart',idempotency_key:randomUUID()},f.database).data.outcome).toBe('refused');
    const rows=f.database.query('SELECT response_json FROM authority_commands').all();expect(JSON.stringify(rows)).not.toContain(secret);
    expect(compatibility('codex','unknown','darwin-arm64').status).toBe('unknown');expect(compatibility('codex','0.153.3','win32-x64').status).toBe('unsupported');
    expect(()=>assignSkill(f.reportAuth,{},f.database)).toThrow();expect(digest('fixture')).toHaveLength(64);
  }finally{f.database.close();}
});
