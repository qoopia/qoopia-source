/** Leo's offline evaluator finalization, only for a generated disposable qualification. */
import '../tests/helpers/p2-safe-env.ts';
import '../tests/setup.ts';
import {Database} from 'bun:sqlite';
import {readFileSync,realpathSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,basename} from 'node:path';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {principalAuth} from '../tests/helpers/p1-fixtures.ts';
import {recordOutcome} from '../src/skills/runtime.ts';
import {digest} from '../src/skills/commands.ts';
const args=process.argv.slice(2),arg=(n:string)=>args[args.indexOf(n)+1];
if(!args.includes('--root')||!args.includes('--audit'))throw new Error('Required --root qoopia-p2-qualification-* --audit AUDIT_JSON');
const root=realpathSync(resolve(arg('--root')));
if(!basename(root).startsWith('qoopia-p2-qualification-'))throw new Error('Only generated disposable qualifications accepted');
const audit=z.array(z.object({run_id:z.string(),runtime:z.enum(['codex','claude_code']),outside_writes:z.enum(['none','detected','unknown']),method:z.enum(['native_sandbox_trace','os_write_trace']),trace_file:z.string(),trace_digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).parse(JSON.parse(readFileSync(arg('--audit'),'utf8')));
const results=JSON.parse(readFileSync(join(root,'results.json'),'utf8')) as {runtime:string;runs?:{run_id:string;entry_id:string;version_id:string;task_directory:string;native_execution_observed:boolean}[]}[];
const facts=[];
for(const checked of audit){
 const record=results.find(r=>r.runtime===checked.runtime)?.runs?.find(r=>r.run_id===checked.run_id);
 if(!record?.native_execution_observed)throw new Error('No native execution observation for audited run');
 const trace=readFileSync(checked.trace_file);if(!trace.length||digest(trace)!==checked.trace_digest)throw new Error('Audit trace hash mismatch');
 const task=realpathSync(record.task_directory),rel=relative(join(root,checked.runtime),task);
 if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Task escaped the disposable runtime root');
 const database=new Database(join(root,checked.runtime+'.sqlite'));database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
 try{
  const run=database.query('SELECT actor_id FROM skill_runs WHERE id=? AND version_id=?').get(record.run_id,record.version_id) as {actor_id:string}|null;if(!run)throw new Error('Run linkage mismatch');
  const previous=database.query('SELECT id,revision FROM skill_outcomes WHERE run_id=? AND actor_id=? ORDER BY revision DESC LIMIT 1').get(record.run_id,run.actor_id) as {id:string;revision:number}|null;
  const observation=database.query("SELECT id FROM runtime_observations WHERE run_id=? AND kind='observed_execution' ORDER BY event_seq DESC LIMIT 1").get(record.run_id) as {id:string};
  const artifacts:Record<string,string>={};for(const name of ['summary.json','refusal.json','invalid-summary.json']){
   try{const path=join(task,name),st=lstatSync(path);if(!st.isFile()||st.nlink!==1||st.isSymbolicLink()||st.size>100000)throw new Error('Unsafe artifact');artifacts[name]=readFileSync(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  const outcome=recordOutcome(principalAuth(database,run.actor_id),{run_id:record.run_id,version_id:record.version_id,evidence_class:'verified_outcome',outside_writes:checked.outside_writes,artifacts,execution_observation_id:observation.id,expected_revision:previous?.revision??0,...(previous?{supersedes_id:previous.id}:{}),idempotency_key:randomUUID()},database);
  facts.push({run_id:record.run_id,audit_method:checked.method,audit_trace_digest:checked.trace_digest,outcome:outcome.data});
 }finally{database.close();}
}
writeFileSync(join(root,'audited-outcomes.json'),JSON.stringify(facts,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(facts,null,2));
if(!facts.length||facts.some(f=>f.outcome.status!=='succeeded'))process.exitCode=2;
