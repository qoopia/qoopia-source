import {test,expect,beforeAll} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {nativeCommand} from '../src/utils/native-command.ts';
import {inventory,inventoryAsync} from '../src/delivery/files.ts';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {submitMyAgentAction,myAgentState} from '../src/services/my-agent.ts';

beforeAll(()=>runMigrations());
test('slow native probes leave the HTTP event loop responsive; timeout and failure refuse',async()=>{
  const server=Bun.serve({port:0,fetch:()=>new Response('ready')});
  const args=['-e','setTimeout(()=>process.stdout.write("fixture"),300)'];
  try{
    const before=performance.now();let oldTick=0;
    const delayed=new Promise<void>(resolve=>setTimeout(()=>{oldTick=performance.now()-before;resolve();},10));
    spawnSync(process.execPath,args,{encoding:'utf8'});await delayed;
    const start=performance.now(),probe=nativeCommand(process.execPath,args,{env:{PATH:'/usr/bin:/bin'}});
    await Bun.sleep(10);expect(await (await fetch(server.url)).text()).toBe('ready');
    const responseMs=performance.now()-start;expect(responseMs).toBeLessThan(200);
    expect((await probe).status).toBe(0);expect(oldTick).toBeGreaterThan(250);
    expect((await nativeCommand(process.execPath,args,{env:{},timeout:20})).status).not.toBe(0);
    expect((await nativeCommand('/nonexistent-qoopia-fixture',[],{env:{}})).status).not.toBe(0);
    console.log(JSON.stringify({probe_sync_block_ms:Math.round(oldTick),probe_async_http_ms:Math.round(responseMs)}));
  }finally{server.stop(true);}
});
test('streamed verification matches full inventory, detects tampering and yields while hashing',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-hash-perf-')));
  try{
    fs.writeFileSync(path.join(root,'runtime'),Buffer.alloc(64*1024*1024,65),{mode:0o700});
    const start=performance.now(),expected=inventory(root),syncMs=performance.now()-start;
    let ticks=0;const timer=setInterval(()=>ticks++,1);
    let actual;const asyncStart=performance.now();try{actual=await inventoryAsync(root);}finally{clearInterval(timer);}
    expect(actual).toEqual(expected);expect(ticks).toBeGreaterThan(2);
    fs.writeFileSync(path.join(root,'runtime'),'tampered');expect(await inventoryAsync(root)).not.toEqual(expected);
    fs.symlinkSync('/etc/hosts',path.join(root,'link'));await expect(inventoryAsync(root)).rejects.toThrow();
    console.log(JSON.stringify({inventory_64mib_sync_ms:Math.round(syncMs),inventory_async_ms:Math.round(performance.now()-asyncStart),event_loop_ticks:ticks}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('agent preparation acknowledges immediately, exposes progress, rejects duplicates and reports failure',async()=>{
  const slug='perf-'+randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Performance fixture',undefined,slug);
  const original=globalThis.fetch;let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  globalThis.fetch=(async()=>{await blocked;return new Response('fixture unavailable',{status:503});}) as typeof fetch;
  try{
    const start=performance.now();expect(submitMyAgentAction(owner.agent_id,{action:'setup',provider:'codex',acceptPermissions:true})).toEqual({accepted:true});
    expect(performance.now()-start).toBeLessThan(100);
    await Bun.sleep(15);expect(myAgentState(owner.agent_id).operation?.state).toBe('running');
    expect(()=>submitMyAgentAction(owner.agent_id,{action:'setup',provider:'codex',acceptPermissions:true})).toThrow('wait');
    release();for(let i=0;i<100&&myAgentState(owner.agent_id).operation?.state==='running';i++)await Bun.sleep(10);
    const state=myAgentState(owner.agent_id);expect(state.operation?.state).toBe('failed');expect(state.operation?.error).toContain('setup failed');expect(state.configured).toBe(false);
  }finally{release();globalThis.fetch=original;}
});

test('subscription preparation stays responsive, rejects duplicate setup and exposes failure',async()=>{
  const {submitMemorySetupAction,memorySetupState}=await import('../src/services/memory-setup.ts');
  const slug='subscription-perf-'+randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Subscription fixture',undefined,slug);
  const original=globalThis.fetch;let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
  globalThis.fetch=(async()=>{await blocked;return new Response('synthetic unavailable',{status:503});}) as typeof fetch;
  try{
    const start=performance.now();expect(submitMemorySetupAction(owner.agent_id,{action:'select',runtime:'codex'})).toEqual({accepted:true});
    expect(performance.now()-start).toBeLessThan(100);await Bun.sleep(10);
    expect(memorySetupState(owner.agent_id).busy).toBe(true);
    expect(()=>submitMemorySetupAction(owner.agent_id,{action:'select',runtime:'claude_code'})).toThrow('running');
    release();for(let i=0;i<100&&memorySetupState(owner.agent_id).busy;i++)await Bun.sleep(10);
    expect(memorySetupState(owner.agent_id).operation?.state).toBe('failed');expect(memorySetupState(owner.agent_id).busy).toBe(false);
  }finally{release();globalThis.fetch=original;}
});
