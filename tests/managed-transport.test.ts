import {test,expect,spyOn} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {Database} from 'bun:sqlite';import {randomUUID} from 'node:crypto';
import {managedTransport} from '../src/delivery/managed-transport.ts';
import {readTransport} from '../src/delivery/transport-config.ts';
import {loginBroker} from '../src/identity/broker.ts';
import {db} from '../src/db/connection.ts';import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';import {env} from '../src/utils/env.ts';
import {durableWrite,privateDirectory} from '../src/delivery/files.ts';
import {startMcpEdge} from '../src/delivery/mcp-edge.ts';
import http from 'node:http';import {once} from 'node:events';
import {transportSupervisor} from '../src/delivery/transport-supervisor.ts';
import type {TransportConfig} from '../src/delivery/transport-config.ts';
import {newIdentity} from '../src/bridges/protocol.ts';

test('managed wizard resumes email confirmation after restart, saves only private scoped credentials and keeps workspace owners isolated',async()=>{
  runMigrations();const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-managed-')),registry=new Database(':memory:'),origin='https://auth.example.test';
  const workspace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Managed fixture',workspace);
  const owner=bootstrapOwner(db,'Managed owner',undefined,workspace);
  const foreignSpace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(foreignSpace,'Foreign fixture',foreignSpace);
  const foreign=bootstrapOwner(db,'Foreign owner',undefined,foreignSpace);
  let mail='',offline=false;const currentOrigin=env.PUBLIC_URL,previousPort=env.PORT;
  const upstream=http.createServer((_q,r)=>r.end('{}'));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');env.PORT=(upstream.address() as any).port;
  privateDirectory(path.join(root,'config'));durableWrite(path.join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}));
  const helper=path.join(root,'cloudflared-fixture');
  durableWrite(helper,'#!'+process.execPath+'\nsetInterval(()=>{},1000);\n',0o700);
  const handler=loginBroker(registry,{origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture',
    devices:{domain:'example.test',provider:{ensure:async()=>({id:randomUUID(),account:'a'.repeat(32)}),remove:async()=>{}}}},
    (async(_input,init)=>{mail=JSON.parse(String(init?.body)).text;return Response.json({id:'sent'});}) as typeof fetch);
  const network=(async(input,init)=>{
    if(String(input).startsWith('http://127.0.0.1:'))return new Response('ready');
    if(String(input).endsWith('/mcp'))return new Response('',{status:401,headers:{'www-authenticate':'Bearer resource_metadata="'+new URL(String(input)).origin+'/.well-known/oauth-protected-resource"'}});
    if(offline)throw new Error('network offline');
    return handler(new Request(String(input),init),'synthetic');
  }) as typeof fetch;
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
    expect((await handler(new Request(origin+'/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})}),'browser')).status).toBe(200);
    const ready=await act({action:'network-resume'});expect(ready.code).toBe('NETWORK_ONLINE');
    const saved=readTransport(root)!;expect(saved.installation_id).toBe(initial.installation_id);expect(saved.identity).toEqual(initial.identity);
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
    expect((await act({action:'network-enable'})).code).toBe('NETWORK_ONLINE');
    expect((await act({action:'network-revoke',device_id:saved.device!.id})).code).toBe('DEVICE_REVOKED');
    expect(service.status().code).toBe('DEVICE_REVOKED');expect((await act({action:'network-enable'})).code).toBe('DEVICE_REVOKED');
    expect((await act({action:'network-start',method:'email'})).code).toBe('DEVICE_REVOKED');
  }finally{service.stop();upstream.close();env.PORT=previousPort;env.PUBLIC_URL=currentOrigin;registry.close();fs.rmSync(root,{recursive:true,force:true});}
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
      lease:()=>lease,request:(async()=>{calls++;return new Response('ready');}) as typeof fetch});
    try{
      const pending=supervisor.refresh();supervisor[operation]();resolve('active');await pending;
      expect(calls).toBe(0);expect(supervisor.status().state).toBe('disabled');
      expect(supervisor.status().reachable).toBe(false);expect(fs.existsSync(path.join(root,'config/tunnel/config.json'))).toBe(false);
    }finally{supervisor.stop();fs.rmSync(root,{recursive:true,force:true});}
  }
});
