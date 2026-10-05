import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {connectedApps} from '../src/services/browser-connections.ts';
import {connectionAction} from '../src/services/client-connections.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';

let workspace:string,owner:string;
beforeAll(()=>{
  runMigrations();
  workspace=createWorkspace({name:'Connected apps check',slug:'connected-apps-check'}).id;
  owner=bootstrapOwner(db,'Apps owner',undefined,workspace).agent_id;
});

// A Grok Bot connection added for an agent that keeps working over its own key was shown as
// "sign in again" with that agent's requests as its last use. The row carries its own state.
test('a connection the application never signed in through reports its own state',()=>{
  const bot=createAgent({name:'apps-bot',workspaceSlug:'connected-apps-check'}).id;
  db.query('UPDATE agents SET last_seen=? WHERE id=?').run(new Date().toISOString(),bot);
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-0000000a99e5',?,?,?,'grok_bot','read_write','apps-bot','awaiting_client','x','2999-01-01','2026-09-30T20:29:14Z')`).run(workspace,owner,bot);
  expect(connectedApps(workspace).find(a=>a.agent_id===bot)).toMatchObject({kind:'connection',state:'awaiting_client',authorized:0});
});

// That agent kept working over its own bridge key: disconnecting the never-finished setup must not deactivate it.
test('disconnecting an unfinished setup keeps an agent that works over other credentials',()=>{
  const bot=createAgent({name:'apps-bridge-bot',workspaceSlug:'connected-apps-check'}).id;
  db.query('UPDATE agents SET last_seen=? WHERE id=?').run(new Date().toISOString(),bot);
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-0000000b41d9',?,?,?,'grok_bot','read_write','apps-bridge-bot','awaiting_client','x','2999-01-01','2026-09-30T20:29:14Z')`).run(workspace,owner,bot);
  expect(connectionAction(owner,{action:'disconnect',id:'00000000-0000-4000-8000-0000000b41d9'})).toMatchObject({code:'DISCONNECTED',agent_kept:true});
  expect(db.query('SELECT active FROM agents WHERE id=?').get(bot)).toEqual({active:1});
  expect(connectedApps(workspace).some(a=>a.agent_id===bot)).toBe(false);
  // A setup nobody ever used still retires its agent.
  const unused=createAgent({name:'apps-unused',workspaceSlug:'connected-apps-check'}).id;
  db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,state,challenge_hash,challenge_expires_at,created_at)
    VALUES('00000000-0000-4000-8000-0000000c0ffe',?,?,?,'grok_bot','read_write','apps-unused','awaiting_client','x','2999-01-01','2026-09-30T20:29:14Z')`).run(workspace,owner,unused);
  expect(connectionAction(owner,{action:'disconnect',id:'00000000-0000-4000-8000-0000000c0ffe'})).toMatchObject({agent_kept:false});
  expect(db.query('SELECT active FROM agents WHERE id=?').get(unused)).toEqual({active:0});
});
