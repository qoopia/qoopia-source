import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {installAgentInstructions,planAgentInstructions} from '../src/agent-kit/install.ts';
import {agentKitFiles,agentKitManifest,agentProtocol,managedAgentInstructions} from '../src/agent-kit/index.ts';
import {hash,privateDirectory,durableWrite} from '../src/delivery/files.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/server.ts';
import type {AuthContext} from '../src/auth/middleware.ts';
function temporary(){return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-agent-kit-')));}
test('Codex and Claude get the same versioned protocol, preserving user guidance and respecting Codex override',()=>{
 const root=temporary();try{
  for(const runtime of ['codex','claude_code'] as const){
   const profile=privateDirectory(path.join(root,runtime)),entry=path.join(profile,runtime==='codex'?'AGENTS.override.md':'CLAUDE.md');
   durableWrite(entry,'# My instructions\nPreserve this.\n');if(runtime==='codex')durableWrite(path.join(profile,'AGENTS.md'),'Inactive original\n');
   const plan=planAgentInstructions(profile,runtime);expect(fs.existsSync(path.join(profile,'qoopia'))).toBe(false);expect(plan.instruction_file).toBe(entry);
   const result=installAgentInstructions(profile,runtime);expect(result.loaded).toBe('NOT_VERIFIED');expect(fs.readFileSync(entry,'utf8')).toStartWith('# My instructions\nPreserve this.\n');
   const before=fs.readFileSync(entry,'utf8');installAgentInstructions(profile,runtime);expect(fs.readFileSync(entry,'utf8')).toBe(before);
   expect((before.match(/qoopia:protocol:start/g)||[]).length).toBe(1);
   expect(fs.readFileSync(result.protocol_file,'utf8')).toBe(agentKitFiles['qoopia-protocol.md']);
   if(runtime==='claude_code')expect(before).toContain('@qoopia-protocol.md');else expect(fs.readFileSync(path.join(profile,'AGENTS.md'),'utf8')).toBe('Inactive original\n');
   fs.appendFileSync(entry,'\nNew personal guidance.\n');installAgentInstructions(profile,runtime);expect(fs.readFileSync(entry,'utf8')).toEndWith('New personal guidance.\n');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('foreign documents, tampered managed blocks and symlinks are refused without overwriting user files',()=>{
 const root=temporary();try{
  durableWrite(path.join(root,'qoopia-protocol.md'),'My own protocol');expect(()=>installAgentInstructions(root,'codex')).toThrow('not managed');expect(fs.readdirSync(root)).toEqual(['qoopia-protocol.md']);fs.unlinkSync(path.join(root,'qoopia-protocol.md'));
  const result=installAgentInstructions(root,'codex'),entry=result.instruction_file;fs.writeFileSync(entry,fs.readFileSync(entry,'utf8').replace('Before working','Edited before working'));
  const altered=fs.readFileSync(entry,'utf8');expect(()=>installAgentInstructions(root,'codex')).toThrow('block was edited');expect(fs.readFileSync(entry,'utf8')).toBe(altered);
  fs.unlinkSync(entry);fs.symlinkSync(path.join(root,'qoopia-protocol.md'),entry);expect(()=>installAgentInstructions(root,'codex')).toThrow('Links');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an interrupted instruction publication resumes from its pending receipt',()=>{
 const root=temporary();try{
  const plan=planAgentInstructions(root,'claude_code');privateDirectory(plan.store);durableWrite(plan.receiptFile,JSON.stringify(plan.pending));durableWrite(plan.changes[0]!.file,plan.changes[0]!.after);
  installAgentInstructions(root,'claude_code');expect(JSON.parse(fs.readFileSync(plan.receiptFile,'utf8')).state).toBe('installed');expect(planAgentInstructions(root,'claude_code').changes).toEqual([]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('kit manifest covers each bundled document; steward instructions use their actual profile path',()=>{
 const manifest=agentKitManifest();for(const [name,text] of Object.entries(agentKitFiles))expect(manifest.files[name]).toBe(hash(text));
 expect(agentProtocol('connections').text).toContain('CLIENT_CONFIG_CHANGED');expect(agentProtocol('connections').text).toContain('experimental');
 expect(managedAgentInstructions('/profile with spaces')).toContain('"/profile with spaces/qoopia/INSTALLATION.json"');
});
test('cloud and read-only MCP clients can read protocol sections without reading memory or gaining access',async()=>{
 let auth={agent_id:'protocol-reader',workspace_id:'protocol-fixture',type:'standard',source:'api-key'} as AuthContext|null;
 const server=createMcpServer(()=>auth,'memory',{agentToolProfile:'read-only'}),client=new Client({name:'protocol-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);const list=await client.listTools();const tool=list.tools.find(t=>t.name==='qoopia_protocol');expect(tool?.annotations?.readOnlyHint).toBe(true);
  const result=await client.callTool({name:'qoopia_protocol',arguments:{section:'connections'}});const body=JSON.parse((result.content as any)[0].text);expect(body.manifest.revision).toBe(1);expect(body.text).toContain('ChatGPT Web/Desktop');
  auth=null;expect((await client.callTool({name:'qoopia_protocol',arguments:{}})).isError).toBe(true);
 }finally{await client.close();await server.close();}
});

test('completed writes with pending receipt finalize; reconnect preserves the steward role',()=>{
 const root=temporary();try{
  const installed=installAgentInstructions(root,'codex','steward');
  const receipt=path.join(root,'qoopia','instructions-receipt.json');
  const pending=JSON.parse(fs.readFileSync(receipt,'utf8'));pending.state='pending';durableWrite(receipt,JSON.stringify(pending));
  installAgentInstructions(root,'codex');
  expect(JSON.parse(fs.readFileSync(receipt,'utf8')).state).toBe('installed');
  expect(fs.readFileSync(installed.instruction_file,'utf8')).toContain('You are My Qoopia agent.');
  expect(fs.existsSync(path.join(root,'qoopia','install.lock'))).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
