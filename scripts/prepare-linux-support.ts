import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {hash} from '../src/delivery/files.ts';
const pool='https://deb.debian.org/debian/pool/';
const packages=[
 {name:'bubblewrap',url:pool+'main/b/bubblewrap/bubblewrap_0.8.0-2+deb12u1_amd64.deb',sha256:'3cc9134a3286ad01a323dcd924ba123eb634cefaeec82d774257e06308aeaadb',members:{'usr/bin/bwrap':'bwrap.bin'}},
 {name:'libcap2',url:pool+'main/libc/libcap2/libcap2_2.66-4+deb12u3+b1_amd64.deb',sha256:'8d684c673e7483802a5c447834b0df6fce006eb3a7109e1be412f5ad425bb24f',members:{'lib/x86_64-linux-gnu/libcap.so.2.66':'lib/libcap.so.2'}},
 {name:'libselinux1',url:pool+'main/libs/libselinux/libselinux1_3.4-1+b6_amd64.deb',sha256:'2b07f5287b9105f40158b56e4d70cc1652dac56a408f3507b4ab3d061eed425f',members:{'lib/x86_64-linux-gnu/libselinux.so.1':'lib/libselinux.so.1'}},
 {name:'libpcre2-8-0',url:'https://deb.debian.org/debian-security/pool/updates/main/p/pcre2/libpcre2-8-0_10.42-1+deb12u1_amd64.deb',sha256:'81c5502941118a24d47af69a17b8b0b9548d75cc6d72b3eb3fe01047b46fa10e',members:{'usr/lib/x86_64-linux-gnu/libpcre2-8.so.0.11.2':'lib/libpcre2-8.so.0'}},
];
const sources=[
 {file:'bubblewrap_0.8.0.orig.tar.xz',sha256:'957ad1149db9033db88e988b12bcebe349a445e1efc8a9b59ad2939a113d333a'},
 {file:'bubblewrap_0.8.0-2+deb12u1.debian.tar.xz',sha256:'37917e8abdd6df1d1118f089e9cf1f9374e1b5bb21c8a70d7de4e9b5dfb10f6d'},
 {file:'bubblewrap_0.8.0-2+deb12u1.dsc',sha256:'155ac8bc44bd578a628d76f5b826817d6d091fc82e900ed8158d9921f650a41c'},
];
async function download(url:string,sha:string){const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Linux support download HTTP '+response.status);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>2*1024*1024||hash(bytes)!==sha)throw new Error('Linux support checksum mismatch');return bytes;}
/** Build-only Debian extraction. End users receive the small helper and its
 * libraries; no apt, developer tooling or global environment changes at runtime. */
export async function prepareLinuxSupport(out:string) {
 if(process.platform!=='linux')return [];
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-linux-support-')),notices:string[]=[];
 try{
  fs.mkdirSync(path.join(out,'lib'),{recursive:true});
  for(const pkg of packages){
   const file=path.join(temp,pkg.name+'.deb'),unpacked=path.join(temp,pkg.name);fs.writeFileSync(file,await download(pkg.url,pkg.sha256));
   if(spawnSync('dpkg-deb',['-x',file,unpacked],{stdio:'pipe'}).status!==0)throw new Error('Build host must provide dpkg-deb');
   for(const [from,to] of Object.entries(pkg.members))fs.copyFileSync(path.join(unpacked,from),path.join(out,to));
   notices.push(pkg.url+' sha256 '+pkg.sha256+'\n'+fs.readFileSync(path.join(unpacked,'usr/share/doc',pkg.name,'copyright'),'utf8'));
  }
  const license=fs.readFileSync('scripts/vendor/licenses/bubblewrap-LGPL-2.txt');if(hash(license)!=='681e386e44a19d7d0674b4320272c90e66b6610b741e7e6305f8219c42e85366')throw new Error('Bubblewrap license drift');notices.push(license.toString());
  const sourceDir=path.join(out,'source');fs.mkdirSync(sourceDir);
  for(const source of sources)fs.writeFileSync(path.join(sourceDir,source.file),await download(pool+'main/b/bubblewrap/'+source.file,source.sha256));
  fs.writeFileSync(path.join(out,'PROVENANCE.json'),JSON.stringify({packages,sources,glibc_min:'2.34',source_note:'Corresponding bubblewrap source and Debian build instructions are included in source/. No binary modifications.'},null,2));
  fs.writeFileSync(path.join(out,'bwrap'),'#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nLD_LIBRARY_PATH="$dir/lib" exec "$dir/bwrap.bin" "$@"\n',{mode:0o755});fs.chmodSync(path.join(out,'bwrap.bin'),0o755);
  if(spawnSync(path.join(out,'bwrap'),['--version'],{encoding:'utf8'}).stdout?.trim()!=='bubblewrap 0.8.0')throw new Error('Bundled Linux helper failed to start');
  return notices;
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
