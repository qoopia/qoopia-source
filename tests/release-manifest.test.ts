import { test, expect } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inventory, hash } from "../src/utils/fs.ts";
import { inspectReleaseArtifact, assertReleaseIdentity, buildReleaseManifest } from "../scripts/build-release-manifest.ts";

// Independent synthetic signing identity: no production key or data is used.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-manifest-"));
  const bundle = path.join(root, "bundle"); fs.mkdirSync(bundle);
  const pair = generateKeyPairSync("ed25519");
  const trust = pair.publicKey.export({type:"spki",format:"pem"}).toString();
  for (const name of ['qoopia','assets/src/public/dashboard.html', 'assets/src/public/brand/dashboard.js','assets/migrations/037-skill-loop.sql','SBOM.json','THIRD-PARTY-NOTICES.txt','assets/scripts/runtime/codex-seatbelt.py','assets/native/owner-peer.so']) {
    const file = path.join(bundle,name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,"synthetic",{mode:0o644});
  }
  const manifest = {format:'qoopia-bundle/1',version:'5.0.3',horizon:'QOOPIA-V-1',api_version:1,build_sha:'a'.repeat(40),source_digest:hash('synthetic'),target:'linux-x64',bun_version:Bun.version,schema_min:32,schema_max:37,signing:'publisher',publisher_key_sha256:hash(trust),platform_signing:'externally_verified',members:inventory(bundle)};
  const raw = JSON.stringify(manifest);
  fs.writeFileSync(path.join(bundle,"manifest.json"),raw);
  fs.writeFileSync(path.join(bundle,"manifest.sig"),sign(null,Buffer.from(raw),pair.privateKey));
  const archive = path.join(root,"qoopia-5.0.3-linux-x64.tar.gz");
  const pack = () => { if(spawnSync("tar",["-czf",archive,"-C",root,"bundle"]).status!==0) throw new Error("fixture archive failed"); };
  pack();
  return {root,bundle,trust,archive,pack};
}
test("archive inspection authenticates inventory and rejects source/version mismatch", () => {
  const f=fixture();
  try {
    const m=inspectReleaseArtifact(f.archive,"linux-x64",f.trust);
    expect(() => assertReleaseIdentity([m,m],"5.0.3","a".repeat(40))).not.toThrow();
    expect(() => assertReleaseIdentity([m,m],"5.0.3","b".repeat(40))).toThrow(/source/);
    expect(() => assertReleaseIdentity([m,m],"5.0.4","a".repeat(40))).toThrow(/version/);
    expect(() => assertReleaseIdentity([m,{...m,source_digest:"b".repeat(64)}],"5.0.3","a".repeat(40))).toThrow(/inventories/);
    fs.appendFileSync(path.join(f.bundle,"qoopia"),"tampered"); f.pack();
    expect(() => inspectReleaseArtifact(f.archive,"linux-x64",f.trust)).toThrow(/changed/);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
test("archive inspection rejects untrusted keys and corrupted signatures", () => {
  const f=fixture();
  try {
    const wrong=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString();
    expect(() => inspectReleaseArtifact(f.archive,"linux-x64",wrong)).toThrow(/trust/);
    fs.writeFileSync(path.join(f.bundle,"manifest.sig"),Buffer.alloc(64)); f.pack();
    expect(() => inspectReleaseArtifact(f.archive,"linux-x64",f.trust)).toThrow(/signature/);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
test("manifest rejects malformed release identity before opening packages", () => {
  const input={version:"5.0.3",source:"a".repeat(40),date:"2026-09-15",mac:"absent",linux:"absent",publisherPublicKey:"absent"};
  expect(() => buildReleaseManifest({...input,source:"abc"})).toThrow(/40-character/);
  expect(() => buildReleaseManifest({...input,version:"5.0"})).toThrow(/X.Y.Z/);
  expect(() => buildReleaseManifest(input)).toThrow(/not found/);
});
