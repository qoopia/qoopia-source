import type {Database} from 'bun:sqlite';
import {resourceOrigin} from '../auth/resource-origin.ts';

/** Preserve already issued audiences; refuse contradictory evidence instead of changing a grant. */
export function backfill041(database:Database,configuredOrigin:string) {
  for(const row of database.query('SELECT id,agent_id FROM client_connections WHERE origin=\'\'').all() as {id:string;agent_id:string}[]){
    const audiences=database.query(`SELECT resource FROM oauth_tokens WHERE agent_id=? AND resource IS NOT NULL
      UNION SELECT t.resource FROM consent_tickets t JOIN oauth_clients c ON c.id=t.client_id
      WHERE c.agent_id=? AND t.resource IS NOT NULL`).all(row.agent_id,row.agent_id) as {resource:string}[];
    const origins=new Set<string>();
    for(const {resource} of audiences){
      const url=new URL(resource),origin=resourceOrigin(url.origin);
      if(resource!==origin+'/mcp/c/'+row.id)throw new Error('Migration041 found an inconsistent connection audience');
      origins.add(origin);
    }
    if(origins.size>1)throw new Error('Migration041 found multiple origins for one connection; retain the pre-migration backup');
    database.query('UPDATE client_connections SET origin=? WHERE id=?').run([...origins][0]??resourceOrigin(configuredOrigin),row.id);
  }
}
