import {z} from 'zod';
import {db} from '../db/connection.ts';
import {createNote,updateNote} from './notes.ts';
import {saveMessage,sessionSummarize} from './sessions.ts';
import {memoryText,memoryProfile,memoryModelBusy} from './memory-model.ts';
import {pendingNoteEmbeddings,upsertNoteEmbedding} from './embedding-store.ts';
import {autoEmbedEnabled} from './embeddings.ts';
import {QoopiaError,safeJsonParse} from '../utils/errors.ts';
import {redactMemory} from '../utils/secret-guard.ts';
import {backgroundFailure} from '../utils/logger.ts';
import {scrubTelegramTransit} from './telegram-store.ts';
import {duringManual,expireSaveRequests,hasManualHistory,LIVE_SESSION_MS,memoryPolicy,memoryPolicyUnchanged} from './memory-policy.ts';

const FORMAT='qoopia-session-context/1';
const dashboardSnapshot=z.object({
  source_session:z.string().uuid(),title:z.string().max(120),note_id:z.string().nullable(),revision:z.number().int().nonnegative(),
  context:z.string().max(8000),tail:z.array(z.object({id:z.number(),role:z.enum(['user','assistant','system','tool']),content:z.string().max(16000)})).max(100),tail_truncated:z.boolean(),
});
function dashboardPredecessor(metadata:Record<string,any>){const parsed=dashboardSnapshot.safeParse(metadata.dashboard_context);return parsed.success?parsed.data:null;}
const sessionId=z.string().min(1).max(200);
const continuityEventSchema=z.object({session_id:sessionId,project:z.string().max(2048),runtime:z.enum(['claude_code','codex']),
  event:z.enum(['start','progress','precompact','end','restore']),context_percent:z.number().min(0).max(100).optional(),
  previous_session_id:sessionId.optional(),messages:z.array(z.object({id:z.string().min(1).max(240),role:z.enum(['user','assistant','tool']),
    content:z.string().max(100_000),timestamp:z.string().max(80).optional()})).max(100).default([])}).strict();
interface ContextNote {id:string;text:string;metadata:string}
function noteFor(workspace:string,agent:string,session:string):ContextNote|null {
  return db.query("SELECT id,text,metadata FROM notes WHERE workspace_id=? AND agent_id=? AND session_id=? AND source='qoopia-continuity' AND deleted_at IS NULL")
    .get(workspace,agent,session) as ContextNote|null;
}
function assertSession(workspace:string,agent:string,session:string) {
  const row=db.query('SELECT s.agent_id,s.metadata FROM sessions s JOIN agents a ON a.id=s.agent_id AND a.active=1 WHERE s.workspace_id=? AND s.id=?').get(workspace,session) as {agent_id:string;metadata:string}|null;
  if(!row||row.agent_id!==agent)throw new QoopiaError('NOT_FOUND','Session unavailable');
  return row;
}
export function restoreContext(workspace:string,agent:string,session:string,depth=0):{session_id:string;note_id:string|null;context:string;revision:number;through_message_id:number;tail:Array<{id:number;role:string;content:string}>;tail_truncated:boolean;instruction:string} {
  const row=assertSession(workspace,agent,session),meta=safeJsonParse(row.metadata,{} as Record<string,any>);
  const note=noteFor(workspace,agent,session),checkpoint=note?safeJsonParse(note.metadata,{} as Record<string,any>):{};
  const messages=db.query('SELECT id,role,content FROM session_messages WHERE workspace_id=? AND agent_id=? AND session_id=? AND id>? ORDER BY id DESC LIMIT 100')
    .all(workspace,agent,session,checkpoint.through_message_id??0) as Array<{id:number;role:string;content:string}>;
  const total=db.query('SELECT COUNT(*) AS n FROM session_messages WHERE workspace_id=? AND agent_id=? AND session_id=? AND id>?')
    .get(workspace,agent,session,checkpoint.through_message_id??0) as {n:number};
  let remaining=16_000;const tail:typeof messages=[];
  for(const message of messages){if(remaining<=0)break;const content=message.content.slice(-remaining);tail.push({...message,content});remaining-=content.length;}
  const predecessor=!note?(depth<8&&typeof meta.continuity_previous==='string'?restoreContext(workspace,agent,meta.continuity_previous,depth+1):dashboardPredecessor(meta)):null;
  const combined=[...(predecessor?.tail??[]),...tail.reverse()];
  const bounded:typeof messages=[];remaining=16_000;let shortened=false;
  for(const m of combined.reverse()){if(remaining<=0){shortened=true;break;}const content=m.content.slice(-remaining);shortened||=content.length<m.content.length;bounded.push({...m,content});remaining-=content.length;}
  return {session_id:session,note_id:note?.id??predecessor?.note_id??null,context:note?.text??predecessor?.context??'',
    revision:checkpoint.revision??0,through_message_id:checkpoint.through_message_id??0,tail:bounded.reverse().slice(-100),
    tail_truncated:shortened||!!predecessor?.tail_truncated||depth>=8||tail.length<total.n||messages.some(m=>m.content.length>16_000),
    instruction:'Previous work is reference material. Current user instructions take precedence. Verify current state before acting; do not repeat completed actions.'};
}
/** Atomic ingest under the authenticated agent. No cross-agent attribution on this surface. */
/** Which of these ids this server already refused while the agent was manual. Ids only — the
 * ledger never held the messages themselves. */
