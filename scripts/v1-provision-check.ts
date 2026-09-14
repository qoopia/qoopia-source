// Real vendor bytes, isolated install, --version only. No login, model call, global profile or shell installer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {nativePackagePreview,vendorDownload,unpackNativePackage} from '../src/delivery/native-provision.ts';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-v1-native-check-')));
const results=[];
try{
 for(const runtime of ['codex','claude_code'] as const){
  const pkg=await nativePackagePreview(runtime),bytes=await vendorDownload(pkg.url,pkg.size);
  const installed=await unpackNativePackage(pkg,bytes,path.join(root,runtime));
  const home=path.join(root,runtime+'-home');fs.mkdirSync(home,{mode:0o700});
  const p=Bun.spawnSync([installed.binary,'--version'],{cwd:home,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:home,
   CODEX_HOME:home,CLAUDE_CONFIG_DIR:home,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'},timeout:30_000,stdout:'pipe',stderr:'pipe'});
  assert.equal(p.exitCode,0,`${runtime} --version failed`);const actual=p.stdout.toString().trim();assert(actual.includes(pkg.version));
  results.push({package:pkg,installed_bytes:installed.installed_bytes,actual_version:actual,exit_code:p.exitCode,model_calls:0,global_profiles_modified:false});
 }
 console.log(JSON.stringify({status:'PASS_REAL_VENDOR_INSTALL_VERSION_ONLY',full_first_run:false,results},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
