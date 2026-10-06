import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {agentKit,agentKitManifest,type AgentKitLanguage} from './index.ts';
import {safePath,privateDirectory,durableWrite,hash,hasNulOrNewline} from '../utils/fs.ts';
import {QoopiaError,type QoopiaErrorCode} from '../utils/errors.ts';
import {nativeOwnerHome} from '../delivery/native-keychain.ts';
const BEGIN='<!-- qoopia:protocol:start -->',END='<!-- qoopia:protocol:end -->';
const referenceDirectorySchema=z.string().startsWith('/').max(2048).refine(value=>!hasNulOrNewline(value),'Invalid runtime instruction path');
const receiptSchema=z.object({reference_directory:referenceDirectorySchema.optional(),format:z.literal('qoopia-instructions/1'),files:z.record(z.string(), z.object({before:z.string().nullable(),after:z.string()})),blocks:z.array(z.string()),role:z.enum(['client','steward']).optional(),language:z.enum(['ru','en']).optional(),state:z.enum(['pending','installed','removed'])});
type Change={file:string;before:string|null;after:string;kind:'document'|'instructions'};
/** A refusal names its cause and file so the owner can fix it; the client still has qoopia_protocol over MCP. */
function refuse(code:QoopiaErrorCode,message:string,file:string):never{throw new QoopiaError(code,message+': '+file,{file});}
function checked(file:string){try{return safePath(file);}catch(error){return refuse('INSTRUCTIONS_LINKED_PATH',(error as Error).message,file);}}
function read(file:string){checked(file);if(!fs.existsSync(file))return null;const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1)refuse('INSTRUCTIONS_LINKED_PATH','Links and special files are refused',file);
  if(st.uid!==process.getuid?.()||(st.mode&0o022))refuse('INSTRUCTIONS_UNSAFE_MODE','Instruction file must be owned and not writable by other users',file);
  if(st.size>256_000)refuse('INSTRUCTIONS_TOO_LARGE','Instruction file is too large',file);return fs.readFileSync(file,'utf8');}
