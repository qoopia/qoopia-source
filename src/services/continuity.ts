import {z} from 'zod';
import {db} from '../db/connection.ts';
import {createNote,updateNote} from './notes.ts';
import {saveMessage,sessionSummarize} from './sessions.ts';
import {memoryText,memoryProfile,memoryModelBusy} from './memory-model.ts';
import {pendingNoteEmbeddings,upsertNoteEmbedding} from './embedding-store.ts';
import {autoEmbedEnabled} from './embeddings.ts';
import {QoopiaError,safeJsonParse} from '../utils/errors.ts';
import {redactSensitive} from '../utils/secret-guard.ts';

const FORMAT='qoopia-session-context/1';
const dashboardSnapshot=z.object({
  source_session:z.string().uuid(),title:z.string().max(120),note_id:z.string().nullable(),revision:z.number().int().nonnegative(),
  context:z.string().max(8000),tail:z.array(z.object({id:z.number(),role:z.enum(['user','assistant','system','tool']),content:z.string().max(16000)})).max(100),tail_truncated:z.boolean(),
});
function dashboardPredecessor(metadata:Record<string,any>){const parsed=dashboardSnapshot.safeParse(metadata.dashboard_context);return parsed.success?parsed.data:null;}
const sessionId=z.string().min(1).max(200);
export const continuityEventSchema=z.object({session_id:sessionId,project:z.string().max(2048),runtime:z.enum(['claude_code','codex']),
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
export function continuityEvent(workspace:string,agent:string,raw:unknown) {
  const event=continuityEventSchema.parse(raw);
  return db.transaction(()=>{
    const existing=db.query('SELECT workspace_id,agent_id FROM sessions WHERE id=?').get(event.session_id) as {workspace_id:string;agent_id:string}|null;
    if(existing&&(existing.workspace_id!==workspace||existing.agent_id!==agent))throw new QoopiaError('NOT_FOUND','Session unavailable');
    db.query('INSERT OR IGNORE INTO sessions(id,workspace_id,agent_id,created_at,last_active) VALUES(?,?,?,?,?)')
      .run(event.session_id,workspace,agent,new Date().toISOString(),new Date().toISOString());
    let previous=event.previous_session_id;
    if(previous)assertSession(workspace,agent,previous);
    // A client supplies a predecessor only after checking that its native process ended.
    // Same project alone cannot distinguish a continuation from a parallel task.
    if(!existing&&previous&&previous!==event.session_id) {
      const prior=safeJsonParse(assertSession(workspace,agent,previous).metadata,{} as Record<string,any>);
      if(prior.continuity_successor&&prior.continuity_successor!==event.session_id)throw new QoopiaError('CONFLICT','Predecessor already continued in another session');
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
    for(const message of event.messages) {
      const content=redactSensitive(message.content).text;
      if(content.trim())saveMessage({workspace_id:workspace,agent_id:agent,session_id:event.session_id,role:message.role,content,
        ingest_uuid:message.id,metadata:{native_timestamp:message.timestamp??null}});
    }
    return {...restoreContext(workspace,agent,event.session_id),accepted:event.messages.map(m=>m.id)};
  })();
}
/** New messages stay in the journal until a checkpoint and its source cursor
 * commit together. Retries after a crash cannot skip or duplicate a revision. */
export async function checkpointSession(workspace:string,agent:string,session:string,summarize=memoryText) {
  const sess=assertSession(workspace,agent,session),meta=safeJsonParse(sess.metadata,{} as Record<string,any>);
  const note=noteFor(workspace,agent,session),old=note?safeJsonParse(note.metadata,{} as Record<string,any>):{};
  const rows=db.query('SELECT id,role,content FROM session_messages WHERE session_id=? AND workspace_id=? AND agent_id=? AND id>? ORDER BY id LIMIT 100')
    .all(session,workspace,agent,old.through_message_id??0) as Array<{id:number;role:string;content:string}>;
  if(!rows.length)return {state:'unchanged'};
  let size=0;const batch:typeof rows=[];
  for(const row of rows){if(batch.length&&size+row.content.length>50_000)break;batch.push(row);size+=batch.at(-1)!.content.length;}
  if(note&&!meta.continuity_priority&&size<4000&&Date.now()-(old.updated_at_ms??0)<300_000)return {state:'waiting'};
  const predecessor=!note?(meta.continuity_previous?restoreContext(workspace,agent,meta.continuity_previous):dashboardPredecessor(meta)):null;
  const result=await summarize(workspace,
    'Update a concise working-state note, in the user language, at most 6000 characters. Preserve the goal, latest constraints, decisions with reasons, completed work and evidence, paths/links, unresolved issues and next step. Clearly record superseded/cancelled decisions. Distinguish requested/planned work from verified results. Do not invent facts. Keep useful prior facts unless new source evidence changes them. Return the full updated note in result.',
    {previous:note?.text??predecessor?.context??'',previous_tail:predecessor?.tail??[],new_events:batch});
  const text=redactSensitive(result.text).text;
  if(text.length>8000)throw new QoopiaError('SIZE_LIMIT','Context note exceeded its bounded size');
  return db.transaction(()=>{
    assertSession(workspace,agent,session);
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
    db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_priority',0,'$.continuity_error',NULL) WHERE id=?").run(session);
    return {state:'saved',note_id:noteId,revision:version,through_message_id:through};
  })();
}
let timer:ReturnType<typeof setInterval>|undefined,running=false,indexing=false;
export async function processMemoryMaintenance() {
  if(running)return;running=true;
  try {
    if(autoEmbedEnabled()&&!indexing) {
      indexing=true;
      // Archival indexing yields between passages and must not delay a current
      // session checkpoint while the subscription model is available.
      void (async()=>{for(const note of pendingNoteEmbeddings(undefined,16)) {
        const r=await upsertNoteEmbedding(note.id,note.workspace_id,note.text);if(r.error)break;
      }})().catch(()=>{}).finally(()=>{indexing=false;});
    }
    if(memoryModelBusy())return;
    const sessions=db.query(`SELECT s.id,s.workspace_id,s.agent_id FROM sessions s JOIN agents a ON a.id=s.agent_id AND a.active=1
      WHERE json_extract(s.metadata,'$.continuity_enabled')=1
      AND COALESCE(json_extract(s.metadata,'$.continuity_retry_at'),0)<?
      AND EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.id>COALESCE((SELECT json_extract(n.metadata,'$.through_message_id')
        FROM notes n WHERE n.workspace_id=s.workspace_id AND n.agent_id=s.agent_id AND n.session_id=s.id AND n.source='qoopia-continuity' AND n.deleted_at IS NULL),0))
      ORDER BY COALESCE(json_extract(s.metadata,'$.continuity_priority'),0) DESC,s.last_active DESC LIMIT 16`)
      .all(Date.now()) as Array<{id:string;workspace_id:string;agent_id:string}>;
    for(const session of sessions) {
      if(!memoryProfile(session.workspace_id))continue;
      try {const result=await checkpointSession(session.workspace_id,session.agent_id,session.id);if(result.state==='saved')break;}
      catch(error){
        const code=error instanceof QoopiaError?error.code:'DEPENDENCY_UNAVAILABLE';
        // Login/quota errors need owner action. A short cooldown prevents a
        // retry storm while the durable journal keeps all pending messages.
        db.query("UPDATE sessions SET metadata=json_set(metadata,'$.continuity_error',?,'$.continuity_retry_at',?) WHERE id=?")
          .run(code,Date.now()+300_000,session.id);break;
      }
    }
  } finally {running=false;}
}
export function startMemoryMaintenance(){if(!timer){timer=setInterval(()=>void processMemoryMaintenance().catch(()=>{}),5000);timer.unref();}}
export function stopMemoryMaintenance(){if(timer)clearInterval(timer);timer=undefined;}
