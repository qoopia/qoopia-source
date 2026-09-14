import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {loginBroker} from '../src/identity/broker.ts';
import {newIdentity,peerId,secret,signRPC} from '../src/bridges/protocol.ts';

test('device enrollment crosses the loopback HTTP proxy while retaining the public HTTPS audience',async()=>{
  const db=new Database(':memory:'),origin='https://auth.example.test',keys=await newIdentity();
  let confirmation='',provisioned=0;
  const broker=loginBroker(db,{origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture',
    devices:{domain:'example.test',provider:{ensure:async()=>{provisioned++;return {id:randomUUID(),account:'a'.repeat(32)};},remove:async()=>{}}}},
    (async(_url,init)=>{confirmation=JSON.parse(String(init?.body)).text;return Response.json({id:'fixture'});}) as typeof fetch);
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>broker(req,'proxy-fixture')});
  const post=async(route:string,body:unknown,headers:Record<string,string>={})=>{
    const response=await fetch(`http://127.0.0.1:${server.port}${route}`,{method:'POST',headers:{host:new URL(origin).host,'content-type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json() as any};
  };
  try{
    const verifier=secret(),challenge=createHash('sha256').update(verifier).digest('hex');
    const start=await post('/requests',{method:'email',email:'owner@example.test',challenge,device_peer:peerId(keys)});
    expect(start.status).toBe(201);
    const token=new URL(confirmation.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    expect((await post('/confirm',{token},{origin})).status).toBe(200);
    const redeemed=await post('/redeem',{id:start.data.id,verifier});
    expect(redeemed.status).toBe(200);
    const enrollment=await signRPC(keys,origin+'/devices','enroll',{grant:redeemed.data.device_grant,installation_id:randomUUID(),workspace_id:'isolated-proxy',label:'Proxy test',tunnel_secret:randomBytes(32).toString('base64')});
    expect((await post('/devices',enrollment,{host:'foreign.example.test','x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'https'})).status).toBe(403);
    expect((await post('/devices',enrollment,{origin:'https://foreign.example.test'})).status).toBe(403);
    expect((await post('/devices?unexpected=1',enrollment)).status).toBe(404);
    const result=await post('/devices',enrollment);
    expect(result.status).toBe(200);
    expect(result.data.device.state).toBe('active');
    expect(provisioned).toBe(1);
    expect((await post('/devices',enrollment)).status).toBe(409);
    expect((await post('/devices',await signRPC(keys,origin.replace('https:','http:')+'/devices','status',{}))).status).toBe(401);
    expect((await post('/devices',await signRPC(keys,origin+'/devices','status',{}))).status).toBe(200);
  }finally{await server.stop(true);db.close();}
});
