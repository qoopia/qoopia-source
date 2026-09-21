import {SPARKLE} from './prepare-sparkle.ts';
import {desktopReleaseSchema,DESKTOP_RELEASE} from '../src/delivery/desktop-update.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hash } from '../src/utils/fs.ts';

const hex=z.string().regex(/^[a-f0-9]{64}$/),sha=z.string().regex(/^[a-f0-9]{40}$/);
const authorizationSchema=z.object({
  format:z.literal('qoopia-release-authorization/1'),build_sha:sha,target:z.enum(['darwin-arm64','linux-x64']),publisher_key_sha256:hex,
  publisher_custody:z.literal('approved'),legal_materials:z.object({path:z.string(),sha256:hex}).strict(),
  darwin:z.object({codesign_identity:z.string().min(1),notary_keychain_profile:z.string().min(1),notary_keychain:z.string().min(1)}).strict().optional(),
}).strict();
export type ReleaseAuthorization=z.infer<typeof authorizationSchema>;

function regularAbsoluteFile(file:string,label:string) {
  if(!path.isAbsolute(file))throw new Error(`${label} path must be absolute`);
  let stat:fs.Stats;try{stat=fs.lstatSync(file);}catch{throw new Error(`${label} file is absent`);}
  if(stat.isSymbolicLink()||!stat.isFile())throw new Error(`${label} must be a regular non-symlink file`);
}

export function assertCleanSource(cwd=process.cwd()) {
  const run=spawnSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd,encoding:'utf8'});
  if(run.status!==0)throw new Error('Release build refused: source status unavailable');
  if(run.stdout!=='')throw new Error('Release build refused: source checkout is not clean');
}

export function loadReleaseAuthorization(file:string,expected:{buildSha:string,target:string,publisherKeySha256:string}) {
  // Trusted provisioning boundary: this operator-supplied file is required input, not approval derived from bundle contents.
  regularAbsoluteFile(file,'Release authorization');
  let authorization:ReleaseAuthorization;
  try{authorization=authorizationSchema.parse(JSON.parse(fs.readFileSync(file,'utf8')));}catch(error){
    const text=String(error);
    if(text.includes('publisher_custody'))throw new Error('Release authorization lacks publisher custody approval');
    if(text.includes('legal_materials'))throw new Error('Release authorization lacks approved legal materials');
    throw new Error(`Release authorization invalid: ${text}`);
  }
  if(authorization.build_sha!==expected.buildSha||authorization.target!==expected.target||authorization.publisher_key_sha256!==expected.publisherKeySha256)throw new Error('Release authorization does not bind the exact build, target, and publisher key');
  regularAbsoluteFile(authorization.legal_materials.path,'Approved legal materials');
  if(hash(fs.readFileSync(authorization.legal_materials.path))!==authorization.legal_materials.sha256)throw new Error('Approved legal materials digest mismatch');
  if(expected.target==='darwin-arm64'&&!authorization.darwin)throw new Error('Darwin platform signing authorization is absent');
  if(authorization.darwin)regularAbsoluteFile(authorization.darwin.notary_keychain,'Notary keychain');
  return authorization;
}

export function runPublisherSigner(signer:string,raw:Buffer,publicKey:string) {
  regularAbsoluteFile(signer,'Publisher signer');
  if((fs.statSync(signer).mode&0o111)===0)throw new Error('Publisher signer is not executable');
  const run=spawnSync(signer,[],{input:raw,stdio:['pipe','pipe','inherit'],maxBuffer:1024*1024,env:process.env});
  if(run.status!==0)throw new Error('Publisher signer failed');
  const signature=Buffer.from(run.stdout);
  if(!verify(null,raw,publicKey,signature))throw new Error('Publisher signer returned an invalid signature');
  return signature;
}

