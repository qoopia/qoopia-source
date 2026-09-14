import {test,expect} from 'bun:test';
test('analytical collector preserves source truth, idempotency, read-only boundaries and secret-free failures',()=>{
 const r=Bun.spawnSync(['python3','tests/helpers/analytics_collector_test.py'],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
 expect(new TextDecoder().decode(r.stderr)).toContain('OK');expect(r.exitCode).toBe(0);
});
