import {afterAll,beforeAll,expect,test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent,setDreamer} from '../src/admin/agents.ts';
import {createCanon} from '../src/services/canon.ts';
import {proposeCanon} from '../src/services/canon-proposals.ts';
import {db} from '../src/db/connection.ts';
import {startHttpServer} from '../src/http.ts';
import {runInNewContext} from 'node:vm';
import {dashboardScript} from './helpers/dashboard-source.ts';

let server:Server,base='',ownerKey='',agentKey='',other='',workspace='',owner='',slug='';
beforeAll(async()=>{
  runMigrations();
  const ws=createWorkspace({name:'canon-dashboard-test'});
  workspace=ws.id;slug=ws.slug;const made=createAgent({name:'canon-dash-owner',workspaceSlug:ws.slug,type:'owner'});ownerKey=made.api_key;owner=made.id;
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
  // The Canon page names the agent of an agent canon instead of "This agent"; a workspace canon has no agent.
  expect((await get(ownerKey)).body.items.find((c:any)=>c.id===own.id).agent_name).toBe('canon-dash-other');
  expect(seen.body.items.find((c:any)=>c.id===canon.id).agent_name).toBeNull();
  expect((await post(ownerKey,`/${canon.id}/retire`,{},{})).status).toBe(403);
  expect((await post(agentKey,`/${canon.id}/retire`,{})).status).toBe(403);
  expect((await post(ownerKey,`/${canon.id}/retire`,{reason:'test'})).status).toBe(200);
  expect((await post(ownerKey,`/${canon.id}/retire`,{})).status).toBe(409);
  expect((await get(ownerKey,'?status=retired')).body.items.map((c:any)=>c.id)).toContain(canon.id);
  expect((await get(agentKey,'/no-such-canon')).status).toBe(404);
});

// Overview, «Rules from the nightly review»: the owner accepts a draft there, so the draft says whose rule it
// would be, in which project, and which rule it replaces. Names come from this workspace only.
test('a rule proposed by the nightly review names its agent, its project and the rule it replaces',async()=>{
  const dreamer=createAgent({name:'canon-dash-dreamer',workspaceSlug:slug}).id;
  setDreamer({workspace_id:workspace,agent_id:dreamer,enabled:true,actor_id:owner});
  const foreign=createAgent({name:'canon-dash-foreign',workspaceSlug:createWorkspace({name:'canon-dashboard-elsewhere'}).slug}).id;
  const old=createCanon({workspace_id:workspace,actor:{agent_id:owner,type:'owner'},text:'Счета подрядчикам уходят только после сверки.',agent:other,on_conflict:'keep_both'}).canon;
  db.query("INSERT INTO notes (id, workspace_id, agent_id, type, text) VALUES ('canon-dash-project', ?, ?, 'project', 'Synthetic bakery')").run(workspace,owner);
  const propose=(key:string,input:Record<string,unknown>)=>proposeCanon(workspace,{agent_id:dreamer,type:'standard'},
    {reason:'Repeated synthetic preference.',source_refs:['session:synthetic:message-1'],idempotency_key:key,...input}).proposal.id;
  const forAgent=propose('review-agent',{text:'Отчёт агента приходит по пятницам.',scope:'agent',agent:'canon-dash-other',supersedes_id:old.id});
  const forProject=propose('review-project',{text:'Цены пекарни меняет только директор.',scope:'project',project:'canon-dash-project'});
  const forForeign=propose('review-foreign',{text:'Правило для агента из другого пространства.',scope:'agent',agent:foreign});
  const forDecider=propose('review-decider',{text:'Правило без названного агента.',scope:'agent'});
  const general=propose('review-workspace',{text:'Общее правило пространства про краткость.'});
  const answer=await fetch(`${base}/api/dashboard/canon-proposals`,{headers:{authorization:`Bearer ${ownerKey}`}});
  expect(answer.status).toBe(200);
  const by=Object.fromEntries(((await answer.json()) as any).items.map((p:any)=>[p.id,p]));
  expect(by[forAgent]).toMatchObject({agent_name:'canon-dash-other',project_name:null,supersedes_text:'Счета подрядчикам уходят только после сверки.'});
  expect(by[forProject]).toMatchObject({agent_name:null,project_name:'Synthetic bakery',supersedes_text:null});
  expect(by[forForeign].agent_name).toBeNull();
  // Accepting an agent rule that names no agent makes it the accepting owner's own.
  expect(by[forDecider].agent_name).toBe('canon-dash-owner');
  expect(by[general]).toMatchObject({agent_name:null,project_name:null,supersedes_text:null});

  const from=(a:string,b:string)=>{const start=dashboardScript.indexOf(a),end=dashboardScript.indexOf(b,start);if(start<0||end<0)throw Error('dashboard marker moved: '+a);return dashboardScript.slice(start,end);};
  const view:any={dataset:{},hidden:true,innerHTML:'',querySelectorAll:()=>[]};
  runInNewContext(from('  function esc(s) {','  function fmtTime(')+from('  const canonScope','  async function renderCanonList(')+from('  function paintCanonProposals(','  function paintCards(')+
    '\npaintCanonProposals(items)',{$:()=>view,items:[by[forAgent],by[forProject],by[general]],
    QI:{msg:(source:string,params?:Record<string,string>)=>source.replace(/\{(\w+)\}/g,(_,name)=>params?.[name]??'')}});
  const cards=view.innerHTML.split('<article').slice(1);
  expect(cards[0]).toContain('Agent canon-dash-other');
  expect(cards[0]).not.toContain('This agent');
  expect(cards[0]).toContain('Replaces the rule: Счета подрядчикам уходят только после сверки.');
  expect(cards[1]).toContain('Project · Synthetic bakery');
  expect(cards[2]).toContain('Whole workspace');
  expect(cards[2]).not.toContain('Replaces the rule:');
});
