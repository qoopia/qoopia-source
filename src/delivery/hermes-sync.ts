/** Delivers Hermes agent conversations into Qoopia memory without the model: a timer reads the agent's
 * `<hermes_home>/state.db` read-only, past a durable cursor on the message id, and sends the active user and
 * assistant turns to /memory/continuity under the agent's own key. Reasoning columns are never read. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {Database,constants} from 'bun:sqlite';
import {z} from 'zod';
import {durableWrite,hash,hasNulOrNewline,privateDirectory,readJson,safePath} from '../utils/fs.ts';
import {BATCH_BYTES,deliveryChunks,failureCode,memoryConnectionSchema,send,textBlocks,type DeliveryMessage,type HermesFailure,type HermesSyncState} from './memory-client.ts';
import {loadService} from './wake-runner.ts';

export const hermesConnectionSchema=memoryConnectionSchema.extend({runtime:z.literal('hermes')});
type HermesConnection=z.infer<typeof hermesConnectionSchema>;
/** The columns this collector depends on (Hermes state schema 31). Anything missing is refused, never guessed. */
const REQUIRED={messages:['id','session_id','role','content','timestamp','active','compacted','_compressed_summary','display_kind','message_uid'],
  sessions:['id','source','user_id','chat_id','parent_session_id','end_reason']};
/** Rows Hermes shows only to itself: injected notices, hidden turns, failed attempts. */
const HIDDEN_KINDS=['hidden','internal_notification','failed_turn'];
const SCAN_ROWS=200,MAX_MESSAGES=40;
export class HermesSourceError extends Error {constructor(readonly code:HermesFailure,message:string){super(message);}}

/** A WAL database opened read-only needs its -shm file, which SQLite removes when Hermes stops. Without it,
 * SQLite would create -shm and -wal beside Hermes's database wherever this user may write the directory (Linux
 * does), files Hermes running as another user could then not open. So with no -shm the file is read as
 * immutable and nothing is created; a running Hermes keeps its -shm, and that case reads read-only as usual.
 * A Hermes started meanwhile writes into a new -wal first; those rows come next run. */
function readOnly(file:string) {
  const probe=(db:Database)=>{try{db.query('SELECT COUNT(*) FROM sqlite_master').get();return db;}catch(error){db.close();throw error;}};
  if(fs.existsSync(file)&&!fs.existsSync(file+'-shm'))
    // SQLITE_OPEN_URI explicitly: Bun's Linux SQLite does not read file: URIs without it (macOS's does).
    return probe(new Database('file:'+encodeURI(file).replaceAll('?','%3F').replaceAll('#','%23')+'?immutable=1',constants.SQLITE_OPEN_READONLY|constants.SQLITE_OPEN_URI));
  return probe(new Database(file,{readonly:true}));
}
export function openHermes(home:string) {
  const file=path.join(safePath(home),'state.db');
  let db:Database;
  try{db=readOnly(file);db.exec('PRAGMA query_only=1');db.exec('PRAGMA busy_timeout=5000');}
  catch(error){throw new HermesSourceError('HERMES_SOURCE_UNREADABLE',`Cannot open ${file} read-only: ${(error as Error).message}`);}
  try {
    const missing=Object.entries(REQUIRED).flatMap(([table,columns])=>{
      const present=new Set((db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as {name:string}[]).map(c=>c.name));
      return columns.filter(c=>!present.has(c)).map(c=>table+'.'+c);
    });
    if(missing.length)throw new HermesSourceError('HERMES_SCHEMA_UNKNOWN',`Unknown Hermes state.db layout, missing ${missing.join(', ')}; nothing was read`);
  } catch(error){db.close();throw error instanceof HermesSourceError?error:new HermesSourceError('HERMES_SOURCE_UNREADABLE',(error as Error).message);}
  return db;
}

