import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {inspectSetup} from '../src/delivery/setup.ts';

const entry=fs.readFileSync(new URL('../src/delivery/entry.ts',import.meta.url),'utf8');

const hex='a'.repeat(64);
const runtimePackage={runtime:'codex',target:`${process.platform}-${process.arch}`,version:'1.0.0',
 url:`https://github.com/openai/codex/releases/download/rust-v1.0.0/codex-package-${process.platform==='darwin'?'aarch64-apple-darwin':'x86_64-unknown-linux-musl'}.tar.gz`,sha256:hex,size:1,binary:'bin/codex'};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-setup-'));
 const generation='generation-00000000-0000-4000-8000-000000000001';
 fs.mkdirSync(path.join(root,'generations',generation,'data'),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({format:'qoopia-installation/1',generation,bundle:hex,bundle_digest:hex,instance:'instance-1',port:3737}),{mode:0o600});
 const database=new Database(path.join(root,'generations',generation,'data','qoopia.db'));
 database.run('CREATE TABLE workspace_owners(actor_id TEXT, workspace_id TEXT)');database.close();
 return {root,generation,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('setup resumes from durable installation, owner, runtime and connection state without IDs',()=>{
 const f=fixture();try{
  expect(inspectSetup(f.root)).toMatchObject({stage:'OWNER_BOOTSTRAP_REQUIRED'});
  expect(inspectSetup(f.root).next_action).toContain('qoopia start --root ');
  let db=new Database(path.join(f.root,'generations',f.generation,'data','qoopia.db'));
  db.run("INSERT INTO workspace_owners VALUES ('owner-1','workspace-1')");db.close();
  const provision=inspectSetup(f.root,'codex');
  expect(provision.stage).toBe('RUNTIME_PROVISION_REQUIRED');
  expect(provision.next_action).toContain('qoopia runtime provision --runtime codex --root ');
  fs.mkdirSync(path.join(f.root,'native-runtimes'),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(f.root,'native-runtimes','codex.json'),JSON.stringify(runtimePackage),{mode:0o600});
  const pending=inspectSetup(f.root,'codex');
  expect(pending.stage).toBe('CONNECT_REQUIRED');
  expect(pending.next_action).toContain('--config '+JSON.stringify(path.join(os.homedir(),'.codex','config.toml')));
  // A custom CODEX_HOME is where connect must write, as client-config does.
  const codexHome=process.env.CODEX_HOME;process.env.CODEX_HOME=path.join(f.root,'codex-home');
  try{expect(inspectSetup(f.root,'codex').next_action).toContain('--config '+JSON.stringify(path.join(fs.realpathSync(f.root),'codex-home','config.toml')));}
  finally{if(codexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=codexHome;}
  fs.mkdirSync(path.join(f.root,'connections'),{mode:0o700});
  fs.writeFileSync(path.join(f.root,'connections','malformed.json'),JSON.stringify({format:'qoopia-native-connection/1',runtime_kind:'codex',installation:{instance:'instance-1',bundle:hex,generation:f.generation,port:3737}}),{mode:0o600});
  expect(inspectSetup(f.root,'codex').stage).toBe('CONNECT_REQUIRED');
  const agent='00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(path.join(f.root,'connections',agent+'.json'),JSON.stringify({format:'qoopia-native-connection/1',runtime_kind:'codex',runtime_id:'codex:worker',workspace_id:'workspace-1',agent_id:agent,agent_epoch:1,agent_session:1,owner_id:'owner-1',owner_epoch:1,owner_session:1,config:{path:'/tmp/config',dev:1,ino:1,sha256:hex},installation:{root:f.root,instance:'instance-1',bundle:hex,generation:f.generation,port:3737}}),{mode:0o600});
  expect(inspectSetup(f.root,'codex')).toMatchObject({stage:'LIVE_QUALIFICATION_REQUIRED'});
  expect(inspectSetup(f.root,'codex').next_action).toContain('qoopia start --root ');
 }finally{f.cleanup();}
});

test('after the owner, setup follows OAuth client connections; the native runtime path needs --runtime',()=>{
 const f=fixture();try{
  const db=new Database(path.join(f.root,'generations',f.generation,'data','qoopia.db'));
  try{
   db.run("INSERT INTO workspace_owners VALUES ('owner-1','workspace-1')");
   const none=inspectSetup(f.root);
   expect(none.stage).toBe('CONNECTION_REQUIRED');expect(none.next_action).toContain('qoopia connections plan');expect(none.next_action).not.toContain('connect --runtime');
   db.run('CREATE TABLE agents(id TEXT, workspace_id TEXT, active INTEGER)');
   db.run('CREATE TABLE client_connections(id TEXT, workspace_id TEXT, owner_id TEXT, agent_id TEXT, state TEXT)');
   db.run("INSERT INTO agents VALUES ('agent-1','workspace-1',1)");
   db.run("INSERT INTO client_connections VALUES ('c-1','workspace-1','owner-1','agent-1','revoked')");
   expect(inspectSetup(f.root).stage).toBe('CONNECTION_REQUIRED');
   db.run("UPDATE client_connections SET state='awaiting_client'");
   expect(inspectSetup(f.root)).toMatchObject({stage:'CLIENT_CALL_REQUIRED'});expect(inspectSetup(f.root).next_action).toContain('qoopia connections status --root ');
   db.run("UPDATE client_connections SET state='verified'");
   expect(inspectSetup(f.root)).toMatchObject({stage:'CLIENT_CONNECTED',next_action:null});
   expect(inspectSetup(f.root,'codex').stage).toBe('RUNTIME_PROVISION_REQUIRED');
  }finally{db.close();}
 }finally{f.cleanup();}
});

test('setup reports install first and does not create state',()=>{
 expect(entry.indexOf("if(cmd==='setup')")).toBeGreaterThan(entry.indexOf('const dispatchInstalled='));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-setup-empty-'));try{
  expect(inspectSetup(root)).toMatchObject({stage:'INSTALL_REQUIRED'});
  expect(inspectSetup(root).next_action).toContain('qoopia install --root ');
  expect(fs.readdirSync(root)).toEqual([]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('setup refuses linked runtime state',()=>{
 const f=fixture();try{
  const db=new Database(path.join(f.root,'generations',f.generation,'data','qoopia.db'));
  db.run("INSERT INTO workspace_owners VALUES ('owner-1','workspace-1')");db.close();
  fs.mkdirSync(path.join(f.root,'native-runtimes'),{recursive:true,mode:0o700});
  const target=path.join(f.root,'runtime.json');fs.writeFileSync(target,JSON.stringify(runtimePackage));
  fs.symlinkSync(target,path.join(f.root,'native-runtimes','codex.json'));
  expect(inspectSetup(f.root,'codex').stage).toBe('RUNTIME_PROVISION_REQUIRED');
 }finally{f.cleanup();}
});

test('start without an owner names the owner-login step instead of a browser it does not open [F-297]',async()=>{
 const {startedMessage}=await import('../src/delivery/entry.ts');
 const message=startedMessage(false,3881,'/tmp/Qoopia root');
 expect(message).toContain('qoopia owner-login --owner-name YOUR_NAME --root "/tmp/Qoopia root"');
 expect(message).toContain('http://127.0.0.1:3881/local-login');
 expect(startedMessage(false,3881)).not.toContain('--root');
 // start reads the owner table after the server is up and prints this message.
 expect(entry.slice(entry.indexOf("if(cmd==='start'||cmd==='open'){"))).toContain("startedMessage(!!db.query('SELECT 1 FROM workspace_owners LIMIT 1').get()");
 const control=fs.readFileSync(new URL('../src/delivery/owner-control.ts',import.meta.url),'utf8');
 expect(control).toContain('owner-login --owner-name YOUR_NAME');
});
