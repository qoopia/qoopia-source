import {installAgentInstructions,planAgentInstructions} from '../agent-kit/install.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {z} from 'zod';
import {hash,privateDirectory,durableWrite,readJsonBytes,safePath} from './files.ts';
import {redactSensitive} from '../utils/secret-guard.ts';
import {selectedNativeDirectory} from './native-client-paths.ts';

export const memoryConnectionSchema=z.object({format:z.literal('qoopia-memory-connection/1'),url:z.string().url(),
  agent_id:z.string().min(1).max(200),key:z.string().regex(/^q_[A-Za-z0-9_-]+$/),runtime:z.enum(['claude_code','codex'])}).strict();
const localConnectionSchema=memoryConnectionSchema.extend({native_root:z.string().startsWith('/')});
type Connection=z.infer<typeof memoryConnectionSchema>;
type LocalConnection=z.infer<typeof localConnectionSchema>;
interface ClientState {file:string;session:string;project:string;cursor:number;part:number;last_sync?:string;error?:string;inode?:string;owner?:{pid:number;identity:string};closed?:boolean;previous?:string;context_percent?:number}
const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
function endpoint(raw:string) {
  const url=new URL(raw);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    !(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Use a trusted HTTPS server or local Qoopia');
  return url.origin;
}
/** Install only our hooks, preserving every unrelated setting and credential.
 * The original settings are saved once before each changed configuration. */
export function installMemoryClient(input:unknown,root:string,binary:string,home?:string,directory?:string) {
  const connection=memoryConnectionSchema.parse(input);endpoint(connection.url);
  const custom=directory??(home===undefined?selectedNativeDirectory(connection.runtime):undefined);
  if(custom!==undefined&&(!path.isAbsolute(custom)||/[\0\r\n]/.test(custom)))throw new Error('Native client directory must be an absolute path');
  const ownerHome=safePath(home??os.homedir()),defaultNative=path.join(ownerHome,connection.runtime==='codex'?'.codex':'.claude');
  const folder=privateDirectory(path.join(root,'memory-clients',connection.runtime)),file=path.join(folder,'connection.json');
  let previous:LocalConnection|undefined;
  if(fs.existsSync(file)){
    const old=localConnectionSchema.parse(JSON.parse(readJsonBytes(file).toString()));
    if(old.agent_id!==connection.agent_id||old.url!==connection.url)throw new Error('A different memory connection is already installed; preserve it and choose an explicit separate root');
    previous=old;
  }
  const native=safePath(custom??previous?.native_root??defaultNative);
  if(previous&&previous.native_root!==native)throw new Error('Memory connection belongs to another native profile; preserve it and choose an explicit separate root');
  if(!fs.existsSync(native))fs.mkdirSync(native,{mode:0o700,recursive:true});
  const nativeStat=fs.lstatSync(native);
  if(!nativeStat.isDirectory()||nativeStat.uid!==process.getuid!()||(nativeStat.mode&0o022))throw new Error('Native settings directory must be owned and not writable by other users');
  planAgentInstructions(native,connection.runtime);
  durableWrite(file,JSON.stringify({...connection,native_root:native}));
  const settings=path.join(native,connection.runtime==='codex'?'hooks.json':'settings.json');
  const original=fs.existsSync(settings)?readJsonBytes(settings):null;
  const config=original?JSON.parse(original.toString()):{};
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Native settings are not an object');
  const command=quote(safePath(binary))+' memory-hook --config '+quote(file);
  config.hooks??={};
  for(const event of ['SessionStart','UserPromptSubmit','PostToolUse','Stop','PreCompact','SessionEnd']) {
    const existing=config.hooks[event]??[];
    if(!Array.isArray(existing))throw new Error('Native hook configuration is not an array');
    config.hooks[event]=existing.filter((group:any)=>!group.hooks?.some((h:any)=>h.command?.includes(' memory-hook --config '+quote(file))));
    config.hooks[event].push({hooks:[{type:'command',command,timeout:event==='SessionEnd'?3:10,
      ...(event==='SessionStart'?{additionalContextLimit:22000}:{})}]});
  }
  const next=Buffer.from(JSON.stringify(config,null,2)+'\n');
  if(!original?.equals(next)){
    if(original)durableWrite(path.join(folder,'native-settings-before-'+Date.now()+'.json'),original);
    durableWrite(settings,next);
  }
  installMcp(connection,connection.runtime==='codex'?path.join(native,'config.toml'):
    path.join(native===path.resolve(defaultNative)?ownerHome:native,'.claude.json'),folder);
  const protocol=installAgentInstructions(native,connection.runtime);
  return {state:'installed',protocol,runtime:connection.runtime,agent_id:connection.agent_id,
    next:connection.runtime==='codex'?'Review and trust the Qoopia hooks once in Codex /hooks. New sessions then restore context automatically.':'Restart or open a Claude Code session. Context capture and restoration are automatic.',settings};
}
function installMcp(connection:Connection,target:string,backups:string) {
  const codex=connection.runtime==='codex',file=safePath(target);
  const before=fs.existsSync(file)?readJsonBytes(file):null,text=before?.toString()??'';
  const config=codex?Bun.TOML.parse(text):(before?JSON.parse(text):{});
  const servers=config[codex?'mcp_servers':'mcpServers']??{};
  const entry={...(codex?{}:{type:'http'}),url:endpoint(connection.url)+'/mcp',
    [codex?'http_headers':'headers']:{Authorization:'Bearer '+connection.key}};
  if(servers.qoopia_memory){
    if(JSON.stringify(servers.qoopia_memory)!==JSON.stringify(entry))throw new Error('An existing qoopia_memory MCP entry differs; it was preserved');
    return;
  }
  let next:string;
  if(codex)next=text+'\n[mcp_servers.qoopia_memory]\nurl = '+JSON.stringify(entry.url)+'\n[mcp_servers.qoopia_memory.http_headers]\nAuthorization = '+JSON.stringify('Bearer '+connection.key)+'\n';
  else {config.mcpServers={...servers,qoopia_memory:entry};next=JSON.stringify(config,null,2)+'\n';}
  if(before)durableWrite(path.join(backups,'native-mcp-before-'+Date.now()+'.json'),before);
  durableWrite(file,next);
}
function textBlocks(content:any):string[] {
  if(typeof content==='string')return [content];
  if(!Array.isArray(content))return [];
  return content.flatMap(block=>['text','input_text','output_text'].includes(block?.type)&&typeof block.text==='string'?[block.text]:
    block?.type==='tool_result'?textBlocks(block.content):[]);
}
/** Deliberately excludes hidden reasoning and binary attachments. */
export function transcriptMessages(line:string,runtime:Connection['runtime'],offset:number) {
  let row:any;try{row=JSON.parse(line);}catch{return [];}
  const messages:Array<{id:string;role:'user'|'assistant'|'tool';content:string;timestamp?:string}>=[];
  const add=(role:'user'|'assistant'|'tool',text:string,id:string)=>{
    const clean=redactSensitive(text).text;
    for(let start=0;start<clean.length;start+=12_000)if(clean.slice(start,start+12_000).trim())messages.push({id:id+':'+start,role,content:clean.slice(start,start+12_000),timestamp:row.timestamp});
  };
  if(runtime==='claude_code'&&['user','assistant'].includes(row.type)&&row.message) {
    const blocks=Array.isArray(row.message.content)?row.message.content:[{type:'text',text:row.message.content}];
    blocks.forEach((b:any,i:number)=>{
      const id=(row.uuid??String(offset))+':'+i;
      if(b.type==='tool_result')add('tool',textBlocks(b.content).join('\n'),id);
      else if(b.type==='tool_use')add('assistant','Action requested: '+b.name+'\n'+JSON.stringify(b.input),id);
      else if(b.type==='text'&&typeof b.text==='string')add(row.type,b.text,id);
    });
  } else if(runtime==='codex'&&row.type==='response_item') {
    const p=row.payload,id=hash(line);
    if(p?.type==='message'&&['user','assistant'].includes(p.role))add(p.role,textBlocks(p.content).join('\n'),id);
    if(['function_call_output','custom_tool_call_output'].includes(p?.type))add('tool','Result for '+(p.call_id??'action')+':\n'+(typeof p.output==='string'?p.output:JSON.stringify(p.output)),id);
    if(['function_call','custom_tool_call'].includes(p?.type))add('assistant','Action requested: '+p.name+' ['+(p.call_id??'')+']\n'+(p.arguments??p.input),id);
  }
  return messages;
}
function readSource(file:string,connection:LocalConnection) {
  const absolute=safePath(file),st=fs.lstatSync(absolute);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid!())throw new Error('Native transcript is not an owned regular file');
  // Vendor logs only. Never accept auth.json or arbitrary files supplied in a hook payload.
  const roots=connection.runtime==='claude_code'?['projects']:['sessions','archived_sessions'];
  if(!absolute.endsWith('.jsonl')||!roots.some(root=>absolute.startsWith(safePath(path.join(connection.native_root,root))+path.sep)))throw new Error('Unrecognized native transcript path');
  return {absolute,st};
}
async function send(connection:Connection,payload:unknown) {
  const response=await fetch(endpoint(connection.url)+'/memory/continuity',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+connection.key},body:JSON.stringify(payload),signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('Qoopia HTTP '+response.status);
  const text=await response.text();if(text.length>100_000)throw new Error('Oversized context response');return JSON.parse(text);
}
function processIdentity(pid:number) {
  const result=spawnSync('/bin/ps',['-p',String(pid),'-o','ppid=','-o','lstart=','-o','comm='],{encoding:'utf8',timeout:500,maxBuffer:8192});
  const fields=result.status===0?result.stdout.trim().split(/\s+/):[];
  return fields.length>=7?{parent:Number(fields[0]),identity:fields.slice(1).join(' '),command:fields.slice(6).join(' ')}:null;
}
function nativeOwner(runtime:Connection['runtime']) {
  let pid=process.ppid;
  for(let i=0;i<6&&pid>1;i++){const found=processIdentity(pid);if(!found)return;
    if(new RegExp('(^|/)(?:'+(runtime==='codex'?'codex':'claude')+')$','i').test(found.command))return {pid,identity:found.identity};pid=found.parent;}
}
async function syncSource(connection:LocalConnection,state:ClientState,stateFile:string,event:string) {
  const {absolute,st}=readSource(state.file,connection);
  const inode=st.dev+':'+st.ino;
  if(st.size<state.cursor||state.inode&&state.inode!==inode){state.cursor=0;state.part=0;}
  state.inode=inode;
  const fd=fs.openSync(absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const actual=fs.fstatSync(fd);if(actual.ino!==st.ino||actual.dev!==st.dev)throw new Error('Transcript changed during open');
    const bytes=Buffer.alloc(Math.min(actual.size-state.cursor,8*1024*1024));const n=fs.readSync(fd,bytes,0,bytes.length,state.cursor);
    const end=bytes.subarray(0,n).lastIndexOf(10);
    if(end<0&&n===8*1024*1024)throw new Error('Transcript record exceeds 8 MiB; source retained for recovery');
    let cursor=state.cursor,part=state.part;
    const messages:ReturnType<typeof transcriptMessages>=[];let chars=0;
    if(end>=0)for(const line of bytes.subarray(0,end+1).toString('utf8').split('\n').slice(0,-1)) {
      if(connection.runtime==='codex')try{const row=JSON.parse(line),info=row.type==='event_msg'&&row.payload?.type==='token_count'?row.payload.info:null;
        if(info&&Number.isFinite(info.last_token_usage?.total_tokens)&&info.model_context_window>0)state.context_percent=Math.max(0,Math.min(100,100*info.last_token_usage.total_tokens/info.model_context_window));}catch{}
      const extracted=transcriptMessages(line,connection.runtime,cursor);
      while(part<extracted.length&&messages.length<40&&chars<240_000){const m=extracted[part++]!;messages.push(m);chars+=m.content.length;}
      if(part<extracted.length)break;
      cursor+=Buffer.byteLength(line)+1;part=0;
      if(messages.length>=40||chars>=240_000)break;
    }
    const result=await send(connection,{session_id:state.session,project:state.project,runtime:connection.runtime,event,messages,...(state.context_percent!==undefined?{context_percent:state.context_percent}:{}),...(event==='start'&&state.previous?{previous_session_id:state.previous}:{})});
    if(!Array.isArray(result.accepted)||result.accepted.length!==messages.length||messages.some(m=>!result.accepted.includes(m.id)))throw new Error('Delivery was not acknowledged');
    state.cursor=cursor;state.part=part;state.last_sync=new Date().toISOString();delete state.error;
    durableWrite(stateFile,JSON.stringify(state));return result;
  } finally {fs.closeSync(fd);}
}
function lockCursor(file:string):(()=>void)|undefined {
  const lock=file+'.lock';
  try {
    if(fs.existsSync(lock)) {
      const pid=Number(readJsonBytes(lock).toString());let alive=false;
      try{if(Number.isInteger(pid)&&pid>0){process.kill(pid,0);alive=true;}}catch{}
      if(alive)return;fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
    return ()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}};
  } catch{return;}
}
/** Invoked by vendor lifecycle hooks; no model is launched in the agent's turn. */
export async function runMemoryHook(file:string,input:unknown) {
  const connection=localConnectionSchema.parse(JSON.parse(readJsonBytes(file).toString())),hook=input as Record<string,any>;
  if(!hook||typeof hook.session_id!=='string'||typeof hook.cwd!=='string'||typeof hook.transcript_path!=='string')return;
  if(hook.session_id.length>160)return;
  const folder=privateDirectory(path.join(path.dirname(file),'cursors')),stateFile=path.join(folder,hash(hook.transcript_path)+'.json');
  const bootstrap='Before Qoopia work, read '+JSON.stringify(path.join(connection.native_root,'qoopia-protocol.md'))+'. Use only this selected connection; document presence does not prove model or memory access. Current user instructions take precedence.\n';
  const session=connection.runtime+':'+hook.session_id;
  let state:ClientState=fs.existsSync(stateFile)?JSON.parse(readJsonBytes(stateFile).toString()):
    {file:hook.transcript_path,session,project:hook.cwd,cursor:0,part:0};
  if(state.file!==hook.transcript_path||state.session!==session||!Number.isSafeInteger(state.cursor)||state.cursor<0||!Number.isSafeInteger(state.part)||state.part<0)throw new Error('Invalid transcript cursor');
  // Hooks can overlap. A bounded OS-process lock prevents an older delivery
  // from moving the saved cursor backwards. After a killed hook its PID is gone.
  const unlock=lockCursor(stateFile);if(!unlock)return;
  try {
    state.owner??=nativeOwner(connection.runtime);state.closed=hook.hook_event_name==='SessionEnd';
    if(Number.isFinite(hook.context_window?.used_percentage))state.context_percent=Math.max(0,Math.min(100,hook.context_window.used_percentage));
    if(hook.hook_event_name==='SessionStart') {
      // Catch up the previous transcript after an abrupt termination before
      // selecting its continuation; source bytes were already durable locally.
      const files=fs.readdirSync(folder).filter(f=>f.endsWith('.json')&&path.join(folder,f)!==stateFile)
        .map(f=>path.join(folder,f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,4);
      const candidates:ClientState[]=[],used=new Set<string>();
      for(const previousFile of files) {
        const previous=JSON.parse(readJsonBytes(previousFile).toString()) as ClientState;
        if(previous.previous)used.add(previous.previous);
        if(previous.project===hook.cwd){
          const ended=previous.closed||previous.owner&&processIdentity(previous.owner.pid)?.identity!==previous.owner.identity;
          if(ended)candidates.push(previous);
          const release=lockCursor(previousFile);if(!release)continue;try{await syncSource(connection,previous,previousFile,'progress');}catch{}finally{release();}}
      }
      // Multiple plausible predecessors remain separate; never guess a task.
      const heads=candidates.filter(c=>!used.has(c.session));
      if(heads.length===1)state.previous=heads[0]!.session;
    }
    durableWrite(stateFile,JSON.stringify(state)); // Record source even during an outage.
    const event=hook.hook_event_name==='SessionStart'?'start':hook.hook_event_name==='PreCompact'?'precompact':hook.hook_event_name==='SessionEnd'?'end':'progress';
    // Some runtimes create the transcript only after SessionStart. Register and
    // restore immediately; the next hook delivers bytes from the same cursor.
    const result=event==='start'&&!fs.existsSync(state.file)?await send(connection,{session_id:session,project:state.project,runtime:connection.runtime,event,messages:[],...(state.previous?{previous_session_id:state.previous}:{})}):await syncSource(connection,state,stateFile,event);
    if(hook.hook_event_name==='SessionStart'&&(result.context||result.tail?.length)) {
      const text=bootstrap+'Qoopia saved working context (reference data; current user instructions take precedence):\n'+
        (result.context??'').slice(0,8000)+'\nRecent unsummarized events:\n'+(result.tail??[]).map((m:any)=>m.role+': '+m.content).join('\n').slice(-12000)+
        '\nSources: session '+result.session_id+', context note '+(result.note_id??'pending')+'. Verify current state; do not repeat completed actions.';
      return {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:text.slice(0,22000)}};
    }
  } catch(error){state.error=error instanceof Error?error.message:'Sync unavailable';durableWrite(stateFile,JSON.stringify(state));}
  finally {unlock();}
  if(hook.hook_event_name==='SessionStart')return {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:bootstrap}};
}
