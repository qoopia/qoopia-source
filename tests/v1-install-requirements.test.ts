import {test,expect} from 'bun:test';
import {installationRequirements,inspectInstallationRequirements} from '../src/delivery/requirements.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inventory} from '../src/utils/fs.ts';

const sample={format:'qoopia-bootstrap-measurement/1' as const,target:'darwin-arm64',os_release:'25.1.0',initial_database_bytes:1048576,bootstrap_peak_rss_bytes:67108864};
const host={target:'darwin-arm64',os_release:'25.2.0',total_memory_bytes:8*1024**3,available_disk_bytes:10*1024**3};
test('install requirements derive disk from measured bundle and database extents, not guessed minimums',()=>{
 const r=installationRequirements(100*1024**2,sample,host);
 expect(r.ok).toBe(true);expect(r.required_disk_bytes).toBe(203*1024**2);
 expect(r.minimum_ram_bytes).toBeNull();expect(r.minimum_os_release).toBeNull();
 expect(r.bootstrap_peak_rss_bytes).toBe(sample.bootstrap_peak_rss_bytes);
 expect(r.qualification).toBe('bootstrap_only_not_full_agent_workload');
 expect(r.internet).toBe('required_for_cloud_model_not_local_memory');
});
test('measured requirements inspect a fresh destination without creating it; legacy measurement stays unknown',()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-requirements-test-'))),destination=path.join(dir,'not-created');
 try {
  const file=path.join(dir,'BOOTSTRAP-MEASUREMENT.json');
  fs.writeFileSync(file,JSON.stringify({...sample,target:`${process.platform}-${process.arch}`}));
  const verified={root:dir,manifest:{members:inventory(dir)}};
  const report=inspectInstallationRequirements(verified,destination);
  expect(report.ok).toBe(true);expect(fs.existsSync(destination)).toBe(false);
  expect(inspectInstallationRequirements({root:dir,manifest:{members:{}}},destination).qualification).toBe('not_recorded');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('preflight refuses platform mismatch, insufficient physical memory or disk, and malformed observations',()=>{
 expect(installationRequirements(100*1024**2,sample,{...host,available_disk_bytes:1}).blockers).toContain('INSUFFICIENT_DISK');
 expect(installationRequirements(1,sample,{...host,total_memory_bytes:1}).blockers).toContain('BELOW_OBSERVED_BOOTSTRAP_MEMORY');
 expect(installationRequirements(1,sample,{...host,target:'linux-x64'}).blockers).toContain('UNSUPPORTED_BUNDLE_TARGET');
 expect(()=>installationRequirements(Number.MAX_SAFE_INTEGER,sample,host)).toThrow();
 expect(()=>installationRequirements(1,{...sample,initial_database_bytes:-1},host)).toThrow();
 expect(()=>installationRequirements(1,sample,{...host,available_disk_bytes:NaN})).toThrow();
});
