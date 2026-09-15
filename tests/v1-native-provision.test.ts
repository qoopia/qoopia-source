import {test,expect} from 'bun:test';
import {vendorPackage,unpackNativePackage,nativeProvisionPlan,applyNativeProvision,nativeRuntimeEnvironment,vendorDownload,verifyInstalledNative} from '../src/delivery/native-provision.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('vendor metadata pins the exact platform, version, digest and HTTPS download; malformed metadata refuses',()=>{
 const hash='a'.repeat(64),name='codex-package-aarch64-apple-darwin.tar.gz';
 const data={tag_name:'rust-v0.153.4',assets:[{name,size:100,digest:'sha256:'+hash}]};
 expect(vendorPackage('codex','darwin-arm64',data).sha256).toBe(hash);
 expect(vendorPackage('codex','darwin-arm64',data).url).toBe('https://github.com/openai/codex/releases/download/rust-v0.153.4/'+name);
 expect(()=>vendorPackage('codex','linux-x64',data)).toThrow();
 expect(()=>vendorPackage('codex','darwin-arm64',{...data,tag_name:'../../evil'})).toThrow();
 expect(vendorPackage('claude_code','linux-x64',{version:'2.1.263',platforms:{'linux-x64':{checksum:hash,size:100}}}).binary).toBe('claude');
 expect(()=>vendorPackage('claude_code','linux-x64',{version:'2.1.263',platforms:{'linux-x64':{checksum:'bad',size:100}}})).toThrow();
});
test('provision preview is installation-bound; wrong approval and non-vendor URLs fail before download; PATH is local only',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-native-plan-fixture-')));
 try{
  const target=`${process.platform}-${process.arch}`;
  const bytes=Buffer.from('fixture, never executed');
  const pkg=vendorPackage('claude_code',target,{version:'2.1.263',platforms:{[target]:{checksum:new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),size:bytes.length}}});
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({format:'qoopia-installation/1',generation:'generation-11111111-1111-4111-8111-111111111111',bundle:'b'.repeat(64),bundle_digest:'b'.repeat(64),instance:'fixture-native-plan',port:43737}),{mode:0o600});
  const plan=nativeProvisionPlan(root,pkg);expect(plan.plan_digest).toHaveLength(64);
  await expect(applyNativeProvision(root,plan,'0'.repeat(64))).rejects.toThrow();
  expect(fs.existsSync(path.join(root,'native-runtimes'))).toBe(false);
  await expect(vendorDownload('http://127.0.0.1:1/',100)).rejects.toThrow();
  const env={PATH:'/usr/bin:/bin',HOME:'/fixture-home'};expect(await nativeRuntimeEnvironment(root,env)).toEqual(env);
  const directory=path.join(root,'native-runtimes','claude_code',pkg.version);
  await unpackNativePackage(pkg,bytes,directory);
  fs.writeFileSync(path.join(root,'native-runtimes','claude_code.json'),JSON.stringify(pkg),{mode:0o600});
  expect((await nativeRuntimeEnvironment(root,env)).PATH).toBe(directory+':'+env.PATH);
  fs.writeFileSync(path.join(directory,'claude'),'tampered fixture');
  await expect(nativeRuntimeEnvironment(root,env)).rejects.toThrow();
  fs.writeFileSync(path.join(directory,'claude'),bytes);
  fs.chmodSync(path.join(directory,'claude'),0o755);await expect(nativeRuntimeEnvironment(root,env)).rejects.toThrow();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('only verified bytes become executable; native archives preserve required layout without shell extraction',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-native-fixture-')));
 try{
  const bytes=await new Bun.Archive({'bin/codex':'fixture executable, NOT a native runtime','bin/codex-code-mode-host':'fixture','codex-path/rg':'fixture','codex-package.json':'{}'},{compress:'gzip'}).bytes();
  const digest=new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const pkg=vendorPackage('codex','darwin-arm64',{tag_name:'rust-v0.153.4',assets:[{name:'codex-package-aarch64-apple-darwin.tar.gz',size:bytes.length,digest:'sha256:'+digest}]});
  await expect(unpackNativePackage({...pkg,sha256:'0'.repeat(64)},bytes,path.join(root,'bad'))).rejects.toThrow();
  expect(fs.existsSync(path.join(root,'bad'))).toBe(false);
  const hostile=await new Bun.Archive({'../escape':'no','bin/codex':'fixture'},{compress:'gzip'}).bytes();
  const hostilePackage={...pkg,size:hostile.length,sha256:new Bun.CryptoHasher('sha256').update(hostile).digest('hex')};
  await expect(unpackNativePackage(hostilePackage,hostile,path.join(root,'hostile'))).rejects.toThrow();
  expect(fs.existsSync(path.join(root,'hostile'))).toBe(false);expect(fs.existsSync(path.join(root,'escape'))).toBe(false);
  const dest=path.join(root,'good');await unpackNativePackage(pkg,bytes,dest);
  expect(fs.readFileSync(path.join(dest,'bin/codex'),'utf8')).toContain('fixture');
  expect(fs.statSync(path.join(dest,'bin/codex')).mode&0o777).toBe(0o700);
  expect(verifyInstalledNative(pkg,dest).binary).toBe(path.join(dest,'bin/codex'));
  fs.writeFileSync(path.join(dest,'bin/codex'),'tampered fixture');expect(()=>verifyInstalledNative(pkg,dest)).toThrow();
  await expect(unpackNativePackage(pkg,bytes,dest)).rejects.toThrow();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
