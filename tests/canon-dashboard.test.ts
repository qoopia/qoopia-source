import {afterAll,beforeAll,expect,test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {createCanon} from '../src/services/canon.ts';
import {startHttpServer} from '../src/http.ts';

let server:Server,base='',ownerKey='',agentKey='',other='',workspace='',owner='';
beforeAll(async()=>{
  runMigrations();
  const ws=createWorkspace({name:'canon-dashboard-test'});
  workspace=ws.id;const made=createAgent({name:'canon-dash-owner',workspaceSlug:ws.slug,type:'owner'});ownerKey=made.api_key;owner=made.id;
  agentKey=createAgent({name:'canon-dash-agent',workspaceSlug:ws.slug}).api_key;
  other=createAgent({name:'canon-dash-other',workspaceSlug:ws.slug}).id;
  server=startHttpServer();
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',()=>resolve()));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});

const post=(key:string,path:string,body:unknown,headers:Record<string,string>={'x-qoopia-csrf':'1'})=>
  fetch(`${base}/api/dashboard/canons${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
const get=async(key:string,path='')=>{const r=await fetch(`${base}/api/dashboard/canons${path}`,{headers:{authorization:`Bearer ${key}`}});return {status:r.status,body:await r.json() as any};};

test('dashboard only views and retires canons; agents still create rules through the service',async()=>{
  for(const key of [ownerKey,agentKey]){
    expect((await post(key,'',{text:'Do not create from dashboard.'})).status).toBe(405);
    expect((await post(key,'/any-id',{text:'Do not edit from dashboard.'})).status).toBe(405);
  }
  const actor={agent_id:owner,type:'owner'};
  const canon=createCanon({workspace_id:workspace,actor,text:'Отвечай владельцу по-русски, коротко.',mode:'always'}).canon;
  const own=createCanon({workspace_id:workspace,actor,text:'Канон одного агента про его отчёты.',agent:other}).canon;
  const seen=await get(agentKey);
  expect(seen.status).toBe(200);
  expect(seen.body.items.map((c:any)=>c.id)).toContain(canon.id);
  expect(seen.body.items.some((c:any)=>c.id===own.id)).toBe(false);
  expect((await get(ownerKey)).body.items.some((c:any)=>c.id===own.id)).toBe(true);
  expect((await post(ownerKey,`/${canon.id}/retire`,{},{})).status).toBe(403);
  expect((await post(agentKey,`/${canon.id}/retire`,{})).status).toBe(403);
  expect((await post(ownerKey,`/${canon.id}/retire`,{reason:'test'})).status).toBe(200);
  expect((await post(ownerKey,`/${canon.id}/retire`,{})).status).toBe(409);
  expect((await get(ownerKey,'?status=retired')).body.items.map((c:any)=>c.id)).toContain(canon.id);
  expect((await get(agentKey,'/no-such-canon')).status).toBe(404);
});
