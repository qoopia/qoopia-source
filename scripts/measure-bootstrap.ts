import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bootstrapMeasurementSchema} from '../src/delivery/requirements.ts';

/** Build-time measurement against the just-compiled executable; no personal data or model. */
export function measureBootstrap(executable:string){
 const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-bootstrap-measure-')));
 try {
  const child=Bun.spawnSync([executable,'_migrate','--root',scratch],{
   env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:scratch,TMPDIR:scratch},
   stdout:'pipe',stderr:'pipe',timeout:120000,
  });
  if(!child.success)throw new Error(`Bootstrap measurement failed (child exit ${child.exitCode}); no resource qualification recorded`);
  return bootstrapMeasurementSchema.parse({format:'qoopia-bootstrap-measurement/1',target:`${process.platform}-${process.arch}`,
   os_release:os.release(),initial_database_bytes:fs.statSync(path.join(scratch,'data','qoopia.db')).size,
   bootstrap_peak_rss_bytes:child.resourceUsage?.maxRSS,
  });
 } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}
