import {beforeAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {createAgent,deleteAgent,rotateAgentKey} from '../src/admin/agents.ts';
import {memorySetupAction,migrateMemoryOrigins} from '../src/services/memory-setup.ts';
import {installMemoryClient} from '../src/delivery/memory-client.ts';
import {hash} from '../src/utils/fs.ts';
import fs from 'node:fs';import path from 'node:path';
import {env} from '../src/utils/env.ts';import {bindNativeOwnerHome} from '../src/delivery/native-keychain.ts';

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

test('an installed Qoopia binds local Claude Code to loopback, and moves a binding 5.0.16 left on the tunnel origin',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-memory-setup-loopback-')),home=path.join(root,'home');fs.mkdirSync(home,{mode:0o700});
  const prior={url:env.PUBLIC_URL,root:env.ROOT_DIR,standalone:process.env.QOOPIA_STANDALONE};
  env.PUBLIC_URL='https://c-fixture.qoopia.ai';env.ROOT_DIR=root;bindNativeOwnerHome(home);
  try {
    // 5.0.16: a tunnel replaced PUBLIC_URL at startup and connect-agent stored that origin.
    delete process.env.QOOPIA_STANDALONE;
    const stored=(await memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'claude_code'}) as Connected).connection as Connected['connection']&{url:string};
    expect(stored.url).toBe('https://c-fixture.qoopia.ai');
    process.env.QOOPIA_STANDALONE='true';
    const installed=await memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'claude_code'}) as {state:string;agent_id:string};
    expect(installed).toMatchObject({state:'installed',agent_id:stored.agent_id});
    const binding=JSON.parse(fs.readFileSync(path.join(root,'memory-clients/claude_code/connection.json'),'utf8'));
    expect(binding).toMatchObject({url:'http://127.0.0.1:'+env.PORT,agent_id:stored.agent_id,key:stored.key});
    expect(JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).mcpServers.qoopia_memory.url).toBe('http://127.0.0.1:'+env.PORT+'/mcp');
  } finally {
    env.PUBLIC_URL=prior.url;env.ROOT_DIR=prior.root;
    if(prior.standalone===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=prior.standalone;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('the server moves a binding 5.0.16 left on the tunnel origin to loopback at start, with no relink',()=>{
  const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-memory-origin-')),home=path.join(root,'home');fs.mkdirSync(home,{mode:0o700});
  const prior={root:env.ROOT_DIR,standalone:process.env.QOOPIA_STANDALONE};env.ROOT_DIR=root;bindNativeOwnerHome(home);
  try {
    // 5.0.16 stored and linked the tunnel origin; the binary path does not matter for the binding.
    const created=createAgent({name:'Origin fixture '+randomUUID(),workspaceSlug:slug,type:'standard'});
    const tunnel={format:'qoopia-memory-connection/1' as const,url:'https://c-fixture.qoopia.ai',agent_id:created.id,key:created.api_key,runtime:'claude_code' as const};
    const record=path.join(root,'config','memory-clients',hash(slug),'claude_code.json');fs.mkdirSync(path.dirname(record),{recursive:true,mode:0o700});
    fs.writeFileSync(record,JSON.stringify(tunnel),{mode:0o600});
    installMemoryClient(tunnel,root,process.execPath,home);
    const settings=fs.readFileSync(path.join(home,'.claude/settings.json'));
    process.env.QOOPIA_STANDALONE='true';
    expect(migrateMemoryOrigins()).toEqual([{state:'relocated',runtime:'claude_code'}]);
    const loopback='http://127.0.0.1:'+env.PORT;
    expect(JSON.parse(fs.readFileSync(path.join(root,'memory-clients/claude_code/connection.json'),'utf8'))).toMatchObject({url:loopback,agent_id:created.id,key:created.api_key});
    expect(JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).mcpServers.qoopia_memory).toEqual({type:'http',url:loopback+'/mcp',headers:{Authorization:'Bearer '+created.api_key}});
    expect(JSON.parse(fs.readFileSync(record,'utf8')).url).toBe(loopback);
    expect(fs.readFileSync(path.join(home,'.claude/settings.json'))).toEqual(settings);
    expect(migrateMemoryOrigins()).toEqual([{state:'current',runtime:'claude_code'}]);
  } finally {
    env.ROOT_DIR=prior.root;
    if(prior.standalone===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=prior.standalone;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

// Another computer reaches an installed Qoopia only through its external address: its .qoopia-memory file names
// the tunnel origin and its own agent, while this computer keeps the loopback binding.
test('an installed Qoopia downloads a file for another computer at its external address, with a separate agent',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync('/var/tmp/qoopia-memory-setup-remote-'));
  const prior={url:env.PUBLIC_URL,root:env.ROOT_DIR,standalone:process.env.QOOPIA_STANDALONE};
  env.ROOT_DIR=root;process.env.QOOPIA_STANDALONE='true';
  try {
    env.PUBLIC_URL='http://127.0.0.1:'+env.PORT;
    await expect(memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'codex',target:'another_computer'})).rejects.toMatchObject({code:'NOT_READY'});
    env.PUBLIC_URL='https://c-remote.qoopia.ai';
    const remote=await memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'codex',target:'another_computer'}) as Connected&{connection:{url:string}};
    expect(remote.state).toBe('download_connection');expect(remote.connection.url).toBe('https://c-remote.qoopia.ai');
    expect(agent(remote.connection.agent_id)).toEqual({name:'Qoopia Codex memory remote',active:1});
    const again=await memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'codex',target:'another_computer'}) as Connected;
    expect(again.connection).toEqual(remote.connection);
    // A new tunnel origin moves the same remote agent to it.
    env.PUBLIC_URL='https://c-moved.qoopia.ai';
    const moved=await memorySetupAction(owner.agent_id,{action:'connect-agent',runtime:'codex',target:'another_computer'}) as Connected&{connection:{url:string}};
    expect(moved.connection).toMatchObject({url:'https://c-moved.qoopia.ai',agent_id:remote.connection.agent_id,key:remote.connection.key});
  } finally {
    env.PUBLIC_URL=prior.url;env.ROOT_DIR=prior.root;
    if(prior.standalone===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=prior.standalone;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
