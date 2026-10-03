import {desktopRelease} from '../scripts/desktop-release.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { hash, inventory } from '../src/utils/fs.ts';
import { bundleTrust, verifyBundle } from '../src/delivery/bundle.ts';
import { assertCleanSource, collectBundleSource, copyBundleAssets, BUNDLE_ASSETS, PUBLIC_SOURCE_EXCLUSIONS, loadReleaseAuthorization, packageAndNotarizeDarwin, runPublisherSigner, signAndVerifyDarwin, type CommandRunner } from '../scripts/bundle-signing.ts';
import { spawnSync } from 'node:child_process';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});delete process.env.TEST_BUNDLE_SIGNING_KEY;});
const temp=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-bundle-signing-'));roots.push(root);return root;};

describe('publisher bundle signing mechanics (test key only; not production qualification)',()=>{
  test('accepts approved pinned inputs and verifies an external signer before returning its signature',()=>{
    const root=temp(),{publicKey,privateKey}=generateKeyPairSync('ed25519');
    const publicPem=publicKey.export({format:'pem',type:'spki'}).toString();
    const privateFile=path.join(root,'test-private.pem');
    fs.writeFileSync(privateFile,privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    process.env.TEST_BUNDLE_SIGNING_KEY=privateFile;
    const signer=path.join(root,'test-signer.ts');
    fs.writeFileSync(signer,"#!/usr/bin/env bun\nimport fs from 'node:fs';import {sign} from 'node:crypto';const chunks=[];for await(const c of Bun.stdin.stream())chunks.push(c);process.stdout.write(sign(null,Buffer.concat(chunks),fs.readFileSync(process.env.TEST_BUNDLE_SIGNING_KEY!)));\n",{mode:0o700});
    const legal=path.join(root,'approved-materials.json');fs.writeFileSync(legal,'approved test material');
    const buildSha='a'.repeat(40),target='linux-x64',authorization=path.join(root,'authorization.json');
    fs.writeFileSync(authorization,JSON.stringify({format:'qoopia-release-authorization/1',build_sha:buildSha,target,publisher_key_sha256:hash(publicPem),publisher_custody:'approved',legal_materials:{path:legal,sha256:hash(fs.readFileSync(legal))}}));

    loadReleaseAuthorization(authorization,{buildSha,target,publisherKeySha256:hash(publicPem)});
    const raw=Buffer.from('manifest bytes');
    expect(runPublisherSigner(signer,raw,publicPem)).toEqual(sign(null,raw,privateKey));
  });

  test('rejects absent custody, legal materials, and Darwin platform authorization',()=>{
    const root=temp(),legal=path.join(root,'legal');fs.writeFileSync(legal,'approved');
    const expected={buildSha:'b'.repeat(40),target:'darwin-arm64',publisherKeySha256:'c'.repeat(64)};
    const file=path.join(root,'authorization.json');
    const write=(value:unknown)=>fs.writeFileSync(file,JSON.stringify(value));
    const base={format:'qoopia-release-authorization/1',build_sha:expected.buildSha,target:expected.target,publisher_key_sha256:expected.publisherKeySha256,legal_materials:{path:legal,sha256:hash(fs.readFileSync(legal))}};
    write(base);expect(()=>loadReleaseAuthorization(file,expected)).toThrow('publisher custody approval');
    write({...base,publisher_custody:'approved',legal_materials:{path:path.join(root,'missing'),sha256:'d'.repeat(64)}});expect(()=>loadReleaseAuthorization(file,expected)).toThrow('legal materials');
    write({...base,publisher_custody:'approved'});expect(()=>loadReleaseAuthorization(file,expected)).toThrow('Darwin platform signing authorization');
  });

  test('rejects a signer whose output does not verify under the approved public key',()=>{
    const root=temp(),{publicKey}=generateKeyPairSync('ed25519'),signer=path.join(root,'bad-signer');
    fs.writeFileSync(signer,'#!/bin/sh\nprintf not-a-signature\n',{mode:0o700});
    expect(()=>runPublisherSigner(signer,Buffer.from('manifest'),publicKey.export({format:'pem',type:'spki'}).toString())).toThrow('Publisher signer returned an invalid signature');
  });

  test('signs only the Bun executable with runtime entitlements and uses a temporary .dmg filename',()=>{
    if(process.platform!=='darwin')return;
    const root=temp(),directory=path.join(root,'bundle'),dmg=path.join(root,'bundle.dmg');fs.mkdirSync(directory);
    const archive=path.join(root,'sparkle.tar.xz');fs.writeFileSync(archive,'synthetic archive');
    fs.writeFileSync(path.join(directory,'DESKTOP-RELEASE.json'),JSON.stringify(desktopRelease(generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString(),100)));
    const calls:string[]=[];let signedEntitlements='';
    const runner:CommandRunner=(command,args)=>{
      calls.push([command,...args].join(' '));
      if(command==='/usr/bin/hdiutil'){const output=args.at(-1)!;fs.writeFileSync(output.endsWith('.dmg')?output:`${output}.dmg`,'stapled-dmg-fixture');}
      if(command==='/usr/bin/codesign'&&args[0]==='--force'&&args.includes('--entitlements'))signedEntitlements=fs.readFileSync(args[args.indexOf('--entitlements')+1],'utf8');
      if(args[0]==='notarytool')return {status:0,stdout:JSON.stringify({status:'Accepted',id:'test-request'})};
      if(args[0]==='-d'&&args[1]==='--entitlements')return {status:0,stdout:signedEntitlements};
      if(args[0]==='-dv')return {status:0,stderr:'Authority=Developer ID Application: Example (TEAM123)\nTeamIdentifier=TEAM123\n'};
      return {status:0,stdout:''};
    };
    const authorization={codesign_identity:'Developer ID Application: Example (TEAM123)',notary_keychain_profile:'owner-profile',notary_keychain:'/Users/example/Library/Keychains/login.keychain-db'};
    signAndVerifyDarwin(['/native/owner-peer.dylib'],'/bin/qoopia',authorization,runner);
    const receipt=packageAndNotarizeDarwin(directory,dmg,authorization,runner,{file:archive,sha256:hash(fs.readFileSync(archive))});
    expect(receipt).toEqual({status:'Accepted',id:'test-request',sha256:hash(fs.readFileSync(dmg)),app:{status:'Accepted',id:'test-request',stapled:true}});
    const signs=calls.filter(call=>call.startsWith('/usr/bin/codesign --force'));
    expect(signs).toHaveLength(9);
    expect(signs[0]).not.toContain('--entitlements');
    expect(signs[1]).toContain('--options runtime --timestamp --sign Developer ID Application: Example (TEAM123) --entitlements ');
    expect(signs[1]).toEndWith(' /bin/qoopia');
    expect(calls).toContain('/usr/bin/codesign -d --entitlements :- /bin/qoopia');
    const submissions=calls.filter(call=>call.includes('notarytool submit'));
    expect(submissions).toHaveLength(2);
    const appSubmit=submissions[0],app=appSubmit.split(' ')[3].replace('Qoopia-notary.zip','Qoopia.app');
    expect(calls.indexOf(`/usr/bin/xcrun stapler validate ${app}`)).toBeGreaterThan(calls.indexOf(appSubmit));
    expect(calls.indexOf(`/usr/sbin/spctl -a -t execute -v ${app}`)).toBeLessThan(calls.findIndex(call=>call.startsWith('/usr/bin/hdiutil')));
    const submit=submissions[1],work=submit.split(' ')[3],notarize=calls.indexOf(submit);
    expect(calls.slice(notarize-2,notarize+1)).toEqual([
      `/usr/bin/codesign --force --timestamp --sign Developer ID Application: Example (TEAM123) ${work}`,
      `/usr/bin/codesign --verify --strict --verbose=2 ${work}`,
      submit,
    ]);
    expect(work).toEndWith('.dmg');
    expect(submit).toContain('--keychain /Users/example/Library/Keychains/login.keychain-db');
  });

  test('rejects ad-hoc identity and non-Developer-ID inspection output',()=>{
    if(process.platform!=='darwin')return;
    expect(()=>signAndVerifyDarwin(['/native/a'],'/bin/qoopia',{codesign_identity:'-',notary_keychain_profile:'test',notary_keychain:'/tmp/test.keychain'},()=>({status:0}))).toThrow('Developer ID Application');
    expect(()=>signAndVerifyDarwin(['/native/a'],'/bin/qoopia',{codesign_identity:'Developer ID Application: Example (TEAM123)',notary_keychain_profile:'test',notary_keychain:'/tmp/test.keychain'},((_command,args)=>args[0]==='-dv'?{status:0,stderr:'Signature=adhoc\nTeamIdentifier=not set\n'}:{status:0}) as CommandRunner)).toThrow('not signed with the authorized Developer ID Application identity');
  });
});

test('installer SOURCE-MANIFEST skips private-only paths, and the exclusion list stays current',()=>{
  const source=collectBundleSource();
  expect(source['src/index.ts']).toMatch(/^[a-f0-9]{64}$/);
  for(const p of PUBLIC_SOURCE_EXCLUSIONS){expect(fs.existsSync(p)).toBe(true);expect(source[p]).toBeUndefined();}
});

test('publisher clean-source gate refuses gitignored files under bundle roots, not prepared models/',()=>{
  const repo=temp(),run=(...args:string[])=>expect(spawnSync('git',['-C',repo,'-c','user.email=a@example.test','-c','user.name=a',...args]).status).toBe(0);
  run('init','-q');fs.writeFileSync(path.join(repo,'.gitignore'),'.env\n*.log\n/models/\n');
  fs.mkdirSync(path.join(repo,'src/public'),{recursive:true});fs.writeFileSync(path.join(repo,'src/public/app.js'),'1\n');
  run('add','-A');run('commit','-q','-m','fixture');
  expect(()=>assertCleanSource(repo)).not.toThrow();
  fs.mkdirSync(path.join(repo,'models'));fs.writeFileSync(path.join(repo,'models/model.onnx'),'prepared');
  expect(()=>assertCleanSource(repo)).not.toThrow();
  fs.writeFileSync(path.join(repo,'src/public/.env'),'SECRET=synthetic\n');
  expect(()=>assertCleanSource(repo)).toThrow('ignored files');
});

/** One test key; each call writes a minimal signed bundle with the given signing mode. */
function signedBundle() {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),trust=publicKey.export({type:'spki',format:'pem'}).toString();
  const bundle=(signing:'publisher'|'test-fixture')=>{
    const root=temp();
    for(const file of ['qoopia','assets/src/public/dashboard.html','assets/migrations/037-skill-loop.sql','SBOM.json','THIRD-PARTY-NOTICES.txt','assets/scripts/runtime/codex-seatbelt.py',`assets/native/owner-peer.${process.platform==='darwin'?'dylib':'so'}`]){
      fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true,mode:0o700});fs.writeFileSync(path.join(root,file),file,{mode:0o644});
    }
    const manifest={format:'qoopia-bundle/1',version:'5.0.0-test',horizon:'QOOPIA-V-1',api_version:1,build_sha:'a'.repeat(40),source_digest:hash('fixture'),target:`${process.platform}-${process.arch}`,bun_version:Bun.version,schema_min:32,schema_max:37,signing,publisher_key_sha256:hash(trust),platform_signing:'NOT_RUN',members:inventory(root)};
    const raw=Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(root,'manifest.json'),raw,{mode:0o644});fs.writeFileSync(path.join(root,'manifest.sig'),sign(null,raw,privateKey),{mode:0o644});
    return {root,manifest};
  };
  return {trust,bundle};
}