export type CommandRunner=(command:string,args:string[])=>{status:number|null,stdout?:string|Buffer,stderr?:string|Buffer};
const systemRunner:CommandRunner=(command,args)=>spawnSync(command,args,{encoding:'utf8'});
function checked(command:string,args:string[],message:string,runner:CommandRunner=systemRunner) {
  const run=runner(command,args);
  if(run.status!==0)throw new Error(message);
  return run.stdout?.toString()??'';
}

function assertDeveloperId(binary:string,identity:string,runner:CommandRunner) {
  const details=runner('/usr/bin/codesign',['-dv','--verbose=4',binary]);
  if(details.status!==0)throw new Error('Developer ID signature inspection failed');
  const text=`${details.stdout??''}\n${details.stderr??''}`;
  if(!text.split('\n').includes(`Authority=${identity}`)||!/^TeamIdentifier=[A-Z0-9]+$/m.test(text))throw new Error('Native part is not signed with the authorized Developer ID Application identity');
}

const bunRuntimeEntitlements=fileURLToPath(new URL('./darwin-runtime-entitlements.plist',import.meta.url));
const bunRuntimeEntitlementKeys=['com.apple.security.cs.allow-jit','com.apple.security.cs.allow-unsigned-executable-memory','com.apple.security.cs.disable-executable-page-protection','com.apple.security.cs.allow-dyld-environment-variables','com.apple.security.cs.disable-library-validation'].sort();

export function signAndVerifyDarwin(libraries:string[],bunExecutable:string,authorization:NonNullable<ReleaseAuthorization['darwin']>,runner:CommandRunner=systemRunner,sparkleArchive={file:path.resolve('.cache/sparkle-'+SPARKLE.version+'/archive.tar.xz'),sha256:SPARKLE.sha256}) {
  if(process.platform!=='darwin')throw new Error('Darwin platform signing requires a Darwin build host');
  if(authorization.codesign_identity==='-'||!authorization.codesign_identity.startsWith('Developer ID Application:'))throw new Error('Darwin release requires an explicit Developer ID Application identity');
  for(const binary of [...libraries,bunExecutable]){
    const args=['--force','--options','runtime','--timestamp','--sign',authorization.codesign_identity];
    if(binary===bunExecutable)args.push('--entitlements',bunRuntimeEntitlements);
    checked('/usr/bin/codesign',[...args,binary],'Developer ID signing failed',runner);
    checked('/usr/bin/codesign',['--verify','--strict','--verbose=2',binary],'Developer ID signature verification failed',runner);
    assertDeveloperId(binary,authorization.codesign_identity,runner);
  }
  const entitlements=checked('/usr/bin/codesign',['-d','--entitlements',':-',bunExecutable],'Bun runtime entitlement inspection failed',runner);
  const keys=[...entitlements.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g)].map(match=>match[1]).sort();
  if(JSON.stringify(keys)!==JSON.stringify(bunRuntimeEntitlementKeys)||bunRuntimeEntitlementKeys.some(key=>!new RegExp(`<key>\\s*${key.replaceAll('.','\\.')}\\s*</key>\\s*<true\\s*/>`).test(entitlements)))throw new Error('Bun executable runtime entitlements are missing or unexpected');
}

