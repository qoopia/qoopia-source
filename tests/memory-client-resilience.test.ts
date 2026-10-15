import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {installMemoryClient,memoryClientsCheck,runMemoryHook} from '../src/delivery/memory-client.ts';
import {hash} from '../src/utils/fs.ts';

test('a hanging server costs one tool call its short timeout; later hooks skip the network and nothing is lost [A7-01]',async()=>{
 const root=fs.mkdtempSync('/var/tmp/qoopia-client-breaker-'),home=path.join(root,'home'),sessions=path.join(home,'.codex/sessions');
 fs.mkdirSync(sessions,{mode:0o700,recursive:true});let hang=true;const stored:string[]=[];
 const server=Bun.serve({port:0,idleTimeout:30,async fetch(req){if(new URL(req.url).pathname==='/memory/canon')return new Response('',{status:404});const event=await req.json() as any;if(hang)await Bun.sleep(8000);
   stored.push(...event.messages.map((m:any)=>m.content));
   return Response.json({accepted:event.messages.map((m:any)=>m.id),session_id:event.session_id,memory_mode:'auto',tail:[]});}});
 try {
  installMemoryClient({format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:'fixture',key:'q_fixturekey',runtime:'codex'},root,process.execPath,home);
  const file=path.join(root,'memory-clients/codex/connection.json'),transcript=path.join(sessions,'b.jsonl');
  fs.writeFileSync(transcript,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'kept while the server hangs'}]}})+'\n');
  const hook=(event:string)=>runMemoryHook(file,{session_id:'b',cwd:'/p',transcript_path:transcript,hook_event_name:event});
  let t0=Date.now();
  for(let i=0;i<5;i++)await hook('PostToolUse');
  expect(Date.now()-t0).toBeLessThan(3000);
  // Manual: the probe and the send share one budget, well inside the vendor's 10 s.
  const cursor=path.join(fs.realpathSync(root),'memory-clients/codex/cursors',hash(transcript)+'.json'),breaker=path.join(path.dirname(cursor),'.server-unavailable');
  expect(fs.existsSync(breaker)).toBe(true);
  fs.writeFileSync(cursor,JSON.stringify({...JSON.parse(fs.readFileSync(cursor,'utf8')),manual:true}));fs.rmSync(breaker);
  t0=Date.now();await hook('Stop');expect(Date.now()-t0).toBeLessThan(6000);
  // The server answers again and the paused minute passes: the held bytes are delivered.
  hang=false;fs.writeFileSync(cursor,JSON.stringify({...JSON.parse(fs.readFileSync(cursor,'utf8')),manual:false}));fs.writeFileSync(breaker,String(Date.now()-1));
  await hook('Stop');
  expect(stored).toEqual(['kept while the server hangs']);expect(fs.existsSync(breaker)).toBe(false);
 } finally {server.stop(true);fs.rmSync(root,{recursive:true,force:true});}
},30_000);

test('an empty Codex Desktop thread without a transcript sends nothing to the server [A7-08]',async()=>{
 const root=fs.mkdtempSync('/var/tmp/qoopia-codex-empty-'),home=path.join(root,'home');fs.mkdirSync(path.join(home,'.codex'),{recursive:true,mode:0o700});
 const received:any[]=[];
 const server=Bun.serve({port:0,async fetch(req){if(new URL(req.url).pathname==='/memory/canon'){received.push('canon');return new Response('',{status:404});}const event=await req.json() as any;received.push(event);return Response.json({accepted:event.messages.map((m:any)=>m.id),session_id:event.session_id,tail:[]});}});
 try {
  installMemoryClient({format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:'fixture',key:'q_fixture',runtime:'codex'},root,process.execPath,home);
  const file=path.join(root,'memory-clients/codex/connection.json');
  const hook=(session:string,event:string,extra:any={})=>runMemoryHook(file,{session_id:session,cwd:'/',transcript_path:null,hook_event_name:event,...extra});
  await hook('empty','SessionStart');await hook('empty','SessionEnd');
  expect(received).toEqual([]);
  // The first turn registers the thread, then delivers it.
  await hook('real','SessionStart');await hook('real','UserPromptSubmit',{turn_id:'t1',prompt:'hello'});
  // The first turn also asks for canon: it brings the always canons the silent start skipped.
  expect(received.filter(e=>e==='canon').length).toBe(1);
  expect(received.filter(e=>e!=='canon').map(e=>[e.event,e.messages.length])).toEqual([['start',0],['progress',1]]);
 } finally {server.stop(true);fs.rmSync(root,{recursive:true,force:true});}
});

