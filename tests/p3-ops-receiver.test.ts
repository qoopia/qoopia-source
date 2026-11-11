import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { hash } from '../src/utils/fs.ts';
import { recordMaintenance, readOps } from '../src/delivery/ops-state.ts';
import { deliverOpsAlerts, readOwnerAlertChannels } from '../src/services/ops-alerts.ts';
import { deliverMemoryEvent } from '../src/services/event-outbox.ts';
import { fakeFetch } from './helpers/fake-fetch.ts';
// Actual disposable local receiver; in the first two tests a transport seam maps only this fixture host to loopback.
// Production URL/DNS policy is exercised separately, and by the third test with no seam at all.
test('local receiver verifies request then confirms fire and recurrence; transport-only 200 and failure remain pending',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p3-receiver-'));
 const key=new Uint8Array(32).fill(23),accepted=new Map<string,string>();let mode='accept';
 const server=http.createServer((req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
   const signature='sha256='+createHmac('sha256',key).update(body).digest('base64url');
   if(req.headers['x-qoopia-signature']!==signature){res.writeHead(403);res.end();return;}
   const event=JSON.parse(body);
   if(mode==='failure'){res.writeHead(503);res.end();return;}
   if(mode==='transport'){res.writeHead(200);res.end('{}');return;}
   const digest=hash(body);accepted.set(event.id,digest);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({accepted:true,event_id:event.id,payload_sha256:digest}));
  });
 });
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;
  const fetchImpl=fakeFetch(async(url,init)=>{expect(String(url)).toBe('https://receiver.example.test/alerts');return fetch(`http://127.0.0.1:${port}/alerts`,init);});
  const destination={id:'local-test',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:key};
  const transport={fetchImpl,resolver:async()=>[{address:'93.184.216.34'}]};
  recordMaintenance(root,'disposable','BACKUP_FAILED',1000);
  await deliverOpsAlerts(root,[destination],transport,1001);
  const first=readOps(root).alerts[0]!;expect(first.state).toBe('confirmed');expect(accepted.get(first.id)).toBe(first.receipt!.payload_sha256);
  recordMaintenance(root,'disposable',null,1002);recordMaintenance(root,'disposable','BACKUP_FAILED',1003);
  await deliverOpsAlerts(root,[destination],transport,1004);
  const second=readOps(root).alerts[1]!;expect(second.state).toBe('confirmed');expect(second.id).not.toBe(first.id);expect(accepted.get(second.id)).toBe(second.receipt!.payload_sha256);expect(accepted.size).toBe(2);
  recordMaintenance(root,'disposable',null,1005);recordMaintenance(root,'disposable','BACKUP_FAILED',1006);
  mode='transport';await deliverOpsAlerts(root,[destination],transport,1007);expect(readOps(root).alerts[2]!.state).toBe('pending');
  mode='failure';await deliverOpsAlerts(root,[destination,destination],transport,999999);expect(readOps(root).alerts[2]!.state).toBe('pending');expect(accepted.size).toBe(2);
 }finally{if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
},15000);

test('local receiver refusal survives resolve and restart; retry confirms the same pending event only after receipt',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p3-receiver-retry-'));let accepting=false,seen=0;
 const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  seen++;if(!accepting){res.writeHead(503);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({accepted:true,event_id:JSON.parse(body).id,payload_sha256:hash(body)}));
 });});
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;
  const destination={id:'retry-fixture',url:'https://receiver.example.test/alerts',allowed_hosts:['receiver.example.test'],signing_key:new Uint8Array(32).fill(31)};
  const fetchImpl=fakeFetch(async(url,init)=>{expect(String(url)).toBe(destination.url);return fetch(`http://127.0.0.1:${port}/alerts`,init);});
  const transport={fetchImpl,resolver:async()=>[{address:'93.184.216.34'}]};
  const id=recordMaintenance(root,'disposable','BACKUP_FAILED',1000).alerts[0]!.id;
  await deliverOpsAlerts(root,[destination,destination],transport,1001);expect(seen).toBe(2);expect(readOps(root).alerts[0]).toMatchObject({id,state:'pending',receipt:null});
  recordMaintenance(root,'disposable',null,1002);expect(readOps(root).alerts[0]!.active).toBe(false);
  accepting=true;await deliverOpsAlerts(root,[destination],transport,100000);expect(readOps(root).alerts[0]).toMatchObject({id,active:false,state:'confirmed',receipt:{event_id:id,accepted:true}});
 }finally{if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
},15000);

