import {z} from 'zod';
import path from 'node:path';
import os from 'node:os';
import {readJson,preflightSpace} from './files.ts';
const bytes=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const bootstrapMeasurementSchema=z.object({
 format:z.literal('qoopia-bootstrap-measurement/1'),target:z.enum(['darwin-arm64','linux-x64']),
 os_release:z.string().min(1),initial_database_bytes:bytes.positive(),bootstrap_peak_rss_bytes:bytes.positive(),
}).strict();
export type BootstrapMeasurement=z.infer<typeof bootstrapMeasurementSchema>;
const hostSchema=z.object({target:z.string(),os_release:z.string(),total_memory_bytes:bytes,available_disk_bytes:bytes}).strict();
/** Call only after verifyBundle: the observation must belong to its signed inventory. */
export function inspectInstallationRequirements(verified:{root:string;manifest:{members:Record<string,{size:number}>}},destination:string){
 const member='BOOTSTRAP-MEASUREMENT.json';
 if(!verified.manifest.members[member])return {ok:true,blockers:[] as string[],qualification:'not_recorded',full_workload_qualification:'unknown',minimum_ram_bytes:null,minimum_os_release:null};
 const observation=readJson(path.join(verified.root,member));
 const extent=Object.values(verified.manifest.members).reduce((sum,member)=>sum+member.size,0);
 const space=preflightSpace(destination,[]);
 return installationRequirements(extent,observation,{target:`${process.platform}-${process.arch}`,os_release:os.release(),
  total_memory_bytes:os.totalmem(),available_disk_bytes:space.available_bytes});
}
/** Read-only planning. A bootstrap observation is NOT a qualified full-workload minimum. */
export function installationRequirements(bundleBytes:number,observation:unknown,host: z.infer<typeof hostSchema>){
 const size=bytes.parse(bundleBytes),sample=bootstrapMeasurementSchema.parse(observation),machine=hostSchema.parse(host);
 // Two bundle copies (installed and one update); live DB, one backup and one staging DB.
 // This is available-space planning, not a reservation or a cap on user data growth.
 const required=bytes.parse(size*2+sample.initial_database_bytes*3);
 const blockers:string[]=[];
 if(machine.target!==sample.target)blockers.push('UNSUPPORTED_BUNDLE_TARGET');
 if(machine.available_disk_bytes<required)blockers.push('INSUFFICIENT_DISK');
 if(machine.total_memory_bytes<sample.bootstrap_peak_rss_bytes)blockers.push('BELOW_OBSERVED_BOOTSTRAP_MEMORY');
 return {format:'qoopia-install-requirements/1',ok:blockers.length===0,blockers,target:sample.target,
  host:machine,required_disk_bytes:required,bundle_bytes:size,initial_database_bytes:sample.initial_database_bytes,
  bootstrap_peak_rss_bytes:sample.bootstrap_peak_rss_bytes,measured_os_release:sample.os_release,
  minimum_ram_bytes:null,minimum_os_release:null,qualification:'bootstrap_only_not_full_agent_workload',full_workload_qualification:'unknown',
  internet:'required_for_cloud_model_not_local_memory',
  runtime:'separately_installed_and_authenticated_claude_code_or_codex',
  storage_warning:'User files, retained generations, backups and native runtime require additional space; a backup on this disk cannot protect against disk loss.',
 };
}
