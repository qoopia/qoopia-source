import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {deviceRegistry,type TunnelProvider} from '../src/identity/device-registry.ts';
import {cloudflareTunnels} from '../src/identity/cloudflare.ts';
import {loginBroker} from '../src/identity/broker.ts';
import {newIdentity,peerId,secret,signRPC} from '../src/bridges/protocol.ts';

test('device enrollment binds confirmed account, installation key and workspace; retries, quota and revoke remain isolated',async()=>{
  const db=new Database(':memory:'),origin='https://auth.example.test',aud=origin+'/devices';
  const assigned=new Map<string,{id:string;account:string}>(),deleted:string[]=[];
  let unavailable=false,cleanupUnavailable=false;
  const provider:TunnelProvider={ensure:async(device)=>{
    if(!assigned.has(device))assigned.set(device,{id:randomUUID(),account:'a'.repeat(32)});
    if(unavailable)throw new Error('secret provider response should never escape');return assigned.get(device)!;
  },remove:async(device)=>{if(cleanupUnavailable)throw new Error('offline');deleted.push(device);}};
  let registry=deviceRegistry(db,origin,{domain:'example.test',provider,maxDevices:3,maxPerAccount:2});
  const one=await newIdentity(),two=await newIdentity(),stranger=await newIdentity();
  const send=async(keys:typeof one,op:string,body:Record<string,unknown>)=>{
    const envelope=await signRPC(keys,aud,op,body);
    const response=await registry.handler(new Request(aud,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope)}));
    return {response,data:await response.json() as any,envelope};
  };
  const grant=registry.issueGrant({email:'one@example.test'},peerId(one));
  const input={grant,installation_id:randomUUID(),workspace_id:'workspace-one',label:'Mac',tunnel_secret:randomBytes(32).toString('base64')};
  expect((await send(stranger,'enroll',input)).response.status).toBe(401);
  unavailable=true;expect((await send(one,'enroll',input)).data).toEqual({code:'DEVICE_SERVICE_UNAVAILABLE'});
  expect(assigned.size).toBe(1);unavailable=false;
  // A process restart can resume the existing reservation without a second route.
  registry=deviceRegistry(db,origin,{domain:'example.test',provider,maxDevices:3,maxPerAccount:2});
  const enrolled=await send(one,'enroll',input);expect(enrolled.response.status).toBe(200);expect(assigned.size).toBe(1);
  const first=enrolled.data.device.id;
  expect(JSON.stringify(enrolled.data)).not.toContain(input.tunnel_secret);expect(JSON.stringify(enrolled.data)).not.toContain('one@example');
  expect((await send(one,'enroll',{...input,tunnel_secret:randomBytes(32).toString('base64')})).data.code).toBe('DEVICE_IDENTITY_CONFLICT');
  expect((await send(one,'enroll',{...input,workspace_id:'changed'})).data.code).toBe('DEVICE_IDENTITY_CONFLICT');
  expect((await registry.handler(new Request(aud,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(enrolled.envelope)}))).status).toBe(409);
  const wrong=await signRPC(one,origin+'/bridge','status',{});
  expect((await registry.handler(new Request(aud,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(wrong)}))).status).toBe(401);
  const sameAccount=registry.issueGrant({email:'one@example.test'},peerId(two));
  const second=await send(two,'enroll',{...input,grant:sameAccount,installation_id:randomUUID(),label:'Linux',workspace_id:'workspace-two'});
  expect(second.response.status).toBe(200);expect(second.data.device.id).not.toBe(first);
  const secondId=second.data.device.id;
  expect((await send(two,'list',{})).data.devices).toHaveLength(2);
  const thirdKey=await newIdentity(),quotaGrant=registry.issueGrant({email:'one@example.test'},peerId(thirdKey));
  expect((await send(thirdKey,'enroll',{...input,grant:quotaGrant,installation_id:randomUUID()})).data.code).toBe('DEVICE_LIMIT_REACHED');
  const foreign=registry.issueGrant({email:'stranger@example.test'},peerId(stranger));
  const other=await send(stranger,'enroll',{...input,grant:foreign,installation_id:randomUUID()});expect(other.response.status).toBe(200);
  expect((await send(stranger,'list',{})).data.devices).toHaveLength(1);
  expect((await send(stranger,'revoke',{device_id:first})).response.status).toBe(404);
  cleanupUnavailable=true;
  const revoke=await send(one,'revoke',{device_id:secondId});expect(revoke.response.status).toBe(202);
  expect((await send(thirdKey,'enroll',{...input,grant:quotaGrant,installation_id:randomUUID()})).data.code).toBe('DEVICE_LIMIT_REACHED');
  expect((await send(two,'status',{})).data.code).toBe('DEVICE_REVOKED');
  expect((await send(two,'enroll',{...input,grant:sameAccount,installation_id:second.data.device.installation_id,workspace_id:'workspace-two'})).data.code).toBe('SIGN_IN_REQUIRED');
  const deniedGrant=registry.issueGrant({email:'one@example.test'},peerId(two));
  expect((await send(two,'enroll',{...input,grant:deniedGrant,installation_id:second.data.device.installation_id,workspace_id:'workspace-two'})).data.code).toBe('DEVICE_REVOKED');
  expect((await send(one,'status',{})).response.status).toBe(200);
  cleanupUnavailable=false;await registry.reconcileRevocations();expect(deleted).toContain(secondId);
  expect((await send(one,'revoke',{device_id:first})).response.status).toBe(200);
  expect((await send(one,'revoke',{device_id:first})).response.status).toBe(200); // self-revoke retry may only clean itself
  expect((await send(one,'revoke',{device_id:secondId})).response.status).toBe(403);
  const serialized=JSON.stringify(db.query('SELECT * FROM connection_devices').all());
  expect(serialized).not.toContain(input.tunnel_secret);expect(serialized).not.toContain(one.signPrivate.d);db.close();
});

