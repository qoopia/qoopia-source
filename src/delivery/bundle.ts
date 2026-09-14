import fs from 'node:fs';
import path from 'node:path';
import { verify } from 'node:crypto';
import { z } from 'zod';
import { inventory, readJson, hash } from './files.ts';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const bundleSchema = z.object({
  format: z.literal('qoopia-bundle/1'), version: z.string().regex(/^5\.0\.0(?:-[a-z0-9.-]+)?$/),
  horizon: z.literal('QOOPIA-V-1'), api_version: z.literal(1), build_sha: z.string().regex(/^[a-f0-9]{40}$/),
  source_digest: hex, target: z.enum(['darwin-arm64', 'linux-x64']), bun_version: z.string(),
  schema_min: z.literal(32), schema_max: z.union([z.literal(37),z.literal(38),z.literal(39),z.literal(40),z.literal(41),z.literal(42),z.literal(43)]),
  signing: z.enum(['test-fixture', 'publisher']), publisher_key_sha256: hex,
  platform_signing: z.enum(['NOT_RUN', 'externally_verified']),
  members: z.record(z.object({ size: z.number().int().nonnegative(), sha256: hex, mode: z.union([z.literal(0o600),z.literal(0o644),z.literal(0o700),z.literal(0o755)]) }).strict()),
}).strict();
export type BundleManifest = z.infer<typeof bundleSchema>;
// An inventory member keeps the existing signed manifest envelope compatible.
// Absence is NOT evidence that an old binary understands holds or journal pointers.
export const OPS_READER_MEMBER = 'OPS-JOURNAL-READER.json';
export const OPS_READER_CAPABILITY = {format:'qoopia-ops-reader/3', reads:['qoopia-ops/1','qoopia-ops/2','qoopia-ops/3'], writes:'qoopia-ops/3'} as const;
export function requireOpsJournalV3(bundle: ReturnType<typeof verifyBundle>) {
  if (!bundle.manifest.members[OPS_READER_MEMBER] ||
      JSON.stringify(readJson(path.join(bundle.root, OPS_READER_MEMBER))) !== JSON.stringify(OPS_READER_CAPABILITY)) {
    throw new Error('OPS_BUNDLE_INCOMPATIBLE: bundle must declare qoopia-ops-reader/3; old binaries cannot be retrofitted');
  }
}
export function verifyBundle(root: string, publicKey: string, allowTest = false, target = `${process.platform}-${process.arch}`) {
  const raw = fs.readFileSync(path.join(root, 'manifest.json'));
  const m = bundleSchema.parse(readJson(path.join(root, 'manifest.json')));
  if (m.publisher_key_sha256 !== hash(publicKey)) throw new Error('Publisher trust root mismatch');
  if (!verify(null, raw, publicKey, fs.readFileSync(path.join(root, 'manifest.sig')))) throw new Error('Bundle signature invalid');
  if (m.signing === 'test-fixture' && !allowTest) throw new Error('Development test signing is not publisher trust; explicit --allow-test-fixture required');
  if (m.target !== target) throw new Error('Unsupported platform: bundle target mismatch');
  for (const required of ['qoopia', 'assets/src/public/dashboard.html', 'assets/migrations/037-skill-loop.sql', 'SBOM.json', 'THIRD-PARTY-NOTICES.txt', 'assets/scripts/runtime/codex-seatbelt.py', `assets/native/owner-peer.${m.target === 'darwin-arm64' ? 'dylib' : 'so'}`]) {
    if (!m.members[required]) throw new Error('Required bundle member missing');
  }
  if(m.schema_max>=38)for(const required of ['assets/migrations/038-memory-continuity.sql','assets/models/multilingual-e5-small/model.onnx','assets/models/MODEL-NOTICE.json'])if(!m.members[required])throw new Error('Required memory bundle member missing');
  if(m.schema_max>=43&&!m.members['assets/migrations/043_my_agent_provider.sql'])throw new Error('Required agent provider migration missing');
  if(m.schema_max>=42&&!m.members['assets/migrations/042-my-agent.sql'])throw new Error('Required agent conversation migration missing');
  if(m.schema_max>=41&&!m.members['assets/migrations/041-connection-origins.sql'])throw new Error('Required connection origin migration missing');
  if(m.schema_max>=40&&!m.members['assets/migrations/040-connections.sql'])throw new Error('Required connections migration missing');
  if(m.schema_max>=39&&!m.members['assets/migrations/039-bridges.sql'])throw new Error('Required bridge migration missing');
  const actual = inventory(root, new Set(['manifest.json', 'manifest.sig']));
  if (JSON.stringify(actual) !== JSON.stringify(m.members)) throw new Error('Bundle member hashes, modes or file set changed');
  return { manifest: m, digest: hash(raw), root };
}
