import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { durableWrite, inventory, hash, privateDirectory } from '../../src/delivery/files.ts';
import { OPS_READER_MEMBER, OPS_READER_CAPABILITY } from '../../src/delivery/bundle.ts';

/** Signed inert bundle for engine tests only; executable dispatch is checked separately. */
export function journalBundleFixture(root: string) {
  const {privateKey, publicKey}=generateKeyPairSync('ed25519');
  const trust=publicKey.export({type:'spki',format:'pem'}).toString();
  const bundle=path.join(root,'fixture-bundle');privateDirectory(bundle);
  for(const name of ['qoopia','assets/src/public/dashboard.html','assets/migrations/037-skill-loop.sql','SBOM.json','THIRD-PARTY-NOTICES.txt','assets/scripts/runtime/codex-seatbelt.py',`assets/native/owner-peer.${process.platform==='darwin'?'dylib':'so'}`]) {
    privateDirectory(path.dirname(path.join(bundle,name)));durableWrite(path.join(bundle,name),'inert test fixture');
  }
  durableWrite(path.join(bundle,OPS_READER_MEMBER),JSON.stringify(OPS_READER_CAPABILITY));
  const raw=JSON.stringify({format:'qoopia-bundle/1',version:'5.0.0-p3.0',horizon:'QOOPIA-V-1',api_version:1,build_sha:'a'.repeat(40),source_digest:hash('fixture'),target:`${process.platform}-${process.arch}`,bun_version:Bun.version,schema_min:32,schema_max:37,signing:'test-fixture',publisher_key_sha256:hash(trust),platform_signing:'NOT_RUN',members:inventory(bundle)});
  durableWrite(path.join(bundle,'manifest.json'),raw);durableWrite(path.join(bundle,'manifest.sig'),sign(null,Buffer.from(raw),privateKey));
  return {bundle,trust,digest:hash(raw)};
}
