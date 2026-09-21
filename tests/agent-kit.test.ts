import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {installAgentInstructions,planAgentInstructions,refreshAgentInstructions} from '../src/agent-kit/install.ts';
import {agentKitFiles,agentKitManifest,agentProtocol,managedAgentInstructions,AGENT_KIT_REVISION} from '../src/agent-kit/index.ts';
import {hash,privateDirectory,durableWrite} from '../src/utils/fs.ts';
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
  const result=await client.callTool({name:'qoopia_protocol',arguments:{section:'connections'}});const body=JSON.parse((result.content as any)[0].text);expect(body.manifest.revision).toBe(AGENT_KIT_REVISION);expect(body.text).toContain('ChatGPT Web/Desktop');
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

// Agents only learn that their installed copy is old by comparing revision
// numbers, so documents that change without a bump are invisible drift: every
// client keeps serving the previous text while reporting itself current.
// Editing a document below fails this test until the revision is bumped and its
// digest recorded, which is also the moment a reader decides the change is worth
// re-publishing to every profile.
const PUBLISHED_REVISIONS: Record<number, string> = {
  4: '9b92f581a013443daeb74d5af01a1910bd5dd5d66244a6ddc4330301f9ecf4ce',
};
test('changing a shipped document requires a new kit revision',()=>{
  const combined=hash(['qoopia-protocol.md','MCP-CONNECTIONS.md','SOUL.md','OPERATIONS.md']
    .map(name=>hash(agentKitFiles[name as keyof typeof agentKitFiles])).join(''));
  expect(PUBLISHED_REVISIONS[AGENT_KIT_REVISION]).toBeDefined();
  expect(combined).toBe(PUBLISHED_REVISIONS[AGENT_KIT_REVISION]);

  // The managed block is instruction too, and it is the only place that tells an
  // agent how to notice its documents have gone stale.
  const root=temporary();try{
    const profile=privateDirectory(path.join(root,'claude_code'));
    installAgentInstructions(profile,'claude_code');
    const block=fs.readFileSync(path.join(profile,'CLAUDE.md'),'utf8');
    expect(block).toContain('manifest.json');
    expect(block).toContain('qoopia_capabilities');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('refresh republishes linked profiles and leaves hand-edited ones alone',()=>{
 const root=temporary();try{
  const profile=privateDirectory(path.join(root,'claude-profile'));
  installAgentInstructions(profile,'claude_code');
  const link=privateDirectory(path.join(root,'memory-clients','claude_code'));
  durableWrite(path.join(link,'connection.json'),JSON.stringify({native_root:profile}));

  // Nothing changed since the install, so a refresh has nothing to do.
  expect(refreshAgentInstructions(root).profiles).toEqual([
    {runtime:'claude_code',directory:profile,state:'current'}]);

  // A profile that predates a document — what an older kit revision looks like
  // from here — is reported before anything is written, and only --commit
  // actually republishes it.
  const store=path.join(profile,'qoopia','manifest.json'),document=path.join(profile,'qoopia-protocol.md');
  fs.rmSync(document);
  expect(refreshAgentInstructions(root).profiles[0]!.state).toBe('outdated');
  expect(fs.existsSync(document)).toBe(false);
  expect(refreshAgentInstructions(root,true).profiles[0]!.state).toBe('updated');
  expect(fs.readFileSync(document,'utf8')).toBe(agentKitFiles['qoopia-protocol.md']);
  expect(JSON.parse(fs.readFileSync(store,'utf8')).revision).toBe(AGENT_KIT_REVISION);

  // A document the user rewrote is refused, not overwritten.
  durableWrite(path.join(profile,'qoopia','OPERATIONS.md'),'mine now\n');
  const refused=refreshAgentInstructions(root,true).profiles[0]!;
  expect(refused.state).toBe('refused');
  expect(fs.readFileSync(path.join(profile,'qoopia','OPERATIONS.md'),'utf8')).toBe('mine now\n');

  // An installation that never linked a client has nothing to refresh.
  const empty=temporary();
  try{expect(refreshAgentInstructions(empty).profiles).toEqual([]);}finally{fs.rmSync(empty,{recursive:true,force:true});}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('refresh upgrades a prior revision with valid receipts, preserving steward and owner text',()=>{
 const root=temporary();try{
  const profile=privateDirectory(path.join(root,'profile'));
  durableWrite(path.join(profile,'CLAUDE.md'),'Owner instructions stay here.\n');
  installAgentInstructions(profile,'claude_code','steward');
  const manifestFile=path.join(profile,'qoopia/manifest.json'),receiptFile=path.join(profile,'qoopia/instructions-receipt.json');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));manifest.revision=3;
  const oldManifest=JSON.stringify(manifest,null,2)+'\n';durableWrite(manifestFile,oldManifest);
  const entry=path.join(profile,'CLAUDE.md');
  const old=fs.readFileSync(entry,'utf8').split('\n').filter(line=>!line.startsWith('Compare the revision in ')).join('\n');durableWrite(entry,old);
  const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  receipt.files['qoopia/manifest.json'].after=hash(oldManifest);
  receipt.blocks=[hash(old.slice(old.indexOf('<!-- qoopia:protocol:start -->'),old.indexOf('<!-- qoopia:protocol:end -->')+'<!-- qoopia:protocol:end -->'.length))];
  durableWrite(receiptFile,JSON.stringify(receipt));
  const link=privateDirectory(path.join(root,'memory-clients/claude_code'));
  durableWrite(path.join(link,'connection.json'),JSON.stringify({native_root:profile}));
  expect(refreshAgentInstructions(root).profiles[0]!.state).toBe('outdated');
  expect(refreshAgentInstructions(root,true).profiles[0]!.state).toBe('updated');
  expect(JSON.parse(fs.readFileSync(manifestFile,'utf8')).revision).toBe(AGENT_KIT_REVISION);
  expect(fs.readFileSync(entry,'utf8')).toContain('Owner instructions stay here.');
  expect(fs.readFileSync(entry,'utf8')).toContain('You are My Qoopia agent.');
  expect(refreshAgentInstructions(root,true).profiles[0]!.state).toBe('current');
  manifest.revision=AGENT_KIT_REVISION+1;durableWrite(manifestFile,JSON.stringify(manifest));
  expect(refreshAgentInstructions(root,true).profiles[0]!.reason).toContain('refusing downgrade');
  durableWrite(path.join(link,'connection.json'),'broken json');
  expect(refreshAgentInstructions(root).profiles[0]!.state).toBe('refused');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
