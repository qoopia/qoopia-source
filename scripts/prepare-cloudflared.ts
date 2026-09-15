import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {hash,durableWrite,privateDirectory} from '../src/utils/fs.ts';
import {cloudflaredMaterials} from './cloudflared-materials.ts';
export const CLOUDFLARED_VERSION='2026.9.1';
const packages={
  'darwin-arm64':{name:'cloudflared-darwin-arm64.tgz',sha256:'c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe'},
  'linux-x64':{name:'cloudflared-linux-amd64',sha256:'03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc'},
} as const;
export async function prepareCloudflared(out:string) {
  const pkg=packages[`${process.platform}-${process.arch}` as keyof typeof packages];
  if(!pkg)throw new Error('Unsupported tunnel target');
  const url='https://github.com/cloudflare/cloudflared/releases/download/'+CLOUDFLARED_VERSION+'/'+pkg.name;
  const cache=privateDirectory(path.join(os.homedir(),'.cache/qoopia-build/cloudflared'));
  const archive=path.join(cache,pkg.sha256);
  if(!fs.existsSync(archive)){
    const response=await fetch(url,{signal:AbortSignal.timeout(120_000)});if(!response.ok)throw new Error('Pinned tunnel download unavailable');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>150*1024*1024||hash(bytes)!==pkg.sha256)throw new Error('Tunnel checksum mismatch');durableWrite(archive,bytes);
  }
  if(hash(fs.readFileSync(archive))!==pkg.sha256)throw new Error('Tunnel cache checksum mismatch');
  privateDirectory(out);const binary=path.join(out,'cloudflared');
  if(process.platform==='darwin'){
    const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});
    if(listing.status!==0||listing.stdout.trim()!=='cloudflared')throw new Error('Unexpected tunnel archive');
    const extraction=spawnSync('tar',['-xzf',archive,'-C',out,'cloudflared'],{stdio:'pipe'});
    if(extraction.status!==0)throw new Error('Tunnel extraction failed');
  }else fs.copyFileSync(archive,binary);
  fs.chmodSync(binary,0o755);
  const version=spawnSync(binary,['--version'],{encoding:'utf8',timeout:10_000,env:{PATH:'/usr/bin:/bin'}});
  if(version.status!==0||!version.stdout.startsWith('cloudflared version '+CLOUDFLARED_VERSION+' '))throw new Error('Bundled tunnel version mismatch');
  const license=fs.readFileSync('scripts/vendor/licenses/cloudflared-2026.9.1-LICENSE');
  if(hash(license)!=='58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd')throw new Error('Tunnel license provenance drift');
  const binaryDigest=hash(fs.readFileSync(binary)),materials=cloudflaredMaterials(`${process.platform}-${process.arch}`,binaryDigest);
  const provenance={version:CLOUDFLARED_VERSION,url,archive_sha256:pkg.sha256,upstream_binary_sha256:binaryDigest,binary_sha256:binaryDigest,license:'Apache-2.0',
    license_source:'https://github.com/cloudflare/cloudflared/blob/2026.9.1/LICENSE',go_version:materials.platform.go_version,
    source_revision:materials.platform.settings['vcs.revision'],upstream_source_modified:materials.platform.settings['vcs.modified']==='true',
    materials_sha256:materials.materials_sha256,notices_sha256:materials.notices_sha256,
    materials_path:'assets/native/cloudflared-MATERIALS.json',notices_path:'assets/native/cloudflared-NOTICES.txt'};
  durableWrite(path.join(out,'cloudflared-MATERIALS.json'),materials.materials);
  durableWrite(path.join(out,'cloudflared-NOTICES.txt'),materials.notices);
  durableWrite(path.join(out,'cloudflared-PROVENANCE.json'),JSON.stringify(provenance));
  return {provenance,modules:materials.platform.dependencies,notice:'Cloudflare cloudflared '+CLOUDFLARED_VERSION+'\n'+url+'\n'+license.toString()+'\n\n'+materials.notices.toString()};
}
