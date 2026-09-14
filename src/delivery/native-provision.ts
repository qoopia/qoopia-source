import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,safePath,privateDirectory,durableWrite,syncDirectory,readJson,preflightSpace,inventory} from './files.ts';
import {readCurrent,lockInstallation} from './operations.ts';
import {RUNTIMES} from './runtime-versions.ts';

const version=z.string().regex(/^\d+\.\d+\.\d+$/),sha=z.string().regex(/^[a-f0-9]{64}$/);
const size=z.number().int().positive().max(512*1024*1024);
const targetSchema=z.enum(['darwin-arm64','linux-x64']);
export const nativePackageSchema=z.object({runtime:z.enum(['codex','claude_code']),target:targetSchema,version,
 url:z.string().url(),sha256:sha,size,binary:z.enum(['bin/codex','claude'])}).strict().superRefine((p,ctx)=>{
 const name=`codex-package-${p.target==='darwin-arm64'?'aarch64-apple-darwin':'x86_64-unknown-linux-musl'}.tar.gz`;
 const expected=p.runtime==='codex'?`https://github.com/openai/codex/releases/download/rust-v${p.version}/${name}`:
  `https://downloads.claude.ai/claude-code-releases/${p.version}/${p.target}/claude`;
 if(p.url!==expected||p.binary!==(p.runtime==='codex'?'bin/codex':'claude'))ctx.addIssue({code:'custom',message:'Native package identity does not match its official vendor path'});
});
export type NativePackage=z.infer<typeof nativePackageSchema>;
export function nativeProvisionPlan(root:string,input:unknown){
 const pkg=nativePackageSchema.parse(input),r=safePath(root),current=readCurrent(r);
 if(pkg.target!==`${process.platform}-${process.arch}`)throw new Error('Native package is for another platform');
 const plan={format:'qoopia-native-provision/1',root:r,instance:current.instance,bundle:current.bundle,package:pkg,
  destination:path.join(r,'native-runtimes',pkg.runtime,pkg.version),trust:'official_vendor_https_metadata',
  changes:'installation-local files only; no shell profile, login, model call or paid API fallback'};
 return {...plan,plan_digest:hash(JSON.stringify(plan))};
}
export async function applyNativeProvision(root:string,input:unknown,approval:string){
 const unlock=lockInstallation(root);
 try{return await applyNativeProvisionLocked(root,input,approval);}finally{unlock();}
}
/** The running standalone service already owns the installation lifetime lock. */
export async function applyNativeProvisionLocked(root:string,input:unknown,approval:string){
 const saved=z.object({package:nativePackageSchema,plan_digest:sha}).passthrough().parse(input);
  const plan=nativeProvisionPlan(root,saved.package);
  if(approval!==saved.plan_digest||approval!==plan.plan_digest)throw new Error('Native install approval changed; preview again');
  preflightSpace(root,[plan.package.size,1024*1024*1024]);
  const installed=fs.existsSync(plan.destination)?verifyInstalledNative(plan.package,plan.destination):
   await unpackNativePackage(plan.package,await vendorDownload(plan.package.url,plan.package.size),plan.destination);
  // Selection is published only after complete verified extraction; old versions are not removed.
  durableWrite(path.join(root,'native-runtimes',plan.package.runtime+'.json'),JSON.stringify(plan.package));
  return {...installed,state:'INSTALLED_NOT_AUTHENTICATED',login_required:true,model_verified:false};
}
/** Only explicit Qoopia-local selections precede PATH; no global installation/profile modification. */
export function nativeRuntimeEnvironment(root:string,source:NodeJS.ProcessEnv){
 const bins:string[]=[];
 for(const runtime of ['codex','claude_code'] as const){
  const record=path.join(root,'native-runtimes',runtime+'.json');if(!fs.existsSync(record))continue;
  const pkg=nativePackageSchema.parse(readJson(record));if(pkg.runtime!==runtime||pkg.target!==`${process.platform}-${process.arch}`)throw new Error('Invalid selected native runtime');
  const {binary}=verifyInstalledNative(pkg,path.join(root,'native-runtimes',runtime,pkg.version));
  const st=fs.lstatSync(binary);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('Selected native runtime is not private and owned');
  bins.push(path.dirname(binary));
 }
 return {...source,PATH:[...bins,source.PATH??'/usr/bin:/bin'].join(path.delimiter)};
}
/** Vendor HTTPS metadata is the bootstrap trust root, NOT a Qoopia publisher signature. */
export function vendorPackage(runtime:NativePackage['runtime'],target:string,metadata:unknown):NativePackage{
 targetSchema.parse(target);
 if(runtime==='codex'){
  const m=z.object({tag_name:z.string(),assets:z.array(z.object({name:z.string(),digest:z.string(),size}))}).parse(metadata);
  const v=version.parse(m.tag_name.replace(/^rust-v/,''));
  const name=`codex-package-${target==='darwin-arm64'?'aarch64-apple-darwin':'x86_64-unknown-linux-musl'}.tar.gz`;
  const matches=m.assets.filter(a=>a.name===name);if(matches.length!==1)throw new Error('Native package unavailable for selected target');
  const a=matches[0]!;return nativePackageSchema.parse({runtime,target,version:v,size:a.size,sha256:sha.parse(a.digest.replace(/^sha256:/,'')),
   binary:'bin/codex',url:`https://github.com/openai/codex/releases/download/rust-v${v}/${name}`});
 }
 const m=z.object({version,platforms:z.record(z.object({checksum:sha,size}))}).parse(metadata),a=m.platforms[target];
 if(!a)throw new Error('Native package unavailable for selected target');
 return nativePackageSchema.parse({runtime,target,version:m.version,size:a.size,sha256:a.checksum,binary:'claude',
  url:`https://downloads.claude.ai/claude-code-releases/${m.version}/${target}/claude`});
}
const origins=new Set(['https://api.github.com','https://github.com','https://release-assets.githubusercontent.com','https://downloads.claude.ai']);
export async function vendorDownload(url:string,maxBytes:number):Promise<Uint8Array>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),300_000);
 try{
  for(let redirects=0;redirects<4;redirects++){
   const u=new URL(url);if(!origins.has(u.origin)||u.username||u.password)throw new Error('Untrusted native package origin');
   const response=await fetch(u,{redirect:'manual',signal:controller.signal,headers:{'user-agent':'Qoopia-native-provision'}});
   if([301,302,303,307,308].includes(response.status)){
    const next=response.headers.get('location');await response.body?.cancel();if(!next)throw new Error('Invalid vendor redirect');url=new URL(next,u).href;continue;
   }
   if(!response.ok||!response.body)throw new Error(`Native vendor download failed (${response.status}); no fallback billing or installer execution`);
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
   try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;
    if(total>maxBytes)throw new Error('Native vendor response exceeds size limit');chunks.push(part.value);}}
   finally{await reader.cancel();}
   return Buffer.concat(chunks,total);
  }
  throw new Error('Too many vendor redirects');
 }finally{clearTimeout(timer);}
}
export async function nativePackagePreview(runtime:NativePackage['runtime'],target=`${process.platform}-${process.arch}`){
 const kind=z.enum(['codex','claude_code']).parse(runtime),v=RUNTIMES[kind].version;
 if(kind==='codex')return vendorPackage(kind,target,JSON.parse(Buffer.from(await vendorDownload(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${v}`,2*1024*1024)).toString()));
 const metadata=JSON.parse(Buffer.from(await vendorDownload(`https://downloads.claude.ai/claude-code-releases/${v}/manifest.json`,1024*1024)).toString());
 return vendorPackage(runtime,target,{...metadata,version:v});
}
/** No downloaded shell script and no archive.extract: write only bounded regular files into a NEW private directory. */
export function verifyInstalledNative(input:unknown,destination:string){
 const p=nativePackageSchema.parse(input),dest=safePath(destination),saved=readJson<{package:unknown;members:unknown}>(path.join(dest,'qoopia-native-package.json'));
 if(JSON.stringify(nativePackageSchema.parse(saved.package))!==JSON.stringify(p))throw new Error('Installed native package identity changed');
 const members=inventory(dest,new Set(['qoopia-native-package.json']));
 if(JSON.stringify(saved.members)!==JSON.stringify(members))throw new Error('Installed native package contents changed');
 return {binary:path.join(dest,p.binary),installed_bytes:Object.values(members).reduce((n,m)=>n+m.size,0)};
}
export async function unpackNativePackage(input:unknown,bytes:Uint8Array,destination:string){
 const p=nativePackageSchema.parse(input);
 if(bytes.length!==p.size||hash(bytes)!==p.sha256)throw new Error('Native package checksum/size mismatch');
 const dest=safePath(destination);if(fs.existsSync(dest))throw new Error('Native package destination already exists; never overwrite a runtime');
 const files=p.runtime==='claude_code'?new Map([['claude',new File([bytes],'claude')]]):await new Bun.Archive(bytes).files();
 if(!files.size||files.size>2000)throw new Error('Invalid native package inventory');
 const normalized=new Map<string,File>();let expanded=0;
 for(const [raw,file] of files){
  const name=raw.replace(/^\.\//,'');
  if(!/^[A-Za-z0-9._/-]+$/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..')||normalized.has(name))throw new Error('Unsafe native package member');
  expanded+=file.size;if(expanded>1024*1024*1024)throw new Error('Expanded native package exceeds size limit');normalized.set(name,file);
 }
 if(!normalized.has(p.binary))throw new Error('Native package executable missing');
 if(p.runtime==='codex'&&!['codex-package.json','codex-path/rg','bin/codex-code-mode-host'].every(n=>normalized.has(n)))throw new Error('Native package resources missing');
 if(p.runtime==='codex'&&p.target==='linux-x64'&&!normalized.has('codex-resources/bwrap'))throw new Error('Native sandbox helper missing');
 const staging=dest+'.staging-'+randomUUID();privateDirectory(staging);
 try{
  for(const [name,file] of normalized){const filename=path.join(staging,name);privateDirectory(path.dirname(filename));durableWrite(filename,new Uint8Array(await file.arrayBuffer()));
   if(name===p.binary||name==='bin/codex-code-mode-host'||name==='codex-path/rg'||name==='codex-resources/bwrap')fs.chmodSync(filename,0o700);
  }
  durableWrite(path.join(staging,'qoopia-native-package.json'),JSON.stringify({package:p,members:inventory(staging)}));
  if(fs.existsSync(dest))throw new Error('Native package destination changed');
  fs.renameSync(staging,dest);syncDirectory(path.dirname(dest));
 }finally{if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});}
 return {binary:path.join(dest,p.binary),installed_bytes:expanded,package:p};
}
