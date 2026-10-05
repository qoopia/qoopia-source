import {test,expect,spyOn} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {Database} from 'bun:sqlite';import {randomUUID} from 'node:crypto';
import {managedTransport} from '../src/delivery/managed-transport.ts';
import {readTransport} from '../src/delivery/transport-config.ts';
import {loginBroker} from '../src/identity/broker.ts';
import {db} from '../src/db/connection.ts';import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';import {env} from '../src/utils/env.ts';
import {durableWrite,privateDirectory} from '../src/utils/fs.ts';
import {startMcpEdge} from '../src/delivery/mcp-edge.ts';
import http from 'node:http';import {once} from 'node:events';
import {transportSupervisor} from '../src/delivery/transport-supervisor.ts';
import type {TransportConfig} from '../src/delivery/transport-config.ts';
import {newIdentity} from '../src/bridges/protocol.ts';
import {fakeFetch} from './helpers/fake-fetch.ts';
import {wellKnownAuthorizationServer,wellKnownProtectedResource} from '../src/auth/oauth.ts';
import {connectionAction} from '../src/services/client-connections.ts';
import {browserConnectionState} from '../src/services/browser-connections.ts';
import {authenticate} from '../src/auth/middleware.ts';
import {sha256Hex} from '../src/auth/api-keys.ts';

