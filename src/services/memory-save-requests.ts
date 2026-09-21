import {db} from '../db/connection.ts';
import {QoopiaError} from '../utils/errors.ts';
import {canManagePolicy,dropPendingSave,expireSaveRequests,pendingSave,pendingSavesFor} from './memory-policy.ts';
import {createNote,updateNote} from './notes.ts';

function assertOwner(workspace:string,actor:string) {
  if(!canManagePolicy(workspace,actor))throw new QoopiaError('FORBIDDEN','Only the workspace owner reviews what a manual agent asked to save');
}

/** What waits for the owner. The prepared text is shown to the owner alone and is held in the
 * server's memory: it is not memory, not searchable, and gone after a restart. */
export function listSaveRequests(workspace:string,actor:string,agent?:string) {
  assertOwner(workspace,actor);
  return pendingSavesFor(workspace,agent).map(row=>{
    const input=row.input as {id?:string;text?:string;type?:string};
    return {id:row.id,agent_id:row.agent_id,agent:(db.query('SELECT name FROM agents WHERE id=? AND workspace_id=?').get(row.agent_id,workspace) as {name:string}|null)?.name??row.agent_id,
      operation:row.operation,note_id:input.id??null,type:input.type??null,text:input.text??null,
      created_at_ms:row.created_at_ms,expires_at_ms:row.expires_at_ms};
  });
}

/** One use, one decision. A repeated confirmation of the same material returns the note already
 * written; the asking agent can never confirm its own request, whatever its type. */
export function decideSaveRequest(input:{workspace_id:string;actor_id:string;id:string;accept:boolean}) {
  assertOwner(input.workspace_id,input.actor_id);
  expireSaveRequests();
  const row=pendingSave(input.workspace_id,input.id);
  if(!row) {
    // A decision already recorded for this id is reported as it stands; anything else is gone.
    const decided=db.query('SELECT decision,note_id,agent_id FROM memory_save_decisions WHERE id=? AND workspace_id=?')
      .get(input.id,input.workspace_id) as {decision:string;note_id:string|null;agent_id:string}|null;
    if(decided&&decided.decision==='saved'&&input.accept)return {id:input.id,state:'saved',note_id:decided.note_id,agent_id:decided.agent_id};
    if(decided)throw new QoopiaError('CONFLICT',`This save request is already ${decided.decision}`);
    throw new QoopiaError('NOT_FOUND','This save request is no longer held. Ask the agent to prepare it again.');
  }
  if(row.agent_id===input.actor_id)throw new QoopiaError('FORBIDDEN','An agent cannot confirm its own save');
  let noteId:string|null=null;
  if(input.accept) {
    const prepared=row.input as Record<string,unknown>;
    noteId=row.operation==='note_update'?updateNote({...prepared,origin:'owner_confirmed'} as never).id
      :createNote({...prepared,origin:'owner_confirmed'} as never).id;
  }
  // The note is written first: a failure there must not consume the request.
  db.query('INSERT INTO memory_save_decisions(id,workspace_id,agent_id,operation,request_hash,decision,note_id,decided_by,decided_at_ms) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(row.id,row.workspace_id,row.agent_id,row.operation,row.request_hash,input.accept?'saved':'declined',noteId,input.actor_id,Date.now());
  dropPendingSave(row.id);
  return {id:row.id,state:input.accept?'saved':'declined',note_id:noteId,agent_id:row.agent_id};
}