test('only confirmed PKCE login issues a device grant and the confirmation binds its installation key',async()=>{
  const db=new Database(':memory:'),origin='https://auth.example.test',keys=await newIdentity();let mail='';
  const handler=loginBroker(db,{origin,resendKey:'test',from:'test@example.test',googleClientId:'test',googleClientSecret:'test',
    devices:{domain:'example.test',provider:{ensure:async()=>({id:randomUUID(),account:'b'.repeat(32)}),remove:async()=>{}}}},
    (async(_url,init)=>{mail=JSON.parse(String(init?.body)).text;return Response.json({id:'test'});}) as typeof fetch);
  const post=(route:string,body:unknown)=>handler(new Request(origin+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),'test');
  const verifier=secret(),challenge=createHash('sha256').update(verifier).digest('hex');
  const start=await(await post('/requests',{method:'email',email:'owner@example.test',challenge,device_peer:peerId(keys)})).json() as any;
  expect((await post('/redeem',{id:start.id,verifier:secret()})).status).toBe(410);
  expect(await(await post('/redeem',{id:start.id,verifier})).json()).toEqual({pending:true});
  const token=new URL(mail.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
  expect((await post('/confirm',{token})).status).toBe(200);
  const redeemed=await(await post('/redeem',{id:start.id,verifier})).json() as any;
  expect(redeemed.device_grant).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(redeemed.email).toBe('owner@example.test');
  expect((await post('/redeem',{id:start.id,verifier})).status).toBe(410);
  const body={grant:redeemed.device_grant,installation_id:randomUUID(),workspace_id:'local',label:'My Mac',tunnel_secret:randomBytes(32).toString('base64')};
  expect((await post('/devices',await signRPC(await newIdentity(),origin+'/devices','enroll',body))).status).toBe(401);
  expect((await post('/devices',await signRPC(keys,origin+'/devices','enroll',body))).status).toBe(200);db.close();
});

test('Cloudflare provisioning reconciles a lost create response and refuses foreign DNS without leaking operator credentials',async()=>{
  const device=randomUUID(),tunnel=randomUUID(),account='a'.repeat(32),zone='b'.repeat(32),operator=secret();
  let exists=false,dns=false,wrong=false,createCount=0;
  const calls:{path:string;method:string}[]=[];
  const provider=cloudflareTunnels({account,zone,token:operator},(async(input,init)=>{
    const url=new URL(String(input)),method=init?.method??'GET';calls.push({path:url.pathname,method});
    if(url.hostname==='cloudflare-dns.com'){
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json({Status:0,Answer:[{name:url.searchParams.get('name'),type:1,data:'192.0.2.1'}]});
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+operator);
    let result:unknown=[];
    if(url.pathname.endsWith('/cfd_tunnel')){
      if(method==='POST'){exists=true;createCount++;throw new Error('socket closed after provider committed');}
      result=exists?[{id:tunnel,name:'qoopia-device-'+device,config_src:'local'}]:[];
    }else if(url.pathname.endsWith('/dns_records')){
      if(method==='POST'){dns=true;result={};}
      else result=dns?[{id:'c'.repeat(32),type:'CNAME',name:'c-'+device+'.example.test',content:wrong?'someone-else.example':tunnel+'.cfargotunnel.com',proxied:true}]:[];
    }else if(method==='DELETE')result={};
    else throw new Error('Unexpected route');
    return Response.json({success:true,result});
  }) as typeof fetch);
  const hostname='c-'+device+'.example.test',tunnelSecret=randomBytes(32).toString('base64');
  await expect(provider.ensure(device,hostname,tunnelSecret)).rejects.toThrow();
  expect(await provider.ensure(device,hostname,tunnelSecret)).toEqual({id:tunnel,account});expect(createCount).toBe(1);
  expect(await provider.ensure(device,hostname,tunnelSecret)).toEqual({id:tunnel,account});expect(createCount).toBe(1);
  wrong=true;await expect(provider.ensure(device,hostname,tunnelSecret)).rejects.toThrow('TUNNEL_DNS_CONFLICT');
  const before=calls.filter(c=>c.method==='DELETE').length;
  await expect(provider.remove(device,hostname,tunnel)).rejects.toThrow('TUNNEL_DNS_CONFLICT');expect(calls.filter(c=>c.method==='DELETE')).toHaveLength(before);
  wrong=false;await provider.remove(device,hostname,tunnel);
  expect(calls.slice(-3).map(c=>c.method)).toEqual(['DELETE','DELETE','DELETE']);
});
