import type { Database } from 'bun:sqlite';
import { bootstrapOwner } from '../auth/pairings.ts';
import { issueLocalLogin } from './local-login.ts';
import { ownerRequestSchema, type OwnerResponse } from './owner-control.ts';
import type { AuthContext } from '../auth/middleware.ts';

/** Local OS authority only: caller must hold the installation lock or authenticated owner IPC. */
export function localOwner(database: Database, selected?: string): AuthContext {
  let ownerId = selected;
  if (!ownerId) {
    const owners = database.query('SELECT actor_id FROM workspace_owners').all() as { actor_id: string }[];
    if (owners.length === 1) ownerId = owners[0]!.actor_id;
  }
  const owner = database.query(`SELECT a.* FROM workspace_owners o JOIN agents a ON a.id=o.actor_id AND a.workspace_id=o.workspace_id
    WHERE a.id=? AND a.active=1 AND a.principal_kind='human' AND a.authority_profile='owner'`).get(ownerId ?? '') as
    { id: string; workspace_id: string; name: string; type: AuthContext['type']; policy_epoch: number; session_version: number } | null;
  if (!owner) throw new Error('Select an existing active human owner; new instances require explicit bootstrap');
  return { agent_id: owner.id, workspace_id: owner.workspace_id, agent_name: owner.name, type: owner.type,
    source: 'api-key', policy_epoch: owner.policy_epoch, session_version: owner.session_version };
}

/** Only the credential-checked local transport calls this; never an HTTP route. */
export function ownerControlRequest(database: Database, input: unknown): OwnerResponse {
  const request = ownerRequestSchema.parse(input);
  let ownerId: string | undefined;
  if (request.operation === 'bootstrap') {
    // Global first-claim gate plus the existing domain's immediate transaction.
    // The outer immediate transaction keeps check + bootstrap atomic across processes.
    ownerId = database.transaction(() => {
      if (database.query('SELECT 1 FROM workspace_owners LIMIT 1').get()) throw new Error('Owner already bound; select existing owner login');
      return bootstrapOwner(database, request.name, request.workspaceName ?? (request.workspaceId ? undefined : 'My workspace'), request.workspaceId).agent_id;
    }).immediate();
  } else {
    ownerId = request.ownerId;
  }
  return { code: issueLocalLogin(localOwner(database, ownerId).agent_id), expiresInSeconds: 300 };
}
