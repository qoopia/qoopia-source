/**
 * An agent on another computer sends its session memory through the installation's tunnel edge.
 * The edge publishes /memory/continuity for key-authenticated POSTs only, with the continuity body limit.
 */
import {afterAll,beforeAll,expect,test} from 'bun:test';
import http,{type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {db} from '../src/db/connection.ts';
import {startHttpServer} from '../src/http.ts';
import {startMcpEdge} from '../src/delivery/mcp-edge.ts';
import {ingestLimiter} from '../src/utils/rate-limit.ts';
import {CONTINUITY_MAX_BODY_BYTES} from '../src/utils/http-json.ts';

const HOST='continuity-edge.example';
let server:Server,edge:Server,key='';
beforeAll(async()=>{
  runMigrations();const ws=createWorkspace({name:'Edge continuity',slug:'edge-continuity-'+randomUUID()});
  key=createAgent({name:'Qoopia Claude memory remote',workspaceSlug:ws.slug}).api_key;
  db.query("UPDATE agents SET tool_profile='no-destructive',legacy_skill_access=0 WHERE workspace_id=?").run(ws.id);
  server=startHttpServer();if(!server.listening)await once(server,'listening');
  edge=startMcpEdge({publicOrigin:'https://'+HOST,upstreamPort:(server.address() as AddressInfo).port});if(!edge.listening)await once(edge,'listening');
});
afterAll(async()=>{for(const s of [edge,server]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
const post=(body:string,headers:Record<string,string>={},method='POST')=>new Promise<{status:number;body:string}>((resolve,reject)=>{
  const r=http.request({port:(edge.address() as AddressInfo).port,path:'/memory/continuity',method,
    headers:{host:HOST,'content-type':'application/json','content-length':Buffer.byteLength(body),'cf-connecting-ip':'203.0.113.9',...headers}},x=>{
    let text='';x.on('data',d=>text+=d);x.on('end',()=>resolve({status:x.statusCode!,body:text}));});
  r.on('error',reject);r.end(body);});
const event=JSON.stringify({session_id:'claude_code:edge-remote',project:'/remote-project',runtime:'claude_code',event:'progress',
  messages:[{id:'remote-1',role:'user',content:'Saved from another computer.'}]});

test('a keyed continuity POST through the edge is saved; no key never reaches the installation',async()=>{
  ingestLimiter.resetForTests();
  const anonymous=await post(event);
  expect(anonymous.status).toBe(401);expect(JSON.parse(anonymous.body).error).toBe('AUTHORIZATION_REQUIRED');
  const cookieOnly=await post(event,{cookie:'qoopia_dash=owner'});
  expect(cookieOnly.status).toBe(401);expect(JSON.parse(cookieOnly.body).error).toBe('AUTHORIZATION_REQUIRED');
  // A wrong key passes the edge and is refused by the installation's own authentication.
  const wrong=await post(event,{authorization:'Bearer q_wrong-key'});
  expect(wrong.status).toBe(401);expect(JSON.parse(wrong.body).error).toBe('unauthenticated');
  const saved=await post(event,{authorization:'Bearer '+key});
  expect(saved.status).toBe(200);
  expect(db.query("SELECT 1 FROM sessions WHERE id='claude_code:edge-remote'").get()).toBeTruthy();
  expect((await post('',{authorization:'Bearer '+key},'GET')).status).toBe(405);
});

test('the edge applies the continuity body limit, not the larger MCP limit',async()=>{
  ingestLimiter.resetForTests();
  const oversized=await post('x'.repeat(CONTINUITY_MAX_BODY_BYTES+1),{authorization:'Bearer '+key});
  expect(oversized.status).toBe(413);expect(JSON.parse(oversized.body).error).toBe('BODY_TOO_LARGE');
});