/** What a connect reports instead of failing: the MCP entry does not depend on local instructions. */
export function instructionRefusal(error:unknown){
  return {state:'refused',code:error instanceof QoopiaError?error.code:'INSTRUCTIONS_REFUSED',...(error instanceof QoopiaError&&typeof error.details?.file==='string'?{file:error.details.file}:{}),
    reason:error instanceof Error?error.message:'unknown',delivery:'mcp',tool:'qoopia_protocol',loaded:'NOT_VERIFIED'};
}
/** Plan contains no credentials; unchanged user instructions outside our block are preserved. */
export function planAgentInstructions(directory:string,runtime:'codex'|'claude_code',role:'client'|'steward'='client',referenceDirectory?:string,relink=true,requestedLanguage?:AgentKitLanguage){
  const root=checked(directory);
  if(fs.existsSync(root)){const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022))refuse('INSTRUCTIONS_UNSAFE_MODE','Native instruction directory is not owned and protected',root);}
  const store=path.join(root,'qoopia'),receiptFile=path.join(store,'instructions-receipt.json'),receiptText=read(receiptFile),receipt=receiptText?receiptSchema.parse(JSON.parse(receiptText)):null;
  if(role==='client'&&receipt?.role==='steward')role='steward';
  // A bind mount can give the same files different writer and reader paths.
  const referenceRoot=path.normalize(referenceDirectorySchema.parse(referenceDirectory??receipt?.reference_directory??root)),referenceStore=path.join(referenceRoot,'qoopia');
  const installedManifest=read(path.join(store,'manifest.json'));
  if(installedManifest&&JSON.parse(installedManifest).revision>agentKitManifest().revision)refuse('INSTRUCTIONS_NEWER','Newer instruction kit already installed; refusing downgrade',path.join(store,'manifest.json'));
  const overrides=runtime==='codex'?read(path.join(root,'AGENTS.override.md')):null;
  const entry=path.join(root,runtime==='codex'&&overrides?.trim()?'AGENTS.override.md':runtime==='codex'?'AGENTS.md':'CLAUDE.md');
  // An explicit choice (the owner's dashboard language, refresh --language) wins; otherwise the profile keeps its language.
  const language=requestedLanguage??receipt?.language??'ru',kit=agentKit(language);
  const manifest=agentKitManifest(language),changes:Change[]=[];
  // A removed kit, or a block the owner deleted, stays out until an explicit connect or link (relink).
  if(!relink&&receipt&&(receipt.state==='removed'||receipt.state==='installed'&&!entryFiles(runtime).some(name=>read(path.join(root,name))?.includes(BEGIN))))
    return {opted_out:true as const,root,instruction_file:entry,protocol_file:path.join(root,'qoopia-protocol.md'),manifest,changes};
  const docs:Record<string,string>={'qoopia-protocol.md':kit['qoopia-protocol.md'],...Object.fromEntries(Object.entries(kit).filter(([name])=>name!=='qoopia-protocol.md').map(([name,text])=>['qoopia/'+name,text])),'qoopia/manifest.json':JSON.stringify(manifest,null,2)+'\n'};
  for(const [relative,after] of Object.entries(docs)){
    const file=path.join(root,relative),before=read(file),known=receipt?.files[relative];
    if(before!==null&&before!==after&&(!known||![known.before,known.after].includes(hash(before))))refuse('INSTRUCTIONS_EDITED','Qoopia instruction document was edited or is not managed',file);
    if(before!==after)changes.push({file,before,after,kind:'document'});
  }
  const instructionBefore=read(entry),text=instructionBefore??'',start=text.indexOf(BEGIN),end=text.indexOf(END);
  if((start<0)!==(end<0)||start>=0&&(end<start||text.indexOf(BEGIN,start+BEGIN.length)>=0||text.indexOf(END,end+END.length)>=0))refuse('INSTRUCTIONS_EDITED','Qoopia instruction markers are malformed; user file preserved',entry);
  const oldBlock=start>=0?text.slice(start,end+END.length):null;
  const block=BEGIN+'\n## Qoopia protocol\nBefore working with Qoopia, read '+(runtime==='claude_code'?'the imported protocol below.\n@qoopia-protocol.md':'the protocol at '+JSON.stringify(path.join(referenceRoot,'qoopia-protocol.md'))+'.')+'\nCompare the revision in '+JSON.stringify(path.join(referenceStore,'manifest.json'))+' with protocol.revision from qoopia_capabilities. If the server number is higher these documents are out of date: do not present them as current, read qoopia_protocol instead and tell the owner; qoopia instructions refresh --commit on this computer updates them.\nUse only the selected connection; query its actual tools and permissions. Documents do not grant owner authority. For reconnecting ChatGPT or Claude read '+JSON.stringify(path.join(referenceStore,'MCP-CONNECTIONS.md'))+'.\n'+(role==='steward'?'Keep your existing name, role and instructions. For Qoopia stewardship read '+JSON.stringify(path.join(referenceStore,'SOUL.md'))+' and '+JSON.stringify(path.join(referenceStore,'OPERATIONS.md'))+' for Qoopia operating procedures.\n':'Keep your existing role and instructions; this block applies only to Qoopia work.\n')+END;
  if(oldBlock&&oldBlock!==block&&!receipt?.blocks.includes(hash(oldBlock)))refuse('INSTRUCTIONS_EDITED','Qoopia managed instruction block was edited; user file preserved',entry);
  const after=start>=0?text.slice(0,start)+block+text.slice(end+END.length):text+(text&&!text.endsWith('\n')?'\n':'')+'\n'+block+'\n';
  if(Buffer.byteLength(after)>28_000)refuse('INSTRUCTIONS_TOO_LARGE','Native instructions are too large to safely append Qoopia guidance; use an explicit dedicated profile',entry);
  if(after!==text)changes.push({file:entry,before:instructionBefore,after,kind:'instructions'});
  const files={...receipt?.files};for(const [relative,body] of Object.entries(docs)){const change=changes.find(c=>c.file===path.join(root,relative));files[relative]={before:change?.before===null?null:change?.before!==undefined?hash(change.before):hash(body),after:hash(body)};}
  const pending={reference_directory:referenceRoot,format:'qoopia-instructions/1' as const,role,language,files,blocks:[...new Set([...receipt?.blocks??[],...(oldBlock?[hash(oldBlock)]:[]),hash(block)])].slice(-32),state:'pending' as const};
  return {opted_out:false as const,root,store,receiptFile,receiptText,pending,changes,instruction_file:entry,protocol_file:path.join(root,'qoopia-protocol.md'),manifest,digest:hash(JSON.stringify({runtime,role,manifest,changes:changes.map(c=>({file:c.file,before:c.before===null?null:hash(c.before),after:hash(c.after)}))}))};
}
/** The SessionStart hook installs under a vendor timeout, so a kill can leave the lock behind.
 * Its owner is then gone; a reused PID or a lock that never got one is bounded by age. */
