import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIGRATION=fs.readFileSync(new URL('../migrations/045-agent-memory-policy.sql',import.meta.url),'utf8');

test('schema 44 agents adopt auto; a manual set after the upgrade survives backup and restore',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-policy-rehearsal-')),backup=path.join(dir,'backup.db');
  const before=new Database(':memory:');
  try {
    // The part of schema 44 this migration touches, holding agents that predate it.
    before.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY);
      CREATE TABLE agents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE UNIQUE INDEX agents_workspace_identity ON agents(id,workspace_id);
      INSERT INTO workspaces VALUES('ws');
      INSERT INTO agents(id,workspace_id,name) VALUES('existing-one','ws','one'),('existing-two','ws','two');`);
    before.exec('PRAGMA foreign_keys=ON');
    before.transaction(()=>before.exec(MIGRATION))();
    expect(before.query('SELECT memory_mode,memory_mode_revision FROM agents ORDER BY id').all())
      .toEqual([{memory_mode:'auto',memory_mode_revision:0},{memory_mode:'auto',memory_mode_revision:0}]);

    // Records written after the upgrade: an owner decision and an agent created on the new schema.
    before.run("UPDATE agents SET memory_mode='manual',memory_mode_revision=1,memory_mode_updated_at_ms=1,memory_mode_actor_id='owner' WHERE id='existing-two'");
    before.run("INSERT INTO agent_memory_policy_log(workspace_id,agent_id,mode,revision,actor_id,created_at_ms) VALUES('ws','existing-two','manual',1,'owner',1)");
    before.run("INSERT INTO agents(id,workspace_id,name) VALUES('created-later','ws','three')");
    before.run("INSERT INTO memory_save_decisions(id,workspace_id,agent_id,operation,request_hash,decision,note_id,decided_by,decided_at_ms) VALUES('dec-1','ws','existing-two','note_create','h','saved','note-1','owner',1)");
    // A decision row never carries text, and 'saved' must name the note it produced.
    expect(()=>before.run("INSERT INTO memory_save_decisions(id,workspace_id,agent_id,operation,request_hash,decision,note_id,decided_by,decided_at_ms) VALUES('dec-2','ws','existing-two','note_create','h','saved',NULL,'owner',1)")).toThrow();
    expect(()=>before.run("INSERT INTO memory_save_decisions(id,workspace_id,agent_id,operation,request_hash,decision,note_id,decided_by,decided_at_ms) VALUES('dec-3','ws','nobody','note_create','x','declined',NULL,'owner',1)")).toThrow();
    expect(()=>before.run("UPDATE agents SET memory_mode='off' WHERE id='existing-one'")).toThrow();
    expect(()=>before.run("INSERT INTO agent_memory_policy_log(workspace_id,agent_id,mode,revision,actor_id,created_at_ms) VALUES('ws','nobody','manual',1,'owner',1)")).toThrow();

    // The chosen recovery is a verified backup, not a DROP COLUMN that would re-enable capture.
    before.run(`VACUUM INTO '${backup}'`);
    const restored=new Database(backup,{readonly:true});
    try {
      expect(restored.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
      expect(restored.query('SELECT id,memory_mode FROM agents ORDER BY id').all()).toEqual([
        {id:'created-later',memory_mode:'auto'},{id:'existing-one',memory_mode:'auto'},{id:'existing-two',memory_mode:'manual'}]);
      expect(restored.query('SELECT id,decision,note_id FROM memory_save_decisions').all()).toEqual([{id:'dec-1',decision:'saved',note_id:'note-1'}]);
      expect(restored.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(restored.query('SELECT agent_id,mode,revision FROM agent_memory_policy_log').all()).toEqual([{agent_id:'existing-two',mode:'manual',revision:1}]);
    } finally {restored.close();}
  } finally {before.close();fs.rmSync(dir,{recursive:true,force:true});}
});