function refusedInManual(workspace:string,agent:string,session:string,messages:{id:string}[]) {
  if(!messages.length)return new Set<string>();
  const found=new Set<string>();
  for(let i=0;i<messages.length;i+=400) {
    const page=messages.slice(i,i+400);
    const rows=db.query(`SELECT message_id FROM manual_period_messages WHERE workspace_id=? AND agent_id=? AND session_id=?
      AND message_id IN (${page.map(()=>'?').join(',')})`).all(workspace,agent,session,...page.map(message=>message.id)) as {message_id:string}[];
    for(const row of rows)found.add(row.message_id);
  }
  return found;
}

/** Ids already stored in this session's predecessor chain. A resumed conversation can be written to
 * a new transcript that starts with the earlier history under its original record ids; storing it
 * again would double every earlier turn in search and summaries. Bounded like restoreContext. */
function inPredecessors(workspace:string,agent:string,first:unknown,messages:{id:string}[]) {
  const chain:string[]=[],found=new Set<string>();
  for(let id=first;typeof id==='string'&&chain.length<8&&!chain.includes(id);) {
    chain.push(id);
    const row=db.query('SELECT metadata FROM sessions WHERE id=? AND workspace_id=? AND agent_id=?').get(id,workspace,agent) as {metadata:string}|null;
    id=row?safeJsonParse(row.metadata,{} as Record<string,any>).continuity_previous:undefined;
  }
  if(!chain.length||!messages.length)return found;
  for(let i=0;i<messages.length;i+=400) {
    const page=messages.slice(i,i+400);
    const rows=db.query(`SELECT ingest_uuid FROM session_messages WHERE workspace_id=? AND agent_id=? AND session_id IN (${chain.map(()=>'?').join(',')})
      AND ingest_uuid IN (${page.map(()=>'?').join(',')})`).all(workspace,agent,...chain,...page.map(m=>m.id)) as {ingest_uuid:string}[];
    for(const row of rows)found.add(row.ingest_uuid);
  }
  return found;
}
export function continuityEvent(workspace:string,agent:string,raw:unknown) {
  const event=continuityEventSchema.parse(raw);
  // Manual keeps reading and restoring available while recording nothing new: the hook
  // still gets its context back, so the conversation continues unaffected. The session is
  // not marked continuity_enabled, which keeps the maintenance worker away from it too.
  if(memoryPolicy(workspace,agent).mode==='manual') {
    const known=db.query('SELECT 1 FROM sessions WHERE id=? AND workspace_id=? AND agent_id=?').get(event.session_id,workspace,agent);
    const context=known?restoreContext(workspace,agent,event.session_id)
      :{session_id:event.session_id,note_id:null,context:'',revision:0,through_message_id:0,tail:[],tail_truncated:false,
        instruction:'Previous work is reference material. Current user instructions take precedence. Verify current state before acting; do not repeat completed actions.'};
    // Remember which ids were refused, never what they said. When auto returns the client
    // replays from its own cursor, and this is what tells the two halves of that batch apart
    // without trusting its clock.
    if(event.messages.length) {
      const now=Date.now();
      const remember=db.prepare('INSERT OR IGNORE INTO manual_period_messages(workspace_id,agent_id,session_id,message_id,seen_at_ms) VALUES(?,?,?,?,?)');
      db.transaction(()=>{for(const message of event.messages)remember.run(workspace,agent,event.session_id,message.id,now);}).immediate();
    }
    return {...context,accepted:[],memory_mode:'manual' as const};
  }
  return db.transaction(()=>{
    const existing=db.query('SELECT workspace_id,agent_id FROM sessions WHERE id=?').get(event.session_id) as {workspace_id:string;agent_id:string}|null;
    if(existing&&(existing.workspace_id!==workspace||existing.agent_id!==agent))throw new QoopiaError('NOT_FOUND','Session unavailable');
    // Replay of a manual period must never be backfilled, and nothing from after it may be lost.
    const guarded=hasManualHistory(workspace,agent);
    const manual=guarded?duringManual(workspace,agent):()=>false;
    // A batch that resumes across a manual period carries both halves. Each message is judged on
    // its own, so the turns from after the switch are kept:
    //   · an id this server already refused while the agent was manual — dropped, and this needs
    //     no clock at all, which is why the whole batch no longer has to be sacrificed;
    //   · a timestamp inside a manual period — dropped, which still covers a client that was away
    //     for the whole period and so never showed those ids here.
    const refused=refusedInManual(workspace,agent,event.session_id,guarded?event.messages:[]);
    const fresh=event.messages.filter(message=>!refused.has(message.id)&&!manual(message.timestamp));
    const acknowledge={session_id:event.session_id,note_id:null,context:'',revision:0,through_message_id:0,tail:[],
      tail_truncated:false,instruction:'',accepted:event.messages.map(m=>m.id)};
    // A bare ping about a session this server never recorded opens nothing.
    if(!existing&&!event.messages.length&&event.event!=='start')return acknowledge;
    // Anything else falls through: the session is created even when its resuming batch is
    // dropped, so capture continues from the next batch. Returning here instead would lose the
    // whole session whenever its start event was not the first delivery to land.
    db.query('INSERT OR IGNORE INTO sessions(id,workspace_id,agent_id,created_at,last_active) VALUES(?,?,?,?,?)')
      .run(event.session_id,workspace,agent,new Date().toISOString(),new Date().toISOString());
    const previous=event.previous_session_id;
    // A client supplies a predecessor only after checking that its native process ended.
    // Same project alone cannot distinguish a continuation from a parallel task.
    // It is still a local guess: one this server never recorded (a manual period, an outage) or one
    // another session already continued stays unlinked. Refusing would fail this start and its restore.
    let predecessor:Record<string,any>|undefined;
    if(!existing&&previous&&previous!==event.session_id)try{predecessor=safeJsonParse(assertSession(workspace,agent,previous).metadata,{} as Record<string,any>);}catch{predecessor=undefined;}
    if(predecessor&&previous&&(!predecessor.continuity_successor||predecessor.continuity_successor===event.session_id)) {
      db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_previous',?) WHERE id=?").run(previous,event.session_id);
      db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_successor',?) WHERE id=?").run(event.session_id,previous);
    }
    const prior=assertSession(workspace,agent,event.session_id),metadata=safeJsonParse(prior.metadata,{} as Record<string,any>);
    const contextGrowth=event.context_percent!==undefined&&event.context_percent>=25&&event.context_percent-(metadata.continuity_percent??0)>=10;
    db.query(`UPDATE sessions SET metadata=json_set(metadata,'$.continuity_enabled',1,'$.continuity_project',?,'$.continuity_runtime',?,
      '$.continuity_closed',?,'$.continuity_priority',?,'$.continuity_percent',?),last_active=? WHERE id=?`)
      .run(event.project,event.runtime,event.event==='end'?1:0,
        ['precompact','end'].includes(event.event)||contextGrowth?1:(metadata.continuity_priority??0),event.context_percent??metadata.continuity_percent??0,
        new Date().toISOString(),event.session_id);
    const copied=inPredecessors(workspace,agent,metadata.continuity_previous,fresh);
    for(const message of fresh) {
      if(copied.has(message.id))continue;
      const content=redactMemory(message.content).text;
      if(content.trim())saveMessage({workspace_id:workspace,agent_id:agent,session_id:event.session_id,role:message.role,content,
        ingest_uuid:message.id,metadata:{native_timestamp:message.timestamp??null}});
    }
    return {...restoreContext(workspace,agent,event.session_id),accepted:event.messages.map(m=>m.id)};
  })();
}
/** Escaped-size budget for the summarizer source; memoryText adds its instruction and refuses over 140k. */
const SOURCE_BUDGET=130_000;
/** Head and tail of a text whose JSON-escaped form fits `budget` chars. Summarizer input only. */
function excerpt(text:string,budget:number) {
  let cut=text,size=JSON.stringify(cut).length,keep=text.length;
  while(size>budget&&keep>0) {
    keep=Math.floor(keep*Math.min(0.9,budget/size));const half=Math.floor(keep/2);
    cut=text.slice(0,half)+`\n[… ${text.length-2*half} chars omitted]\n`+text.slice(text.length-half);size=JSON.stringify(cut).length;
  }
  return cut;
}
/** The summarizer sees a large tool output as its head and tail with the middle named by size: the
 * outcome sits at the end and the command at the start, while a 7 MB log would otherwise cost
 * ~150 model calls. The journal keeps every character [F-341]. */
