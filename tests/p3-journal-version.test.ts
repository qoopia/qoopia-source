import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOps, readRecoveryOps, writeOps, validateRecoveryOps, opsFile, opsSummary, recordMaintenance, RECOVERY_DELIVERY_HOLD, OPS_JOURNAL_FORMAT, type OpsState } from '../src/delivery/ops-state.ts';
import { backupOperations } from '../src/delivery/snapshot.ts';
import { durableWrite, hash } from '../src/delivery/files.ts';
import { deliverOpsAlerts } from '../src/services/ops-alerts.ts';

const fixture=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-journal-version-')));
const manifest=(bytes:string)=>({format:'qoopia-backup/2',instance:'fixture',operations:{size:Buffer.byteLength(bytes),sha256:hash(bytes)}} as Parameters<typeof backupOperations>[1]);

test('legacy /1, pre-D1 /1+hold and current /3 read without rewriting and write explicit /3 without losing hold',async()=>{
 for(const format of ['qoopia-ops/1','qoopia-ops/2',OPS_JOURNAL_FORMAT] as const)for(const held of [false,true]){
  const root=fixture();try{
   const state:OpsState={format,last_run:null,alerts:[],...(held?{delivery_hold:RECOVERY_DELIVERY_HOLD}:{})};
   const bytes=JSON.stringify(state,null,2)+'\n';durableWrite(opsFile(root),bytes);
   const parsed=readRecoveryOps(root,'fixture');expect(parsed).toEqual({...state,format:OPS_JOURNAL_FORMAT});
   expect(backupOperations(root,manifest(bytes))).toEqual(parsed);expect(fs.readFileSync(opsFile(root),'utf8')).toBe(bytes);
   writeOps(root,state);expect(JSON.parse(fs.readFileSync(opsFile(root),'utf8'))).toEqual(parsed);
   if(held){
    recordMaintenance(root,'fixture','BACKUP_FAILED',1000);let sends=0,resolves=0;
    await deliverOpsAlerts(root,[],{fetchImpl:(async()=>{sends++;throw new Error('no network');}) as typeof fetch,resolver:async()=>{resolves++;return []; }},2000);
    expect(readOps(root).delivery_hold).toBe(RECOVERY_DELIVERY_HOLD);expect(readOps(root).alerts[0]!.attempts).toBe(0);expect(sends+resolves).toBe(0);
   }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('unknown envelope versions precede schema validation across readers, writers, backup and transport',async()=>{
 for(const format of ['qoopia-ops/0','qoopia-ops/4','qoopia-ops/999','other-format',3,null]){
  const root=fixture();try{
   const value={format,delivery_hold:'future policy',alerts:'unrecognized body'},bytes=JSON.stringify(value,null,2);
   durableWrite(opsFile(root),bytes);
   for(const call of [()=>readOps(root),()=>validateRecoveryOps(value,'fixture'),()=>writeOps(root,value as unknown as OpsState),()=>backupOperations(root,manifest(bytes)),()=>recordMaintenance(root,'fixture','BACKUP_FAILED')])expect(call).toThrow('OPS_JOURNAL_UNSUPPORTED_VERSION');
   expect(opsSummary(root,'fixture').error).toBe('OPS_JOURNAL_UNSUPPORTED_VERSION');
   await expect(deliverOpsAlerts(root,[],{},2000)).rejects.toThrow('OPS_JOURNAL_UNSUPPORTED_VERSION');
   expect(fs.readFileSync(opsFile(root),'utf8')).toBe(bytes);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('malformed JSON and malformed supported schemas retain INVALID classification',()=>{
 const root=fixture();try{
  for(const value of ['{broken','{}',JSON.stringify({format:OPS_JOURNAL_FORMAT,alerts:'bad'}),JSON.stringify({format:'qoopia-ops/1',last_run:null,alerts:[],delivery_hold:'unknown hold'})]){
   durableWrite(opsFile(root),value);expect(()=>readOps(root)).toThrow('OPS_JOURNAL_INVALID');expect(fs.readFileSync(opsFile(root),'utf8')).toBe(value);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