export function packageAndNotarizeDarwin(directory:string,dmg:string,authorization:NonNullable<ReleaseAuthorization['darwin']>,runner:CommandRunner=systemRunner,sparkleArchive={file:path.resolve('.cache/sparkle-'+SPARKLE.version+'/archive.tar.xz'),sha256:SPARKLE.sha256}) {
  if(process.platform!=='darwin')throw new Error('Darwin release packaging requires a Darwin build host');
  if(fs.existsSync(dmg))throw new Error('Darwin distributable path must be new');
  const work=path.join(path.dirname(dmg),`.${path.basename(dmg)}.building-${process.pid}.dmg`);
  const stage=fs.mkdtempSync(path.join(path.dirname(dmg),'.qoopia-app-'));
  try{
    const app=path.join(stage,'Qoopia.app'),contents=path.join(app,'Contents'),resources=path.join(contents,'Resources');
    fs.mkdirSync(path.join(contents,'MacOS'),{recursive:true});fs.mkdirSync(resources);
    fs.cpSync(directory,path.join(resources,'bundle'),{recursive:true});
    const desktop=desktopReleaseSchema.parse(JSON.parse(fs.readFileSync(path.join(directory,DESKTOP_RELEASE),'utf8')));
    if(hash(fs.readFileSync(sparkleArchive.file))!==sparkleArchive.sha256)throw new Error('Sparkle archive checksum mismatch');
    const sparkle=path.join(stage,'sparkle');fs.mkdirSync(sparkle);
    checked('/usr/bin/tar',['-xJf',sparkleArchive.file,'-C',sparkle],'Sparkle extraction failed',runner);
    fs.mkdirSync(path.join(contents,'Frameworks'));
    const framework=path.join(contents,'Frameworks','Sparkle.framework');
    checked('/usr/bin/ditto',[path.join(sparkle,'Sparkle.framework'),framework],'Sparkle copy failed',runner);
    for(const nested of ['Versions/B/XPCServices/Installer.xpc','Versions/B/XPCServices/Downloader.xpc','Versions/B/Autoupdate','Versions/B/Updater.app',''])checked('/usr/bin/codesign',['--force','--options','runtime','--timestamp','--sign',authorization.codesign_identity,path.join(framework,nested)],'Sparkle signing failed',runner);
    fs.writeFileSync(path.join(contents,'Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.qoopia.desktop</string><key>CFBundleName</key><string>Qoopia</string><key>CFBundleExecutable</key><string>Qoopia</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>'+desktop.version+'</string><key>CFBundleVersion</key><string>'+desktop.build+'</string><key>SUFeedURL</key><string>'+desktop.feed_url+'</string><key>SUPublicEDKey</key><string>'+desktop.public_ed_key+'</string><key>SUEnableAutomaticChecks</key><true/><key>SUAllowsAutomaticUpdates</key><true/><key>SUAutomaticallyUpdate</key><true/><key>SUVerifyUpdateBeforeExtraction</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict><key>LSMinimumSystemVersion</key><string>15.0</string><key>CFBundleIconFile</key><string>Qoopia</string><key>NSHighResolutionCapable</key><true/><key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Qoopia memory connection</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Owner</string><key>CFBundleTypeExtensions</key><array><string>qoopia-memory</string><string>qoopia-connection</string></array></dict></array></dict></plist>');
    const iconset=path.join(stage,'Qoopia.iconset');
    checked('/usr/bin/xcrun',['swift',fileURLToPath(new URL('./darwin-icon.swift',import.meta.url)),iconset,path.join(directory,'assets/src/public/brand/graphite/icon-1024.png')],'Desktop icon creation failed',runner);
    checked('/usr/bin/xcrun',['swift',fileURLToPath(new URL('./darwin-tray-icon.swift',import.meta.url)),path.join(directory,'assets/src/public/brand/graphite/qoopia-mark-ivory.svg'),path.join(resources,'QoopiaTray.tiff')],'Menu bar mark creation failed',runner);
    checked('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(resources,'Qoopia.icns')],'Desktop icon packaging failed',runner);
    fs.rmSync(iconset,{recursive:true,force:true});
    checked('/usr/bin/ditto',[path.join(sparkle,'LICENSE'),path.join(contents,'Resources','Sparkle-LICENSE.txt')],'Sparkle license copy failed',runner);
    fs.rmSync(sparkle,{recursive:true,force:true});
    // Match the bundled tunnel's minimum OS, independent of the builder's SDK.
    checked('/usr/bin/xcrun',['swiftc',fileURLToPath(new URL('./darwin-launcher.swift',import.meta.url)),'-target','arm64-apple-macos15.0','-O','-framework','AppKit','-framework','WebKit','-framework','ServiceManagement','-F',path.join(contents,'Frameworks'),'-framework','Sparkle','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks','-o',path.join(contents,'MacOS','Qoopia')],'Desktop launcher compilation failed',runner);
    checked('/usr/bin/codesign',['--force','--options','runtime','--timestamp','--sign',authorization.codesign_identity,app],'Desktop app signing failed',runner);
    checked('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],'Desktop app signature verification failed',runner);
    assertDeveloperId(app,authorization.codesign_identity,runner);
    // Staple the application before sealing it inside the disk image, so the
    // copied app carries its ticket independently of the downloaded DMG.
    const appArchive=path.join(stage,'Qoopia-notary.zip');
    checked('/usr/bin/ditto',['-c','-k','--keepParent',app,appArchive],'App notarization archive failed',runner);
    const appOutput=checked('/usr/bin/xcrun',['notarytool','submit',appArchive,'--keychain-profile',authorization.notary_keychain_profile,'--keychain',authorization.notary_keychain,'--wait','--output-format','json'],'Apple app notarization failed',runner);
    let appResult:{status?:string,id?:string};try{appResult=JSON.parse(appOutput);}catch{throw new Error('Apple app notarization returned invalid output');}
    if(appResult.status!=='Accepted')throw new Error(`Apple app notarization was not accepted: ${appResult.status??'unknown'}`);
    checked('/usr/bin/xcrun',['stapler','staple',app],'App notarization stapling failed',runner);
    checked('/usr/bin/xcrun',['stapler','validate',app],'App notarization staple validation failed',runner);
    checked('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],'Stapled app signature verification failed',runner);
    checked('/usr/sbin/spctl',['-a','-t','execute','-v',app],'Gatekeeper app verification failed',runner);
    fs.rmSync(appArchive,{force:true});
    fs.symlinkSync('/Applications',path.join(stage,'Applications'));
    fs.writeFileSync(path.join(stage,'START-HERE.txt'),'Drag Qoopia to Applications, then open Qoopia.\nYour dashboard opens inside Qoopia. Close its window to keep running in the menu bar. Use Check for Updates from the Qoopia menu. Updates preserve your data and connections.\nYour data stays in your local Application Support/Qoopia folder.\n');
    checked('/usr/bin/hdiutil',['create','-srcfolder',stage,'-volname','Qoopia','-format','UDZO','-ov',work],'DMG creation failed',runner);
    checked('/usr/bin/codesign',['--force','--timestamp','--sign',authorization.codesign_identity,work],'DMG signing failed',runner);
    checked('/usr/bin/codesign',['--verify','--strict','--verbose=2',work],'DMG signature verification failed',runner);
    const output=checked('/usr/bin/xcrun',['notarytool','submit',work,'--keychain-profile',authorization.notary_keychain_profile,'--keychain',authorization.notary_keychain,'--wait','--output-format','json'],'Apple notarization failed',runner);
    let result:{status?:string,id?:string};try{result=JSON.parse(output);}catch{throw new Error('Apple notarization returned invalid output');}
    if(result.status!=='Accepted')throw new Error(`Apple notarization was not accepted: ${result.status??'unknown'}`);
    checked('/usr/bin/xcrun',['stapler','staple',work],'Apple notarization stapling failed',runner);
    checked('/usr/bin/xcrun',['stapler','validate',work],'Apple notarization staple validation failed',runner);
    checked('/usr/sbin/spctl',['-a','-t','open','--context','context:primary-signature','-v',work],'Gatekeeper DMG verification failed',runner);
    const digest=hash(fs.readFileSync(work));
    fs.renameSync(work,dmg);
    if(hash(fs.readFileSync(dmg))!==digest)throw new Error('Final DMG read-back digest mismatch');
    return {status:result.status,id:result.id??null,sha256:digest,app:{status:appResult.status,id:appResult.id??null,stapled:true}};
  }finally{if(fs.existsSync(work))fs.rmSync(work);fs.rmSync(stage,{recursive:true,force:true});}
}
