import {db} from '../db/connection.ts';
import {createAgent} from '../admin/agents.ts';
import {localOwner} from '../delivery/owner-onboarding.ts';
import {env} from '../utils/env.ts';
import {memoryModelStatus} from './memory-model.ts';

/** Registration identifies the client; only the later owner consent grants access. */
export function browserAgent(name:'GPT'|'Claude') {
  const owners=db.query(`SELECT a.workspace_id,w.slug FROM workspace_owners o
    JOIN agents a ON a.id=o.actor_id AND a.workspace_id=o.workspace_id
    JOIN workspaces w ON w.id=a.workspace_id
    WHERE a.active=1 AND a.principal_kind='human' AND a.authority_profile='owner'`).all() as {workspace_id:string;slug:string}[];
  if(!owners.length)return undefined; // Pre-V1 installations keep their registered connector identities.
  if(owners.length!==1)return null; // Never infer which owner's memory a public request belongs to.
  const owner=owners[0]!;
  return db.transaction(()=>{
    const read=()=>db.query(`SELECT id,name,workspace_id,type,tool_profile FROM agents
      WHERE workspace_id=? AND name=? AND active=1 AND principal_kind='agent'`).get(owner.workspace_id,name) as
      {id:string;name:string;workspace_id:string;type:string;tool_profile:string}|null;
    const existing=read();if(existing)return existing;
    // An explicitly revoked identity must not be silently recreated by a public request.
    if(db.query('SELECT 1 FROM agents WHERE workspace_id=? AND name=?').get(owner.workspace_id,name))return null;
    const agent=createAgent({name,workspaceSlug:owner.slug,type:'standard'});
    db.query("UPDATE agents SET tool_profile='no-destructive',legacy_skill_access=0 WHERE id=?").run(agent.id);
    return read();
  })();
}

export function browserConnectionState(ownerId:string) {
  const owner=localOwner(db,ownerId),workspace=owner.workspace_id;
  return {
    mcp_url:new URL('/mcp',env.PUBLIC_URL).href,
    workspace:(db.query('SELECT name FROM workspaces WHERE id=?').get(workspace) as {name:string}).name,
    memory_model:memoryModelStatus(workspace),
    agents:db.query(`SELECT id,name,last_seen FROM agents WHERE workspace_id=? AND active=1
      AND principal_kind='agent' AND type NOT IN ('ingest-daemon','system')
      AND NOT EXISTS (SELECT 1 FROM client_connections c WHERE c.agent_id=agents.id AND c.workspace_id=agents.workspace_id)
      ORDER BY last_seen DESC,name`).all(workspace),
    stewards:db.query("SELECT id,name,last_seen FROM agents WHERE workspace_id=? AND type='steward' AND active=1 AND principal_kind='agent'").all(workspace),
    external_agent:db.query(`SELECT a.id,a.name,a.type FROM bridge_identities b JOIN agents a ON a.id=b.agent_id
      AND a.workspace_id=b.workspace_id WHERE b.workspace_id=? AND a.active=1`).get(workspace),
    clients:db.query(`SELECT a.id,a.name,a.type,a.last_seen,COUNT(DISTINCT c.id) AS registrations,
      COUNT(DISTINCT CASE WHEN t.revoked=0 AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND t.token_type IN ('access','refresh') THEN t.token_hash END) AS active_grants
      FROM agents a JOIN oauth_clients c ON c.agent_id=a.id AND c.workspace_id=a.workspace_id
      LEFT JOIN oauth_tokens t ON t.client_id=c.id AND t.workspace_id=a.workspace_id
      WHERE a.workspace_id=? AND a.active=1 AND a.principal_kind='agent'
      AND NOT EXISTS (SELECT 1 FROM client_connections cc WHERE cc.agent_id=a.id AND cc.workspace_id=a.workspace_id)
      GROUP BY a.id ORDER BY a.name`).all(workspace),
  };
}
