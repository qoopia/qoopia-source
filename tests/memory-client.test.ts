import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {installMemoryClient,runMemoryHook,transcriptMessages} from '../src/delivery/memory-client.ts';
import {hash} from '../src/utils/fs.ts';

test('native hooks preserve settings, resume unacknowledged UTF-8 events, and reject paths outside the selected native home',async()=>{
 const root=fs.mkdtempSync('/var/tmp/qoopia-client-test-');
 const home=path.join(root,'home');fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(path.join(home,'.codex'),{mode:0o700});
 fs.writeFileSync(path.join(home,'.codex/hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'existing-hook'}]}]}}));
 fs.writeFileSync(path.join(home,'.codex/config.toml'),'model = "existing-model"\n');
 let fail=false;const delivered:any[]=[];
 const server=Bun.serve({port:0,async fetch(req){expect(req.headers.get('authorization')).toBe('Bearer q_fixturekey');const event=await req.json() as any;
   if(fail)return new Response('',{status:503});delivered.push(event);return Response.json({accepted:event.messages.map((m:any)=>m.id),session_id:event.session_id,context:'Цель: сохранить накопленные данные.',tail:[]});}});
 try {
  const connection={format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:'fixture',key:'q_fixturekey',runtime:'codex'};
  installMemoryClient(connection,root,process.execPath,home);installMemoryClient(connection,root,process.execPath,home);
  const settings=JSON.parse(fs.readFileSync(path.join(home,'.codex/hooks.json'),'utf8'));expect(settings.hooks.Stop).toHaveLength(2);expect(settings.hooks.Stop[0].hooks[0].command).toBe('existing-hook');
  expect(fs.readFileSync(path.join(home,'.codex/config.toml'),'utf8')).toContain('model = "existing-model"');
  const file=path.join(root,'memory-clients/codex/connection.json'),transcript=path.join(home,'.codex/sessions/test.jsonl');fs.mkdirSync(path.dirname(transcript),{mode:0o700});
  const hook={session_id:'test',cwd:'/project',transcript_path:transcript,hook_event_name:'SessionStart'};
  expect((await runMemoryHook(file,hook))?.hookSpecificOutput.additionalContext).toContain('Цель'); // before the log exists
  // The kit is installed: the hook names the file. A connection older than the kit has no such
  // file, and the hook must say so and point at the protocol served by the connection itself.
  const protocolFile=path.join(home,'.codex/qoopia-protocol.md'),installedKit=fs.readFileSync(protocolFile);
  expect((await runMemoryHook(file,hook))?.hookSpecificOutput.additionalContext).toMatch(/^Before Qoopia work, read "[^"]*\/\.codex\/qoopia-protocol\.md"\./);
  fs.rmSync(protocolFile);
  const missing=(await runMemoryHook(file,hook))?.hookSpecificOutput.additionalContext as string;
  expect(missing).toContain('is not installed at');expect(missing).toContain('qoopia_protocol');expect(missing).not.toContain('Before Qoopia work, read "');
  fs.writeFileSync(protocolFile,installedKit,{mode:0o600});
  const line=JSON.stringify({type:'response_item',timestamp:'2026-09-10',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Сохрани контекст — қазақша.'}]}})+'\n';
  const bytes=Buffer.from(line),split=bytes.indexOf(Buffer.from('қ'))+1;fs.writeFileSync(transcript,bytes.subarray(0,split));
  await runMemoryHook(file,{...hook,hook_event_name:'UserPromptSubmit'});expect(delivered.at(-1).messages).toHaveLength(0);
  fs.appendFileSync(transcript,bytes.subarray(split));fail=true;
  await runMemoryHook(file,{...hook,hook_event_name:'Stop'});
  const cursor=path.join(root,'memory-clients/codex/cursors',hash(transcript)+'.json');expect(JSON.parse(fs.readFileSync(cursor,'utf8')).cursor).toBe(0);
  fail=false;await runMemoryHook(file,{...hook,hook_event_name:'Stop'});expect(delivered.at(-1).messages[0].content).toBe('Сохрани контекст — қазақша.');
  expect(JSON.parse(fs.readFileSync(cursor,'utf8')).cursor).toBe(bytes.length);
  await runMemoryHook(file,{...hook,hook_event_name:'Stop'});expect(delivered.at(-1).messages).toHaveLength(0);
  const foreign=path.join(root,'sessions/foreign.jsonl');fs.mkdirSync(path.dirname(foreign),{mode:0o700});fs.writeFileSync(foreign,line);const count=delivered.length;
  await runMemoryHook(file,{...hook,hook_event_name:'Stop',transcript_path:foreign});expect(delivered).toHaveLength(count);
 } finally {server.stop(true);fs.rmSync(root,{recursive:true,force:true});}
});
test('journal includes tool results without hidden reasoning and stable IDs survive file rewrites',()=>{
 const line=JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',call_id:'apply1',output:'Patch completed'}});
 const first=transcriptMessages(line,'codex',0);expect(first[0]?.role).toBe('tool');expect(first[0]?.content).toContain('apply1');expect(first).toEqual(transcriptMessages(line,'codex',100));
 expect(transcriptMessages(JSON.stringify({type:'response_item',payload:{type:'reasoning',summary:'hidden'}}),'codex',0)).toEqual([]);
});

test('selected native profiles keep hooks, MCP and transcript bounds together without rebinding an existing connection',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-memory-profile-')),delivered:any[]=[];
 const server=Bun.serve({port:0,async fetch(req){const event=await req.json() as any;delivered.push(event);return Response.json({accepted:event.messages.map((m:any)=>m.id),session_id:event.session_id,tail:[]});}});
 try {
  for(const runtime of ['codex','claude_code'] as const){
   const home=path.join(root,'home-'+runtime),native=path.join(root,'profile-'+runtime),store=path.join(root,'store-'+runtime);
   fs.mkdirSync(home,{mode:0o700});
   const connection={format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:'fixture',key:'q_fixturekey',runtime};
   const result=installMemoryClient(connection,store,process.execPath,home,native);
   expect(result.settings).toBe(path.join(native,runtime==='codex'?'hooks.json':'settings.json'));
   const file=path.join(store,'memory-clients',runtime,'connection.json');
   expect(JSON.parse(fs.readFileSync(file,'utf8')).native_root).toBe(native);
   expect(fs.existsSync(path.join(native,runtime==='codex'?'config.toml':'.claude.json'))).toBe(true);
   expect(fs.readdirSync(home)).toEqual([]);
   // A service restart without a profile override resumes the persisted selection.
   expect(installMemoryClient(connection,store,process.execPath,home).settings).toBe(result.settings);
   const before=fs.readFileSync(file,'utf8'),other=path.join(root,'other-'+runtime);
   expect(()=>installMemoryClient(connection,store,process.execPath,home,other)).toThrow('another native profile');
   expect(fs.readFileSync(file,'utf8')).toBe(before);expect(fs.existsSync(other)).toBe(false);
   const transcript=path.join(native,runtime==='codex'?'sessions':'projects','fixture.jsonl');fs.mkdirSync(path.dirname(transcript),{mode:0o700});
   const line=runtime==='codex'?{type:'response_item',payload:{type:'message',role:'user',content:'profile fixture'}}:{type:'user',message:{content:'profile fixture'}};
   fs.writeFileSync(transcript,JSON.stringify(line)+'\n');
   await runMemoryHook(file,{session_id:runtime,cwd:'/fixture',transcript_path:transcript,hook_event_name:'Stop'});
   expect(delivered.at(-1).messages[0].content).toBe('profile fixture');
   const outside=path.join(root,runtime+'-outside.jsonl');fs.writeFileSync(outside,JSON.stringify(line)+'\n');const count=delivered.length;
   await runMemoryHook(file,{session_id:runtime,cwd:'/fixture',transcript_path:outside,hook_event_name:'Stop'});
   expect(delivered).toHaveLength(count);
  }
 } finally {server.stop(true);fs.rmSync(root,{recursive:true,force:true});}
});

test('memory-link respects CODEX_HOME and refuses a relative profile selection',()=>{
 const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-memory-env-')),saved=process.env.CODEX_HOME;
 try {
  const native=path.join(root,'selected');process.env.CODEX_HOME=native;
  const connection={format:'qoopia-memory-connection/1',url:'http://127.0.0.1:1',agent_id:'fixture',key:'q_fixturekey',runtime:'codex'};
  expect(installMemoryClient(connection,root,process.execPath).settings).toBe(path.join(native,'hooks.json'));
  expect(()=>installMemoryClient(connection,root,process.execPath,undefined,'relative')).toThrow('absolute path');
 } finally {if(saved===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=saved;fs.rmSync(root,{recursive:true,force:true});}
});

test('in «only on request» the adapter stops sending the conversation and never sends the skipped part later',async()=>{
 const root=fs.mkdtempSync('/var/tmp/qoopia-client-manual-'),home=path.join(root,'home');fs.mkdirSync(path.join(home,'.codex/sessions'),{mode:0o700,recursive:true});
 let mode:'auto'|'manual'='manual';const received:any[]=[];
 const server=Bun.serve({port:0,async fetch(req){const event=await req.json() as any;received.push(event);
   return Response.json(mode==='manual'?{accepted:[],memory_mode:'manual',session_id:event.session_id,tail:[]}:{accepted:event.messages.map((m:any)=>m.id),session_id:event.session_id,tail:[]});}});
 try {
  installMemoryClient({format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:'fixture',key:'q_fixturekey',runtime:'codex'},root,process.execPath,home);
  const file=path.join(root,'memory-clients/codex/connection.json'),transcript=path.join(home,'.codex/sessions/manual.jsonl');
  const line=(text:string)=>JSON.stringify({type:'response_item',timestamp:'2026-09-20T10:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
  const hook={session_id:'manual',cwd:'/project',transcript_path:transcript,hook_event_name:'Stop'};
  const sent=()=>received.flatMap(event=>event.messages.map((m:any)=>m.content));
  fs.writeFileSync(transcript,line('первое сообщение после переключения'));await runMemoryHook(file,hook);
  // The adapter could not know yet, so the first batch travels once; the server stores nothing.
  expect(sent()).toEqual(['первое сообщение после переключения']);
  fs.appendFileSync(transcript,line('второе — только на этом компьютере'));await runMemoryHook(file,hook);
  fs.appendFileSync(transcript,line('третье — только на этом компьютере'));await runMemoryHook(file,hook);
  expect(sent()).toEqual(['первое сообщение после переключения']);
  const state=JSON.parse(fs.readFileSync(path.join(root,'memory-clients/codex/cursors',hash(transcript)+'.json'),'utf8'));
  expect(state).toMatchObject({manual:true,cursor:fs.statSync(transcript).size});expect(state.error).toBeUndefined();
  mode='auto';fs.appendFileSync(transcript,line('после возврата в auto'));await runMemoryHook(file,hook);
  expect(sent()).toEqual(['первое сообщение после переключения','после возврата в auto']);
 } finally {server.stop(true);fs.rmSync(root,{recursive:true,force:true});}
});
