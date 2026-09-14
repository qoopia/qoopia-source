import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {backfill041} from '../src/db/migration-041-backfill.ts';
import {randomUUID} from 'node:crypto';

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
