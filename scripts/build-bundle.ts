import {prepareSparkle} from './prepare-sparkle.ts';
import {updateFeed} from './update-feed.ts';
import {desktopRelease} from './desktop-release.ts';
import {agentKitFiles,agentKitManifest} from '../src/agent-kit/index.ts';
import {prepareMemoryModel} from './prepare-memory-model.ts';
import {prepareLinuxSupport} from './prepare-linux-support.ts';
import {prepareCloudflared} from './prepare-cloudflared.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { hash, inventory, privateDirectory, durableWrite } from '../src/delivery/files.ts';
import { bundleSchema, verifyBundle, OPS_READER_MEMBER, OPS_READER_CAPABILITY } from '../src/delivery/bundle.ts';
import pkg from '../package.json';
import { buildOwnerPeer } from './build-owner-peer.ts';
import { buildLinuxLauncher, LINUX_GUI_LAUNCHER } from './build-linux-launcher.ts';
import { measureBootstrap } from './measure-bootstrap.ts';
import { assertCleanSource, loadReleaseAuthorization, packageAndNotarizeDarwin, runPublisherSigner, signAndVerifyDarwin } from './bundle-signing.ts';
const args=process.argv.slice(2), value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}, noticeCheck=args.includes('--notice-check'),fixture=args.includes('--test-fixture'),publisher=args.includes('--publisher');
if(!noticeCheck&&fixture===publisher)throw new Error('Select exactly one signing mode: --test-fixture or --publisher');
if(!noticeCheck&&(!args.includes('--out')||!path.isAbsolute(value('--out')??'')))throw new Error('--out absolute new directory required');
const finalOut=value('--out')!;
if(!noticeCheck&&fs.existsSync(finalOut))throw new Error('Build output must be new');
const target=`${process.platform}-${process.arch}`;
if(!['darwin-arm64','linux-x64'].includes(target))throw new Error('Unsupported build host; cross-compilation is not qualification');
const git=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});if(git.status!==0)throw new Error('Exact base SHA unavailable');
if(publisher){
 assertCleanSource();
 const top=spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).stdout.trim();
 if(finalOut===top||finalOut.startsWith(top+path.sep))throw new Error('Publisher build output must be outside the clean source checkout');
}
const roots=['src','scripts','migrations','package.json','bun.lock','docs/v4/export-table-policy.json','docs/v4/export-schema-columns.json','LICENSE'];
const source:Record<string,string>={};
const collect=(p:string)=>{const st=fs.lstatSync(p);if(st.isSymbolicLink())throw new Error('Source link refused');if(st.isDirectory())for(const n of fs.readdirSync(p).sort())collect(path.join(p,n));else source[p]=hash(fs.readFileSync(p));};
for(const p of roots)collect(p);
const sourceDigest=hash(JSON.stringify(source));
const bunNotice={version:'1.3.11',source_commit:'a04817ce2b7f1a1e8b7cbf8af8f2c027ab072f1d',license_file:'LICENSE.md',license_source:'https://raw.githubusercontent.com/oven-sh/bun/a04817ce2b7f1a1e8b7cbf8af8f2c027ab072f1d/LICENSE.md',license_sha256:'7068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb',third_party_licenses:'INTEGRATED_IN_CANONICAL_LICENSE_MD'} as const;
const bunLicense=fs.readFileSync('scripts/vendor/licenses/bun-1.3.11-LICENSE.md');
if(Bun.version!==bunNotice.version||hash(bunLicense)!==bunNotice.license_sha256)throw new Error('Pinned Bun runtime notice provenance drift');
const dependencies:Record<string,unknown>[]=[], covered=new Set<string>();const notices:string[]=['Qoopia V1. Third-party license notices.','Owner-controlled Qoopia and unified code: MIT.\n'+fs.readFileSync('LICENSE','utf8'),'Skillonomia Apache-2.0:\n'+fs.readFileSync('src/skills/legacy/LICENSE','utf8'),
  `Bun ${bunNotice.version} canonical upstream ${bunNotice.license_file} (source commit ${bunNotice.source_commit}; source ${bunNotice.license_source}; sha256 ${bunNotice.license_sha256})\nThe complete pinned file below is Bun's published inventory for Bun, JavaScriptCore/WebKit, linked libraries, embedded polyfills, and additional credits; no separate THIRD_PARTY_LICENSES file is present in the exact tagged repository or release archive.\n${bunLicense.toString()}`,'Vendored pdf.js 5.4.296 via unpdf 1.4.0; Apache-2.0. Advisory guard: GHSA-hq66-cqwq-w95j.'];
