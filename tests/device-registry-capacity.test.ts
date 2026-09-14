import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';import {randomUUID,randomBytes} from 'node:crypto';
import {deviceRegistry} from '../src/identity/device-registry.ts';
import {newIdentity,peerId,signRPC} from '../src/bridges/protocol.ts';

test('900-device capacity reserves in-flight provisioning and retains failed provider cleanup before admitting a replacement',async()=>{
  const db=new Database(':memory:'),origin='https://capacity.example.test';
  let begin!:()=>void,release!:()=>void,failCleanup=true,created=0;
  const entered=new Promise<void>(r=>begin=r),gate=new Promise<void>(r=>release=r);
  const registry=deviceRegistry(db,origin,{domain:'example.test',maxDevices:900,maxPerAccount:20,provider:{
    ensure:async()=>{created++;begin();await gate;return {id:randomUUID(),account:'a'.repeat(32)};},
    remove:async()=>{if(failCleanup)throw new Error('Synthetic provider outage');},
  }});
  // Seed existing reservations; exercise actual signed requests across the upper boundary.
  const insert=db.query(`INSERT INTO connection_devices(id,account_id,peer,identity,installation_id,workspace_id,label,hostname,state,secret_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(()=>{for(let i=0;i<899;i++)insert.run(randomUUID(),'fixture-account-'+Math.floor(i/20),'fixture-peer-'+i,'{}',randomUUID(),
    'fixture-workspace-'+i,'Synthetic capacity fixture','fixture-'+i+'.example.test','active','fixture-hash',Date.now());})();
  const one=await newIdentity(),two=await newIdentity();
  const input=(keys:typeof one,email:string)=>({grant:registry.issueGrant({email},peerId(keys)),installation_id:randomUUID(),workspace_id:'fixture',label:'Capacity edge',tunnel_secret:randomBytes(32).toString('base64')});
  const first=input(one,'one@example.test'),second=input(two,'two@example.test');
  const send=async(keys:typeof one,op:string,body:Record<string,unknown>)=>{
    const response=await registry.handler(new Request(origin+'/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await signRPC(keys,origin+'/devices',op,body))}));
    return {status:response.status,data:await response.json() as any};
  };
  try{
    const pending=send(one,'enroll',first);await entered;
    expect((await send(two,'enroll',second)).data.code).toBe('DEVICE_LIMIT_REACHED');expect(created).toBe(1);
    release();const ready=await pending;expect(ready.status).toBe(200);
    expect((await send(one,'revoke',{device_id:ready.data.device.id})).data.code).toBe('REVOKED_CLEANUP_PENDING');
    expect((await send(one,'status',{})).data.code).toBe('DEVICE_REVOKED');
    expect((await send(two,'enroll',second)).data.code).toBe('DEVICE_LIMIT_REACHED');expect(created).toBe(1);
    failCleanup=false;await registry.reconcileRevocations();
    expect((await send(two,'enroll',second)).status).toBe(200);expect(created).toBe(2);
    expect((db.query("SELECT count(*) AS n FROM connection_devices WHERE state!='revoked' OR cleanup_done=0").get() as any).n).toBe(900);
  }finally{release();db.close();}
});

test('revoking during provider creation holds capacity and queues a failed late deletion',async()=>{
  const db=new Database(':memory:'),origin='https://race.example.test';
  let enter!:()=>void,release!:()=>void,created=0,removed=0,unavailable=true;
  const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const registry=deviceRegistry(db,origin,{domain:'example.test',maxDevices:2,provider:{
    ensure:async()=>{if(++created===2){enter();await gate;}return {id:randomUUID(),account:'b'.repeat(32)};},
    remove:async()=>{removed++;if(unavailable)throw new Error('Synthetic late removal outage');},
  }});
  const one=await newIdentity(),two=await newIdentity(),three=await newIdentity();
  const prepare=(keys:typeof one)=>({grant:registry.issueGrant({email:'owner@example.test'},peerId(keys)),installation_id:randomUUID(),workspace_id:'fixture',label:'Revocation race',tunnel_secret:randomBytes(32).toString('base64')});
  const send=async(keys:typeof one,op:string,body:Record<string,unknown>)=>{
    const response=await registry.handler(new Request(origin+'/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await signRPC(keys,origin+'/devices',op,body))}));
    return {status:response.status,data:await response.json() as any};
  };
  try{
    expect((await send(one,'enroll',prepare(one))).status).toBe(200);
    const pending=send(two,'enroll',prepare(two));await entered;
    const id=(db.query('SELECT id FROM connection_devices WHERE peer=?').get(peerId(two)) as {id:string}).id;
    expect((await send(one,'revoke',{device_id:id})).data.code).toBe('REVOKED_CLEANUP_PENDING');expect(removed).toBe(0);
    await registry.reconcileRevocations();expect(removed).toBe(0);
    release();expect((await pending).status).toBe(503);expect(removed).toBe(1);
    const input=prepare(three);expect((await send(three,'enroll',input)).data.code).toBe('DEVICE_LIMIT_REACHED');
    unavailable=false;await registry.reconcileRevocations();expect(removed).toBe(2);
    expect((await send(three,'enroll',input)).status).toBe(200);
    expect((await send(two,'status',{})).data.code).toBe('DEVICE_REVOKED');
  }finally{release();db.close();}
});
