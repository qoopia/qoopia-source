import {z} from 'zod';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {readJson,preflightSpace} from '../utils/fs.ts';
const bytes=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const bootstrapMeasurementSchema=z.object({
 format:z.literal('qoopia-bootstrap-measurement/1'),target:z.enum(['darwin-arm64','linux-x64']),
 os_release:z.string().min(1),initial_database_bytes:bytes.positive(),bootstrap_peak_rss_bytes:bytes.positive(),
}).strict();
const hostSchema=z.object({target:z.string(),os_release:z.string(),total_memory_bytes:bytes,available_disk_bytes:bytes,glibc:z.string().regex(/^\d+\.\d+$/).nullable().optional()}).strict();
/** Linux glibc release from the C library (getconf); null off Linux or when unreadable, e.g. musl. */
export function glibcVersion(platform:NodeJS.Platform=process.platform){
 if(platform!=='linux')return null;
 const result=spawnSync('getconf',['GNU_LIBC_VERSION'],{encoding:'utf8',timeout:5_000});
 return /^glibc (\d+\.\d+)/.exec(result.stdout??'')?.[1]??null;
}
/** The CLI runs on older glibc; the desktop launcher (Open Qoopia) needs 2.34+. Reported, not a blocker. */
function glibcRequirement(target:string,glibc:string|null|undefined){
 if(!target.startsWith('linux-'))return {warnings:[] as string[]};
 const [major=0,minor=0]=(glibc??'').split('.').map(Number);
 return {glibc:glibc??null,minimum_glibc_desktop_launcher:'2.34',warnings:glibc&&(major<2||(major===2&&minor<34))?['GLIBC_BELOW_DESKTOP_LAUNCHER_2_34']:[]};
}
/** Call only after verifyBundle: the observation must belong to its signed inventory. */
export function inspectInstallationRequirements(verified:{root:string;manifest:{members:Record<string,{size:number}>}},destination:string,glibc=glibcVersion(),target=`${process.platform}-${process.arch}`){
 const member='BOOTSTRAP-MEASUREMENT.json';
 if(!verified.manifest.members[member])return {ok:true,blockers:[] as string[],...glibcRequirement(target,glibc),qualification:'not_recorded',full_workload_qualification:'unknown',minimum_ram_bytes:null,minimum_os_release:null};
 const observation=readJson(path.join(verified.root,member));
 const extent=Object.values(verified.manifest.members).reduce((sum,member)=>sum+member.size,0);
 const space=preflightSpace(destination,[]);
 return installationRequirements(extent,observation,{target,os_release:os.release(),
  total_memory_bytes:os.totalmem(),available_disk_bytes:space.available_bytes,glibc});
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
 return {format:'qoopia-install-requirements/1',ok:blockers.length===0,blockers,...glibcRequirement(machine.target,machine.glibc),target:sample.target,
  host:machine,required_disk_bytes:required,bundle_bytes:size,initial_database_bytes:sample.initial_database_bytes,
  bootstrap_peak_rss_bytes:sample.bootstrap_peak_rss_bytes,measured_os_release:sample.os_release,
  minimum_ram_bytes:null,minimum_os_release:null,qualification:'bootstrap_only_not_full_agent_workload',full_workload_qualification:'unknown',
  internet:'required_for_cloud_model_not_local_memory',
  runtime:'separately_installed_and_authenticated_claude_code_or_codex',
  storage_warning:'User files, retained generations, backups and native runtime require additional space; a backup on this disk cannot protect against disk loss.',
 };
}