type Row={id:number;session_id:string;role:string;timestamp:number;message_uid:string|null;content:unknown;source:string|null;chat_id:string|null;user_id:string|null;parent_session_id:string|null;parent_end:string|null};
/** Content is selected only for deliverable rows: tool output and hidden rows never leave the database. */
function scan(db:Database,after:number):Row[] {
  return db.query(`SELECT m.id,m.session_id,m.role,m.timestamp,m.message_uid,
      CASE WHEN m.role IN ('user','assistant') AND (m.active=1 OR m.compacted=1) AND COALESCE(m._compressed_summary,0)=0
        AND COALESCE(m.display_kind,'') NOT IN (${HIDDEN_KINDS.map(k=>`'${k}'`).join(',')}) THEN m.content END AS content,
      s.source,s.chat_id,s.user_id,s.parent_session_id,(SELECT p.end_reason FROM sessions p WHERE p.id=s.parent_session_id) AS parent_end
    FROM messages m LEFT JOIN sessions s ON s.id=m.session_id WHERE m.id>? ORDER BY m.id LIMIT ?`).all(after,SCAN_ROWS) as Row[];
}
/** Hermes stores multimodal parts as "\0json:" + JSON; only their text is kept. */
function text(content:unknown):string {
  if(typeof content!=='string')return '';
  if(!content.startsWith('\0json:'))return content;
  try{const value=JSON.parse(content.slice(6));return typeof value==='string'?value:textBlocks(value).join('\n');}catch{return '';}
}
/** Same shape and 100-character bound as the Leo sync worker this replaces, so its sessions continue. */
export function hermesSessionId(prefix:string,row:Pick<Row,'session_id'|'source'|'chat_id'|'user_id'>) {
  const raw=`${prefix}:${row.source||'unknown'}:${row.chat_id||row.user_id||'unknown'}:${row.session_id}`;
  return raw.length<=100?raw:raw.slice(0,83)+':'+hash(raw).slice(0,16);
}
/** Compaction continues a conversation in a child session and copies its tail there under the same message
 * ids; linking the child to its parent lets the server skip those copies. A sub-agent's parent is not its past. */
const predecessor=(prefix:string,row:Row)=>row.parent_session_id&&row.parent_end==='compression'?
  hermesSessionId(prefix,{...row,session_id:row.parent_session_id}):undefined;
function messagesOf(row:Row):DeliveryMessage[] {
  // A sub-agent's "user" is the delegating agent, never the person: kept, marked, as the assistant's work.
  const sub=row.source==='subagent',body=text(row.content);
  if(!body.trim())return [];
  return deliveryChunks(sub?'assistant':row.role as 'user'|'assistant',(sub?'[Sub-agent] ':'')+body,'hermes:'+(row.message_uid??'row-'+row.id),
    new Date(row.timestamp*1000).toISOString());
}

/** The next batch after the cursor: one Qoopia session, at most 40 messages and the byte budget. A row
 * younger than `settled` stops the batch, so Hermes can still rewrite or classify it. */
export function nextBatch(db:Database,state:Pick<HermesSyncState,'cursor'|'part'|'session_prefix'>,settled:number) {
  let cursor=state.cursor,part=state.part,size=0,session:string|undefined,previous:string|undefined,young=false;
  const messages:DeliveryMessage[]=[];
  const rows=scan(db,state.cursor);
  outer: for(const row of rows) {
    if(row.timestamp*1000>settled){young=true;break;}
    const chunks=messagesOf(row);
    if(chunks.length) {
      const sid=hermesSessionId(state.session_prefix,row);
      if(session&&sid!==session)break;
      session??=sid;previous??=predecessor(state.session_prefix,row);
      for(let i=row.id===rows[0]!.id?part:0;i<chunks.length;i++) {
        const weight=Buffer.byteLength(JSON.stringify(chunks[i]));
        if(messages.length&&(messages.length>=MAX_MESSAGES||size+weight>BATCH_BYTES)){part=i;break outer;}
        messages.push(chunks[i]!);size+=weight;
      }
    }
    cursor=row.id;part=0;
  }
  return {messages,session,previous,cursor,part,more:!young&&(rows.length===SCAN_ROWS||cursor<(rows.at(-1)?.id??cursor))};
}

export const stateDirectory=(root:string,home:string)=>path.join(root,'hermes-sync',hash(safePath(home)).slice(0,16));
const RUN_BUDGET_MS=240_000;
export interface HermesSyncOptions {root:string;home:string;connection:unknown;afterId?:number;sessionPrefix?:string;settleMs?:number;budgetMs?:number;timeout?:number}
/** One pass: catches up within the budget, then stops. Safe to rerun at any time: the cursor only moves past
 * what the server acknowledged, and the server keeps one copy per message id. */
