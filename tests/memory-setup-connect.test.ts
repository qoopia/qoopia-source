import {beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {deleteAgent,rotateAgentKey} from '../src/admin/agents.ts';
import {memorySetupAction} from '../src/services/memory-setup.ts';

let owner:ReturnType<typeof bootstrapOwner>,slug:string;
type Connected={state:string;connection:{agent_id:string;key:string;runtime:string}};
const connect=()=>memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'codex'}) as Promise<Connected>;
const agent=(id:string)=>db.query('SELECT name,active FROM agents WHERE id=?').get(id) as {name:string;active:number};
beforeAll(()=>{
  runMigrations();
  slug='memory-connect-'+randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  owner=bootstrapOwner(db,'Memory connect owner',undefined,slug);
});

test('login-code without a waiting sign-in and check before select are rejected',async()=>{
  await expect(memorySetupAction(owner.agent_id,{action:'login-code',code:'ABCD-EFGH'})).rejects.toThrow('No sign-in is waiting');
  await expect(memorySetupAction(owner.agent_id,{action:'check'})).rejects.toMatchObject({code:'NOT_READY'});
});

test('connect-agent reuses a live connection and reissues one after the owner revokes its agent',async()=>{
  const first=await connect();
  expect(first.state).toBe('download_connection');expect(agent(first.connection.agent_id)).toEqual({name:'Qoopia Codex memory',active:1});
  expect((await connect()).connection).toEqual(first.connection);

  deleteAgent('Qoopia Codex memory',slug);
  const second=await connect();
  expect(second.state).toBe('download_connection');expect(second.connection.agent_id).not.toBe(first.connection.agent_id);
  expect(agent(second.connection.agent_id).active).toBe(1);
  expect(agent(first.connection.agent_id).active).toBe(0);
  expect((await connect()).connection).toEqual(second.connection);
});

test('connect-agent refuses, without replacing it, an active agent whose key was rotated elsewhere',async()=>{
  const live=(await connect()).connection;
  rotateAgentKey('Qoopia Codex memory',slug);
  await expect(connect()).rejects.toMatchObject({code:'CONFLICT'});
  expect(agent(live.agent_id).active).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM agents WHERE workspace_id=? AND name='Qoopia Codex memory' AND active=1").get(slug)).toEqual({n:1});
});
