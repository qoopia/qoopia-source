import {desktopRelease} from '../scripts/desktop-release.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { hash } from '../src/delivery/files.ts';
import { loadReleaseAuthorization, packageAndNotarizeDarwin, runPublisherSigner, signAndVerifyDarwin, type CommandRunner } from '../scripts/bundle-signing.ts';

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
