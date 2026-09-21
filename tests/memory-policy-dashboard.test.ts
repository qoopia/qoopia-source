import {afterAll,beforeAll,expect,test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {startHttpServer} from '../src/http.ts';
import {continuityEvent} from '../src/services/continuity.ts';

let server:Server,base='',ownerKey='',stewardKey='',workspace='',target='';
beforeAll(async()=>{
  runMigrations();
  const ws=createWorkspace({name:'policy-dashboard-test'});workspace=ws.id;
  ownerKey=createAgent({name:'policy-dash-owner',workspaceSlug:ws.slug,type:'owner'}).api_key;
  stewardKey=createAgent({name:'policy-dash-steward',workspaceSlug:ws.slug,type:'steward'}).api_key;
  target=createAgent({name:'policy-dash-agent',workspaceSlug:ws.slug}).id;
  server=startHttpServer();
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',()=>resolve()));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});

const write=(key:string,body:unknown,headers:Record<string,string>={'x-qoopia-csrf':'1'})=>
  fetch(`${base}/api/dashboard/agents/${target}/memory-policy`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
const card=async(key:string)=>((await (await fetch(`${base}/api/dashboard/agents`,{headers:{authorization:`Bearer ${key}`}})).json()) as any).items.find((a:any)=>a.id===target).memory;

test('the agent card reports the wanted mode next to the factual channel state',async()=>{
  expect(await card(ownerKey)).toMatchObject({mode:'auto',revision:0,state:'waiting',last_capture_at:null,pending_sessions:0});
  continuityEvent(workspace,target,{session_id:'claude_code:dash-policy',project:'/dash',runtime:'claude_code',event:'progress',messages:[{id:'d1',role:'user',content:'Синтетическое сообщение.'}]});
  const working=await card(ownerKey);
  expect(working.state).toBe('working');expect(working.last_capture_at).toBeString();expect(working.pending_sessions).toBe(1);
  expect(JSON.stringify(working)).not.toContain('Синтетическое');
});

test('only the owner switches the mode; forged, stale and malformed requests change nothing',async()=>{
  expect((await write(ownerKey,{mode:'manual'},{})).status).toBe(403);
  expect((await write(ownerKey,{mode:'manual'},{'x-qoopia-csrf':'1',origin:'https://evil.example.com'})).status).toBe(403);
  expect((await write(stewardKey,{mode:'manual'})).status).toBe(403);
  expect((await write(ownerKey,{mode:'off'})).status).toBe(400);
  expect((await write(ownerKey,{mode:'manual',expected_revision:7})).status).toBe(409);
  expect((await card(ownerKey)).mode).toBe('auto');

  const changed=await write(ownerKey,{mode:'manual',expected_revision:0});
  expect(changed.status).toBe(200);expect(await changed.json()).toMatchObject({agent_id:target,mode:'manual',revision:1});
  expect(await card(stewardKey)).toMatchObject({mode:'manual',state:'manual',error_code:null});
  expect(await (await write(ownerKey,{mode:'manual'})).json()).toMatchObject({mode:'manual',revision:1});
  expect((await fetch(`${base}/api/dashboard/agents/${target}/memory-policy`,{headers:{authorization:`Bearer ${ownerKey}`}})).status).toBe(404);
});