// Ship only the vendor's self-contained WASM engine; WebGL/WebGPU packages
// are build dependencies and are not included in the running application.
const onnxNotices=JSON.parse(fs.readFileSync('scripts/vendor/licenses/onnxruntime-1.29.0.json','utf8'));
for(const record of onnxNotices){const bytes=fs.readFileSync(record.path);if(hash(bytes)!==record.sha256)throw new Error('ONNX notice provenance drift');notices.push(`ONNX Runtime 1.29.0 ${record.url} sha256 ${record.sha256}\n${bytes.toString()}`);}
notices.push('Built-in multilingual-e5-small (MIT), Microsoft; ONNX conversion Xenova. Pinned revision, original model source and file digests: assets/models/MODEL-NOTICE.json.');
const override=JSON.parse(fs.readFileSync('scripts/vendor/licenses/isarray-1.0.0.json','utf8'));
if(hash(override.body)!==override.body_sha256||hash(fs.readFileSync('node_modules/isarray/README.md'))!==override.source_sha256)throw new Error('isarray@1.0.0 license provenance drift');
const qrNotice=JSON.parse(fs.readFileSync('scripts/vendor/licenses/qrcode-generator-2.0.4.json','utf8'));
if(hash(fs.readFileSync(qrNotice.path))!==qrNotice.sha256||hash(fs.readFileSync('node_modules/qrcode-generator/package.json'))!==qrNotice.package_sha256)throw new Error('QR license provenance drift');
const seen=new Set<string>();
const dependency=(name:string)=>{
 if(seen.has(name))return;seen.add(name);const dir=path.join('node_modules',name),file=path.join(dir,'package.json');if(!fs.existsSync(file))throw new Error('Dependency inventory incomplete: '+name);
 const p=JSON.parse(fs.readFileSync(file,'utf8')), id=`${p.name}@${p.version}`;dependencies.push({name:p.name,version:p.version,license:p.license??'REVIEW_REQUIRED',package_sha256:hash(fs.readFileSync(file))});
 for(const n of fs.readdirSync(dir).filter(n=>/^(license|notice|copying)(\.|$)/i.test(n)))if(fs.statSync(path.join(dir,n)).isFile()){notices.push(`${id} ${n}\n${fs.readFileSync(path.join(dir,n),'utf8')}`);covered.add(id);}
 if(id===`${override.package}@${override.version}`){notices.push(`${id} README.md#license (source ${override.upstream}; source_sha256 ${override.source_sha256}; body_sha256 ${override.body_sha256})\n${override.body}`);covered.add(id);}
 if(id==='qrcode-generator@2.0.4'){notices.push(`${id} ${qrNotice.upstream} sha256 ${qrNotice.sha256}\n${fs.readFileSync(qrNotice.path,'utf8')}`);covered.add(id);}
 for(const dep of Object.keys(p.dependencies??{}))dependency(dep);
};
for(const name of Object.keys(pkg.dependencies))dependency(name);
for(const family of ['MarckScript','IBMPlexSans'])notices.push(family+' — SIL Open Font License 1.1\n'+fs.readFileSync('src/public/brand/'+family+'-OFL.txt','utf8'));
const missing=dependencies.map(p=>`${p.name}@${p.version}`).filter(id=>!covered.has(id));
if(noticeCheck){console.log(JSON.stringify({status:'NOTICE_COVERAGE_CHECK',dependencies:dependencies.length,covered:covered.size,missing,runtime_notice:bunNotice,overrides:[{package:`${override.package}@${override.version}`,body_sha256:override.body_sha256,source_sha256:override.source_sha256}]}));process.exit(0);}
let privateKey:KeyObject|undefined;
let publicPem:string,authorization:ReturnType<typeof loadReleaseAuthorization>|undefined;
if(fixture){const pair=generateKeyPairSync('ed25519');privateKey=pair.privateKey;publicPem=pair.publicKey.export({format:'pem',type:'spki'}).toString();}
else{
 const publicKeyFile=value('--publisher-public-key'),signer=value('--signer'),authorizationFile=value('--release-authorization');
 if(!publicKeyFile||!signer||!authorizationFile)throw new Error('Publisher builds require --publisher-public-key, --signer, and --release-authorization');
 if(!path.isAbsolute(publicKeyFile))throw new Error('--publisher-public-key must be absolute');
 publicPem=fs.readFileSync(publicKeyFile,'utf8');
 authorization=loadReleaseAuthorization(authorizationFile,{buildSha:git.stdout.trim(),target,publisherKeySha256:hash(publicPem)});
}
const out=path.join(path.dirname(finalOut),`.${path.basename(finalOut)}.building-${process.pid}`);
let finalized=false;process.on('exit',()=>{if(!finalized&&fs.existsSync(out))fs.rmSync(out,{recursive:true,force:true});});
privateDirectory(out);
const compile=spawnSync(process.execPath,['build','src/delivery/entry.ts','--compile','--no-compile-autoload-dotenv','--no-compile-autoload-bunfig','--no-compile-autoload-tsconfig','--no-compile-autoload-package-json',
  '--define',`QOOPIA_PINNED_KEY=${JSON.stringify(publicPem)}`,'--define',`QOOPIA_BUILD_SHA=${JSON.stringify(git.stdout.trim())}`,'--outfile',path.join(out,'qoopia')],{stdio:'inherit'});