test('F-237 verifyBundle trusts members only from the exact manifest bytes whose signature it checked',()=>{
  const {trust,bundle}=signedBundle(),{root,manifest}=bundle('test-fixture'),manifestFile=path.join(root,'manifest.json');
  expect(verifyBundle(root,trust,true).manifest.version).toBe('5.0.0-test');
  // Tamper a member and forge a manifest whose member table matches the tampered tree.
  fs.appendFileSync(path.join(root,'assets/src/public/dashboard.html'),'<script>injected</script>');
  const forged=Buffer.from(JSON.stringify({...manifest,members:inventory(root,new Set(['manifest.json','manifest.sig']))}));
  // A concurrent writer swaps manifest.json right after the verifier's first read of it, whichever API it uses.
  const io=fs as unknown as Record<'readFileSync'|'openSync'|'closeSync',(...a:unknown[])=>unknown>,original={...io},fds=new Set<unknown>();
  let swapped=false;const swap=()=>{if(!swapped){swapped=true;fs.writeFileSync(manifestFile,forged);}};
  io.readFileSync=(...a)=>{const out=original.readFileSync(...a);if(a[0]===manifestFile)swap();return out;};
  io.openSync=(...a)=>{const fd=original.openSync(...a);if(a[0]===manifestFile)fds.add(fd);return fd;};
  io.closeSync=(...a)=>{const out=original.closeSync(...a);if(fds.delete(a[0]))swap();return out;};
  try{expect(()=>verifyBundle(root,trust,true)).toThrow('Bundle member hashes, modes or file set changed');}
  finally{Object.assign(io,original);}
  expect(swapped).toBe(true);
});

