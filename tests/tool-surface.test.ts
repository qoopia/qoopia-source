import {beforeAll,expect,test} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/server.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {authenticate,type AuthContext} from '../src/auth/middleware.ts';
import {db} from '../src/db/connection.ts';
import {MCP_INSTRUCTIONS,agentGuide,agentKitFiles,agentKitFilesEn} from '../src/agent-kit/index.ts';
import {executeCode,CODE_LIMITS} from '../src/mcp/code-mode.ts';
import {codeModeArgs} from '../src/mcp/surface.ts';
import {randomUUID} from 'node:crypto';
beforeAll(()=>runMigrations());
async function fixture(opts:Parameters<typeof createMcpServer>[2]={},profile:Parameters<typeof createMcpServer>[1]='full'){
 const ws=createWorkspace({name:'Surface',slug:'surface-'+randomUUID()});
 const agent=createAgent({name:'surface-'+randomUUID(),workspaceSlug:ws.slug});
 let auth=authenticate(new Request('http://localhost/',{headers:{authorization:'Bearer '+agent.api_key}}))!;
 const server=createMcpServer(()=>auth,profile,opts),client=new Client({name:'surface-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const call=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});return {error:r.isError===true,body:JSON.parse((r.content as any)[0].text.startsWith('{')?(r.content as any)[0].text:JSON.stringify({message:(r.content as any)[0].text}))};};
 return {client,call,agent,ws,setAuth:(next:AuthContext)=>{auth=next;},close:async()=>{await client.close();await server.close();}};
}
test('lean hides schemas only: old tools and protocol still call; search returns authorized schemas',async()=>{
 const f=await fixture();try{
  const list=await f.client.listTools();expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThanOrEqual(8192);
  expect(list.tools.map(t=>t.name)).not.toContain('note_list');
  expect((await f.call('note_list')).error).toBe(false);
  expect((await f.call('qoopia_protocol')).body.text).toContain('APPROVAL_REQUIRED');
  const found=await f.call('tool_search',{query:'note_list'});expect(found.body.tools[0].name).toBe('note_list');expect(found.body.tools[0].inputSchema).toBeDefined();
  expect((await f.call('qoopia_guide')).body.sections).toContain('safety');
 }finally{await f.close();}
});
test('classic restores the full registry and code mode has an independent off switch',async()=>{
 const previous=process.env.QOOPIA_TOOL_SURFACE,code=process.env.QOOPIA_CODE_MODE;
 process.env.QOOPIA_TOOL_SURFACE='classic';process.env.QOOPIA_CODE_MODE='off';
 const f=await fixture();try{const names=(await f.client.listTools()).tools.map(t=>t.name);expect(names).toContain('note_list');expect(names).toContain('session_expand');expect(names.length).toBeGreaterThan(40);expect(names).not.toContain('qoopia_execute');expect((await f.call('qoopia_execute',{code:'return 1'})).error).toBe(true);}
 finally{await f.close();if(previous===undefined)delete process.env.QOOPIA_TOOL_SURFACE;else process.env.QOOPIA_TOOL_SURFACE=previous;if(code===undefined)delete process.env.QOOPIA_CODE_MODE;else process.env.QOOPIA_CODE_MODE=code;}
});
test('batch reads bound bodies and preserve single-id and workspace privacy',async()=>{
 const f=await fixture(),other=await fixture();try{
  const n=(await f.call('note_create',{text:'Surface fixture '+randomUUID()+' '+'a'.repeat(600),type:'knowledge'})).body;
  const id=n.id??n.note?.id;expect(id).toBeString();
  expect((await f.call('note_get',{id})).body.text.length).toBeGreaterThan(500);
  const batch=(await f.call('note_get',{ids:[id,'missing'],max_chars:50})).body.notes;
  expect(batch[0].text.length).toBe(50);expect(batch[0].completeness).toBe('excerpt');expect(batch[1]).toEqual({id:'missing',error:'NOT_FOUND'});
  expect((await other.call('note_get',{ids:[id]})).body.notes).toEqual([{id,error:'NOT_FOUND'}]);
  expect((await f.call('note_get',{id,ids:[id]})).error).toBe(true);
  const foreign=await other.call('qoopia_execute',{code:`return await qoopia.note_get({ids:[${JSON.stringify(id)}]});`});
  expect(foreign.body.result.notes).toEqual([{id,error:'NOT_FOUND'}]);
  const executed=await f.call('qoopia_execute',{code:`const r=await qoopia.note_get({ids:[${JSON.stringify(id)}],max_chars:30}); console.log(r.notes.length); return r.notes.filter(n=>n.text);`});
  expect(executed.error).toBe(false);expect(executed.body.result[0].text.length).toBe(30);expect(executed.body.calls).toBe(1);expect(executed.body.logs).toEqual(['[1]']);
 }finally{await f.close();await other.close();}
});
test('execute only exposes read tools from the caller registry; writes, other tenants and revoked agents fail',async()=>{
 const f=await fixture({bootstrapProfile:'memory-worker',agentToolProfile:'read-only',grantedScope:['mcp:read']});try{
  const answer=await f.call('qoopia_execute',{code:'return {write:typeof qoopia.note_create,file:typeof qoopia.file_get,confirmation:typeof qoopia.connection_verify};'});
  expect(answer.body.result).toEqual({write:'undefined',file:'undefined',confirmation:'undefined'});
  expect((await f.call('qoopia_execute',{code:'return await qoopia.note_create({text:"forbidden"});'})).error).toBe(true);
  expect((await f.call('tool_search',{query:'file_get'})).body.tools).toEqual([]);
  const before=(db.query('SELECT count(*) AS n FROM notes WHERE workspace_id=?').get(f.ws.id) as any).n;
  expect(before).toBe(0);
  db.query('UPDATE agents SET active=0 WHERE id=?').run(f.agent.id);
  expect((await f.call('qoopia_execute',{code:'return await qoopia.note_get({ids:["anything"]});'})).error).toBe(true);
 }finally{await f.close();}
});
test('lean byte budget holds for full, owner, memory and restricted worker profiles',async()=>{
 for(const [opts,profile] of [[{},'full'],[{isSteward:true},'full'],[{bootstrapProfile:'memory-worker',agentToolProfile:'no-destructive'},'full'],[{bootstrapProfile:'memory-reader',agentToolProfile:'read-only',grantedScope:['mcp:read']},'memory']] as const){
  const f=await fixture({...opts} as any,profile);try{const list=await f.client.listTools();expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThanOrEqual(8192);
   if(profile==='memory'){expect(list.tools.map(t=>t.name)).not.toContain('note_create');expect(list.tools.map(t=>t.name)).not.toContain('agent_send');}
  }finally{await f.close();}
 }
});
test('explicit empty OAuth scope cannot be widened through Code Mode',async()=>{
 const f=await fixture();try{const auth=authenticate(new Request('http://localhost/',{headers:{authorization:'Bearer '+f.agent.api_key}}))!;f.setAuth({...auth,source:'oauth',granted_scope:[]});expect((await f.call('qoopia_execute',{code:'return await qoopia.note_list({});'})).error).toBe(true);
 }finally{await f.close();}
});
test('guide chapters retain all protocol safety content in both languages, within short injection budgets',()=>{
 expect(Buffer.byteLength(MCP_INSTRUCTIONS)).toBeLessThanOrEqual(2048);
 for(const language of ['ru','en'] as const){
  const index=agentGuide(undefined,language);expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(2048);
  const full=(language==='ru'?agentKitFiles:agentKitFilesEn)['qoopia-protocol.md'];
  const chapters=index.sections!.map(section=>(agentGuide(section,language) as any).text).join('\n');
  for(const paragraph of full.split('\n').filter(p=>p.trim()&&!p.startsWith('## ')))expect(chapters).toContain(paragraph);
 }
});
test('WASM sandbox has no host, filesystem, network, timers, module imports or host-eval escape',async()=>{
 const out=await executeCode('return [typeof process,typeof Bun,typeof fetch,typeof require,typeof setTimeout,typeof WebAssembly,typeof globalThis.constructor.constructor("return typeof process")()];',[],async()=>null);
 expect(out.result).toEqual(['undefined','undefined','undefined','undefined','undefined','undefined','string']);
 await expect(executeCode('return await import("node:fs");',[],async()=>null)).rejects.toThrow();
 const parallel=await executeCode('return await Promise.all([qoopia.read({n:1}),qoopia.read({n:2})]);',['read'],async(_n,a)=>a);
 expect(parallel.result).toEqual([{n:1},{n:2}]);
});
test('sandbox enforces synchronous and async deadlines, calls, output and memory caps',async()=>{
 const limits={...CODE_LIMITS,time_ms:100};
 await expect(executeCode('while(true){}',[],async()=>null,limits)).rejects.toThrow();
 await expect(executeCode('return await new Promise(()=>{});',[],async()=>null,limits)).rejects.toThrow();
 await expect(executeCode('for(let i=0;i<4;i++) await qoopia.read({});',['read'],async()=>null,{...limits,calls:2})).rejects.toThrow();
 await expect(executeCode('console.log("x".repeat(1000));return "y".repeat(1000);',[],async()=>null,{...limits,output_bytes:1000})).rejects.toThrow();
 await expect(executeCode('return "x".repeat(100000000);',[],async()=>null,limits)).rejects.toThrow();
 // A pending read may finish after the deadline; it must not touch the disposed VM.
 await expect(executeCode('return await qoopia.read({});',['read'],async()=>{await Bun.sleep(200);return 1;},limits)).rejects.toThrow();await Bun.sleep(150);
});
test('Code Mode hides reads with side effects and never spends the owner model',async()=>{
 expect(codeModeArgs('recall',{query:'x',judge:true,deep_llm:true})).toEqual({query:'x',judge:false,deep_llm:false});
 expect(codeModeArgs('recall',{query:'x'})).toEqual({query:'x'});
 expect(codeModeArgs('note_get',{id:'a',judge:true})).toEqual({id:'a',judge:true});
 const f=await fixture();try{
  const seen=await f.call('qoopia_execute',{code:'return [typeof qoopia.qoopia_protocol,typeof qoopia.qoopia_guide,typeof qoopia.agent_inbox,typeof qoopia.recall];'});
  expect(seen.body.result).toEqual(['undefined','undefined','undefined','function']);
  const judged=await f.call('qoopia_execute',{code:'const r=await qoopia.recall({query:"anything",judge:true,deep_llm:true});return r.judging??null;'});
  expect(judged.error).toBe(false);
  if(judged.body.result)expect(judged.body.result.attempted).not.toBe(true);
 }finally{await f.close();}
});
test('a remembered APPROVAL_REQUIRED text is data, not a refusal',async()=>{
 const f=await fixture();try{
  const n=(await f.call('note_create',{text:'Runbook: a tool may answer APPROVAL_REQUIRED '+randomUUID(),type:'knowledge'})).body;const id=n.id??n.note?.id;
  const read=await f.call('qoopia_execute',{code:`return (await qoopia.note_get({ids:[${JSON.stringify(id)}]})).notes[0].text;`});
  expect(read.error).toBe(false);expect(read.body.result).toContain('APPROVAL_REQUIRED');
 }finally{await f.close();}
});
test('note_create description mentions idempotency_key only when the schema has it',async()=>{
 const f=await fixture();try{const tool=(await f.client.listTools()).tools.find(t=>t.name==='note_create')!;
  expect(Boolean(tool.description?.includes('idempotency_key'))).toBe(Boolean((tool.inputSchema as any).properties?.idempotency_key));
 }finally{await f.close();}
});
test('after the deadline queued calls never start, concurrency stays bounded and the signal aborts',async()=>{
 let started=0,active=0,maxActive=0;const signals:AbortSignal[]=[];
 const dispatch=async(_n:string,_a:Record<string,unknown>,signal:AbortSignal)=>{started++;active++;maxActive=Math.max(maxActive,active);signals.push(signal);try{await Bun.sleep(80);return 1;}finally{active--;}};
 await expect(executeCode('return await Promise.all(Array.from({length:40},()=>qoopia.read({})));',['read'],dispatch,{...CODE_LIMITS,time_ms:100})).rejects.toThrow();
 const atEnd=started;await Bun.sleep(400);
 expect(started).toBe(atEnd);expect(started).toBeLessThanOrEqual(8);expect(maxActive).toBeLessThanOrEqual(CODE_LIMITS.concurrency);
 expect(signals.every(s=>s.aborted)).toBe(true);
});
test('guest JSON overrides cannot add result keys; syntax errors are invalid input',async()=>{
 const out=await executeCode('JSON.stringify=()=>\'{"result":1,"calls":-5,"logs":["forged"],"admin":true}\';return 2;',[],async()=>null);
 expect(Object.keys(out).sort()).toEqual(['calls','logs','result']);expect(out.calls).toBe(0);expect(out.logs).toEqual([]);
 await expect(executeCode('return )(;',[],async()=>null)).rejects.toMatchObject({code:'INVALID_INPUT'});
});
