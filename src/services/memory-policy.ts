import {ulid} from 'ulid';
import type {Database} from 'bun:sqlite';
import {db} from '../db/connection.ts';
import {QoopiaError} from '../utils/errors.ts';

export type MemoryMode='auto'|'manual';
export interface MemoryPolicy {agent_id:string;name:string;mode:MemoryMode;revision:number;updated_at_ms:number|null;actor_id:string|null}

/** Where a write came from. The server decides this at the call site: an agent
 * naming its own source proves nothing, so this is never read from a request body. */
export type MemoryOrigin='automatic'|'owner_confirmed';

interface PolicyRow {id:string;name:string;memory_mode:string;memory_mode_revision:number;memory_mode_updated_at_ms:number|null;memory_mode_actor_id:string|null}
const SELECT='SELECT id,name,memory_mode,memory_mode_revision,memory_mode_updated_at_ms,memory_mode_actor_id FROM agents';
const shape=(row:PolicyRow):MemoryPolicy=>({agent_id:row.id,name:row.name,mode:row.memory_mode as MemoryMode,
  revision:row.memory_mode_revision,updated_at_ms:row.memory_mode_updated_at_ms,actor_id:row.memory_mode_actor_id});

/** One policy per identity, shared by every connection and device of that agent. */
export function memoryPolicy(workspace:string,agent:string,database:Database=db):MemoryPolicy {
  const row=database.query(`${SELECT} WHERE id=? AND workspace_id=?`).get(agent,workspace) as PolicyRow|null;
  if(!row)throw new QoopiaError('NOT_FOUND','Agent unavailable');
  return shape(row);
}

export function listMemoryPolicies(workspace:string):MemoryPolicy[] {
  return (db.query(`${SELECT} WHERE workspace_id=? AND active=1 ORDER BY name`).all(workspace) as PolicyRow[]).map(shape);
}

/** Gate for automatic capture. Reading and searching existing memory stays allowed in
 * manual, so callers guard the write path only — turning the setting off must not break
 * the conversation itself. */
export function assertAutomaticMemoryAllowed(workspace:string,agent:string,origin:MemoryOrigin='automatic',database:Database=db) {
  if(origin==='owner_confirmed')return;
  if(memoryPolicy(workspace,agent,database).mode==='manual')
    throw new QoopiaError('APPROVAL_REQUIRED','Automatic memory is off for this agent. Ask the owner to turn it back on, or save the material explicitly.');
}

export type HeldOperation='note_create'|'note_update';
export const SAVE_REQUEST_TTL_MS=24*60*60*1000;
const MAX_PENDING_PER_AGENT=20,MAX_PENDING_TOTAL=200;
export interface PendingSave {id:string;workspace_id:string;agent_id:string;operation:HeldOperation;request_hash:string;input:object;created_at_ms:number;expires_at_ms:number}

/** Prepared saves live here and nowhere else. The server cannot prove that the user asked for
 * one, so the material is unverified and must not reach the database: a restart discards it and
 * the agent asks again. Only the owner's decision writes anything — the note itself, or a
 * decision row that records who decided, never the text. */
const pendingSaves=new Map<string,PendingSave>();

export function expireSaveRequests(now=Date.now()) {
  for(const [id,row] of pendingSaves)if(row.expires_at_ms<=now)pendingSaves.delete(id);
}
export function pendingSavesFor(workspace:string,agent?:string):PendingSave[] {
  expireSaveRequests();
  return [...pendingSaves.values()].filter(row=>row.workspace_id===workspace&&(!agent||row.agent_id===agent))
    .sort((a,b)=>a.created_at_ms-b.created_at_ms||(a.id<b.id?-1:1));
}
export function pendingSave(workspace:string,id:string):PendingSave|undefined {
  expireSaveRequests();const row=pendingSaves.get(id);
  return row&&row.workspace_id===workspace?row:undefined;
}
export function dropPendingSave(id:string){pendingSaves.delete(id);}

/** The same material is one request however it arrived: transport fields and empty values do not count. */
function saveMaterialHash(operation:HeldOperation,input:object) {
  const material=Object.entries(input).filter(([key,value])=>value!=null&&!['connection_id','idempotency_key','is_admin','source','origin'].includes(key)).sort(([a],[b])=>a<b?-1:1);
  return new Bun.CryptoHasher('sha256').update(operation+'\n'+JSON.stringify(material)).digest('hex');
}

/** A note write by a manual agent. A flag from the model cannot prove the user asked, so the
 * prepared note waits for the owner instead. Returns the note id when this exact save was
 * already confirmed; otherwise holds the request and refuses the write. */