test('F-338 version trust comes from the verified manifest, not from the build kind',()=>{
  const {trust,bundle}=signedBundle(),publisher=bundle('publisher').root;
  expect(bundleTrust(publisher,trust)).toBe('publisher signature verified');
  expect(bundleTrust(bundle('test-fixture').root,trust)).toBe('test fixture builds do not establish publisher trust');
  fs.appendFileSync(path.join(publisher,'qoopia'),'tamper');
  expect(bundleTrust(publisher,trust)).toBe('not verified: Bundle member hashes, modes or file set changed');
  expect(bundleTrust(temp(),trust)).toStartWith('not verified: ');
});

test('bundle assets leave out migrations/rollback, which the runtime never reads [F-303]',()=>{
  const root=temp(),assets=path.join(temp(),'assets');
  for(const p of BUNDLE_ASSETS){const file=p.endsWith('.json')?path.join(root,p):path.join(root,p,'fixture.txt');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{}');}
  fs.mkdirSync(path.join(root,'migrations/rollback'),{recursive:true});
  for(const file of ['migrations/001-a.sql','migrations/rollback/001-a.rollback.sql'])fs.writeFileSync(path.join(root,file),'SELECT 1;');
  copyBundleAssets(root,assets);
  expect(fs.readFileSync(path.join(assets,'migrations/001-a.sql'),'utf8')).toBe('SELECT 1;');
  expect(fs.existsSync(path.join(assets,'migrations/rollback'))).toBe(false);
  expect(fs.existsSync(path.join(assets,'docs/v4/export-table-policy.json'))).toBe(true);
});
