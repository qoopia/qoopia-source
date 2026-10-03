// The public source export is scripted and fail-closed (allowlist + content scan).
// This file is itself exported: marker samples are assembled at runtime so the
// scanner never sees a literal private value here.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PUBLIC_SOURCE_EXCLUSIONS } from '../scripts/bundle-signing.ts';
import { scanText } from '../scripts/export-public-source.ts';

const exporter=(args:string[])=>spawnSync(process.execPath,['scripts/export-public-source.ts',...args],{encoding:'utf8',maxBuffer:64*1024*1024});
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function publicCheckout(files:Record<string,string>,email='1+publisher@users.noreply.github.com'){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-public-export-')));dirs.push(dir);
  const git=(...args:string[])=>spawnSync('git',['-C',dir,...args],{encoding:'utf8'});
  expect(git('init','-q').status).toBe(0);
  for(const [key,value] of [['user.name','publisher'],['user.email',email],['user.useConfigOnly','true']])expect(git('config',key,value).status).toBe(0);
  for(const [p,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,p)),{recursive:true});fs.writeFileSync(path.join(dir,p),text);}
  expect(git('add','-A').status).toBe(0);expect(git('commit','-q','-m','public').status).toBe(0);
  return {dir,status:()=>git('status','--porcelain').stdout};
}

test('plan selects by allowlist and the exported tree carries no private markers',()=>{
  const run=exporter(['--plan']);
  const plan=JSON.parse(run.stdout);
  expect(plan.hits).toEqual([]);expect(run.status).toBe(0);
  expect(plan.files).toEqual(expect.arrayContaining(['src/index.ts','package.json','scripts/build-bundle.ts']));
  for(const p of [...PUBLIC_SOURCE_EXCLUSIONS,'docs/cosine-distribution-2026-05-13.txt','PROJECT-STATE.json','START-HERE.md','AGENTS.md','CLAUDE.md',
    'deploy/qoopia-source-mirror.service','docs/operations/public-source-distribution.md'])expect(plan.files).not.toContain(p);
});

test('scanner flags every marker kind and passes documented placeholders',()=>{
  const at='@',markers:Record<string,string>={
    'home-path':'cd /Us'+'ers/alice/project','tailnet-ip':'host 10'+'0.101.2.3','ssh-target':'ssh deploy'+at+'10.0.0.5',
    'agent-home':'~/.duct'+'or-main/workspace','local-hostname':'me'+at+'Mac-mini-2.lo'+'cal','email':'someone'+at+'gmail.c'+'om',
    'private-key':'-----BEGIN RSA PRIV'+'ATE KEY-----','token':'gh'+'p_'+'A1'.repeat(18),
  };
  for(const [kind,line] of Object.entries(markers))expect(scanText('src/x.ts',line).map(h=>h.kind)).toContain(kind);
  expect(scanText('src/x.ts','/Us'+'ers/example/a /ho'+'me/node/b user'+at+'example.com bot'+at+'users.noreply.github.com 01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual([]);
});

test('export rewrites a clean public checkout: allowlisted canonical files, public-maintained files kept, stale files removed, manifest',()=>{
  const pub=publicCheckout({'AGENTS.md':'public contributor instructions\n','scripts/retired-one-off.ts':'old\n','SOURCE-MANIFEST.json':'{}\n'});
  const run=exporter(['--public',pub.dir]);
  expect(run.status).toBe(0);expect(JSON.parse(run.stdout)).toMatchObject({status:'EXPORTED',removed:['scripts/retired-one-off.ts']});
  expect(fs.readFileSync(path.join(pub.dir,'AGENTS.md'),'utf8')).toBe('public contributor instructions\n');
  expect(fs.readFileSync(path.join(pub.dir,'src/index.ts'))).toEqual(fs.readFileSync('src/index.ts'));
  for(const p of [...PUBLIC_SOURCE_EXCLUSIONS,'scripts/retired-one-off.ts','CLAUDE.md'])expect(fs.existsSync(path.join(pub.dir,p))).toBe(false);
  const manifest=JSON.parse(fs.readFileSync(path.join(pub.dir,'SOURCE-MANIFEST.json'),'utf8'));
  expect(manifest).toMatchObject({format:'qoopia-public-source/1',runtime_files_identical:true,product_version:JSON.parse(fs.readFileSync('package.json','utf8')).version});
  const rows=new Map(manifest.files.map((f:{path:string})=>[f.path,f]));
  expect(rows.get('AGENTS.md')).toMatchObject({bytes:32,source_snapshot_identical:false});
  expect(rows.get('src/index.ts')).toMatchObject({source_snapshot_identical:true});
  expect(rows.has('SOURCE-MANIFEST.json')).toBe(false);
});

test('export refuses a dirty checkout and refuses private markers before writing anything',()=>{
  const dirty=publicCheckout({'README.md':'public\n'});fs.writeFileSync(path.join(dirty.dir,'README.md'),'edited\n');
  expect(exporter(['--public',dirty.dir]).status).not.toBe(0);
  // Export commits must not fall back to a personal email or the machine's hostname identity.
  const personal=publicCheckout({'README.md':'public\n'},'publisher@example.test');
  expect(exporter(['--public',personal.dir]).stderr).toContain('noreply identity');
  expect(personal.status()).toBe('');
  const leaking=publicCheckout({'README.md':'contact: owner'+'@'+'gmail.c'+'om\n'});
  const run=exporter(['--public',leaking.dir]);
  expect(run.status).toBe(1);expect(JSON.parse(run.stdout).hits).toEqual([{path:'README.md',line:1,kind:'email'}]);
  expect(leaking.status()).toBe('');expect(fs.existsSync(path.join(leaking.dir,'src'))).toBe(false);
});
