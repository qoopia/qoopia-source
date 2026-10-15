import {afterAll,beforeAll,expect,test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {startHttpServer} from '../src/http.ts';

let server:Server,base='',ownerKey='',agentKey='',other='';
beforeAll(async()=>{
  runMigrations();
  const ws=createWorkspace({name:'canon-dashboard-test'});
  ownerKey=createAgent({name:'canon-dash-owner',workspaceSlug:ws.slug,type:'owner'}).api_key;
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

test('the owner writes, rewords and retires canons in the dashboard; agents read what they may',async()=>{
  expect((await post(ownerKey,'',{text:'Отвечай владельцу по-русски.'},{})).status).toBe(403);
  expect((await post(agentKey,'',{text:'Пишу себе правило.'})).status).toBe(403); // the dashboard writes for the owner alone
  const made=await post(ownerKey,'',{text:'Отвечай владельцу по-русски, коротко.',mode:'always'});
  expect(made.status).toBe(200);
  const canon=(await made.json() as any).canon;
  expect(canon).toMatchObject({scope:'workspace',mode:'always',source:'dashboard'});
  const own=await post(ownerKey,'',{text:'Канон одного агента про его отчёты.',agent:other});
  expect((await own.json() as any).canon).toMatchObject({scope:'agent',agent_id:other});

  const seen=await get(agentKey);
  expect(seen.status).toBe(200);
  expect(seen.body.items.map((c:any)=>c.id)).toContain(canon.id);
  expect(seen.body.items.some((c:any)=>c.agent_id===other)).toBe(false);
  expect((await get(ownerKey)).body.items.some((c:any)=>c.agent_id===other)).toBe(true);

  const reworded=await post(ownerKey,`/${canon.id}`,{text:'Отвечай владельцу по-русски, коротко и без воды.'});
  const next=(await reworded.json() as any).canon;
  expect(next.supersedes_id).toBe(canon.id);
  expect((await get(ownerKey,`/${next.id}`)).body.history.map((h:any)=>h.id)).toEqual([canon.id]);
  expect((await post(ownerKey,`/${next.id}/retire`,{reason:'test'})).status).toBe(200);
  expect((await post(ownerKey,`/${next.id}/retire`,{})).status).toBe(409);
  expect((await get(ownerKey,'?status=retired')).body.items.map((c:any)=>c.id)).toContain(next.id);
  expect((await get(agentKey,'/no-such-canon')).status).toBe(404);
});