function abandoned(lock:string){
  let pid:unknown;
  try{pid=JSON.parse(fs.readFileSync(lock,'utf8')).pid;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;}
  if(Date.now()-fs.lstatSync(lock).mtimeMs>60_000)return true;
  if(!Number.isSafeInteger(pid)||(pid as number)<=0)return false;
  try{process.kill(pid as number,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
}
function locked<T>(store:string,run:()=>T):T{
  const lock=path.join(store,'install.lock');if(abandoned(lock))fs.rmSync(lock,{force:true});
  let fd:number;try{fd=fs.openSync(lock,'wx',0o600);}catch{refuse('INSTRUCTIONS_LOCKED','Another instruction installation is running; inspect an abandoned lock before retrying',lock);}
  try{fs.writeSync(fd,JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));return run();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function installAgentInstructions(directory:string,runtime:'codex'|'claude_code',role:'client'|'steward'='client',referenceDirectory?:string,relink=true,language?:AgentKitLanguage){
  const plan=planAgentInstructions(directory,runtime,role,referenceDirectory,relink,language);
  if(plan.opted_out)return {state:'opted_out' as const,protocol_file:plan.protocol_file,instruction_file:plan.instruction_file,manifest:plan.manifest,loaded:'NOT_VERIFIED'};
  if(!plan.changes.length&&plan.receiptText&&JSON.parse(plan.receiptText).state==='installed')return {state:'installed' as const,protocol_file:plan.protocol_file,instruction_file:plan.instruction_file,manifest:plan.manifest,loaded:'NOT_VERIFIED'};
  if(!fs.existsSync(plan.root))privateDirectory(plan.root);privateDirectory(plan.store);
  return locked(plan.store,()=>{
    if(read(plan.receiptFile)!==plan.receiptText)throw new Error('Instruction receipt changed during installation');
    for(const c of plan.changes)if(read(c.file)!==c.before)throw new Error('Instructions changed during installation; retry the plan');
    const backups=privateDirectory(path.join(plan.store,'backups'));
    for(const c of plan.changes)if(c.before!==null)durableWrite(path.join(backups,randomUUID()+'.md'),c.before);
    durableWrite(plan.receiptFile,JSON.stringify(plan.pending));
    for(const c of plan.changes){if(read(c.file)!==c.before)throw new Error('Instructions changed during installation; retry the plan');durableWrite(c.file,c.after);}
    durableWrite(plan.receiptFile,JSON.stringify({...plan.pending,state:'installed'}));
    return {state:'installed' as const,protocol_file:plan.protocol_file,instruction_file:plan.instruction_file,manifest:plan.manifest,loaded:'NOT_VERIFIED'};
  });
}
const entryFiles=(runtime:'codex'|'claude_code')=>runtime==='codex'?['AGENTS.md','AGENTS.override.md']:['CLAUDE.md'];
/** The inverse of an install, from its receipt: our block and our unchanged documents go; owner
 * text and blocks around it stay. Anything edited is refused before a write. Without commit this
 * only reports. The SessionStart hook then leaves the profile alone (see relink). */
export function removeAgentInstructions(directory:string,runtime:'codex'|'claude_code',commit=false){
  const root=checked(directory),store=path.join(root,'qoopia'),receiptFile=path.join(store,'instructions-receipt.json'),receiptText=read(receiptFile);
  if(!receiptText)return {state:'absent' as const,directory:root,files:[] as string[]};
  const receipt=receiptSchema.parse(JSON.parse(receiptText)),changes:{file:string;before:string;after:string|null}[]=[];
  for(const [relative,known] of Object.entries(receipt.files)){
    const file=path.join(root,relative),before=read(file);if(before===null)continue;
    if(![known.before,known.after].includes(hash(before)))refuse('INSTRUCTIONS_EDITED','Qoopia instruction document was edited; it was preserved',file);
    changes.push({file,before,after:null});
  }
  for(const name of entryFiles(runtime)){
    const file=path.join(root,name),text=read(file),start=text?.indexOf(BEGIN)??-1,end=text?.indexOf(END)??-1;
    if(text===null||start<0&&end<0)continue;
    if(start<0||end<start||text.indexOf(BEGIN,start+BEGIN.length)>=0||text.indexOf(END,end+END.length)>=0)refuse('INSTRUCTIONS_EDITED','Qoopia instruction markers are malformed; user file preserved',file);
    if(!receipt.blocks.includes(hash(text.slice(start,end+END.length))))refuse('INSTRUCTIONS_EDITED','Qoopia managed instruction block was edited; user file preserved',file);
    let prefix=text.slice(0,start),suffix=text.slice(end+END.length);
    if(suffix.startsWith('\n'))suffix=suffix.slice(1);
    // The blank line the install put before the block goes with it.
    if((prefix==='\n'||prefix.endsWith('\n\n'))&&(!suffix||suffix.startsWith('\n')))prefix=prefix.slice(0,-1);
    changes.push({file,before:text,after:prefix+suffix||null});
  }
  if(!commit)return {state:'planned' as const,directory:root,files:changes.map(c=>c.file)};
  return locked(store,()=>{
    if(read(receiptFile)!==receiptText)throw new Error('Instruction receipt changed during removal');
    for(const c of changes)if(read(c.file)!==c.before)throw new Error('Instructions changed during removal; retry');
    const backups=privateDirectory(path.join(store,'backups'));
    for(const c of changes)durableWrite(path.join(backups,randomUUID()+'.md'),c.before);
    for(const c of changes)if(c.after===null)fs.unlinkSync(c.file);else durableWrite(c.file,c.after);
    durableWrite(receiptFile,JSON.stringify({...receipt,state:'removed'}));
    return {state:'removed' as const,directory:root,files:changes.map(c=>c.file)};
  });
}

/** The instruction profile of a client MCP file: Claude Code keeps ~/.claude.json beside ~/.claude. */
export function clientInstructionProfile(surface:'codex'|'claude_code',file:string,home=nativeOwnerHome()){
  // A linked ~/.claude.json is never a selected file, so it only has to compare unequal here.
  let homeFile=path.join(home,'.claude.json');try{homeFile=safePath(homeFile);}catch{/* Linked: keep the raw path, which never equals a selected file. */}
  return surface==='codex'?path.dirname(file):file===homeFile?path.join(home,'.claude'):path.dirname(file);
}
/** Re-publish the kit into every profile this installation has already linked.
 *
 * Instructions are otherwise written only while connecting a client or linking
 * memory, so a new revision never reaches an existing profile by itself and
 * someone has to remember every machine. Without --commit this reports what
 * would change; a profile whose documents were edited by hand is reported and
 * left alone rather than overwritten. */
export function refreshAgentInstructions(root:string,commit=false,language?:AgentKitLanguage){
  const base=safePath(root),profiles:Record<string,unknown>[]=[],seen=new Set<string>();
  const manifest=agentKitManifest(),list=(folder:string)=>fs.existsSync(folder)?fs.readdirSync(folder).sort():[];
  const memory=path.join(base,'memory-clients'),clients=path.join(base,'client-configs');
  // memory-link records the profile; client-link/client-apply install into the profile of the MCP file they edited.
  const sources:(readonly [string,unknown,(value:any)=>{runtime:unknown;native:unknown}|null])[]=[
    ...list(memory).filter(runtime=>runtime==='codex'||runtime==='claude_code').map(runtime=>[path.join(memory,runtime,'connection.json'),runtime,(value:any)=>({runtime,native:value?.native_root})] as const),
    ...list(clients).map(id=>[path.join(clients,id,'receipt.json'),undefined,(value:any)=>value?.state!=='applied'||!['codex','claude_code'].includes(value?.binding?.surface)?null:
      {runtime:value.binding.surface,native:typeof value.file==='string'&&path.isAbsolute(value.file)?clientInstructionProfile(value.binding.surface,value.file):undefined}] as const),
  ];
  for(const [record,known,locate] of sources){
    if(!fs.existsSync(record))continue;
    let runtime=known,native:unknown;
    try{
      let value;
      try{value=JSON.parse(read(record)??'null');}catch{throw new Error('Cannot read linked profile receipt');}
      const found=locate(value);if(!found)continue;
      ({runtime,native}=found);
      if(typeof native!=='string'||!path.isAbsolute(native)||(runtime!=='codex'&&runtime!=='claude_code'))throw new Error('Invalid linked native profile');
      if(seen.has(native))continue;seen.add(native);
      const plan=planAgentInstructions(native,runtime,'client',undefined,false,language);
      if(plan.opted_out){profiles.push({runtime,directory:native,state:'opted_out'});continue;}
      if(!plan.changes.length&&plan.receiptText&&JSON.parse(plan.receiptText).state==='installed'){profiles.push({runtime,directory:native,state:'current'});continue;}
      if(!commit){profiles.push({runtime,directory:native,state:'outdated',files:plan.changes.map(c=>c.file)});continue;}
      installAgentInstructions(native,runtime,'client',undefined,false,language);
      profiles.push({runtime,directory:native,state:'updated'});
    }catch(error){profiles.push({runtime,directory:native,state:'refused',reason:error instanceof Error?error.message:'unknown'});}
  }
  return {revision:manifest.revision,profiles};
}
