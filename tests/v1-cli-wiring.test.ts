import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectInstallationRequirements} from '../src/delivery/requirements.ts';

const entry=fs.readFileSync(new URL('../src/delivery/entry.ts',import.meta.url),'utf8');

test('actual standalone help exposes bounded runtime task and provision operations',()=>{
 const result=spawnSync(process.execPath,['src/delivery/entry.ts','help'],{cwd:path.resolve(import.meta.dir,'..'),encoding:'utf8',env:{PATH:process.env.PATH}});
 expect(result.status).toBe(0);
 expect(result.stdout).toContain('runtime provision');
 expect(result.stdout).toContain('runtime task');
 expect(result.stdout).toContain('no login or model invocation');
});

test('install preview and commit share verified read-only requirements before reservation or mutation',()=>{
 const install=entry.indexOf("if(cmd==='install')");
 expect(install).toBeGreaterThan(-1);
 const block=entry.slice(install,entry.indexOf("if(cmd==='backup')",install));
 expect(block.indexOf('verifyBundle(')).toBeGreaterThan(-1);
 expect(block.indexOf('inspectInstallationRequirements(')).toBeGreaterThan(block.indexOf('verifyBundle('));
 expect(block.indexOf("if(!flag('commit'))")).toBeGreaterThan(block.indexOf('inspectInstallationRequirements('));
 expect(block.indexOf('reservePort(')).toBeGreaterThan(block.indexOf("if(!flag('commit'))"));
 expect(entry.indexOf("if(!['start','open','owner-login','parser-smoke','steward'].includes(cmd)&&!flag('commit'))")).toBeGreaterThan(install);
});

test('retained bundles without measurements stay installable while workload qualification is explicit unknown',()=>{
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-cli-requirements-'))),destination=path.join(parent,'new-install');
 try{
  const report=inspectInstallationRequirements({root:parent,manifest:{members:{}}},destination);
  expect(report.ok).toBe(true);
  expect(report.minimum_ram_bytes).toBeNull();
  expect(report.minimum_os_release).toBeNull();
  expect(report.full_workload_qualification).toBe('unknown');
  expect(fs.existsSync(destination)).toBe(false);
 }finally{fs.rmSync(parent,{recursive:true,force:true});}
});

test('setup accepts explicit test-fixture trust as a boolean while retaining strict option and installed trust checks',()=>{
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-setup-parser-'))),root=path.join(parent,'root');
 try{
  const accepted=spawnSync(process.execPath,['src/delivery/entry.ts','setup','--root',root,'--allow-test-fixture'],{cwd:path.resolve(import.meta.dir,'..'),encoding:'utf8',env:{PATH:process.env.PATH}});
  expect(accepted.status).toBe(0);
  const unknown=spawnSync(process.execPath,['src/delivery/entry.ts','setup','--root',root,'--unknown'],{cwd:path.resolve(import.meta.dir,'..'),encoding:'utf8',env:{PATH:process.env.PATH}});
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('Invalid setup option');
  const setup=entry.slice(entry.indexOf("if(cmd==='setup')"),entry.indexOf("const delivery=",entry.indexOf("if(cmd==='setup')")));
  expect(setup).toContain("if(option==='--allow-test-fixture')continue");
  expect(setup).toContain('dispatchInstalled()');
  expect(entry).toContain("allow=flag('allow-test-fixture')");
 }finally{fs.rmSync(parent,{recursive:true,force:true});}
});

test('runtime provision precedes generic runtime dispatch and task gets local PATH, explicit subscription handoff and task timeout',()=>{
 const provision=entry.indexOf("if(cmd==='runtime'&&argv[1]==='provision')");
 const generic=entry.indexOf("if(cmd==='skill'||cmd==='runtime')");
 expect(provision).toBeGreaterThan(-1);
 expect(provision).toBeLessThan(generic);
 const provisionBlock=entry.slice(provision,generic);
 expect(provisionBlock).toContain('nativePackagePreview');
 expect(provisionBlock).toContain('nativeProvisionPlan');
 expect(provisionBlock).toContain('applyNativeProvision');
 expect(provisionBlock).toContain("need('approve')");
 expect(entry).toContain("['run','inspect','task'].includes(argv[1]!)");
 expect(entry).toContain('nativeRuntimeEnvironment(root');
 expect(entry).toContain("cmd==='runtime'&&argv[1]==='task'?330_000:120_000");
});
