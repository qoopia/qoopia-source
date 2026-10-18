import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent,rotateAgentKey} from '../src/admin/agents.ts';

test('key-age migration leaves existing dates unknown and tracks every new key',()=>{
  const fixture=new Database(':memory:');
  try{
    fixture.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,api_key_hash TEXT); INSERT INTO agents VALUES('old','old-hash');");
    fixture.exec(readFileSync(new URL('../migrations/052-api-key-age.sql',import.meta.url),'utf8'));
    expect((fixture.query('SELECT api_key_issued_at FROM agents').get() as any).api_key_issued_at).toBeNull();
    fixture.exec("UPDATE agents SET api_key_hash='new-hash' WHERE id='old'");
    expect((fixture.query('SELECT api_key_issued_at FROM agents').get() as any).api_key_issued_at).toMatch(/^20/);
  }finally{fixture.close();}
  runMigrations();const ws=createWorkspace({name:'Key age fixture'});
  const a=createAgent({name:'key-age-agent',workspaceSlug:ws.slug});
  expect((db.query('SELECT api_key_issued_at FROM agents WHERE id=?').get(a.id) as any).api_key_issued_at).toMatch(/^20/);
  db.query("UPDATE agents SET api_key_issued_at='2020-01-01T00:00:00Z' WHERE id=?").run(a.id);
  rotateAgentKey(a.name,ws.slug);
  expect((db.query('SELECT api_key_issued_at FROM agents WHERE id=?').get(a.id) as any).api_key_issued_at).not.toStartWith('2020');
});
