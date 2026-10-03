import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {installAgentInstructions,planAgentInstructions,refreshAgentInstructions,removeAgentInstructions} from '../src/agent-kit/install.ts';
import {agentKitFiles,agentKitFilesEn,agentKitManifest,agentProtocol,managedAgentInstructions,AGENT_KIT_REVISION} from '../src/agent-kit/index.ts';
import {hash,privateDirectory,durableWrite} from '../src/utils/fs.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/server.ts';
import type {AuthContext} from '../src/auth/middleware.ts';
import {configureNativeClient} from '../src/delivery/client-config.ts';
import {randomUUID} from 'node:crypto';
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
  const plan=planAgentInstructions(root,'claude_code');if(plan.opted_out)throw new Error('Fixture directory unexpectedly opted out');privateDirectory(plan.store);durableWrite(plan.receiptFile,JSON.stringify(plan.pending));durableWrite(plan.changes[0]!.file,plan.changes[0]!.after);
  installAgentInstructions(root,'claude_code');expect(JSON.parse(fs.readFileSync(plan.receiptFile,'utf8')).state).toBe('installed');expect(planAgentInstructions(root,'claude_code').changes).toEqual([]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('kit manifest covers each bundled document; steward instructions use their actual profile path',()=>{
 const manifest=agentKitManifest();for(const [name,text] of Object.entries(agentKitFiles))expect(manifest.files[name]).toBe(hash(text));
 expect(agentProtocol('connections').text).toContain('CLIENT_CONFIG_CHANGED');expect(agentProtocol('connections').text).toContain('15 сентября 2026');
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

test('the kit ships in English beside Russian; a profile keeps the language it was installed in until refresh switches it [F-301]',async()=>{
 expect(Object.keys(agentKitFilesEn)).toEqual(Object.keys(agentKitFiles));
 for(const text of Object.values(agentKitFilesEn))expect(text).not.toMatch(/[Ѐ-ӿ]/);
 expect(agentProtocol('protocol','en')).toMatchObject({text:agentKitFilesEn['qoopia-protocol.md'],manifest:{language:'en'}});
 expect(agentProtocol('protocol').text).toBe(agentKitFiles['qoopia-protocol.md']);
 const auth={agent_id:'protocol-reader',workspace_id:'protocol-fixture',type:'standard',source:'api-key'} as AuthContext;
 const server=createMcpServer(()=>auth,'memory',{agentToolProfile:'read-only'}),client=new Client({name:'protocol-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const result=await client.callTool({name:'qoopia_protocol',arguments:{section:'soul',language:'en'}});
  expect(JSON.parse((result.content as any)[0].text).text).toBe(agentKitFilesEn['SOUL.md']);
 }finally{await client.close();await server.close();}
 const root=temporary();try{
  const profile=privateDirectory(path.join(root,'claude-profile'));
  installAgentInstructions(profile,'claude_code','client',undefined,true,'en');
  expect(fs.readFileSync(path.join(profile,'qoopia-protocol.md'),'utf8')).toBe(agentKitFilesEn['qoopia-protocol.md']);
  expect(fs.readFileSync(path.join(profile,'qoopia','OPERATIONS.md'),'utf8')).toBe(agentKitFilesEn['OPERATIONS.md']);
  const link=privateDirectory(path.join(root,'memory-clients','claude_code'));
  durableWrite(path.join(link,'connection.json'),JSON.stringify({native_root:profile}));
  expect(refreshAgentInstructions(root).profiles[0]!.state).toBe('current');
  expect(refreshAgentInstructions(root,true,'ru').profiles[0]!.state).toBe('updated');
  expect(fs.readFileSync(path.join(profile,'qoopia-protocol.md'),'utf8')).toBe(agentKitFiles['qoopia-protocol.md']);
  // The dashboard passes its language when it adds a client on this computer.
  const id=randomUUID(),home=privateDirectory(path.join(root,'home')),client=privateDirectory(path.join(root,'claude-config'));
  configureNativeClient(root,{format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_code',access_mode:'read',mcp_url:'http://127.0.0.1:3737/mcp/c/'+id},'apply',home,client,'en');
  expect(fs.readFileSync(path.join(client,'qoopia-protocol.md'),'utf8')).toBe(agentKitFilesEn['qoopia-protocol.md']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('completed writes with pending receipt finalize; reconnect preserves the steward role',()=>{
 const root=temporary();try{
  const installed=installAgentInstructions(root,'codex','steward');
  const receipt=path.join(root,'qoopia','instructions-receipt.json');
  const pending=JSON.parse(fs.readFileSync(receipt,'utf8'));pending.state='pending';durableWrite(receipt,JSON.stringify(pending));
  installAgentInstructions(root,'codex');
  expect(JSON.parse(fs.readFileSync(receipt,'utf8')).state).toBe('installed');
  expect(fs.readFileSync(installed.instruction_file,'utf8')).toContain('Keep your existing name, role and instructions.');
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
  9: '2836b52017b72b8ef3930f573d02f6153bee455a2923e297b42d712db311a481',
  8: '631b1a1829e09d74e05b60d8c4d3e4058fb021e7567b53a21297f87e63d7e695',
  7: '9a2159d6a263b8078ca27072e78ac52a2c9f88441019aa1314a29e4609217cd1',
  4: '9b92f581a013443daeb74d5af01a1910bd5dd5d66244a6ddc4330301f9ecf4ce',
  5: '4eabb8275fa226ca923164a383defdff200c1b1979137c1c99af3ab81db91fc4',
  6: '7a80edbe54275c1f9622ee003eae27bcf944cabc82c64cc27ef020e8b56fc4ce',
};
test('changing a shipped document requires a new kit revision',()=>{
  // Revisions up to 8 were Russian only; from 9 the English documents count too [F-301].
  const combined=hash([agentKitFiles,agentKitFilesEn].flatMap(kit=>['qoopia-protocol.md','MCP-CONNECTIONS.md','SOUL.md','OPERATIONS.md']
    .map(name=>hash(kit[name as keyof typeof agentKitFiles]))).join(''));
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
  expect(fs.readFileSync(entry,'utf8')).toContain('Keep your existing name, role and instructions.');
  expect(refreshAgentInstructions(root,true).profiles[0]!.state).toBe('current');
  manifest.revision=AGENT_KIT_REVISION+1;durableWrite(manifestFile,JSON.stringify(manifest));
  expect(refreshAgentInstructions(root,true).profiles[0]!.reason).toContain('refusing downgrade');
  durableWrite(path.join(link,'connection.json'),'broken json');
  expect(refreshAgentInstructions(root).profiles[0]!.state).toBe('refused');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('bind-mounted instruction profiles retain reader paths and agent identity across updates',()=>{
 const root=temporary();try{
  for(const runtime of ['claude_code','codex'] as const){
   const writer=privateDirectory(path.join(root,runtime)),reader=runtime==='claude_code'?'/home/node/.claude':'/home/node/agents/liam-runtime/codex';
   const entry=path.join(writer,runtime==='claude_code'?'CLAUDE.md':'AGENTS.md');
   durableWrite(entry,'You are Liam. Preserve LIAM_RUNTIME.md and your existing duties.\n');
   installAgentInstructions(writer,runtime,'steward',reader);
   const text=fs.readFileSync(entry,'utf8');
   expect(text).toStartWith('You are Liam. Preserve LIAM_RUNTIME.md');
   expect(text).not.toContain(writer);expect(text).not.toContain('You are My Qoopia agent');
   for(const file of ['manifest.json','SOUL.md','OPERATIONS.md','MCP-CONNECTIONS.md'])expect(text).toContain(reader+'/qoopia/'+file);
   expect(JSON.parse(fs.readFileSync(path.join(writer,'qoopia/instructions-receipt.json'),'utf8')).reference_directory).toBe(reader);
   fs.rmSync(path.join(writer,'qoopia/MCP-CONNECTIONS.md'));
   installAgentInstructions(writer,runtime);
   expect(fs.readFileSync(entry,'utf8')).toBe(text);
   expect(planAgentInstructions(writer,runtime).changes).toEqual([]);
   expect(()=>planAgentInstructions(writer,runtime,'steward','relative/path')).toThrow();
   expect(()=>planAgentInstructions(writer,runtime,'steward','/bad\npath')).toThrow();
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a lock left by a killed installer is reclaimed; a live one still refuses [F-228]',()=>{
 const root=temporary();try{
  installAgentInstructions(root,'claude_code');
  const lock=path.join(root,'qoopia','install.lock'),document=path.join(root,'qoopia','OPERATIONS.md');
  fs.rmSync(document);
  durableWrite(lock,JSON.stringify({pid:999999,created_at:new Date().toISOString()}));
  installAgentInstructions(root,'claude_code');
  expect(fs.readFileSync(document,'utf8')).toBe(agentKitFiles['OPERATIONS.md']);
  expect(fs.existsSync(lock)).toBe(false);
  // A running installer (this process) keeps its lock.
  fs.rmSync(document);durableWrite(lock,JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));
  expect(()=>installAgentInstructions(root,'claude_code')).toThrow('Another instruction installation is running');
  expect(fs.existsSync(document)).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('removing the kit restores the owner file with its own blocks; only an explicit link adds it again [F-226]',()=>{
 const root=temporary();try{
  for(const runtime of ['claude_code','codex'] as const){
   const profile=privateDirectory(path.join(root,runtime)),entry=path.join(profile,runtime==='codex'?'AGENTS.md':'CLAUDE.md'),ops=path.join(profile,'qoopia/OPERATIONS.md');
   const owner='You are Liam. Preserve LIAM_RUNTIME.md.\n<!-- liam:manual:start -->\nNever touch this.\n<!-- liam:manual:end -->\n';
   durableWrite(entry,owner);installAgentInstructions(profile,runtime);
   const installed=fs.readFileSync(entry,'utf8');
   expect(removeAgentInstructions(profile,runtime)).toMatchObject({state:'planned',files:expect.arrayContaining([entry,ops])});
   expect(fs.readFileSync(entry,'utf8')).toBe(installed);
   // A document the owner changed stops the removal before anything is touched.
   durableWrite(ops,'mine\n');
   expect(()=>removeAgentInstructions(profile,runtime,true)).toThrow('edited');
   expect(fs.readFileSync(entry,'utf8')).toBe(installed);expect(fs.readFileSync(ops,'utf8')).toBe('mine\n');
   durableWrite(ops,agentKitFiles['OPERATIONS.md']);
   expect(removeAgentInstructions(profile,runtime,true).state).toBe('removed');
   expect(fs.readFileSync(entry,'utf8')).toBe(owner);
   expect(fs.existsSync(path.join(profile,'qoopia-protocol.md'))).toBe(false);expect(fs.existsSync(ops)).toBe(false);
   // What the SessionStart hook runs leaves it removed; an explicit connect or link reinstalls it.
   expect(installAgentInstructions(profile,runtime,'client',undefined,false).state).toBe('opted_out');
   expect(fs.readFileSync(entry,'utf8')).toBe(owner);
   installAgentInstructions(profile,runtime);
   expect(fs.readFileSync(entry,'utf8')).toBe(installed);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a block the owner deleted by hand is an opt-out the hook and refresh respect [F-226]',()=>{
 const root=temporary();try{
  const profile=privateDirectory(path.join(root,'profile')),entry=path.join(profile,'CLAUDE.md');
  durableWrite(entry,'# mine\n');installAgentInstructions(profile,'claude_code');
  const owner='# mine\n\nA later note of mine.\n';durableWrite(entry,owner);
  expect(installAgentInstructions(profile,'claude_code','client',undefined,false).state).toBe('opted_out');
  durableWrite(path.join(privateDirectory(path.join(root,'memory-clients','claude_code')),'connection.json'),JSON.stringify({native_root:profile}));
  expect(refreshAgentInstructions(root,true).profiles).toEqual([{runtime:'claude_code',directory:profile,state:'opted_out'}]);
  expect(fs.readFileSync(entry,'utf8')).toBe(owner);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('refresh also republishes profiles linked through client-link, once per profile [F-230]',()=>{
 const root=temporary();try{
  const profile=privateDirectory(path.join(root,'claude-config')),id=randomUUID(),document=path.join(profile,'qoopia-protocol.md');
  const binding={format:'qoopia-client-connection/1',connection_id:id,workspace_id:'fixture',surface:'claude_code',access_mode:'read',mcp_url:'http://127.0.0.1:3737/mcp/c/'+id};
  configureNativeClient(root,binding,'apply',path.join(root,'unused-home'),profile);
  expect(refreshAgentInstructions(root).profiles).toEqual([{runtime:'claude_code',directory:profile,state:'current'}]);
  fs.rmSync(document);
  expect(refreshAgentInstructions(root).profiles).toEqual([{runtime:'claude_code',directory:profile,state:'outdated',files:[document]}]);
  // The same profile also memory-linked is reported once.
  durableWrite(path.join(privateDirectory(path.join(root,'memory-clients','claude_code')),'connection.json'),JSON.stringify({native_root:profile}));
  expect(refreshAgentInstructions(root,true).profiles).toEqual([{runtime:'claude_code',directory:profile,state:'updated'}]);
  expect(fs.readFileSync(document,'utf8')).toBe(agentKitFiles['qoopia-protocol.md']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a block Qoopia wrote in an earlier revision stays managed after the Codex entry file moved away and back [F-229]',()=>{
 const root=temporary();try{
  const agents=path.join(root,'AGENTS.md'),override=path.join(root,'AGENTS.override.md'),receiptFile=path.join(root,'qoopia/instructions-receipt.json');
  durableWrite(agents,'# base\n');installAgentInstructions(root,'codex');
  // An older kit wrote a different block into AGENTS.md, as the upgrade test simulates.
  const older=fs.readFileSync(agents,'utf8').split('\n').filter(line=>!line.startsWith('Compare the revision in ')).join('\n');durableWrite(agents,older);
  const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  receipt.blocks=[hash(older.slice(older.indexOf('<!-- qoopia:protocol:start -->'),older.indexOf('<!-- qoopia:protocol:end -->')+'<!-- qoopia:protocol:end -->'.length))];
  durableWrite(receiptFile,JSON.stringify(receipt));
  durableWrite(override,'# temporary override\n');installAgentInstructions(root,'codex');
  expect(fs.readFileSync(override,'utf8')).toContain('Compare the revision in ');
  fs.rmSync(override);
  installAgentInstructions(root,'codex');
  expect(fs.readFileSync(agents,'utf8')).toStartWith('# base\n');
  expect(fs.readFileSync(agents,'utf8')).toContain('Compare the revision in ');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
