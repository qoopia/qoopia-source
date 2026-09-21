import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {bridgeRelay} from '../src/bridges/relay.ts';
import {BRIDGE_RELAY,newIdentity,peerId,signRPC,sealPacket,openPacket,secret,sha,publicIdentity} from '../src/bridges/protocol.ts';
import {ownerFixture} from './helpers/p1-fixtures.ts';
import {bridgeService} from '../src/bridges/service.ts';

test('Three independent peers: invite consent, scoped encrypted delivery, replay and removal',async()=>{
  const db=new Database(':memory:'),relay=bridgeRelay(db);
  try {
    const [a,b,c,stranger]=await Promise.all([newIdentity(),newIdentity(),newIdentity(),newIdentity()]);
    const call=async(keys:typeof a,op:string,body:Record<string,unknown>)=>{
      const response=await relay(new Request(BRIDGE_RELAY+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await signRPC(keys,BRIDGE_RELAY,op,body))}),'fixture');
      return {status:response.status,data:await response.json() as any};
    };
    const group=randomUUID();expect((await call(a,'create',{id:group,name:'Fixture bridge'})).status).toBe(200);
    const invitation=secret(),code='QPB1.'+invitation+'.'+peerId(a);
    expect((await call(a,'invite',{group,digest:sha(invitation),expires:Date.now()+60_000})).status).toBe(200);
    for(const who of [b,c]) {
      expect((await call(who,'join',{code,name:'Independent owner'})).data.state).toBe('pending');
      expect((await call(who,'poll',{group})).status).toBe(403);
      expect((await call(a,'admit',{group,peer:peerId(who),identity:publicIdentity.parse({sign:who.sign,encrypt:who.encrypt})})).status).toBe(200);
    }
    expect((await call(b,'state',{group})).data.members).toHaveLength(3);
    expect((await call(stranger,'poll',{group})).status).toBe(403);
    expect((await call(b,'remove',{group,peer:peerId(c)})).status).toBe(403);
    const packet={id:randomUUID(),group,from:peerId(a),to:peerId(b),created:Date.now(),kind:'material' as const,body:{text:'Synthetic selected content'}};
    const encrypted=await sealPacket(a,b,packet);
    expect(encrypted).not.toContain('Synthetic selected content');
    await expect(openPacket(c,a,encrypted)).rejects.toThrow();
    await expect(openPacket(b,c,encrypted)).rejects.toThrow();
    expect((await openPacket(b,a,encrypted)).body.text).toBe('Synthetic selected content');
    const signed=await signRPC(a,BRIDGE_RELAY,'send',{group,id:packet.id,to:peerId(b),data:encrypted});
    const request=()=>new Request(BRIDGE_RELAY+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(signed)});
    expect((await relay(request(),'fixture')).status).toBe(200);
    expect((await relay(request(),'fixture')).status).toBe(409);
    expect((await call(c,'poll',{group})).data.messages).toHaveLength(0);
    expect((await call(b,'poll',{group})).data.messages).toHaveLength(1);
    expect((await call(a,'remove',{group,peer:peerId(b)})).status).toBe(200);
    expect((await call(b,'poll',{group})).status).toBe(403);
    expect((await call(a,'send',{group,id:randomUUID(),to:peerId(b),data:encrypted})).status).toBe(403);
    expect((await call(a,'revoke-invite',{group,digest:sha(invitation)})).status).toBe(200);
    expect((await call(stranger,'join',{code,name:'Stranger'})).status).toBe(403);
  }finally{db.close();}
});

