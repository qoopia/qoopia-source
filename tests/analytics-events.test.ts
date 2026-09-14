import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {eventStore,browserEvent} from '../src/analytics/events.ts';

test('event records reject content and secrets; duplicate delivery is idempotent',()=>{
 const db=new Database(':memory:');const store=eventStore(db,()=>1234);const e={id:randomUUID(),kind:'download_click',platform:'mac'};
 expect(store.write(e,'browser')).toBe(true);expect(store.write(e,'browser')).toBe(false);
 for(const extra of [{email:'private@example.test'},{token:'secret'},{url:'https://a/#secret'},{query:'private memory'},{duration_ms:Infinity}])expect(()=>store.write({...e,id:randomUUID(),...extra})).toThrow();
 expect(db.query('SELECT count(*) AS n FROM analytics_events').get()).toEqual({n:1});db.close();
});
test('browser cannot submit trusted events, foreign origins, oversized bodies or credential properties',async()=>{
 const writes:unknown[]=[];
 const send=(body:unknown,origin='https://qoopia.ai')=>browserEvent(new Request('https://auth.qoopia.ai/analytics/events',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),v=>{writes.push(v);return true;});
 expect((await send({id:randomUUID(),kind:'site_view',page:'home'})).status).toBe(204);
 expect((await send({id:randomUUID(),kind:'profile_login'})).status).toBe(400);
 expect((await send({id:randomUUID(),kind:'site_view'},'https://evil.example')).status).toBe(403);
 expect((await send({id:randomUUID(),kind:'site_view',email:'x@example.test'})).status).toBe(400);
 expect((await send({id:randomUUID(),kind:'site_view',junk:'a'.repeat(4096)})).status).toBe(413);
 expect(writes).toHaveLength(1);
});
test('browser privacy signal prevents collection and preflight sends no credentials allowance',async()=>{
 let writes=0;const write=()=>{writes++;return true;};
 const response=await browserEvent(new Request('https://auth.qoopia.ai/analytics/events',{method:'POST',headers:{origin:'https://qoopia.ai','sec-gpc':'1'},body:'{}'}),write);
 expect(response.status).toBe(204);expect(writes).toBe(0);
 const preflight=await browserEvent(new Request('https://auth.qoopia.ai/analytics/events',{method:'OPTIONS',headers:{origin:'https://qoopia.ai'}}),write);
 expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-origin')).toBe('https://qoopia.ai');expect(preflight.headers.has('access-control-allow-credentials')).toBe(false);
});
test('event ingestion has a measurable daily bound and duplicate IDs do not consume capacity',()=>{
 const db=new Database(':memory:');const store=eventStore(db,()=>0,1);const e={id:randomUUID(),kind:'profile_login'};
 expect(store.write(e)).toBe(true);expect(store.write(e)).toBe(false);expect(store.write({...e,id:randomUUID()})).toBe(false);
 expect(db.query('SELECT accepted,dropped FROM analytics_daily').get()).toEqual({accepted:1,dropped:1});db.close();
});