export async function hermesSyncOnce(options:HermesSyncOptions) {
  const connection:HermesConnection=hermesConnectionSchema.parse(options.connection);
  const home=safePath(options.home),dir=stateDirectory(options.root,home),file=path.join(dir,'state.json');
  privateDirectory(dir);
  const release=lock(path.join(dir,'run.lock'));
  if(!release)return {state:'BUSY' as const,next_action:'Another hermes-sync run for this home is in progress.'};
  const saved:HermesSyncState|undefined=fs.existsSync(file)?readJson(file):undefined;
  if(saved&&options.sessionPrefix&&options.sessionPrefix!==saved.session_prefix)
    {release();throw new Error(`This home already delivers under the session prefix "${saved.session_prefix}"; changing it would split its conversations`);}
  if(saved&&saved.agent_id!==connection.agent_id){release();throw new Error('This home already delivers to another agent; remove its hermes-sync state to change the agent');}
  const state:HermesSyncState={format:'qoopia-hermes-sync/1',home,agent_id:connection.agent_id,session_prefix:options.sessionPrefix??'hermes',
    cursor:-1,part:0,source_max_id:0,delivered:0,...saved,last_attempt_at:new Date().toISOString()};
  const persist=()=>durableWrite(file,JSON.stringify(state));
  let db:Database|undefined,sent=0;
  try {
    db=openHermes(home);
    state.source_max_id=(db.query('SELECT COALESCE(MAX(id),0) AS id FROM messages').get() as {id:number}).id;
    // A new home starts at the present: its history is sent only on request (--after-id), since every
    // delivered session also queues a summary for the memory model.
    if(options.afterId!==undefined){state.cursor=options.afterId;state.part=0;}
    else if(state.cursor<0)state.cursor=state.source_max_id;
    const deadline=Date.now()+(options.budgetMs??RUN_BUDGET_MS);
    for(;;) {
      const batch=nextBatch(db,state,Date.now()-(options.settleMs??30_000));
      if(batch.messages.length) {
        const envelope={session_id:batch.session!,project:home,runtime:'hermes',event:'progress',...(batch.previous?{previous_session_id:batch.previous}:{})};
        // «Only on request»: once the server said manual, ask before sending any text. What passes by
        // while it stays manual never leaves this computer, as with the Claude Code/Codex hooks.
        const probe=state.manual?await send(connection,{...envelope,messages:[]},options.timeout??30_000):undefined;
        const result=probe?.memory_mode==='manual'?probe:await send(connection,{...envelope,messages:batch.messages},options.timeout??30_000);
        state.manual=result.memory_mode==='manual';
        if(!state.manual&&(!Array.isArray(result.accepted)||batch.messages.some(m=>!result.accepted.includes(m.id))))throw new Error('Delivery was not acknowledged');
        if(!state.manual){sent+=batch.messages.length;state.delivered+=batch.messages.length;state.last_delivery_at=new Date().toISOString();}
      }
      state.cursor=batch.cursor;state.part=batch.part;persist();
      if(!batch.more||Date.now()>deadline)break;
    }
    delete state.error;state.last_success_at=new Date().toISOString();persist();
    return {state:'SYNCED' as const,agent_id:state.agent_id,sent,cursor:state.cursor,behind_rows:Math.max(0,state.source_max_id-state.cursor),manual:!!state.manual};
  } catch(error) {
    const message=(error as Error).message??String(error);
    const code:HermesFailure=error instanceof HermesSourceError?error.code:(()=>{const c=failureCode(message);return c==='KEY_REJECTED'||c==='REFUSED'||c==='WRONG_ADDRESS'?c:'SERVER_UNAVAILABLE';})();
    state.error={code,at:new Date().toISOString()};persist();
    throw new HermesSourceError(code,message);
  } finally {db?.close();release();}
}

/** A run lock for one home: a manual run beside the timer must not send the same batch twice at once. */
function lock(file:string):(()=>void)|undefined {
  try {
    if(fs.existsSync(file)) {
      // A run ends within its budget plus one request: an older lock is a killed run's, whatever holds its PID now.
      const pid=Number(fs.readFileSync(file,'utf8'));
      try{if(Number.isInteger(pid)&&pid>0&&Date.now()-fs.statSync(file).mtimeMs<600_000){process.kill(pid,0);return;}}catch{/* The run that held it is gone. */}
      fs.unlinkSync(file);
    }
    fs.writeFileSync(file,String(process.pid),{flag:'wx',mode:0o600});
    return ()=>{try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{/* Reclaimed by the next run. */}};
  } catch{return;}
}

