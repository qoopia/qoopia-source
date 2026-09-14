import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { db, DB_PATH } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createWorkspace } from '../src/admin/workspaces.ts';
import { createAgent } from '../src/admin/agents.ts';
import { startHttpServer } from '../src/http.ts';
import { recordStorageWriteFailure, resetStorageDegradationForTests, storageDegradation } from '../src/utils/storage-degradation.ts';

let server:Server,base='',key='';
function parseMcp(text:string){try{return JSON.parse(text);}catch{}for(const line of text.split('\n').reverse())if(line.startsWith('data:'))try{return JSON.parse(line.slice(5).trim());}catch{}throw new Error('invalid MCP response');}
async function call(name:string,args:Record<string,unknown>){const response=await fetch(`${base}/mcp`,{method:'POST',headers:{authorization:`Bearer ${key}`,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});const rpc=parseMcp(await response.text()),text=rpc.result?.content?.find((x:any)=>x.type==='text')?.text;return {isError:rpc.result?.isError===true,text,value:typeof text==='string'&&!rpc.result?.isError?JSON.parse(text):undefined};}
beforeAll(async()=>{runMigrations();const ws=createWorkspace({name:'T27 SQLITE FULL',slug:'t27-sqlite-full'}),agent=createAgent({name:'t27-writer',workspaceSlug:ws.slug});key=agent.api_key;server=startHttpServer();await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
afterEach(()=>{db.exec('PRAGMA max_page_count=1073741823');resetStorageDegradationForTests();});

test('T27 does not degrade from spoofed SQLITE_FULL text or code',()=>{
 const textSpoof=new Error('database or disk is full');textSpoof.name='SQLiteError';
 expect(recordStorageWriteFailure(textSpoof)).toBe(false);
 expect(recordStorageWriteFailure({code:'SQLITE_FULL',message:'database or disk is full'})).toBe(false);
 expect(storageDegradation().degraded).toBe(false);
});

// The fault mutates SQLite's page limit and the process-wide write latch.
// CI must run `bun run test:storage-full` in its own process/database after
// the ordinary suite; its deliberate skip there is not a qualification.
const sqliteFullTest=process.env.QOOPIA_T27_SQLITE_FULL==='true'?test:test.skip;
sqliteFullTest('T27 SQLITE_FULL preserves committed data, degrades readiness, blocks later writes and keeps reads',async()=>{
 const baselineText='T27 baseline '+randomUUID(),baseline=await call('note_create',{type:'memory',text:baselineText});expect(baseline.isError).toBe(false);const baselineId=baseline.value.id;
 db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const pageSize=(db.query('PRAGMA page_size').get() as {page_size:number}).page_size,pageCount=(db.query('PRAGMA page_count').get() as {page_count:number}).page_count,maxPages=pageCount+256;db.exec(`PRAGMA max_page_count=${maxPages}`);expect(maxPages*pageSize).toBeLessThan(32*1024*1024);
 const secretMarker='must-not-log-'+randomUUID(),logged:string[]=[];const originalError=console.error;console.error=(...args:unknown[])=>logged.push(args.map(String).join(' '));
 let failure:any,beforeFailure=0,attempts=0;try{for(;attempts<32;attempts++){beforeFailure=(db.query('SELECT count(*) n FROM notes').get() as {n:number}).n;const result=await call('note_create',{type:'memory',text:`${secretMarker} t27fill${attempts} `+'x'.repeat(99_900)});if(result.isError){failure=result;break;}}}finally{console.error=originalError;}
 const afterFailure=(db.query('SELECT count(*) n FROM notes').get() as {n:number}).n;
 expect(failure).toBeDefined();expect(failure.text).toContain('STORAGE_FULL');expect(afterFailure).toBe(beforeFailure);expect((db.query('SELECT text FROM notes WHERE id=?').get(baselineId) as {text:string}).text).toBe(baselineText);expect((db.query('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check).toBe('ok');expect(fs.statSync(DB_PATH).size).toBeLessThan(32*1024*1024);
 expect(logged.join('\n')).not.toContain(secretMarker);expect(logged.join('\n')).not.toContain(key);
 const read=await call('note_get',{id:baselineId});expect(read.isError).toBe(false);expect(read.value.text).toBe(baselineText);
 const healthResponse=await fetch(`${base}/health`),health=await healthResponse.json();expect(healthResponse.status).toBe(200);expect(health).toMatchObject({status:'degraded',writes_enabled:false,checks:{storage:'degraded'}});
 const readyResponse=await fetch(`${base}/ready`),ready=await readyResponse.json();expect(readyResponse.status).toBe(503);expect(ready).toMatchObject({status:'not_ready',writes_enabled:false,checks:{storage:'degraded'}});
 const after=await call('note_create',{type:'memory',text:'must refuse after storage degradation'});expect(after.isError).toBe(true);expect(after.text).toContain('READ_ONLY_INSTANCE');expect((db.query('SELECT count(*) n FROM notes').get() as {n:number}).n).toBe(beforeFailure);
 console.log(JSON.stringify({status:'PASS_SOURCE_T27_SQLITE_FULL',sqlite_code:'SQLITE_FULL',sqlite_primary_result_code:13,sqlite_message:'database or disk is full',page_size:pageSize,page_count_before_limit:pageCount,max_page_count:maxPages,max_bytes:maxPages*pageSize,attempts_until_full:attempts+1,file_bytes:fs.statSync(DB_PATH).size,count_before_failed_write:beforeFailure,count_after_failed_write:afterFailure,baseline_text_sha256:createHash('sha256').update(baselineText).digest('hex'),atomic_prior_data:true,integrity_check:'ok',read_after_full:true,health_status:health.status,health_writes_enabled:health.writes_enabled,ready_http:readyResponse.status,ready_storage:ready.checks.storage,second_write_refused:true}));
});