test('External folders remain local: three catalogues, exact approval, received quarantine and offline retry',async()=>{
  const relayDb=new Database(':memory:'),fixtures=[ownerFixture(39),ownerFixture(39),ownerFixture(39)];
  let online=true,relay=bridgeRelay(relayDb);
  const transport=(async (url:string|URL|Request,init?:RequestInit)=>{if(!online)throw new Error('Fixture offline');return relay(new Request(url,init),'fixture-folder');}) as typeof fetch;
  const [a,b,c]=fixtures.map(f=>({ ...f,service:bridgeService(f.database,BRIDGE_RELAY,transport)}));
  try {
    const group=randomUUID();await a!.service.create(a!.auth,{id:group,name:'Small group'});
    expect(a!.service.view(a!.auth).groups[0]?.state).toBe('active');
    const invite=await a!.service.invite(a!.auth,{id:randomUUID(),group});
    for(const f of [b!,c!]) {
      await f.service.join(f.auth,{code:invite.code,name:f===b?'B':'C'});
      a!.database.query('UPDATE bridges SET checked_at_ms=0').run();await a!.service.tick();
      await a!.service.membership(a!.auth,{group,action:'admit',peer:f.service.view(f.auth).peer_id!});await f.service.tick();
    }
    const staged={id:randomUUID(),title:'Visible title',description:'Visible short description',kind:'note' as const,filename:'example.md',mime:'text/markdown',content_base64:Buffer.from('Selected bytes; never in the catalogue').toString('base64')};
    const material=a!.service.stage(a!.auth,staged);
    a!.service.publish(a!.auth,{group,material_id:material.id,version:material.version,visible:true,auto_send:false});
    const privateId=randomUUID();a!.database.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,visibility) VALUES (?,?,?,'note','Never share this private fixture','private')").run(privateId,a!.auth.workspace_id,a!.auth.agent_id);
    const cycle=async()=>{for(let i=0;i<3;i++)for(const f of [a!,b!,c!])await f.service.tick();};
    b!.service.refresh(b!.auth,{group});await cycle();
    const view=b!.service.view(b!.auth),cat=view.catalogues.find(v=>v.peer_id===a!.service.view(a!.auth).peer_id);
    expect(cat?.items).toEqual([{id:material.id,version:material.version,title:staged.title,description:staged.description}]);
    expect(JSON.stringify(view)).not.toContain('Selected bytes');expect(JSON.stringify(view)).not.toContain('Never share this');
    const peer=a!.service.view(a!.auth).peer_id!;
    expect(()=>b!.service.requestMaterial(b!.auth,{id:randomUUID(),group,peer,material_id:privateId,version:material.version})).toThrow();
    expect(()=>b!.service.getMaterial(b!.auth,material.id)).toThrow();
    const requestId=randomUUID();b!.service.requestMaterial(b!.auth,{id:requestId,group,peer,material_id:material.id,version:material.version});await cycle();
    expect(a!.service.view(a!.auth).requests.find((r:any)=>r.id===requestId)).toMatchObject({state:'requested'});
    expect(b!.service.view(b!.auth).materials).toHaveLength(0);
    expect(()=>a!.service.decide(a!.auth,{id:requestId,version:sha('changed'),approve:true})).toThrow();
    online=false;a!.service.decide(a!.auth,{id:requestId,version:material.version,approve:true});await a!.service.tick();
    expect(b!.service.view(b!.auth).materials).toHaveLength(0);
    online=true;await a!.service.tick();
    // Lose the volatile relay buffer and recreate both service objects. The
    // durable local outbox and request are sufficient to recover the receipt.
    relay=bridgeRelay(relayDb);a!.service=bridgeService(a!.database,BRIDGE_RELAY,transport);b!.service=bridgeService(b!.database,BRIDGE_RELAY,transport);
    a!.database.query('UPDATE bridge_outbox SET attempted_at_ms=0').run();await cycle();
    const received=b!.service.view(b!.auth).materials as any[];
    expect(received).toHaveLength(1);expect(received[0].direction).toBe('received');
    expect(b!.service.getMaterial(b!.auth,received[0].id).content_base64).toBe(staged.content_base64);
    expect(c!.service.view(c!.auth).materials).toHaveLength(0);
    expect(()=>b!.service.publish(b!.auth,{group,material_id:received[0].id,version:material.version,visible:true,auto_send:true})).toThrow();
    expect(b!.database.query('SELECT count(*) n FROM notes').get()).toEqual({n:0});
    b!.service.requestMaterial(b!.auth,{id:requestId,group,peer,material_id:material.id,version:material.version});await cycle();
    expect(b!.service.view(b!.auth).materials).toHaveLength(1);
    c!.service.refresh(c!.auth,{group});await cycle();
    expect(c!.service.view(c!.auth).catalogues.find(c=>c.peer_id===b!.service.view(b!.auth).peer_id)?.items).toEqual([]);
    const skipped=randomUUID();c!.service.requestMaterial(c!.auth,{id:skipped,group,peer,material_id:material.id,version:material.version});await cycle();
    a!.service.decide(a!.auth,{id:skipped,version:material.version,approve:false});await cycle();
    expect(c!.service.view(c!.auth).requests.find((r:any)=>r.id===skipped)).toMatchObject({state:'skipped'});
    expect(c!.service.view(c!.auth).materials).toHaveLength(0);
    a!.service.publish(a!.auth,{group,material_id:material.id,version:material.version,visible:true,auto_send:true});
    c!.service.requestMaterial(c!.auth,{id:randomUUID(),group,peer,material_id:material.id,version:material.version});await cycle();
    expect(c!.service.view(c!.auth).materials).toHaveLength(1);
    online=false;
    await a!.service.membership(a!.auth,{group,action:'remove',peer:b!.service.view(b!.auth).peer_id!});
    expect(a!.service.view(a!.auth).pending_controls).toHaveLength(1);
    expect(()=>a!.service.refresh(a!.auth,{group,peer:b!.service.view(b!.auth).peer_id!})).toThrow();
    online=true;await a!.service.tick();expect(a!.service.view(a!.auth).pending_controls).toHaveLength(0);
    b!.database.query('UPDATE bridges SET checked_at_ms=0').run();await b!.service.tick();
    expect(b!.service.view(b!.auth).groups[0]?.state).toBe('removed');expect(b!.service.view(b!.auth).catalogues).toHaveLength(0);
    expect(b!.service.view(b!.auth).materials).toHaveLength(1);
    for(const f of fixtures)expect(f.database.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{fixtures.forEach(f=>f.database.close());relayDb.close();}
});

test('the public invite page allows its one script by hash and nothing inline beyond it',async()=>{
  const page=await bridgeRelay(new Database(':memory:'))(new Request(BRIDGE_RELAY+'/invite'),'fixture');
  const csp=page.headers.get('content-security-policy')!,html=await page.text();
  expect(csp).not.toContain("script-src 'unsafe-inline'");
  const script=/<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  expect(csp).toContain("script-src 'sha256-"+new Bun.CryptoHasher('sha256').update(script).digest('base64')+"'");
  expect(script).toContain('navigator.clipboard.writeText');expect(html.match(/<script/g)).toHaveLength(1);
});