export function holdSaveForOwner(workspace:string,agent:string,operation:HeldOperation,input:object,origin:MemoryOrigin='automatic'):string|null {
  if(origin==='owner_confirmed'||memoryPolicy(workspace,agent).mode==='auto')return null;
  const hash=saveMaterialHash(operation,input),now=Date.now();
  expireSaveRequests(now);
  // Asking again for a note the owner already confirmed returns that note instead of a second request.
  const saved=db.query(`SELECT d.note_id FROM memory_save_decisions d JOIN notes n ON n.id=d.note_id AND n.deleted_at IS NULL
    WHERE d.workspace_id=? AND d.agent_id=? AND d.request_hash=? AND d.decision='saved' ORDER BY d.decided_at_ms DESC LIMIT 1`)
    .get(workspace,agent,hash) as {note_id:string}|null;
  if(saved)return saved.note_id;
  let held=[...pendingSaves.values()].find(row=>row.workspace_id===workspace&&row.agent_id===agent&&row.request_hash===hash);
  if(!held) {
    if(pendingSavesFor(workspace,agent).length>=MAX_PENDING_PER_AGENT||pendingSaves.size>=MAX_PENDING_TOTAL)
      throw new QoopiaError('RATE_LIMITED','Too many saves from this agent already wait for the owner. Ask the owner to review them in Qoopia.');
    held={id:ulid(),workspace_id:workspace,agent_id:agent,operation,request_hash:hash,input,created_at_ms:now,expires_at_ms:now+SAVE_REQUEST_TTL_MS};
    pendingSaves.set(held.id,held);
  }
  throw new QoopiaError('APPROVAL_REQUIRED',`This agent saves only on request. Nothing was saved: the note is prepared as request ${held.id} and waits for the owner's confirmation in Qoopia (agent card, or memory_save_decide) until ${new Date(held.expires_at_ms).toISOString()}. It is held in the server's memory only and a restart discards it.`);
}

/** The closed and open manual periods of this agent, from the policy log. */
export function manualSpans(workspace:string,agent:string):[number,number][] {
  const rows=db.query('SELECT mode,created_at_ms FROM agent_memory_policy_log WHERE workspace_id=? AND agent_id=? ORDER BY id')
    .all(workspace,agent) as {mode:MemoryMode;created_at_ms:number}[];
  const spans:[number,number][]=[];let start:number|null=null;
  for(const row of rows){if(row.mode==='manual')start??=row.created_at_ms;else if(start!==null){spans.push([start,row.created_at_ms]);start=null;}}
  if(start!==null)spans.push([start,Number.POSITIVE_INFINITY]);
  return spans;
}

/** Plausibility window for a client-supplied message time. Wider than any real clock drift,
 * narrower than the shortest interesting manual period. */
const TRUSTED_CLOCK_MS=48*60*60*1000;

/** Was this moment inside a manual period? A client that kept its own transcript cursor
 * re-sends that material after the owner returns to auto, and it must not be backfilled.
 *
 * The timestamp comes from the client, so it is used only while it is plausible; one the server
 * cannot parse, or one further than two days from server time, falls back to the server's own
 * receipt time. Live capture therefore never suffers from a client clock, and a replayed batch
 * is still caught because every supported adapter stamps its transcript records.
 *
 * This is the secondary guard. The structural one in continuityEvent — a session this server
 * never recorded is not resumed into existence — needs no clock at all and covers the whole
 * replay case, because a manual period never creates sessions here. */
export function duringManual(workspace:string,agent:string) {
  const spans=manualSpans(workspace,agent);
  if(!spans.length)return ()=>false;
  return (timestamp?:string|null)=>{
    const now=Date.now(),parsed=timestamp?Date.parse(timestamp):Number.NaN;
    const at=Number.isFinite(parsed)&&Math.abs(parsed-now)<=TRUSTED_CLOCK_MS?parsed:now;
    return spans.some(([from,to])=>at>=from&&at<to);
  };
}

/** True once the owner has ever used «only on request» for this agent. Until then no replay
 * guard applies and capture behaves exactly as it did before schema 45. */
export function hasManualHistory(workspace:string,agent:string) {
  return manualSpans(workspace,agent).length>0;
}

/** For callers whose own work must go on either way — a chat keeps answering in manual,
 * it just stops copying the conversation into memory. */
export function automaticMemoryOn(workspace:string,agent:string) {
  return memoryPolicy(workspace,agent).mode==='auto';
}

/** True only while the policy is still the one the caller started under. A summary that
 * began under auto must not commit after the owner switched the agent to manual. */
export function memoryPolicyUnchanged(workspace:string,agent:string,revision:number,mode:MemoryMode='auto') {
  const current=memoryPolicy(workspace,agent);
  return current.revision===revision&&current.mode===mode;
}

/** The owner of the workspace, or an agent explicitly registered as an owner principal.
 * A steward administers the workspace but does not decide what the owner's memory keeps. */
export function canManagePolicy(workspace:string,actor:string) {
  const row=db.query(`SELECT 1 FROM agents a WHERE a.id=? AND a.workspace_id=? AND a.active=1
    AND (a.type='owner' OR a.authority_profile='owner'
      OR EXISTS(SELECT 1 FROM workspace_owners o WHERE o.workspace_id=a.workspace_id AND o.actor_id=a.id))`)
    .get(actor,workspace);
  return !!row;
}

export interface SetMemoryPolicyInput {workspace_id:string;agent_id:string;mode:MemoryMode;actor_id:string;expected_revision?:number}