if(compile.status!==0)throw new Error('Standalone compile failed');
for(const name of ['connections-guide-en.html','connections-guide-ru.html','connections-agent.md']){
 let content=fs.readFileSync('src/public/'+name,'utf8');
 if(name.endsWith('.html'))content=content.replaceAll('/brand/','assets/src/public/brand/').replaceAll('href="/dashboard#connections"','href="#offline-workspace"').replace('<h2>','<p id="offline-workspace">'+(name.includes('-ru')?'Откройте приложение Qoopia и выберите «Подключения» в своей установке.':'Open the Qoopia app and choose Connections in your workspace.')+'</p><h2>');
 durableWrite(path.join(out,name),content);
}
privateDirectory(path.join(out,'agent-guide'));
for(const [name,text] of Object.entries(agentKitFiles))durableWrite(path.join(out,'agent-guide',name),text);
durableWrite(path.join(out,'agent-guide','manifest.json'),JSON.stringify({...agentKitManifest(),source:git.stdout.trim()},null,2)+'\n');
if(target==='darwin-arm64'){const stamp=spawnSync('git',['show','-s','--format=%ct','HEAD'],{encoding:'utf8'});if(stamp.status!==0)throw new Error('Desktop build timestamp unavailable');durableWrite(path.join(out,'DESKTOP-RELEASE.json'),JSON.stringify(desktopRelease(publicPem,Number(stamp.stdout.trim()))));}
const launcher=target==='darwin-arm64'?'Open Qoopia.command':'open-qoopia.sh';
durableWrite(path.join(out,launcher),'#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./qoopia open "$@"\n');
if(target==='linux-x64')buildLinuxLauncher(out);
const graphicalLauncher=target==='linux-x64'?LINUX_GUI_LAUNCHER:launcher;
durableWrite(path.join(out,'START-HERE.txt'),'QOOPIA V1\n\nOpen '+graphicalLauncher+' to open Qoopia. With an existing server, run ./qoopia use-server --url https://YOUR-SERVER --commit once; subsequent launches open that same server without creating a second local database. Otherwise Qoopia installs a local workspace. On Linux you can also run ./qoopia open from a terminal.\n\nChoose Google or enter your email in the browser, then confirm the new sign-in email. Your workspace opens automatically. Connect the agents you use from Connections first. Basic memory search works without a model subscription. Optionally, open Memory model settings, choose Claude or ChatGPT, sign in to your own subscription, and check the connection. On Mac, open the downloaded .qoopia-memory file with Qoopia; on Linux use ./qoopia memory-link --file /absolute/path/to/connection.qoopia-memory. Codex asks you to trust the installed Qoopia hooks once in /hooks. Continue working in your agent application; session context is captured and restored automatically. Browser MCP clients have memory access but no automatic transcript lifecycle capture.\n\nIf launched from a terminal, keep it open while working. Reopening the launcher connects to the running service. Data stays in the selected installation: your server, or your platform application data directory in local mode. Installation does not enable automatic startup.\n\nAdvanced: ./qoopia help. Backup and restore commands preserve the original data; they preview changes before --commit.\n');
durableWrite(path.join(out,'START-HERE.txt'),fs.readFileSync(path.join(out,'START-HERE.txt'),'utf8')+'\nSupported connections: tested Codex CLI, Claude Code, Claude Desktop and Claude Web combinations. ChatGPT Web/Desktop are experimental; complete setup verification is not qualified. See the client/version/plan matrix in the included guides.\n\nConnections wizard: open Connections in your selected workspace. Offline instructions: connections-guide-en.html / connections-guide-ru.html. Agent commands: connections-agent.md. URL-only .qoopia-connection files configure OAuth clients separately from transcript capture and background model login.\n');
await prepareMemoryModel();
const assets=['models','migrations','src/public','scripts/runtime','docs/v4/export-table-policy.json','docs/v4/export-schema-columns.json'];
for(const p of assets){const dest=path.join(out,'assets',p);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.cpSync(p,dest,{recursive:true,dereference:false});}
buildOwnerPeer(path.join(out,'assets/native'));
const tunnel=await prepareCloudflared(path.join(out,'assets/native'));notices.push(tunnel.notice);
notices.push(...await prepareLinuxSupport(path.join(out,'assets/native/linux')));
// unpdf loads its vendored PDF.js dynamically by path; carry exact pinned module in the artifact.
fs.mkdirSync(path.join(out,'assets/vendor'),{recursive:true,mode:0o700});
fs.copyFileSync('node_modules/unpdf/dist/pdfjs.mjs',path.join(out,'assets/vendor/pdfjs.mjs'));
durableWrite(path.join(out,'SBOM.json'),JSON.stringify({format:'qoopia-sbom/1',scope:fixture?'resolved production dependency graph plus embedded runtime; legal clearance pending':`resolved production dependency graph plus embedded runtime; approved materials sha256 ${authorization!.legal_materials.sha256}`,dependencies,platform_support:fs.existsSync(path.join(out,'assets/native/linux/PROVENANCE.json'))?JSON.parse(fs.readFileSync(path.join(out,'assets/native/linux/PROVENANCE.json'),'utf8')):null,runtime:{name:'Bun',...bunNotice},vendored:[{name:'cloudflared',...tunnel.provenance,modules:tunnel.modules},{name:'pdf.js',version:'5.4.296',sha256:hash(fs.readFileSync('node_modules/unpdf/dist/pdfjs.mjs'))},{name:'onnxruntime-web/wasm',version:'1.29.0',notices:onnxNotices},{name:'multilingual-e5-small',manifest:JSON.parse(fs.readFileSync('models/MODEL-NOTICE.json','utf8'))}]},null,2));
durableWrite(path.join(out,'THIRD-PARTY-NOTICES.txt'),notices.join('\n\n'));
durableWrite(path.join(out,'SOURCE-MANIFEST.json'),JSON.stringify({base_sha:git.stdout.trim(),source_digest:sourceDigest,files:source},null,2));
durableWrite(path.join(out,'VERIFY.txt'),fixture?'TEST FIXTURE ONLY. Self-signing is not publisher trust or macOS notarization. First-download verifier trust must be established separately. No public release permitted.\n':`Publisher signature verified against approved key sha256 ${hash(publicPem)}. First-download trust still requires the independently pinned key and authorized release channel.\n`);
if(fixture)durableWrite(path.join(out,'TEST-PUBLIC-KEY.pem'),publicPem);
durableWrite(path.join(out,OPS_READER_MEMBER),JSON.stringify(OPS_READER_CAPABILITY));
// Signed observation of this executable's bootstrap, not a claimed minimum for a full agent workload.
durableWrite(path.join(out,'BOOTSTRAP-MEASUREMENT.json'),JSON.stringify(measureBootstrap(path.join(out,'qoopia')),null,2));
if(publisher&&target==='darwin-arm64'){
 signAndVerifyDarwin([path.join(out,'assets/native/owner-peer.dylib'),path.join(out,'assets/native/cloudflared')],path.join(out,'qoopia'),authorization!.darwin!);
}
// Developer ID signing changes the Mach-O bytes. Preserve the upstream digest
// for attribution and bind provenance/SBOM to the bytes actually shipped.
tunnel.provenance.binary_sha256=hash(fs.readFileSync(path.join(out,'assets/native/cloudflared')));
durableWrite(path.join(out,'assets/native/cloudflared-PROVENANCE.json'),JSON.stringify(tunnel.provenance));
const sealedSbom=JSON.parse(fs.readFileSync(path.join(out,'SBOM.json'),'utf8'));
sealedSbom.vendored=sealedSbom.vendored.map((component:{name:string})=>component.name==='cloudflared'?{name:'cloudflared',...tunnel.provenance,modules:tunnel.modules}:component);
durableWrite(path.join(out,'SBOM.json'),JSON.stringify(sealedSbom,null,2));
// Canonical package permissions do not inherit dependency-cache modes or host umask.
for(const member of Object.keys(inventory(out)))fs.chmodSync(path.join(out,member),member==='qoopia'||member===launcher||member===graphicalLauncher||['assets/native/cloudflared','assets/native/linux/bwrap','assets/native/linux/bwrap.bin'].includes(member)?0o755:0o644);
// Exercise the packaged permissions before sealing; preparation alone does not
// prove the final artifact can launch its managed transport child.
const tunnelSmoke=spawnSync(path.join(out,'assets/native/cloudflared'),['--version'],{encoding:'utf8',timeout:10_000,env:{PATH:'/usr/bin:/bin'}});
if(tunnelSmoke.status!==0||!tunnelSmoke.stdout.startsWith('cloudflared version '+tunnel.provenance.version+' '))throw new Error('Final packaged tunnel is not executable');
const manifest=bundleSchema.parse({format:'qoopia-bundle/1',version:pkg.version,horizon:'QOOPIA-V-1',api_version:1,build_sha:git.stdout.trim(),source_digest:sourceDigest,target,bun_version:Bun.version,schema_min:32,schema_max:43,signing:fixture?'test-fixture':'publisher',publisher_key_sha256:hash(publicPem),platform_signing:fixture?'NOT_RUN':'externally_verified',members:inventory(out)});
const raw=JSON.stringify(manifest),rawBytes=Buffer.from(raw),signature=fixture?sign(null,rawBytes,privateKey!):runPublisherSigner(value('--signer')!,rawBytes,publicPem);
durableWrite(path.join(out,'manifest.json'),raw);durableWrite(path.join(out,'manifest.sig'),signature);
verifyBundle(out,publicPem,fixture);
if(publisher)assertCleanSource();
fs.renameSync(out,finalOut);finalized=true;
const sealedDirectory=JSON.stringify(inventory(finalOut));
let notarization:{status:string,id:string|null,sha256:string}|undefined;
if(publisher&&target==='darwin-arm64'){
 const downloadUrl=value('--update-download-url');if(!downloadUrl)throw new Error('Darwin release requires --update-download-url for the signed appcast');
 await prepareSparkle();
 const dmg=`${finalOut}.dmg`;
 notarization=packageAndNotarizeDarwin(finalOut,dmg,authorization!.darwin!);
 const archive=fs.readFileSync(dmg);durableWrite(`${finalOut}.appcast.xml`,updateFeed(JSON.parse(fs.readFileSync(path.join(finalOut,'DESKTOP-RELEASE.json'),'utf8')),downloadUrl,archive,runPublisherSigner(value('--signer')!,archive,publicPem),publicPem));
 if(JSON.stringify(inventory(finalOut))!==sealedDirectory)throw new Error('Final bundle directory changed after manifest signing');
 durableWrite(`${finalOut}.notarization.json`,JSON.stringify({format:'qoopia-apple-notarization/1',artifact:path.basename(dmg),...notarization}));
 assertCleanSource();
}
console.log(JSON.stringify({status:fixture?'TEST_FIXTURE_BUILT':'PUBLISHER_BUNDLE_BUILT',out:finalOut,target,version:pkg.version,base_sha:git.stdout.trim(),source_digest:sourceDigest,manifest_sha256:hash(raw),publisher_trust:publisher,notarization:notarization?.status??(target==='linux-x64'&&publisher?'NOT_APPLICABLE':'NOT_RUN'),distributable_sha256:notarization?.sha256??null,bytes:Object.values(manifest.members).reduce((n,r)=>n+r.size,0)}));
