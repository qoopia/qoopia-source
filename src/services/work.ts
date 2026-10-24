/**
 * Claims: «this work is taken» [5.0.23]. An agent claims a topic of a project for a while; the claim
 * expires by itself and is released by its holder, the steward or the owner. It locks nothing: memory,
 * files and the project stay open, and an agent that opens the project sees the claim in its handoff
 * and decides. Claims are coordination, not memory, so a manual agent may claim too.
 */
import {ulid} from 'ulid';
import {db} from '../db/connection.ts';
import {QoopiaError} from '../utils/errors.ts';
import {assertNoSecrets} from '../utils/secret-guard.ts';

export const CLAIM_DEFAULT_MINUTES=120,CLAIM_MAX_MINUTES=24*60;
const ADMIN=new Set(['steward','owner']);
interface ClaimRow {id:string;agent_id:string;agent:string;project:string;topic:string;session_id:string|null;note:string|null;claimed_at_ms:number;expires_at_ms:number}
const shape=(row:ClaimRow)=>({id:row.id,agent_id:row.agent_id,agent:row.agent,project:row.project,topic:row.topic,session_id:row.session_id,note:row.note,
  claimed_at:new Date(row.claimed_at_ms).toISOString(),expires_at:new Date(row.expires_at_ms).toISOString()});
export type WorkClaim=ReturnType<typeof shape>;

/** One spelling per project: the path or name as given, without surrounding space or a trailing slash. */
export const projectKey=(project:string)=>project.trim().replace(/(.)[\\/]+$/,'$1');

function text(value:string,max:number,field:string) {
  const clean=value.trim();
  if(!clean||clean.length>max)throw new QoopiaError('INVALID_INPUT',`${field} must be 1–${max} characters`);
  assertNoSecrets(clean,`work_claim.${field}`);
  return clean;
}

/** Open claims, newest first; `project` narrows to one project. */
export function openClaims(workspace:string,project?:string,now=Date.now()):WorkClaim[] {
  const rows=db.query(`SELECT c.id,c.agent_id,a.name AS agent,c.project,c.topic,c.session_id,c.note,c.claimed_at_ms,c.expires_at_ms
    FROM work_claims c JOIN agents a ON a.id=c.agent_id WHERE c.workspace_id=? AND c.released_at_ms IS NULL AND c.expires_at_ms>?
    ${project===undefined?'':'AND c.project=?'} ORDER BY c.claimed_at_ms DESC LIMIT 100`)
    .all(workspace,now,...(project===undefined?[]:[projectKey(project)])) as ClaimRow[];
  return rows.map(shape);
}

/** Claim a topic, or renew one's own claim on it. Another agent's open claim on the same topic is
 * reported, not overridden: there is no taking over, only waiting for it to expire or be released. */
export function claimWork(input:{workspace_id:string;agent_id:string;project:string;topic:string;minutes?:number;note?:string;session_id?:string}) {
  const project=text(projectKey(input.project),2048,'project'),topic=text(input.topic,200,'topic');
  const note=input.note===undefined?null:text(input.note,500,'note');
  const minutes=input.minutes??CLAIM_DEFAULT_MINUTES;
  if(!Number.isInteger(minutes)||minutes<5||minutes>CLAIM_MAX_MINUTES)throw new QoopiaError('INVALID_INPUT',`minutes must be 5–${CLAIM_MAX_MINUTES}`);
  return db.transaction(()=>{
    const now=Date.now(),open=openClaims(input.workspace_id,project,now).filter(claim=>claim.topic===topic);
    const other=open.find(claim=>claim.agent_id!==input.agent_id);
    if(other)return {claimed:false as const,held_by:other};
    const mine=open.find(claim=>claim.agent_id===input.agent_id),expires=now+minutes*60_000;
    if(mine) {
      db.query('UPDATE work_claims SET expires_at_ms=?,note=COALESCE(?,note),session_id=COALESCE(?,session_id) WHERE id=?').run(expires,note,input.session_id??null,mine.id);
      return {claimed:true as const,renewed:true,claim:openClaims(input.workspace_id,project,now).find(claim=>claim.id===mine.id)!};
    }
    const id=ulid();
    db.query(`INSERT INTO work_claims(id,workspace_id,agent_id,project,topic,session_id,note,claimed_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id,input.workspace_id,input.agent_id,project,topic,input.session_id??null,note,now,expires);
    return {claimed:true as const,renewed:false,claim:openClaims(input.workspace_id,project,now).find(claim=>claim.id===id)!};
  }).immediate();
}

/** Release a claim: its holder, the steward or the owner. Releasing one already gone is not an error. */
export function releaseWork(input:{workspace_id:string;actor:{agent_id:string;type:string};id:string}) {
  const row=db.query('SELECT agent_id,released_at_ms,expires_at_ms FROM work_claims WHERE id=? AND workspace_id=?').get(input.id,input.workspace_id) as
    {agent_id:string;released_at_ms:number|null;expires_at_ms:number}|null;
  if(!row)throw new QoopiaError('NOT_FOUND','Claim not found');
  if(row.agent_id!==input.actor.agent_id&&!ADMIN.has(input.actor.type))throw new QoopiaError('FORBIDDEN','Only the agent holding a claim, the steward or the owner releases it');
  if(row.released_at_ms!==null||row.expires_at_ms<=Date.now())return {released:false,id:input.id,state:row.released_at_ms!==null?'already_released':'expired'};
  db.query('UPDATE work_claims SET released_at_ms=?,released_by=? WHERE id=? AND released_at_ms IS NULL').run(Date.now(),input.actor.agent_id,input.id);
  return {released:true,id:input.id,state:'released'};
}