test('a relink keeps a hook the owner added to the Qoopia group, and accepts an entry with the ignored ?profile=full [A7-05, A7-11]',()=>{
 const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-client-group-')),home=path.join(root,'home');fs.mkdirSync(path.join(home,'.claude'),{recursive:true,mode:0o700});
 try {
  const connection={format:'qoopia-memory-connection/1',url:'http://127.0.0.1:9',agent_id:'fixture',key:'q_fixturekey',runtime:'claude_code'};
  installMemoryClient(connection,root,process.execPath,home);
  const settings=path.join(home,'.claude/settings.json'),config=JSON.parse(fs.readFileSync(settings,'utf8'));
  config.hooks.Stop[0].hooks.push({type:'command',command:'/usr/local/bin/my-own-stop-hook'});fs.writeFileSync(settings,JSON.stringify(config));
  const mcp=path.join(home,'.claude.json'),entry=JSON.parse(fs.readFileSync(mcp,'utf8'));
  entry.mcpServers.qoopia_memory.url+='?profile=full';fs.writeFileSync(mcp,JSON.stringify(entry));
  installMemoryClient(connection,root,process.execPath,home);
  const after=JSON.parse(fs.readFileSync(settings,'utf8'));
  expect(after.hooks.Stop.flatMap((g:any)=>g.hooks.map((h:any)=>h.command))).toContain('/usr/local/bin/my-own-stop-hook');
  expect(after.hooks.Stop.flatMap((g:any)=>g.hooks).filter((h:any)=>h.command.includes('memory-hook'))).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(mcp,'utf8')).mcpServers.qoopia_memory.url).toBe('http://127.0.0.1:9/mcp');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('doctor sees removed hooks and a missing MCP entry; deleted and foreign transcripts are not failures [A7-04, A7-09, A7-10]',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-client-health-')),home=path.join(root,'home'),logs=path.join(home,'.claude/projects/p');
 fs.mkdirSync(logs,{recursive:true,mode:0o700});
 const server=Bun.serve({port:0,async fetch(req){if(new URL(req.url).pathname==='/memory/canon')return new Response('',{status:404});const event=await req.json() as any;return Response.json({accepted:event.messages.map((m:any)=>m.id),session_id:event.session_id,tail:[]});}});
 try {
  installMemoryClient({format:'qoopia-memory-connection/1',url:`http://127.0.0.1:${server.port}`,agent_id:'fixture',key:'q_fixturekey',runtime:'claude_code'},root,process.execPath,home);
  const file=path.join(root,'memory-clients/claude_code/connection.json'),line=JSON.stringify({type:'user',uuid:'u',message:{role:'user',content:'x'}})+'\n';
  const run=(t:string,event='Stop')=>runMemoryHook(file,{session_id:path.basename(t,'.jsonl'),cwd:'/p',transcript_path:t,hook_event_name:event});
  const live=path.join(logs,'live.jsonl'),gone=path.join(logs,'gone.jsonl');fs.writeFileSync(live,line);fs.writeFileSync(gone,line);
  await run(live);await run(gone);fs.rmSync(gone);await run(gone); // Claude Code pruned it
  const foreign=path.join(root,'other-profile/projects/p/f.jsonl');fs.mkdirSync(path.dirname(foreign),{recursive:true,mode:0o700});fs.writeFileSync(foreign,line);await run(foreign);
  await Bun.sleep(20);fs.appendFileSync(live,line.replace('"u"','"u2"'));await run(live);
  const check=memoryClientsCheck(root,home);
  expect(check).toMatchObject({status:'warn',reason:'FOREIGN_PROFILE',runtimes:[{failing_sessions:0,stale_sessions:1,foreign_profile_sessions:1,hooks:'6/6',mcp_entry:'present'}]});
  expect(check.action).toContain('--config-directory');
  const mcp=path.join(home,'.claude.json');fs.writeFileSync(mcp,'{}');
  expect(memoryClientsCheck(root,home)).toMatchObject({status:'warn',reason:'MCP_ENTRY_MISSING'});
  const settings=path.join(home,'.claude/settings.json');fs.writeFileSync(settings,'{}');
  expect(memoryClientsCheck(root,home)).toMatchObject({status:'fail',reason:'HOOKS_MISSING',runtimes:[{hooks:'0/6'}]});
  // A month later, session start moves the dead cursor out of every scan.
  const dead=path.join(root,'memory-clients/claude_code/cursors',hash(gone)+'.json'),old=new Date(Date.now()-40*86_400_000);fs.utimesSync(dead,old,old);
  await run(path.join(logs,'next.jsonl'),'SessionStart');
  expect(fs.existsSync(dead)).toBe(false);expect(fs.existsSync(path.join(path.dirname(dead),'archived',path.basename(dead)))).toBe(true);
 } finally {server.stop(true);fs.rmSync(root,{recursive:true,force:true});}
});