const TOOL_HEAD=2000,TOOL_TAIL=1000;
const toolView=(head:string,tail:string,total:number)=>{
  if(total<=TOOL_HEAD+TOOL_TAIL)return head;
  const h=head.slice(0,TOOL_HEAD),t=tail.slice(-TOOL_TAIL);
  return h+`\n[… ${total-h.length-t.length} characters omitted …]\n`+t;
};
/** Clients split one output into 12k-char rows whose ingest ids share a prefix ("<record>:<start>"). */
const outputOf=(uuid:string|null)=>uuid?.match(/^(.+):\d+$/)?.[1];
type JournalRow={id:number;role:string;content:string;ingest_uuid:string|null};
/** Rows as summarizer events: each tool output, however many rows it spans, becomes one trimmed
 * event carrying the id of its last row. An output cut by the fetch limit is followed to its end
 * (only sizes and its final tail are read), so its middle is never summarised piecemeal. */
function summaryEvents(workspace:string,agent:string,session:string,rows:JournalRow[],more:boolean) {
  const events:Array<{id:number;role:string;content:string}>=[];
  for(let i=0;i<rows.length;i++) {
    const first=rows[i]!;
    if(first.role!=='tool'){events.push({id:first.id,role:first.role,content:first.content});continue;}
    const key=outputOf(first.ingest_uuid);let last=first,total=first.content.length,tail=first.content;
    while(key&&rows[i+1]?.role==='tool'&&outputOf(rows[i+1]!.ingest_uuid)===key){last=rows[++i]!;total+=last.content.length;tail=last.content;}
    if(key&&more&&last===rows.at(-1)) {
      // .all() with a bound, not .iterate() with break: a cached statement left mid-step keeps the table locked.
      for(const next of db.query(`SELECT id,role,ingest_uuid,length(content) AS size,substr(content,-${TOOL_TAIL}) AS tail FROM session_messages
        WHERE session_id=? AND workspace_id=? AND agent_id=? AND id>? ORDER BY id LIMIT 4096`).all(session,workspace,agent,last.id) as {id:number;role:string;ingest_uuid:string|null;size:number;tail:string}[]) {
        if(next.role!=='tool'||outputOf(next.ingest_uuid)!==key)break;
        last={...last,id:next.id};total+=next.size;tail=next.tail;
      }
    }
    events.push({id:last.id,role:'tool',content:toolView(first.content,tail,total)});
  }
  return events;
}
/** New messages stay in the journal until a checkpoint and its source cursor
 * commit together. Retries after a crash cannot skip or duplicate a revision. */