/** Atomic and idempotent. Repeating a command that already holds returns the current
 * state instead of asking for confirmation again or inflating the revision. */
export function setMemoryPolicy(input:SetMemoryPolicyInput):MemoryPolicy {
  if(input.mode!=='auto'&&input.mode!=='manual')throw new QoopiaError('INVALID_INPUT','mode must be auto or manual');
  return db.transaction(()=>{
    if(!canManagePolicy(input.workspace_id,input.actor_id))
      throw new QoopiaError('FORBIDDEN','Only the workspace owner can change an agent memory policy');
    const current=memoryPolicy(input.workspace_id,input.agent_id);
    if(input.expected_revision!==undefined&&input.expected_revision!==current.revision)
      throw new QoopiaError('STALE_REVISION',`Policy revision is ${current.revision}`);
    if(current.mode===input.mode)return current;
    const revision=current.revision+1,now=Date.now();
    db.query('UPDATE agents SET memory_mode=?,memory_mode_revision=?,memory_mode_updated_at_ms=?,memory_mode_actor_id=? WHERE id=? AND workspace_id=?')
      .run(input.mode,revision,now,input.actor_id,input.agent_id,input.workspace_id);
    db.query('INSERT INTO agent_memory_policy_log(workspace_id,agent_id,mode,revision,actor_id,created_at_ms) VALUES(?,?,?,?,?,?)')
      .run(input.workspace_id,input.agent_id,input.mode,revision,input.actor_id,now);
    return memoryPolicy(input.workspace_id,input.agent_id);
  }).immediate();
}

/** Resolves a display name to exactly one agent. An ambiguous name is reported rather
 * than guessed — picking the wrong target would silently change someone else's setting. */
export function resolveAgentByName(workspace:string,name:string):MemoryPolicy {
  const matches=db.query(`${SELECT} WHERE workspace_id=? AND active=1 AND lower(name)=lower(?)`).all(workspace,name.trim()) as PolicyRow[];
  if(matches.length===1)return shape(matches[0]!);
  if(!matches.length)throw new QoopiaError('NOT_FOUND',`No active agent named ${name}`);
  throw new QoopiaError('CONFLICT',`Several agents are named ${name}. Use the agent id: ${matches.map(m=>m.id).join(', ')}`);
}

export type MemoryChannelState='working'|'manual'|'waiting'|'behind'|'sign_in'|'error';
export interface AgentMemoryStatus {mode:MemoryMode;revision:number;state:MemoryChannelState;last_capture_at:string|null;last_summary_at_ms:number|null;pending_sessions:number;pending_saves:number;error_code:string|null}

/** The wanted mode and what the channel actually does, side by side: auto with a broken
 * channel must not look healthy. Counts and timestamps only — never conversation content. */
export function agentMemoryStatus(workspace:string,agent:string,database:Database=db):AgentMemoryStatus {
  const policy=memoryPolicy(workspace,agent,database);
  const capture=database.query('SELECT MAX(created_at) AS at FROM session_messages WHERE workspace_id=? AND agent_id=?').get(workspace,agent) as {at:string|null};
  const summary=database.query("SELECT MAX(json_extract(metadata,'$.updated_at_ms')) AS at FROM notes WHERE workspace_id=? AND agent_id=? AND source='qoopia-continuity' AND deleted_at IS NULL").get(workspace,agent) as {at:number|null};
  const backlog=database.query(`SELECT COUNT(*) AS pending,
      (SELECT json_extract(e.metadata,'$.continuity_error') FROM sessions e WHERE e.workspace_id=?1 AND e.agent_id=?2
        AND json_extract(e.metadata,'$.continuity_error') IS NOT NULL ORDER BY e.last_active DESC LIMIT 1) AS error
    FROM sessions s WHERE s.workspace_id=?1 AND s.agent_id=?2 AND json_extract(s.metadata,'$.continuity_enabled')=1
      AND EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.id>COALESCE((SELECT json_extract(n.metadata,'$.through_message_id')
        FROM notes n WHERE n.workspace_id=s.workspace_id AND n.agent_id=s.agent_id AND n.session_id=s.id AND n.source='qoopia-continuity' AND n.deleted_at IS NULL),0))`)
    .get(workspace,agent) as {pending:number;error:string|null};
  const signIn=['MODEL_NOT_CONNECTED','SIGN_IN_REQUIRED','MODEL_QUOTA','UNAUTHENTICATED'];
  const state:MemoryChannelState=policy.mode==='manual'?'manual':backlog.error?(signIn.includes(backlog.error)?'sign_in':'error')
    :!capture.at?'waiting':backlog.pending>1?'behind':'working';
  const saves={n:pendingSavesFor(workspace,agent).length};
  return {mode:policy.mode,revision:policy.revision,state,last_capture_at:capture.at,last_summary_at_ms:summary.at,
    pending_sessions:backlog.pending,pending_saves:saves.n,error_code:policy.mode==='auto'?backlog.error:null};
}
