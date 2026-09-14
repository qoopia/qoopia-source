import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { exactPendingBoundary, retentionState, retentionAlert } from '../tests/helpers/p3-retention-fixtures.ts';
import { readRecoveryOps, writeOps, serializeOps, compactOps, mergeRecoveryOps, opsFile, opsSerializedSize, recordMaintenance } from '../src/delivery/ops-state.ts';
import { MAX_JSON_BYTES, durableWrite, hash } from '../src/delivery/files.ts';
const mode=process.argv[2];
if(!mode){
 const cases=['pending','compact','merge-refusal','receipts'];
 const results=[];
 for(const name of cases){
  const child=Bun.spawn([process.execPath,'scripts/p3-retention-boundary.ts',name],{stdout:'pipe',stderr:'pipe'});
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  assert.equal(exit,0,stderr);const usage=child.resourceUsage();assert(usage && usage.maxRSS>0);
  results.push({case:name,result:JSON.parse(stdout),resource_usage:{cpu_time_microseconds:{user:String(usage.cpuTime.user),system:String(usage.cpuTime.system),total:String(usage.cpuTime.total)},max_rss_bytes:usage.maxRSS},peak_rss_bytes:usage.maxRSS});
 }
 console.log(JSON.stringify({fixture_only:true,platform:`${process.platform}-${process.arch}`,bun:Bun.version,hardware:os.cpus()[0]?.model,memory_bytes:os.totalmem(),method:'Separate child per case; Bun child.resourceUsage().maxRSS (bytes per installed bun-types runtime/child-process docs) includes fixture construction, parsing, validation, operation and cleanup. Timers exclude fixture generation. External /usr/bin/time -l cross-check requires Leo: sandbox denies sysctl kern.clockrate. No extrapolation or production budget claim.',results},null,2));
}else{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'p3-retention-boundary-')));
 const metrics:Record<string,number>={};
 const timed=<T>(name:string,action:()=>T)=>{const start=performance.now();const result=action();metrics[name]=performance.now()-start;return result;};
 try{
  if(mode==='receipts'){
   const sample=compactOps(retentionState([retentionAlert(1,true)])).receipts![0]!;
   const state={...retentionState(Array.from({length:50},(_,i)=>retentionAlert(1000000+i))),receipts:[] as typeof sample[]};
   const count=Math.floor((MAX_JSON_BYTES-opsSerializedSize(state)+1)/(Buffer.byteLength(JSON.stringify(sample))+1));
   state.receipts=Array.from({length:count},(_,i)=>compactOps(retentionState([retentionAlert(i+1,true)])).receipts![0]!);
   let remain=MAX_JSON_BYTES-opsSerializedSize(state);
   for(const a of state.alerts){const growth=Math.min(remain,15);a.attempts=10**growth;remain-=growth;if(!remain)break;}
   assert.equal(remain,0);assert.equal(opsSerializedSize(state),MAX_JSON_BYTES);
   durableWrite(opsFile(root),JSON.stringify(state));
   const read=timed('read_validate_ms',()=>readRecoveryOps(root,'scopeb-fixture'));
   timed('rewrite_ms',()=>writeOps(root,read));assert.equal(fs.statSync(opsFile(root)).size,MAX_JSON_BYTES);
   const before=hash(fs.readFileSync(opsFile(root)));
   const overflow={...read,receipts:[...read.receipts!,compactOps(retentionState([retentionAlert(2000000,true)])).receipts![0]!]};
   timed('receipt_overflow_refusal_ms',()=>assert.throws(()=>writeOps(root,overflow),/TOO_LARGE/));assert.equal(hash(fs.readFileSync(opsFile(root))),before);
   console.log(JSON.stringify({mode,input_bytes:MAX_JSON_BYTES,receipts:count,pending:50,output_bytes:MAX_JSON_BYTES,metrics}));
  }else{
   const state=exactPendingBoundary(0,mode==='compact');durableWrite(opsFile(root),JSON.stringify(state));
   const inputHash=hash(fs.readFileSync(opsFile(root)));
   if(mode==='pending'){
    const read=timed('read_validate_ms',()=>readRecoveryOps(root,'scopeb-fixture'));
    timed('rewrite_ms',()=>writeOps(root,read));assert.equal(fs.statSync(opsFile(root)).size,MAX_JSON_BYTES);
    const overflow={...read,alerts:[...read.alerts,retentionAlert(999999)]};
    timed('overflow_refusal_ms',()=>assert.throws(()=>writeOps(root,overflow),/TOO_LARGE/));assert.equal(hash(fs.readFileSync(opsFile(root))),inputHash);
   }else if(mode==='compact'){
    timed('maintenance_compaction_ms',()=>recordMaintenance(root,'scopeb-fixture','BACKUP_FAILED',1000));
    const compact=readRecoveryOps(root,'scopeb-fixture');assert.equal(compact.receipts?.length,state.alerts.length);assert.equal(compact.alerts.length,1);
    // Old pending backup can be restored without replaying any of these receipts.
    const saved=retentionState(state.alerts.map(a=>({...a,state:'pending' as const,receipt:null,last_error:'NO_CHANNEL'})));
    const merged=timed('old_pending_receipt_merge_ms',()=>mergeRecoveryOps(saved,compact,'scopeb-fixture'));
    assert.equal(merged.receipts?.length,state.alerts.length);assert.equal(merged.alerts.length,1);timed('merged_write_ms',()=>writeOps(root,merged));
   }else if(mode==='merge-refusal'){
    const other=exactPendingBoundary(1000000);
    timed('two_boundary_union_refusal_ms',()=>assert.throws(()=>mergeRecoveryOps(state,other,'scopeb-fixture'),/TOO_LARGE/));
    assert.equal(hash(fs.readFileSync(opsFile(root))),inputHash);assert.equal(Buffer.byteLength(serializeOps(other)),MAX_JSON_BYTES);
   }else throw new Error('Unknown case');
   console.log(JSON.stringify({mode,input_bytes:MAX_JSON_BYTES,events:state.alerts.length,output_bytes:fs.statSync(opsFile(root)).size,input_sha256:inputHash,metrics}));
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
