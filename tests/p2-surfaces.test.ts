import {test,expect} from 'bun:test';
import {dashboardSource,dashboardPage,dashboardScript} from './helpers/dashboard-source.ts';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerAuthorityTools,handleAuthorityRequest,effectiveAuthority,getOperation} from '../src/api/authority.ts';
import {loopFixture,csvContent,accepted,assigned,opened} from './helpers/p2-fixtures.ts';
import {writeFileSync,mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('P2 REST / real MCP SDK transport / actual CLI share capture replay and current policy',async()=>{
 const f=loopFixture(),dir=mkdtempSync(join(tmpdir(),'p2-parity-'));
 const server=new McpServer({name:'p2-fixture',version:'1'}),client=new Client({name:'p2-client',version:'1'});
 try{
  const [st,ct]=InMemoryTransport.createLinkedPair();registerAuthorityTools(server,()=>f.auth,new Set(),f.database);await server.connect(st);await client.connect(ct);
  const input={kind:'manual',title:csvContent.title,slug:'parity',text:'1. Read.\n2. Sum.',content:csvContent,expected_revision:0,idempotency_key:'parity'};
  const mcp=await client.callTool({name:'skill_capture',arguments:input});expect(mcp.isError).not.toBe(true);
  const body=JSON.parse((mcp.content as {text:string}[])[0]!.text);
  const response=await handleAuthorityRequest(new Request('http://fixture/api/v1/skills/captures',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'parity','if-match':'0'},body:JSON.stringify(input)}),f.database,f.auth);
  expect(response.status).toBe(200);expect(await response.json()).toEqual(body);
  mkdirSync(join(dir,'data'));writeFileSync(join(dir,'data/qoopia.db'),f.database.serialize());writeFileSync(join(dir,'input.json'),JSON.stringify(input));
  const child=Bun.spawnSync({cmd:[process.execPath,'src/cli.ts','skill','capture','--input',join(dir,'input.json')],env:{PATH:process.env.PATH,NODE_ENV:'test',HOME:dir,TMPDIR:dir,QOOPIA_DATA_DIR:join(dir,'data'),QOOPIA_LOG_DIR:join(dir,'logs'),QOOPIA_BACKUP_DIR:join(dir,'backups'),QOOPIA_API_KEY:f.owner.api_key,QOOPIA_LOG_LEVEL:'error'},stdout:'pipe',stderr:'pipe',timeout:10000});
  expect(child.exitCode).toBe(0);expect(JSON.parse(child.stdout.toString())).toEqual(body);
  const catalog=JSON.stringify(effectiveAuthority(f.reportAuth,f.database));expect(catalog).toContain('skill_observe');expect(catalog).not.toContain('"name":"skill_assign"');
  const v=accepted(f);assigned(f,v);const s=opened(f);const operation=f.database.query("SELECT id FROM authority_commands WHERE operation='skill_session_open'").get() as {id:string};
  // Reporter operation inspection remains a report-only surface, through its session/outbox facts.
  expect(s.entries).toHaveLength(1);expect(()=>getOperation(f.auth,{id:operation.id},f.database)).toThrow('requester scope');
 }finally{await client.close();await server.close();f.database.close();rmSync(dir,{recursive:true,force:true});}
});
test('Dashboard JavaScript parses without executing a browser or user profile',()=>{
 // The page's code is a separate file now; parse it directly. A <script> tag search would match
 // only the empty bodies of the two src= tags and prove nothing.
 expect(dashboardScript.length).toBeGreaterThan(10_000);
 expect(()=>new Function(dashboardScript)).not.toThrow();
 for(const match of dashboardPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))expect(()=>new Function(match[1]!)).not.toThrow();
});
