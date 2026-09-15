import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {db,DB_PATH} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {issueLocalLogin} from '../src/delivery/local-login.ts';
import {enableLocalWorkspace} from '../src/delivery/workspace.ts';
import {lockInstallation} from '../src/delivery/operations.ts';
import {hash,safePath} from '../src/utils/fs.ts';
import {startHttpServer} from '../src/http.ts';
import {env} from '../src/utils/env.ts';

test('local workspace enforces owner cookie and origin, connects once, runs once and keeps conversation history',async()=>{
  const keychains=()=>process.platform==='darwin'?spawnSync('/usr/bin/security',['list-keychains','-d','user'],{env:{HOME:os.userInfo().homedir,PATH:'/usr/bin:/bin'},encoding:'utf8'}).stdout:'';
  const originalKeychains=keychains();
  runMigrations();
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'v1-workspace-'))),bin=path.join(root,'bin');
  fs.mkdirSync(bin,{mode:0o700});
  // This executable is a deterministic native protocol fixture, not a model or subscription claim.
  fs.writeFileSync(path.join(bin,'claude'),`#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.224 (Claude Code)'; exit; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$#" = 2 ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'; exit; fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then printf 'https://claude.com/cai/oauth/authorize?client_id=fixture'; IFS= read -r code; [ "$code" = "fixture-once" ]; exit; fi
if [ "$1" != "--print" ]; then exit 1; fi
for folder in task-*; do
  if [ -d "$folder" ]; then echo 'Durable fixture file.' > "$folder/handoff.md"; ln -s "$0" "$folder/refused-link"; fi
done
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Fixture answer preserved."}]}}'
echo '{"type":"result","subtype":"success","is_error":false}'
`,{mode:0o700});
  const ws=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(ws,'Workspace test',ws);
  const owner=bootstrapOwner(db,'Workspace fixture owner',undefined,ws),previous={port:env.PORT,standalone:process.env.QOOPIA_STANDALONE,mode:fs.statSync(DB_PATH).mode&0o777};
  fs.chmodSync(DB_PATH,0o600);process.env.QOOPIA_STANDALONE='true';env.PORT=0;
  const server=startHttpServer();await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  env.PORT=(server.address() as {port:number}).port;
  const base=`http://127.0.0.1:${env.PORT}`,instance=(db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({format:'qoopia-installation/1',generation:'generation-'+randomUUID(),bundle:'a'.repeat(64),bundle_digest:'a'.repeat(64),instance,port:env.PORT}),{mode:0o600});
  const unlock=lockInstallation(root);enableLocalWorkspace(root,{PATH:bin+':/usr/bin:/bin'});
  try{
    const endpoint=base+'/api/dashboard/workspace';
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint,{headers:{Authorization:'Bearer '+owner.api_key}})).status).toBe(401);
    const signed=await fetch(base+'/api/dashboard/local-login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({code:issueLocalLogin(owner.agent_id)})});
    expect(signed.status).toBe(200);
    const cookie=signed.headers.get('set-cookie')!.split(';')[0]!;
    const send=(body:unknown,origin=base,csrf='1')=>fetch(endpoint,{method:'POST',headers:{cookie,origin,'x-qoopia-csrf':csrf,'content-type':'application/json'},body:JSON.stringify(body)});
    const input={action:'connect',runtime:'claude_code'};
    expect((await send(input,'https://foreign.invalid')).status).toBe(403);
    expect((await send(input,base,'')).status).toBe(403);
    expect((await send({...input,command:'anything'})).status).toBe(400);
    const first=await send(input),firstBody=await first.json();expect(firstBody).toMatchObject({state:'ready'});
    expect(first.status).toBe(200);expect((await (await send(input)).json()).state).toBe('ready');
    expect(db.query("SELECT count(*) n FROM agents WHERE workspace_id=? AND name='Qoopia Claude'").get(ws)).toEqual({n:1});
    expect((await (await send({action:'login',runtime:'claude_code'})).json()).state).toBe('login_started');
    await new Promise(resolve=>setTimeout(resolve,150));
    expect((await (await fetch(endpoint,{headers:{cookie}})).json()).login.url).toBe('https://claude.com/cai/oauth/authorize?client_id=fixture');
    expect((await send({action:'login-code',runtime:'claude_code',code:'fixture-once'},'https://foreign.invalid')).status).toBe(403);
    expect((await (await send({action:'login-code',runtime:'claude_code',code:'fixture-once'})).json()).state).toBe('code_submitted');
    await new Promise(resolve=>setTimeout(resolve,150));
    expect((await (await fetch(endpoint,{headers:{cookie}})).json()).login).toEqual({runtime:'claude_code',state:'completed'});
    const task={action:'task',runtime:'claude_code',session:'Useful conversation',task:'Keep this context for later.',model:'claude-opus-5',effort:'high'};
    const answer=await (await send(task)).json();expect(answer).toMatchObject({status:'completed',output:'Fixture answer preserved.'});
    expect(answer.artifacts).toHaveLength(1);expect(answer.artifacts[0].filename).toBe('handoff.md');
    expect(answer.artifact_warning).toContain('regular files');
    const download=await fetch(base+'/api/dashboard/files/'+answer.artifacts[0].id+'/download',{headers:{cookie}});
    expect(download.status).toBe(200);expect(await download.text()).toBe('Durable fixture file.\n');
    expect(db.query('SELECT content FROM files WHERE id=?').get(answer.artifacts[0].id)).toEqual({content:Buffer.from('Durable fixture file.\n')});
    const continued=await (await send({...task,task:'Continue the same conversation.'})).json();
    expect(continued.session_id).toBe(answer.session_id);
    const history=await (await fetch(base+'/api/dashboard/sessions/'+answer.session_id+'/messages',{headers:{cookie}})).json();
    expect(history.messages.map((m:{role:string})=>m.role)).toEqual(['user','assistant','user','assistant']);
    const pointer=JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8'));
    fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({...pointer,generation:'generation-'+randomUUID(),bundle:'b'.repeat(64),bundle_digest:'b'.repeat(64)}));
    expect((await send(task)).status).toBe(400); // A task cannot silently approve an update.
    expect((await (await send(input)).json()).state).toBe('ready'); // Explicit reconnect retains the agent.
    expect(db.query("SELECT count(*) n FROM agents WHERE workspace_id=? AND name='Qoopia Claude'").get(ws)).toEqual({n:1});
    db.query("UPDATE agents SET policy_epoch=policy_epoch+1 WHERE workspace_id=? AND name='Qoopia Claude'").run(ws);
    expect((await send(input)).status).toBe(400); // Reconnect never restores revoked access.
    db.query('UPDATE agents SET active=0 WHERE id=?').run(owner.agent_id);
    expect((await send(task)).status).toBe(401);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));unlock();
    env.PORT=previous.port;if(previous.standalone===undefined)delete process.env.QOOPIA_STANDALONE;else process.env.QOOPIA_STANDALONE=previous.standalone;
    fs.chmodSync(DB_PATH,previous.mode);fs.rmSync(root,{recursive:true,force:true});
    fs.rmSync(safePath(`/var/tmp/qoopia-${process.getuid!()}/${hash(root).slice(0,24)}`),{recursive:true,force:true});
    expect(keychains()).toBe(originalKeychains);
  }
},20_000);
