import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bootstrapMeasurementSchema} from '../src/delivery/requirements.ts';

/** Build-time measurement against the just-compiled executable; no personal data. The peak
 * covers a fresh migration and the first built-in embedding, whose model then stays
 * resident (about 1 GB, F-307); a migration alone peaks near 75 MB. */
export function measureBootstrap(executable:string){
 const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-bootstrap-measure-')));
 try {
  const peaks=['_migrate','_embed-probe'].map(command=>{
   const child=Bun.spawnSync([executable,command,'--root',scratch],{
    env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:scratch,TMPDIR:scratch},
    stdout:'pipe',stderr:'pipe',timeout:120000,
   });
   if(!child.success)throw new Error(`Bootstrap measurement failed (child exit ${child.exitCode}); no resource qualification recorded`);
   // Bun reports ru_maxrss as the OS does: KiB on Linux, bytes on macOS (F-336).
   return Number(child.resourceUsage?.maxRSS)*(process.platform==='linux'?1024:1);
  });
  return bootstrapMeasurementSchema.parse({format:'qoopia-bootstrap-measurement/1',target:`${process.platform}-${process.arch}`,
   os_release:os.release(),initial_database_bytes:fs.statSync(path.join(scratch,'data','qoopia.db')).size,
   bootstrap_peak_rss_bytes:Math.max(...peaks),
  });
 } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}