// ---- timers: launchd on macOS, a systemd user timer on Linux; written only with --commit ----
const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function hermesSyncService(binary:string,o:{name:string;home:string;config:string;root:string},platform=process.platform,userHome=os.homedir()) {
  if(!/^[a-z0-9][a-z0-9-]{0,39}$/.test(o.name))throw new Error('--name must be 1-40 lowercase letters, digits or dashes');
  for(const value of [binary,o.home,o.config,o.root])if(!path.isAbsolute(value)||hasNulOrNewline(value))throw new Error('Paths must be absolute, without control characters');
  const args=[binary,'hermes-sync','run','--once','--home',o.home,'--config',o.config,'--root',o.root];
  const label=`ai.qoopia.hermes-sync.${o.name}`,log=path.join(stateDirectory(o.root,o.home),'hermes-sync.log');
  if(platform==='darwin')return {label,file:path.join(userHome,'Library/LaunchAgents',label+'.plist'),files:[] as {file:string;bytes:string}[],
    bytes:`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>120</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`,
    load:[['/bin/launchctl','bootout',`gui/${process.getuid?.()}/${label}`],['/bin/launchctl','bootstrap',`gui/${process.getuid?.()}`]]};
  const q=(v:string)=>'"'+v.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$','$$$$')+'"';
  const unit=`qoopia-hermes-sync-${o.name}`,dir=path.join(process.env.XDG_CONFIG_HOME||path.join(userHome,'.config'),'systemd/user');
  return {label:unit,file:path.join(dir,unit+'.timer'),
    bytes:`[Unit]\nDescription=Qoopia Hermes sync (${o.name}) every 2 minutes\n[Timer]\nOnActiveSec=10s\nOnUnitInactiveSec=2min\n[Install]\nWantedBy=timers.target\n`,
    files:[{file:path.join(dir,unit+'.service'),bytes:`[Unit]\nDescription=Qoopia Hermes sync (${o.name})\n[Service]\nType=oneshot\nExecStart=${args.map(q).join(' ')}\nTimeoutStartSec=600\n`}],
    load:[['/usr/bin/systemctl','--user','daemon-reload'],['/usr/bin/systemctl','--user','enable','--now',unit+'.timer']]};
}
export function installHermesSync(binary:string,o:{name:string;home:string;config:string;root:string},commit:boolean) {
  hermesConnectionSchema.parse(readJson(o.config));openHermes(o.home).close();
  const service=hermesSyncService(binary,o);
  if(!commit)return {state:'PREVIEW',label:service.label,files:[service.file,...service.files.map(f=>f.file)],requires:'--commit'};
  privateDirectory(stateDirectory(o.root,o.home));
  for(const f of [...service.files,{file:service.file,bytes:service.bytes}]){fs.mkdirSync(path.dirname(f.file),{recursive:true});durableWrite(f.file,f.bytes,0o644);}
  loadService(service.load,service.file);
  return {state:'INSTALLED',label:service.label,files:[service.file,...service.files.map(f=>f.file)]};
}
export function uninstallHermesSync(name:string,commit:boolean) {
  const service=hermesSyncService(process.execPath,{name,home:'/unused',config:'/unused',root:'/unused'});
  const files=[service.file,...service.files.map(f=>f.file)];
  if(!commit)return {state:'PREVIEW',label:service.label,files,requires:'--commit'};
  if(process.platform==='darwin')spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid?.()}/${service.label}`]);
  else spawnSync('/usr/bin/systemctl',['--user','disable','--now',service.label+'.timer']);
  for(const f of files)fs.rmSync(f,{force:true});
  return {state:'REMOVED',label:service.label,files};
}

const USAGE='hermes-sync run --home HERMES_HOME --config CONNECTION_JSON [--root ROOT] [--once] [--after-id N] [--session-prefix NAME] | '+
  'install|uninstall --name NAME [--home HERMES_HOME --config CONNECTION_JSON] [--root ROOT] [--commit] | status [--root ROOT]';
export async function hermesSyncCli(argv:string[],arg:(n:string)=>string|undefined,flag:(n:string)=>boolean,root:string) {
  const action=argv[1],emit=(v:unknown)=>console.log(JSON.stringify(v));
  const need=(n:string)=>{const v=arg(n);if(!v)throw new Error('--'+n+' required. Usage: '+USAGE);return v;};
  if(action==='status'){const {memoryClientsCheck}=await import('./memory-client.ts');const check=memoryClientsCheck(root);
    const hermes=check.runtimes.filter(r=>r.runtime==='hermes');emit({homes:hermes});if(hermes.some(r=>r.status==='fail'))process.exitCode=1;return;}
  if(action==='install')return emit(installHermesSync(process.execPath,{name:need('name'),home:safePath(need('home')),config:safePath(need('config')),root},flag('commit')));
  if(action==='uninstall')return emit(uninstallHermesSync(need('name'),flag('commit')));
  if(action!=='run')throw new Error('Usage: '+USAGE);
  const after=arg('after-id');
  if(after!==undefined&&!/^\d+$/.test(after))throw new Error('--after-id must be a message id (0 sends the whole history)');
  const options:HermesSyncOptions={root,home:need('home'),connection:readJson(safePath(need('config'))),sessionPrefix:arg('session-prefix'),afterId:after===undefined?undefined:Number(after)};
  for(let first=true;;first=false) {
    try{emit(await hermesSyncOnce(first?options:{...options,afterId:undefined}));}
    catch(error){
      // Code and a short reason only: the message never carries conversation text.
      emit({state:'FAILED',code:error instanceof HermesSourceError?error.code:'SERVER_UNAVAILABLE',reason:String((error as Error).message).slice(0,300)});
      if(flag('once')){process.exitCode=1;return;}
    }
    if(flag('once'))return;
    await Bun.sleep(120_000);
  }
}
