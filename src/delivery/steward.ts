import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { hash } from './files.ts';
import { localOwner } from './owner-onboarding.ts';

/** Local OS owner operation; caller holds the stopped installation's lock. */
export function stewardCommand(database: Database, input: {ownerId?:string; agentId?:string; commit?:boolean; approve?:string}) {
  return database.transaction(() => {
    const owner=localOwner(database,input.ownerId);
    const agents=database.query(`SELECT id,name,type,tool_profile,policy_epoch FROM agents
      WHERE workspace_id=? AND active=1 AND principal_kind='agent'
      AND type IN ('standard','claude-privileged','steward') ORDER BY id`).all(owner.workspace_id) as
      {id:string;name:string;type:string;tool_profile:string;policy_epoch:number}[];
    const current=agents.find(a=>a.type==='steward');
    if(!input.agentId){
      if(input.commit)throw new Error('Select --agent-id before assigning a steward');
      return {state:'status',workspace_id:owner.workspace_id,steward:current??null,agents};
    }
    const target=agents.find(a=>a.id===input.agentId);
    if(!target)throw new Error('Select an active agent in this owner workspace');
    if(current&&current.id!==target.id)throw new Error('An active steward is already assigned; automatic replacement is refused');
    if(!['full','no-destructive'].includes(target.tool_profile))throw new Error('Steward requires a writable agent profile; existing permissions are preserved');
    const plan={format:'qoopia-steward-plan/1',workspace_id:owner.workspace_id,owner_id:owner.agent_id,
      agent:target,existing_steward:current?.id??null,new_type:'steward',
      scope:'Workspace-wide memory access and steward tools within the existing tool profile; no autonomous background agent or human-owner authority'};
    const digest=hash(JSON.stringify(plan));
    if(!input.commit)return {...plan,plan_digest:digest};
    if(input.approve!==digest)throw new Error('Steward plan changed or was not approved; preview again');
    if(target.type==='steward')return {state:'already_assigned',workspace_id:owner.workspace_id,agent_id:target.id};
    database.query("UPDATE agents SET type='steward',session_version=session_version+1 WHERE id=? AND workspace_id=?").run(target.id,owner.workspace_id);
    database.query(`INSERT INTO activity(id,workspace_id,agent_id,action,entity_type,entity_id,project_id,summary,details,visibility,created_at)
      VALUES(?,?,?,'agent.steward_assigned','agent',?,NULL,'Local owner assigned the workspace steward',?,'workspace',?)`)
      .run(ulid(),owner.workspace_id,owner.agent_id,target.id,JSON.stringify({from:target.type,to:'steward',plan_digest:digest}),new Date().toISOString());
    return {state:'assigned',workspace_id:owner.workspace_id,agent_id:target.id,reconnect_client:true};
  }).immediate();
}
