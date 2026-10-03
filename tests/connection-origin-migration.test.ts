import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {backfill041} from '../src/db/migration-041-backfill.ts';
import {resourceOrigin} from '../src/auth/resource-origin.ts';
import {randomUUID} from 'node:crypto';

/**
 * Pin for migration 041: backfill041 validates schema-40 audiences with the live
 * runtime resourceOrigin(). Loosening or tightening that rule silently changes
 * which audiences a fresh upgrade accepts, or makes it abort.
 *
 * If you are here because this test failed: decide whether migration 041 must
 * keep its original rule, and if so freeze a copy of it for the migration.
 */
test('resourceOrigin accepts only HTTPS or loopback HTTP bare origins (migration 041 pin)',()=>{
  for(const [input,origin] of [['https://a.example','https://a.example'],['https://a.example/','https://a.example'],
    ['http://127.0.0.1:1','http://127.0.0.1:1'],['http://localhost:1','http://localhost:1'],['http://[::1]:1','http://[::1]:1']])
    expect(resourceOrigin(input)).toBe(origin);
  for(const input of ['http://10.0.0.1','http://a.example','https://a.example/x','https://u:p@a.example','https://a.example?q'])
    expect(()=>resourceOrigin(input)).toThrow('MCP requires an HTTPS or local loopback origin');
});

test('schema40 audiences survive origin backfill and contradictory grants roll back the whole migration',()=>{
  const database=new Database(':memory:'),id=randomUUID(),draft=randomUUID();
  database.exec(`CREATE TABLE client_connections(id TEXT,agent_id TEXT,origin TEXT DEFAULT '');
    CREATE TABLE oauth_tokens(agent_id TEXT,resource TEXT);
    CREATE TABLE consent_tickets(client_id TEXT,resource TEXT);
    CREATE TABLE oauth_clients(id TEXT,agent_id TEXT);`);
  try{
    database.query('INSERT INTO client_connections(id,agent_id) VALUES (?,?), (?,?)').run(id,'agent',draft,'draft');
    const resource='http://127.0.0.1:19377/mcp/c/'+id;
    database.query('INSERT INTO oauth_tokens VALUES (?,?)').run('agent',resource);
    database.transaction(()=>backfill041(database,'https://new.example'))();
    expect(database.query('SELECT origin FROM client_connections WHERE id=?').get(id)).toEqual({origin:'http://127.0.0.1:19377'});
    expect(database.query('SELECT origin FROM client_connections WHERE id=?').get(draft)).toEqual({origin:'https://new.example'});
    database.run("UPDATE client_connections SET origin=''");
    database.query('INSERT INTO oauth_clients VALUES (?,?)').run('client','agent');
    database.query('INSERT INTO consent_tickets VALUES (?,?)').run('client','https://different.example/mcp/c/'+id);
    expect(()=>database.transaction(()=>backfill041(database,'https://new.example'))()).toThrow('multiple origins');
    expect(database.query("SELECT count(*) AS n FROM client_connections WHERE origin='' ").get()).toEqual({n:2});
    database.run('DELETE FROM consent_tickets');database.run('DELETE FROM oauth_tokens');
    database.query('INSERT INTO consent_tickets VALUES (?,?)').run('client',resource);
    database.transaction(()=>backfill041(database,'https://new.example'))();
    expect(database.query('SELECT origin FROM client_connections WHERE id=?').get(id)).toEqual({origin:'http://127.0.0.1:19377'});
  }finally{database.close();}
});