test('managed wizard resumes email confirmation after restart, saves only private scoped credentials and keeps workspace owners isolated',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-')),registry=new Database(':memory:'),origin='https://auth.example.test';
  const workspace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Managed fixture',workspace);
  const owner=bootstrapOwner(db,'Managed owner',undefined,workspace);
  const foreignSpace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(foreignSpace,'Foreign fixture',foreignSpace);
  const foreign=bootstrapOwner(db,'Foreign owner',undefined,foreignSpace);
  let mail='',offline=false;const currentOrigin=env.PUBLIC_URL,currentIssuer=env.OAUTH_ISSUER,previousPort=env.PORT;
  const upstream=http.createServer((_q,r)=>r.end('{}'));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');env.PORT=(upstream.address() as any).port;
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const helper=path.join(root,'cloudflared-fixture');
  durableWrite(helper,'#!'+process.execPath+'\nsetInterval(()=>{},1000);\n',0o700);
  const handler=loginBroker(registry,{origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture',
    devices:{domain:'example.test',provider:{ensure:async()=>({id:randomUUID(),account:'a'.repeat(32)}),remove:async()=>{}}}},
    fakeFetch(async(_input,init)=>{mail=JSON.parse(String(init?.body)).text;return Response.json({id:'sent'});}));
  const network=fakeFetch(async(input,init)=>{
    if(String(input).startsWith('http://127.0.0.1:'))return new Response('ready');
    if(String(input).endsWith('/mcp'))return new Response('',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="'+new URL(String(input)).origin+'/.well-known/oauth-protected-resource"'}});
    if(offline)throw new Error('network offline');
    return handler(new Request(String(input),init),'synthetic');
  });
  let service=managedTransport(root,db,helper,network,origin);
  const act=(input:unknown)=>service.action(owner.agent_id,input) as Promise<any>;
  try{
    expect((await act({action:'network-plan'})).code).toBe('NETWORK_CONSENT_REQUIRED');expect(readTransport(root)).toBeNull();
    expect((await act({action:'network-start',method:'email'})).code).toBe('ACCOUNT_CONFIRMATION_REQUIRED');
    const initial=readTransport(root)!;expect(initial.flow?.verifier).toBeTruthy();expect(initial.enabled).toBe(false);
    const clock=spyOn(Date,'now').mockReturnValue(initial.flow!.expires+1);
    try{
      expect((await act({action:'network-resume'})).code).toBe('SIGN_IN_REQUIRED');
      expect(service.status().code).toBe('SIGN_IN_REQUIRED');
      expect(readTransport(root)!.identity).toEqual(initial.identity);
      expect(readTransport(root)!.device).toBeUndefined();
    }finally{clock.mockRestore();}
    expect((await act({action:'network-resume'})).code).toBe('ACCOUNT_CONFIRMATION_REQUIRED');
    service.stop();service=managedTransport(root,db,helper,network,origin);
    const token=new URL(mail.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    // The enrollment is bound to this installation's network: a browser elsewhere cannot confirm it.
    const send=(ip:string)=>handler(new Request(origin+'/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})}),ip);
    expect((await send('browser')).status).toBe(400);
    expect((await send('synthetic')).status).toBe(200);
    const ready=await act({action:'network-resume'});expect(ready.code).toBe('NETWORK_ONLINE');
    const saved=readTransport(root)!;expect(saved.installation_id).toBe(initial.installation_id);expect(saved.identity).toEqual(initial.identity);
    // Generic discovery through the tunnel names the tunnel as authorization server, never the loopback startup origin.
    const published=wellKnownProtectedResource();expect(published.resource).toBe(saved.device!.public_origin+'/mcp');
    expect(published.authorization_servers).toEqual([saved.device!.public_origin]);expect(wellKnownAuthorizationServer().issuer).toBe(saved.device!.public_origin);
    expect(saved.flow).toBeUndefined();expect(saved.grant).toBeUndefined();expect(saved.device?.workspace_id).toBe(workspace);
    expect(fs.statSync(path.join(root,'config/transport.json')).mode&0o777).toBe(0o600);
    expect(fs.statSync(path.join(root,'config/tunnel/credentials.json')).mode&0o777).toBe(0o600);
    expect(JSON.stringify(ready)).not.toContain(saved.tunnel_secret);expect(JSON.stringify(ready)).not.toContain(saved.identity.signPrivate.d);
    const proxyConfig=JSON.parse(fs.readFileSync(path.join(root,'config/tunnel/config.json'),'utf8'));
    expect(proxyConfig.ingress[0].service).toStartWith('unix:');expect(proxyConfig.ingress[1].service).toBe('http_status:404');
    await expect(service.action(foreign.agent_id,{action:'network-status'})).rejects.toThrow('another workspace');
    offline=true;await service.refresh();expect(service.status().code).toBe('NETWORK_CONNECTING');
    offline=false;await service.refresh();expect(service.status().code).toBe('NETWORK_ONLINE');
    expect((await act({action:'network-disable'})).code).toBe('NETWORK_DISABLED');
    expect(fs.existsSync(proxyConfig.ingress[0].service.slice(5))).toBe(false);
    // Paused, also after a restart: discovery names loopback and a new remote client is refused until access is on again.
    for(const restarted of [false,true]){
      if(restarted)managedTransport(root,db,helper,network,origin).stop();
      expect(wellKnownProtectedResource().authorization_servers).toEqual(['http://127.0.0.1:'+env.PORT]);
      const remote={surface:'chatgpt_web',access_mode:'read',request_key:randomUUID()} as const;
      expect((connectionAction(owner.agent_id,{action:'plan',...remote}) as any).code).toBe('EXTERNAL_ACCESS_REQUIRED');
      expect(()=>connectionAction(owner.agent_id,{action:'apply',...remote})).toThrow('Enable external access');
    }
    expect((await act({action:'network-enable'})).code).toBe('NETWORK_ONLINE');
    expect(wellKnownProtectedResource().authorization_servers).toEqual([saved.device!.public_origin]);
    const remote=(connectionAction(owner.agent_id,{action:'apply',surface:'chatgpt_web',access_mode:'read',request_key:randomUUID()}) as any).connection;
    expect(remote.mcp_url).toStartWith(saved.device!.public_origin);
    // The remote client's grant, bound to its connection resource at the old address.
    const grant='remote-grant-'+randomUUID(),remoteAgent=(db.query('SELECT agent_id FROM client_connections WHERE id=?').get(remote.id) as {agent_id:string}).agent_id;
    db.query("INSERT INTO oauth_clients(id,name,agent_id,client_secret_hash,workspace_id) VALUES (?,?,?,?,?)").run('client-'+remote.id,'ChatGPT',remoteAgent,'none',workspace);
    db.query(`INSERT INTO oauth_tokens(token_hash,client_id,agent_id,workspace_id,token_type,granted_scope,expires_at,revoked,created_at,resource)
      VALUES(?,?,?,?,'access','mcp:read','2999-01-01T00:00:00Z',0,'2000-01-01T00:00:00Z',?)`).run(sha256Hex(grant),'client-'+remote.id,remoteAgent,workspace,remote.mcp_url);
    const call=()=>authenticate(new Request('http://127.0.0.1:'+env.PORT+'/mcp/c/'+remote.id,{headers:{authorization:'Bearer '+grant}}));
    expect(call()?.connection_id).toBe(remote.id);
    expect((await act({action:'network-revoke',device_id:saved.device!.id})).code).toBe('DEVICE_REVOKED');
    expect(service.status().code).toBe('DEVICE_REVOKED');expect((await act({action:'network-enable'})).code).toBe('DEVICE_REVOKED');
    const layout=process.env.QOOPIA_STANDALONE_LAYOUT;process.env.QOOPIA_STANDALONE_LAYOUT=JSON.stringify({root,logs:path.join(root,'logs')});
    try{
      const connection=()=>(connectionAction(owner.agent_id,{action:'status',id:remote.id}) as any).connections[0];
      expect(connection().code).toBe('RECONNECT_REQUIRED');
      // Recovery: a fresh sign-in registers this installation as a new device; the revoked key stays revoked.
      expect((await act({action:'network-start',method:'email'})).code).toBe('ACCOUNT_CONFIRMATION_REQUIRED');
      const fresh=readTransport(root)!;expect(fresh.installation_id).not.toBe(saved.installation_id);expect(fresh.identity.sign).not.toEqual(saved.identity.sign);
      const again=new URL(mail.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
      expect((await handler(new Request(origin+'/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:again})}),'synthetic')).status).toBe(200);
      expect((await act({action:'network-resume'})).code).toBe('NETWORK_ONLINE');
      const recovered=readTransport(root)!;expect(recovered.device!.public_origin).not.toBe(saved.device!.public_origin);
      expect(wellKnownProtectedResource().authorization_servers).toEqual([recovered.device!.public_origin]);
      // The old remote client stays marked: its address belonged to the revoked device.
      expect(connection()).toMatchObject({state:'error',code:'RECONNECT_REQUIRED'});
      expect(browserConnectionState(owner.agent_id).apps.find(a=>a.id===remote.id)?.reconnect).toBe(true);
      // RECONNECT_REQUIRED is what the server does too: the old grant no longer reaches memory through the new tunnel.
      expect(call()).toBeNull();
    }finally{if(layout===undefined)delete process.env.QOOPIA_STANDALONE_LAYOUT;else process.env.QOOPIA_STANDALONE_LAYOUT=layout;}
  }finally{service.stop();upstream.close();env.PORT=previousPort;env.PUBLIC_URL=currentOrigin;env.OAUTH_ISSUER=currentIssuer;registry.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('an expired device lease refuses a public MCP call before local execution, including after a sleep-size clock jump',async()=>{
  let calls=0;const upstream=http.createServer((_q,r)=>{calls++;r.end('{}');});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const expires=Date.now()+120_000;
  const edge=startMcpEdge({publicOrigin:'https://fixture.example',upstreamPort:(upstream.address() as any).port,available:()=>Date.now()<expires});await once(edge,'listening');
  const call=()=>fetch('http://127.0.0.1:'+(edge.address() as any).port+'/mcp',{headers:{host:'fixture.example'},method:'POST',body:'{}'});
  try{
    expect((await call()).status).toBe(200);expect(calls).toBe(1);
    const clock=spyOn(Date,'now').mockReturnValue(expires+60_000);
    try{const response=await call();expect(response.status).toBe(503);expect((await response.json() as any).error).toBe('DEVICE_LEASE_UNAVAILABLE');expect(calls).toBe(1);}finally{clock.mockRestore();}
  }finally{edge.closeAllConnections();edge.close();upstream.closeAllConnections();upstream.close();}
});

test('pausing or stopping during an in-flight registry lease never reopens a public listener',async()=>{
  for(const operation of ['pause','stop'] as const){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-lease-race-'));
    const id=randomUUID(),workspace=randomUUID(),installation=randomUUID();
    const config={format:'qoopia-transport/1',owner_id:randomUUID(),workspace_id:workspace,installation_id:installation,
      identity:await newIdentity(),tunnel_secret:Buffer.alloc(32).toString('base64'),enabled:true,
      device:{id,installation_id:installation,workspace_id:workspace,state:'active',public_origin:'https://fixture.example'},
      tunnel:{id:randomUUID(),account:'a'.repeat(32)}} as TransportConfig;
    let resolve!:(value:'active')=>void,calls=0;
    const lease=new Promise<'active'>(r=>resolve=r);
    const supervisor=transportSupervisor({root,upstreamPort:19377,binary:'/nonexistent-fixture',config:()=>config,
      lease:()=>lease,request:fakeFetch(async()=>{calls++;return new Response('ready');})});
    try{
      const pending=supervisor.refresh();supervisor[operation]();resolve('active');await pending;
      expect(calls).toBe(0);expect(supervisor.status().state).toBe('disabled');
      expect(supervisor.status().reachable).toBe(false);expect(fs.existsSync(path.join(root,'config/tunnel/config.json'))).toBe(false);
    }finally{supervisor.stop();fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('network setup acknowledges before provider response, rejects duplicates and exposes resumable state',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-async-')),workspace=randomUUID();
  db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(workspace,'Async network fixture',workspace);
  const owner=bootstrapOwner(db,'Async network owner',undefined,workspace);
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'fixture@example.test'}));
  let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
  const transport=managedTransport(root,db,'/nonexistent-fixture',fakeFetch(async()=>{await blocked;return Response.json({id:'a'.repeat(43)});}),'https://auth.example.test');
  try{
    const start=performance.now();expect(transport.submit(owner.agent_id,{action:'network-start',method:'google'})).toEqual({accepted:true,code:'ACTION_IN_PROGRESS'});expect(performance.now()-start).toBeLessThan(100);
    expect(transport.status()).toMatchObject({operation:{state:'running'}});
    expect(()=>transport.submit(owner.agent_id,{action:'network-start',method:'google'})).toThrow('running');
    release();for(let i=0;i<100&&(transport.status() as {operation?:{state?:string}}).operation?.state==='running';i++)await Bun.sleep(10);
    expect(transport.status()).toMatchObject({operation:{state:'completed',result:{code:'ACCOUNT_CONFIRMATION_REQUIRED',open_url:'https://auth.example.test/google?request='+'a'.repeat(43)}}});
    expect(()=>JSON.stringify(transport.status())).not.toThrow();
  }finally{release();transport.stop();fs.rmSync(root,{recursive:true,force:true});}
});

// A headless server cannot open the confirmation in a browser on its own network. It shows a device code;
// the owner confirms it on a phone signed in to the account, from anywhere, and the setup resumes.
test('network-start by device code on a headless installation, and a clear refusal from an older sign-in service',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-device-')),registry=new Database(':memory:'),origin='https://auth.example.test';
  const workspace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Device fixture',workspace);
  const owner=bootstrapOwner(db,'Device owner',undefined,workspace);
  const currentOrigin=env.PUBLIC_URL,currentIssuer=env.OAUTH_ISSUER,previousPort=env.PORT;let mail='';
  const upstream=http.createServer((_q,r)=>r.end('{}'));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');env.PORT=(upstream.address() as any).port;
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const helper=path.join(root,'cloudflared-fixture');durableWrite(helper,'#!'+process.execPath+'\nsetInterval(()=>{},1000);\n',0o700);
  const handler=loginBroker(registry,{origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture',
    devices:{domain:'example.test',provider:{ensure:async()=>({id:randomUUID(),account:'a'.repeat(32)}),remove:async()=>{}}}},
    fakeFetch(async(_input,init)=>{mail=JSON.parse(String(init?.body)).text;return Response.json({id:'sent'});}));
  const network=fakeFetch(async(input,init)=>{
    if(String(input).startsWith('http://127.0.0.1:'))return new Response('ready');
    if(String(input).endsWith('/mcp'))return new Response('',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="'+new URL(String(input)).origin+'/.well-known/oauth-protected-resource"'}});
    return handler(new Request(String(input),init),'198.51.100.30');
  });
  let service=managedTransport(root,db,helper,network,origin);
  const act=(input:unknown)=>service.action(owner.agent_id,input) as Promise<any>;
  try{
    const started=await act({action:'network-start',method:'device'});
    expect(started).toMatchObject({code:'ACCOUNT_CONFIRMATION_REQUIRED',verification_uri:origin+'/device'});
    expect(started.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);expect(started.open_url).toBe(origin+'/device?code='+started.user_code);
    expect(started.next_action).toContain(started.user_code);
    // The code survives a restart of the installation and is repeated by status and resume.
    service.stop();service=managedTransport(root,db,helper,network,origin);
    expect(service.status()).toMatchObject({code:'ACCOUNT_CONFIRMATION_REQUIRED',user_code:started.user_code});
    expect(await act({action:'network-resume'})).toMatchObject({code:'ACCOUNT_CONFIRMATION_REQUIRED',user_code:started.user_code});
    // The owner's phone, on another network, signs in to the profile and approves the code.
    const jar:Record<string,string>={};
    const phone=async(route:string,body:unknown)=>{
      const r=await handler(new Request(origin+route,{method:'POST',headers:{cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),origin,'content-type':'application/json'},body:JSON.stringify(body)}),'203.0.113.60');
      for(const c of r.headers.getSetCookie()){const [k,...v]=c.split(';')[0]!.split('=');jar[k!]=v.join('=');}return r;
    };
    await phone('/profile/start',{method:'email',email:'owner@example.test'});
    await handler(new Request(origin+'/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(mail.match(/https:\/\/[^\s]+/)![0]).hash.slice(1)})}),'203.0.113.60');
    expect((await phone('/profile/poll',{})).status).toBe(200);
    expect((await phone('/profile/device/approve',{code:started.user_code})).status).toBe(200);
    const ready=await act({action:'network-resume'});expect(ready.code).toBe('NETWORK_ONLINE');
    expect(readTransport(root)!.flow).toBeUndefined();expect(readTransport(root)!.device?.workspace_id).toBe(workspace);
  }finally{service.stop();upstream.close();env.PORT=previousPort;env.PUBLIC_URL=currentOrigin;env.OAUTH_ISSUER=currentIssuer;registry.close();fs.rmSync(root,{recursive:true,force:true});}
  const legacyRoot=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-legacy-'));
  privateDirectory(path.join(legacyRoot,'config'));durableWrite(path.join(legacyRoot,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const legacy=managedTransport(legacyRoot,db,'/nonexistent-fixture',fakeFetch(async()=>Response.json({error:'Invalid sign-in request'},{status:400})),origin);
  try{expect(await legacy.action(owner.agent_id,{action:'network-start',method:'device'})).toMatchObject({state:'error',code:'DEVICE_CODE_UNSUPPORTED'});}
  finally{legacy.stop();env.PUBLIC_URL=currentOrigin;env.OAUTH_ISSUER=currentIssuer;fs.rmSync(legacyRoot,{recursive:true,force:true});}
});

// Headless: `qoopia owner-login` gives a local session but no linked account, and nothing on that server can link
// one (the dashboard needs the launcher's setup claim). A device code is confirmed by the account holder: it links it.
test('network-start by device code links the account on an installation that has none; email still needs one',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-unlinked-')),registry=new Database(':memory:'),origin='https://auth.example.test';
  const workspace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Unlinked fixture',workspace);
  const owner=bootstrapOwner(db,'Headless owner',undefined,workspace);
  const currentOrigin=env.PUBLIC_URL,currentIssuer=env.OAUTH_ISSUER,previousPort=env.PORT;let mail='';
  const upstream=http.createServer((_q,r)=>r.end('{}'));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');env.PORT=(upstream.address() as any).port;
  const helper=path.join(root,'cloudflared-fixture');durableWrite(helper,'#!'+process.execPath+'\nsetInterval(()=>{},1000);\n',0o700);
  const handler=loginBroker(registry,{origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture',
    devices:{domain:'example.test',provider:{ensure:async()=>({id:randomUUID(),account:'a'.repeat(32)}),remove:async()=>{}}}},
    fakeFetch(async(_input,init)=>{mail=JSON.parse(String(init?.body)).text;return Response.json({id:'sent'});}));
  const network=fakeFetch(async(input,init)=>{
    if(String(input).startsWith('http://127.0.0.1:'))return new Response('ready');
    if(String(input).endsWith('/mcp'))return new Response('',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="'+new URL(String(input)).origin+'/.well-known/oauth-protected-resource"'}});
    return handler(new Request(String(input),init),'198.51.100.31');
  });
  const service=managedTransport(root,db,helper,network,origin);
  const act=(input:unknown)=>service.action(owner.agent_id,input) as Promise<any>;
  try{
    expect(await act({action:'network-start',method:'email'})).toMatchObject({code:'OWNER_ACCOUNT_REQUIRED'});
    const started=await act({action:'network-start',method:'device'});
    expect(started).toMatchObject({code:'ACCOUNT_CONFIRMATION_REQUIRED'});
    const jar:Record<string,string>={};
    const phone=async(route:string,body:unknown)=>{
      const r=await handler(new Request(origin+route,{method:'POST',headers:{cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),origin,'content-type':'application/json'},body:JSON.stringify(body)}),'203.0.113.61');
      for(const c of r.headers.getSetCookie()){const [k,...v]=c.split(';')[0]!.split('=');jar[k!]=v.join('=');}return r;
    };
    await phone('/profile/start',{method:'email',email:'headless@example.test'});
    await handler(new Request(origin+'/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(mail.match(/https:\/\/[^\s]+/)![0]).hash.slice(1)})}),'203.0.113.61');
    expect((await phone('/profile/poll',{})).status).toBe(200);
    expect((await phone('/profile/device/approve',{code:started.user_code})).status).toBe(200);
    expect((await act({action:'network-resume'})).code).toBe('NETWORK_ONLINE');
    expect(JSON.parse(fs.readFileSync(path.join(root,'config/owner-identity.json'),'utf8'))).toEqual({ownerId:owner.agent_id,email:'headless@example.test'});
    expect(fs.statSync(path.join(root,'config/owner-identity.json')).mode&0o777).toBe(0o600);
  }finally{service.stop();upstream.close();env.PORT=previousPort;env.PUBLIC_URL=currentOrigin;env.OAUTH_ISSUER=currentIssuer;registry.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('a spent sign-in email allowance names the way out instead of "service unavailable"',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-limit-')),workspace=randomUUID();
  db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Limit fixture',workspace);
  const owner=bootstrapOwner(db,'Limit owner',undefined,workspace);
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const network=fakeFetch(async()=>Response.json({error:'Too many sign-in emails. Please try again later'},{status:400}));
  const current=env.PUBLIC_URL,issuer=env.OAUTH_ISSUER,service=managedTransport(root,db,path.join(root,'none'),network,'https://auth.example.test');
  try{
    const started=await service.action(owner.agent_id,{action:'network-start',method:'email'}) as any;
    expect(started.code).toBe('TOO_MANY_SIGN_INS');expect(started.next_action).toContain('Google');
  }finally{service.stop();env.PUBLIC_URL=current;env.OAUTH_ISSUER=issuer;fs.rmSync(root,{recursive:true,force:true});}
});
