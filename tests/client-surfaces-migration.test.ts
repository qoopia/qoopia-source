import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import fs from 'node:fs';

test('adding client surfaces preserves existing connection and OAuth evidence',()=>{
  const database=new Database(':memory:');
  try{
    database.exec('PRAGMA foreign_keys=ON');
    database.exec('CREATE TABLE workspaces(id TEXT PRIMARY KEY)');
    database.exec('CREATE TABLE agents(id TEXT PRIMARY KEY)');
    database.exec('CREATE TABLE oauth_clients(id TEXT PRIMARY KEY)');
    database.exec('CREATE TABLE oauth_tokens(id TEXT PRIMARY KEY)');
    database.exec('CREATE TABLE consent_tickets(id TEXT PRIMARY KEY)');
    database.exec(fs.readFileSync('migrations/040-connections.sql','utf8'));
    database.exec(fs.readFileSync('migrations/041-connection-origins.sql','utf8'));
    database.exec("INSERT INTO workspaces VALUES('w')");
    database.exec("INSERT INTO agents VALUES('owner'),('client')");
    database.exec("INSERT INTO oauth_clients VALUES('oauth')");
    database.exec("INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,oauth_client_id,verified_at,created_at,origin) VALUES('id','w','owner','client','claude_code','read','key','verified','','2026-09-22','oauth','2026-09-22','2026-09-21','https://old.example')");
    database.exec(fs.readFileSync('migrations/047-client-surfaces.sql','utf8'));
    expect(database.query('SELECT surface,state,oauth_client_id,verified_at,origin FROM client_connections WHERE id=?').get('id')).toEqual({surface:'claude_code',state:'verified',oauth_client_id:'oauth',verified_at:'2026-09-22',origin:'https://old.example'});
    database.exec("INSERT INTO agents VALUES('muse'),('grok')");
    for(const [id,surface] of [['muse','muse_code'],['grok','grok_bot']])database.query("INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,challenge_hash,challenge_expires_at,created_at,origin) VALUES(?,?,?,?,?,'read',?,'','2026-09-22','2026-09-22','https://new.example')").run(id,'w','owner',id,surface,id);
    expect((database.query('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check).toBe('ok');
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{database.close();}
});
