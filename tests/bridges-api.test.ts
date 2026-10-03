import {afterAll,beforeAll,expect,spyOn,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {AuthContext} from '../src/auth/middleware.ts';

// src/bridges/api.ts binds its singleton to the production relay and captures fetch on first import.
// Block the network before importing it here, and mock every service method that could reach the
// relay: another test file may already have loaded api.ts with the real fetch.
const nativeFetch=globalThis.fetch,outbound:string[]=[];
globalThis.fetch=(async(input:string|URL|Request)=>{
  outbound.push(input instanceof Request?input.url:String(input));throw new Error('Network is blocked in this test');
}) as unknown as typeof fetch;
afterAll(()=>{globalThis.fetch=nativeFetch;});
const [{db},{runMigrations},{createWorkspace},{bootstrapOwner},{localOwner},api]=await Promise.all([
  import('../src/db/connection.ts'),import('../src/db/migrate.ts'),import('../src/admin/workspaces.ts'),
  import('../src/auth/pairings.ts'),import('../src/delivery/owner-onboarding.ts'),import('../src/bridges/api.ts')]);
const service=api.bridges as unknown as Record<string,(...args:unknown[])=>unknown>;

let owner:string,auth:AuthContext;
beforeAll(()=>{
  runMigrations();
  owner=bootstrapOwner(db,'Bridge dispatch owner',undefined,createWorkspace({name:'Bridge dispatch',slug:'bridge-dispatch'}).id).agent_id;
  auth=localOwner(db,owner);
});
function mocked<T>(method:string,result:unknown,run:(spy:ReturnType<typeof spyOn>)=>Promise<T>) {
  const spy=spyOn(service,method).mockImplementation(async()=>result);
  return run(spy).finally(()=>spy.mockRestore());
}

const group=randomUUID(),item=randomUUID(),peer='P'.repeat(43),version='V'.repeat(43);
const material={id:item,title:'Handbook',description:'Synthetic',kind:'note',filename:'note.md',mime:'text/markdown',content_base64:'IyBOb3Rl'};
// [dashboard action, body the dashboard sends, service method, arguments it must receive after auth]
const dispatch:Array<[string,Record<string,unknown>,string,unknown[]]>=[
  ['create',{id:group,name:'Circle'},'create',[{id:group,name:'Circle'}]],
  ['join',{code:'QPB1.code',name:'Me'},'join',[{code:'QPB1.code',name:'Me'}]],
  ['invite',{id:item,group},'invite',[{id:item,group}]],
  ['revoke-invite',{id:item},'revokeInvite',[item]],
  ['membership',{group,operation:'admit',peer},'membership',[{group,action:'admit',peer}]],
  ['membership',{group,operation:'leave'},'membership',[{group,action:'leave',peer:undefined}]],
  ['stage',material,'stage',[material]],
  ['copy',{id:item,source:'note',source_id:'n1',title:'T',description:'D'},'copySource',[{id:item,source:'note',source_id:'n1',title:'T',description:'D'}]],
  ['publish',{group,material_id:item,version,visible:true,auto_send:false},'publish',[{group,material_id:item,version,visible:true,auto_send:false}]],
  ['refresh',{group},'refresh',[{group}]],
  ['request',{id:item,group,peer,material_id:item,version},'requestMaterial',[{id:item,group,peer,material_id:item,version}]],
  ['decide',{id:item,version,approve:true},'decide',[{id:item,version,approve:true}]],
  ['material',{id:item},'getMaterial',[item]],
  ['agent',{id:null},'selectAgent',[null]],
];

test('every bridge action the dashboard sends has a dispatch case',()=>{
  const sent=[...readFileSync(new URL('../src/public/brand/dashboard.js',import.meta.url),'utf8').matchAll(/\bact\('([a-z-]+)'/g)].map(m=>m[1]);
  expect(sent.length).toBeGreaterThan(0);
  expect([...new Set(sent)].sort()).toEqual([...new Set(dispatch.map(([action])=>action))].sort());
});

for(const [action,body,method,args] of dispatch) test(`dashboard bridge action ${action} ${JSON.stringify(body).slice(0,40)} dispatches to ${method}`,()=>
  mocked(method,action==='invite'?{id:item,code:'c',url:'https://relay.invalid/invite#c',expires_at_ms:1}:{dispatched:method},async spy=>{
    const result=await api.bridgeAction(owner,{action,...body}) as Record<string,unknown>;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([expect.objectContaining({agent_id:owner,workspace_id:auth.workspace_id}),...args]);
    if(action==='invite')expect(String(result.svg)).toStartWith('<svg');else expect(result).toEqual({dispatched:method});
  }));

test('unknown actions and unmapped membership operations are refused before the service',()=>mocked('membership',{},async spy=>{
  await expect(api.bridgeAction(owner,{action:'nope'})).rejects.toThrow('Unknown bridge action');
  await expect(api.bridgeAction(owner,{action:'membership',group,operation:'bogus'})).rejects.toThrow();
  await expect(api.bridgeAction(owner,{action:'membership',group})).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
}));

type Handler=(args:unknown)=>Promise<{isError?:boolean;content:Array<{text:string}>}>;
function register(provider:()=>AuthContext|null) {
  const tools=new Map<string,Handler>();
  api.registerBridgeTools({registerTool(name:string,_config:unknown,handler:Handler){tools.set(name,handler);}} as unknown as McpServer,provider);
  return tools;
}
// [MCP tool, arguments, service method, arguments it must receive after auth]
const tools:Array<[string,Record<string,unknown>,string,unknown[]]>=[
  ['bridge_catalogue',{group,query:'hand'},'searchCatalogue',[{group,query:'hand'}]],
  ['bridge_refresh',{group,peer},'refresh',[{group,peer}]],
  ['bridge_request',{id:item,group,peer,material_id:item,version},'requestMaterial',[{id:item,group,peer,material_id:item,version}]],
  ['bridge_material',{id:item},'getMaterial',[item]],
  ['bridge_stage',material,'stage',[material]],
];

test('MCP bridge tools wrap the service: JSON results, parsed arguments, refused when signed out',async()=>{
  const spies=tools.map(([name,,method])=>spyOn(service,method).mockImplementation(async()=>({tool:name})));
  try {
    let current:AuthContext|null=auth;
    const registered=register(()=>current);
    expect([...registered.keys()].sort()).toEqual([...api.BRIDGE_TOOL_NAMES].sort());
    const status=await registered.get('bridge_status')!({});
    expect(status.isError).toBeUndefined();
    expect(JSON.parse(status.content[0]!.text)).toMatchObject({groups:[],requests:[],received:[],untrusted_content:expect.any(String)});
    for(const [[name,args,,expected],spy] of tools.map((t,i)=>[t,spies[i]!] as const)) {
      const result=await registered.get(name)!(args);
      expect([name,JSON.parse(result.content[0]!.text)]).toEqual([name,{tool:name}]);
      expect(spy.mock.calls).toEqual([[expect.objectContaining({agent_id:owner}),...expected]]);
    }
    const invalid=await registered.get('bridge_material')!({id:'not-a-uuid'});
    expect([invalid.isError,JSON.parse(invalid.content[0]!.text)]).toEqual([true,{error:'Bridge request is invalid or unavailable'}]);
    current=null;
    const signedOut=await registered.get('bridge_status')!({});
    expect([signedOut.isError,JSON.parse(signedOut.content[0]!.text)]).toEqual([true,{error:'Authentication required'}]);
    expect(register(()=>null).size).toBe(0);
  } finally {for(const spy of spies)spy.mockRestore();}
});

test('no request left the machine',()=>{expect(outbound).toEqual([]);});