export async function checkpointSession(workspace:string,agent:string,session:string,summarize=memoryText) {
  // Checked before the model runs, and again at commit against this revision: a switch to
  // manual while the summary is in flight must not land as a new note.
  const policy=memoryPolicy(workspace,agent);
  if(policy.mode==='manual')throw new QoopiaError('APPROVAL_REQUIRED','Automatic memory is off for this agent');
  const sess=assertSession(workspace,agent,session),meta=safeJsonParse(sess.metadata,{} as Record<string,any>);
  const note=noteFor(workspace,agent,session),old=note?safeJsonParse(note.metadata,{} as Record<string,any>):{};
  const rows=db.query('SELECT id,role,content,ingest_uuid FROM session_messages WHERE session_id=? AND workspace_id=? AND agent_id=? AND id>? ORDER BY id LIMIT 100')
    .all(session,workspace,agent,old.through_message_id??0) as JournalRow[];
  if(!rows.length)return {state:'unchanged'};
  const more=rows.length===100,events=summaryEvents(workspace,agent,session,rows,more);
  const predecessor=!note?(meta.continuity_previous?restoreContext(workspace,agent,meta.continuity_previous):dashboardPredecessor(meta)):null;
  // memoryText refuses a prompt over 140k chars after JSON escaping, so the source is budgeted in
  // that escaped form: quotes, newlines or binary output can multiply a message's size.
  const previous=excerpt(note?.text??predecessor?.context??'',SOURCE_BUDGET/4);
  let previousTail=(predecessor?.tail??[]).map(m=>m.role==='tool'?{...m,content:toolView(m.content,m.content,m.content.length)}:m);
  while(previousTail.length&&JSON.stringify({previous,previous_tail:previousTail}).length>SOURCE_BUDGET/2)previousTail=previousTail.slice(1);
  let size=0,room=SOURCE_BUDGET-JSON.stringify({previous,previous_tail:previousTail}).length;const batch:typeof events=[];
  const batchLimit=Number.isInteger(meta.continuity_batch_limit)?Math.max(1,Math.min(100,meta.continuity_batch_limit)):100;
  for(const row of events){
    if(batch.length>=batchLimit||(batch.length&&size+row.content.length>50_000))break;
    const cost=JSON.stringify(row).length+1;
    // A message too large on its own is summarised from an excerpt; the journal keeps it whole and
    // the cursor still moves past it.
    if(cost>room){if(!batch.length){batch.push({...row,content:excerpt(row.content,room-(cost-JSON.stringify(row.content).length))});size=row.content.length;}break;}
    batch.push(row);size+=row.content.length;room-=cost;
  }
  // Only a small remainder waits; a batch cut short by the limit or the budget has a backlog behind it.
  if(note&&!meta.continuity_priority&&!more&&batch.length===events.length&&size<4000&&Date.now()-(old.updated_at_ms??0)<300_000)return {state:'waiting'};
  let result:Awaited<ReturnType<typeof summarize>>;
  try {result=await summarize(workspace,
    'Update a concise working-state note, in the user language, at most 6000 characters. Preserve the goal, latest constraints, decisions with reasons, completed work and evidence, paths/links, unresolved issues and next step. Clearly record superseded/cancelled decisions. Distinguish requested/planned work from verified results. Do not invent facts. Keep useful prior facts unless new source evidence changes them. Return the full updated note in result.',
    {previous,previous_tail:previousTail,new_events:batch},{background:true});
  } catch(error) {
    // Retry a smaller source range after a timeout; never advance its cursor until the summary
    // commits. A single message cannot shrink: each such timeout doubles its pause instead [F-341].
    if(error instanceof QoopiaError&&error.code==='MODEL_TIMEOUT')
      db.query("UPDATE sessions SET metadata=json_set(metadata,?,?) WHERE id=? AND workspace_id=? AND agent_id=?")
        .run(...(batch.length>1?['$.continuity_batch_limit',Math.ceil(batch.length/2)]:['$.continuity_backoff',(meta.continuity_backoff??0)+1]),session,workspace,agent);
    throw error;
  }
  let text=redactMemory(result.text).text;
  // The model is asked for 6000 chars; a longer answer is cut at a line end rather than wasted.
  if(text.length>8000){const end=text.lastIndexOf('\n',8000);text=text.slice(0,end>4000?end:8000).trimEnd();}
  return db.transaction(()=>{
    assertSession(workspace,agent,session);
    if(!memoryPolicyUnchanged(workspace,agent,policy.revision))return {state:'policy_changed'};
    const current=noteFor(workspace,agent,session);
    if(current?.id!==note?.id||current?.text!==note?.text||current?.metadata!==note?.metadata)return {state:'changed_during_summary'};
    const version=(old.revision??0)+1,through=batch.at(-1)!.id;
    const summary=sessionSummarize({workspace_id:workspace,agent_id:agent,session_id:session,content:text,
      msg_start_id:batch[0]!.id,msg_end_id:through,level:1});
    const metadata={format:FORMAT,revision:version,through_message_id:through,source_session:session,
      summary_id:summary.summary_id,model:result.model,updated_at_ms:Date.now()};
    const noteId=note?.id??createNote({workspace_id:workspace,agent_id:agent,type:'context',source:'qoopia-continuity',
      session_id:session,visibility:'private',text,metadata,tags:['session-context']}).id;
    if(note)updateNote({workspace_id:workspace,agent_id:agent,is_admin:false,id:note.id,text,metadata_replace:metadata});
    db.query("UPDATE sessions SET metadata=json_remove(json_set(metadata,'$.continuity_priority',0),'$.continuity_error','$.continuity_retry_at','$.continuity_backoff') WHERE id=?").run(session);
    // A limit halved by earlier timeouts doubles back with each success.
    if(meta.continuity_batch_limit!==undefined)db.query(`UPDATE sessions SET metadata=CASE WHEN ?1>=100 THEN json_remove(metadata,'$.continuity_batch_limit')
      ELSE json_set(metadata,'$.continuity_batch_limit',?1) END WHERE id=?2`).run(batchLimit*2,session);
    return {state:'saved',note_id:noteId,revision:version,through_message_id:through};
  })();
}
let timer:ReturnType<typeof setInterval>|undefined,running=false,indexing=false,embedRetryAt=0,embedFailures=0;
// Per-note errors are logged by upsertNoteEmbedding; this catches the pass itself (e.g. its DB query).
const embeddingFailed=backgroundFailure('Note embedding pass');
export async function processMemoryMaintenance() {
  if(running)return;running=true;
  try {
    expireSaveRequests();scrubTelegramTransit();
    // A client that has not replayed a manual period within a month never will: its cursor moved
    // on long ago. Keeping the ids past that only grows the ledger.
    db.query('DELETE FROM manual_period_messages WHERE seen_at_ms<?').run(Date.now()-30*24*60*60*1000);
    if(autoEmbedEnabled()&&!indexing&&Date.now()>=embedRetryAt) {
      indexing=true;
      // Archival indexing yields between passages and must not delay a current
      // session checkpoint while the subscription model is available.
      void (async()=>{for(const note of pendingNoteEmbeddings(undefined,16)) {
        const r=await upsertNoteEmbedding(note.id,note.workspace_id,note.text);
        // A missing or broken model fails every note: pause 10 s doubling to 10 min instead of a
        // failed inference and a WARN every tick. The first success resumes the normal pace.
        if(r.error){embedFailures++;embedRetryAt=Date.now()+Math.min(600_000,5000*2**embedFailures);break;}
        embedFailures=0;embedRetryAt=0;
      }})().catch(embeddingFailed).finally(()=>{indexing=false;});
    }
    if(memoryModelBusy())return;
    const sessions=db.query(`SELECT s.id,s.workspace_id,s.agent_id FROM sessions s JOIN agents a ON a.id=s.agent_id AND a.active=1
      WHERE a.memory_mode='auto' AND json_extract(s.metadata,'$.continuity_enabled')=1 AND s.last_active>=?
      AND COALESCE(json_extract(s.metadata,'$.continuity_retry_at'),0)<?
      AND EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.id>COALESCE((SELECT json_extract(n.metadata,'$.through_message_id')
        FROM notes n WHERE n.workspace_id=s.workspace_id AND n.agent_id=s.agent_id AND n.session_id=s.id AND n.source='qoopia-continuity' AND n.deleted_at IS NULL),0))
      ORDER BY COALESCE(json_extract(s.metadata,'$.continuity_priority'),0) DESC,s.last_active DESC LIMIT 16`)
      .all(new Date(Date.now()-LIVE_SESSION_MS).toISOString(),Date.now()) as Array<{id:string;workspace_id:string;agent_id:string}>;
    for(const session of sessions) {
      // A workspace without a usable profile steps out of the window for a while instead of
      // aborting the tick or starving the sessions ranked after it, in any workspace.
      let profile=null,invalid=false;
      try{profile=memoryProfile(session.workspace_id);}catch{invalid=true;}
      if(!profile) {
        // Recorded either way: without a code the agent card read «catching up» while nothing could ever be summarised.
        db.query(`UPDATE sessions SET metadata=json_set(metadata,'$.continuity_retry_at',?,'$.continuity_error',?) WHERE id=?`)
          .run(Date.now()+300_000,invalid?'INVALID_PROFILE':'MODEL_NOT_CONNECTED',session.id);
        continue;
      }
      try {const result=await checkpointSession(session.workspace_id,session.agent_id,session.id);if(result.state==='saved')break;}
      catch(error){
        const code=error instanceof QoopiaError?error.code:'DEPENDENCY_UNAVAILABLE';
        // Yielded to an interactive call: nothing failed, the next idle tick retries.
        if(code==='MODEL_BUSY')break;
        // Sign-in, quota and an unusable runtime belong to the workspace's profile, so the cooldown
        // covers all its pending sessions: the next tick must not launch the same failing model
        // for the next session. Other errors stay with this session. The journal keeps everything.
        const profileWide=['UNAUTHENTICATED','MODEL_QUOTA','MODEL_UNAVAILABLE','UNSUPPORTED'].includes(code);
        const backoff=profileWide?0:(db.query("SELECT json_extract(metadata,'$.continuity_backoff') AS n FROM sessions WHERE id=?").get(session.id) as {n:number|null}|null)?.n??0;
        db.query(`UPDATE sessions SET metadata=json_set(metadata,'$.continuity_error',?,'$.continuity_retry_at',?)
          WHERE ${profileWide?"workspace_id=? AND json_extract(metadata,'$.continuity_enabled')=1":'id=?'}`)
          .run(code,Date.now()+Math.min(6*3600_000,300_000*2**backoff),profileWide?session.workspace_id:session.id);break;
      }
    }
  } finally {running=false;}
}
const maintenanceFailed=backgroundFailure('Memory maintenance');
export function memoryMaintenanceTick(){return processMemoryMaintenance().catch(maintenanceFailed);}
export function startMemoryMaintenance(){if(!timer){timer=setInterval(()=>void memoryMaintenanceTick(),5000);timer.unref();}}
export function stopMemoryMaintenance(){if(timer)clearInterval(timer);timer=undefined;}