// OPS-07: the documented receiver is the relay on the same host (scripts/ops-alert-relay.py), plain http on loopback.
// No transport seam here: the request really goes to 127.0.0.1, and nothing else may be reached this way.
test('the owner\'s channel file may name a receiver on this host over http; every other http or private destination is refused and says so',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p3-receiver-loopback-')),key=new Uint8Array(32).fill(41),file=path.join(root,'ops-channels.json');
 let seen=0,redirect=false;
 const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  seen++;
  if(req.headers['x-qoopia-signature']!=='sha256='+createHmac('sha256',key).update(body).digest('base64url')){res.writeHead(403);res.end();return;}
  if(redirect){res.writeHead(307,{location:'/elsewhere'});res.end();return;}
  if(req.url!=='/alert'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({accepted:true,event_id:JSON.parse(body).id,payload_sha256:hash(body)}));
 });});
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port,local=`http://127.0.0.1:${port}/alert`;
  const channels=(url:string,host:string)=>{
   fs.rmSync(file,{force:true});
   fs.writeFileSync(file,JSON.stringify({format:'qoopia-alert-channels/1',channels:[{id:'relay',url,allowed_hosts:[host],signing_key_base64url:Buffer.from(key).toString('base64url')}]}),{mode:0o600});
   return readOwnerAlertChannels(file);
  };
  // A refusal is decided from the URL alone: a lookup here would be a request this test must not make.
  const transport={resolver:async()=>{throw new Error('this test resolves nothing');}};
  const id=recordMaintenance(root,'disposable','BACKUP_FAILED',1000).alerts[0]!.id;let now=1000;
  const attempt=async(destinations:Parameters<typeof deliverOpsAlerts>[1])=>{now+=86400001;await deliverOpsAlerts(root,destinations,transport,now);return readOps(root).alerts[0]!;};
  for(const [url,host] of [['http://10.0.0.5/alert','10.0.0.5'],['http://example.com/alert','example.com'],[`http://127.0.0.2:${port}/alert`,'127.0.0.2'],
   [`http://localhost:${port}/alert`,'localhost'],[`http://${'user:pass'}@127.0.0.1:${port}/alert`,'127.0.0.1'],['https://10.0.0.5/alert','10.0.0.5'],[local,'other.example.test']] as const)
   expect(await attempt(channels(url,host))).toMatchObject({id,state:'pending',receipt:null,last_error:'DESTINATION_REFUSED'});
  // The same address from anywhere but the owner's private file, or for any other event, stays refused.
  const bare={id:'not-the-owner-file',url:local,allowed_hosts:['127.0.0.1'],signing_key:key};
  expect(await attempt([bare])).toMatchObject({state:'pending',last_error:'DESTINATION_REFUSED'});
  await expect(deliverMemoryEvent({row:{id:'event-1',event_type:'memory_event',payload:'{}'},destination:channels(local,'127.0.0.1')[0]!})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(seen).toBe(0);
  // A redirect is not followed, and a receiver that does not answer with the receipt confirms nothing.
  redirect=true;expect(await attempt(channels(local,'127.0.0.1'))).toMatchObject({state:'pending',last_error:'DESTINATION_REFUSED'});expect(seen).toBe(1);
  redirect=false;expect(await attempt(channels(`http://127.0.0.1:${port}/wrong`,'127.0.0.1'))).toMatchObject({state:'pending',last_error:'ACCEPTANCE_UNCONFIRMED'});
  expect(await attempt(channels(local,'127.0.0.1'))).toMatchObject({id,state:'confirmed',last_error:null,receipt:{event_id:id,accepted:true}});
  expect(seen).toBe(3);
 }finally{if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
},15000);
