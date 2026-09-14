import { z } from "zod";
import type { KeyObject } from "node:crypto";
import { canonical, digest } from "./commands.ts";
import { checkPath, readTar, gunzipLimited, LIMITS } from "./legacy/archive.ts";
import { foldKey } from "./legacy/unicode.ts";
import { parseJsonStrict, utf8Decode, type JcsValue } from "./legacy/jcs.ts";
import { signManifest, verifyJws } from "./legacy/signing.ts";
import { QoopiaError } from "../utils/errors.ts";
import { assertNoSecrets, redactSensitive } from "../utils/secret-guard.ts";

export const COMPILER = "qoopia-structured/1";
export const RENDERER = "qoopia-markdown/1";
export const NATIVE_RENDERER = "qoopia-native-markdown/1";
const text = z.string().max(100_000);
const strings = z.array(text).max(100);
const json: z.ZodType<JcsValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(json),
]));
export const contentSchema = z.object({
  title: z.string().min(1).max(300), purpose: text.default(""), trigger: strings.default([]),
  inputs_schema: z.record(json).default({}), outputs_schema: z.record(json).default({}),
  procedure: strings.default([]), verification: strings.default([]), failure_modes: strings.default([]),
  rollback: text.default(""), compatibility: strings.default([]), requested_capabilities: strings.default([]),
  secret_refs: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(100).default([]),
  redaction_report: strings.default([]),
}).strict();
export type SkillContent = z.infer<typeof contentSchema>;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = z.object({
  format: z.literal("qoopia-skill-candidate/1"), version_label: z.string().min(1).max(100),
  license: z.string().min(1).max(200), compatibility: strings, requested_capabilities: strings,
  secret_placeholders: strings, compiler: z.literal(COMPILER), renderer: z.enum([RENDERER, NATIVE_RENDERER]),
  members: z.record(z.object({ size: z.number().int().nonnegative(), sha256: sha }).strict()),
}).strict();
export type Descriptor = z.infer<typeof descriptorSchema>;

export function validatedContent(input: unknown): SkillContent {
  const result = contentSchema.safeParse(input);
  if (!result.success) throw new QoopiaError("INVALID_INPUT", result.error.message);
  const bytes = canonical(result.data);
  if (Buffer.byteLength(bytes) > LIMITS.maxFileBytes) throw new QoopiaError("SIZE_LIMIT", "Structured content exceeds 4 MiB");
  assertNoSecrets(bytes, "skill.content");
  return result.data;
}
export function missingRequirements(c: SkillContent): string[] {
  return (["purpose", "trigger", "procedure", "verification", "failure_modes", "rollback"] as const)
    .filter((key) => c[key].length === 0);
}
export function contentDigest(content: SkillContent): string { return digest(canonical({ compiler_version: COMPILER, content })); }

export function renderRunbook(c: SkillContent): string {
  return [`# ${c.title}`, c.purpose, "## Trigger", ...c.trigger, "## Inputs", canonical(c.inputs_schema),
    "## Outputs", canonical(c.outputs_schema), "## Procedure", ...c.procedure.map((step, i) => `${i + 1}. ${step}`),
    "## Verification", ...c.verification, "## Failure modes", ...c.failure_modes, "## Rollback", c.rollback,
    "## Compatibility", ...c.compatibility, "## Requested capabilities", ...c.requested_capabilities,
    "## Secret references", ...c.secret_refs.map((name) => `\${${name}}`), ""].join("\n\n");
}

/** Same total budget includes nested archives; none are extracted or executed. */
export function checkMembers(members: Map<string, Buffer>, budget = { files: 0, bytes: 0 }, depth = 0): void {
  if (depth > 3) throw new QoopiaError("SIZE_LIMIT", "Nested archive depth exceeds 3");
  const seen = new Set<string>();
  for (const [name, bytes] of members) {
    checkPath(name);
    const key = foldKey(name);
    if (seen.has(key)) throw new QoopiaError("QUARANTINED", "Colliding member paths");
    seen.add(key);
    budget.files++; budget.bytes += bytes.length;
    if (bytes.length > LIMITS.maxFileBytes || budget.files > LIMITS.maxFiles || budget.bytes > LIMITS.maxTotalBytes) {
      throw new QoopiaError("SIZE_LIMIT", "Aggregate package budget exceeded");
    }
    if (/\.(tar\.gz|tgz|gz)$/i.test(name) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      const decompressed = gunzipLimited(bytes);
      checkMembers(new Map([[name.replace(/\.(gz|tgz)$/i, ".tar"), decompressed]]), budget, depth + 1);
    } else if (/\.tar$/i.test(name) || bytes.subarray(257, 263).equals(Buffer.from("ustar\0"))) {
      checkMembers(readTar(bytes), budget, depth + 1);
    }
  }
}

export function compileContent(content: SkillContent, label: string, license: string, extra: Record<string, string> = {}, nativeName?: string) {
  if (missingRequirements(content).length) throw new QoopiaError("INVALID_INPUT", `Missing requirements: ${missingRequirements(content).join(", ")}`);
  if (nativeName && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(nativeName)) throw new QoopiaError("INVALID_INPUT", "Native name must be a lowercase slug of at most 63 characters");
  const markdown = nativeName ? `---\nname: ${nativeName}\ndescription: ${JSON.stringify(content.purpose.replace(/\s+/g, " ").slice(0, 1024))}\n---\n\n${renderRunbook(content)}` : renderRunbook(content);
  const members = new Map<string, Buffer>([
    ["SKILL.md", Buffer.from(markdown)], ["content.json", Buffer.from(canonical(content))],
  ]);
  for (const [name, value] of Object.entries(extra)) {
    if (members.has(name)) throw new QoopiaError("INVALID_INPUT", "Compiled member cannot be overridden");
    assertNoSecrets(value, "skill.member");
    members.set(name, Buffer.from(value));
  }
  checkMembers(members);
  const descriptor = descriptorSchema.parse({
    format: "qoopia-skill-candidate/1", version_label: label, license,
    compatibility: content.compatibility, requested_capabilities: content.requested_capabilities,
    secret_placeholders: content.secret_refs, compiler: COMPILER, renderer: nativeName ? NATIVE_RENDERER : RENDERER,
    members: Object.fromEntries([...members].map(([name, bytes]) => [name, { size: bytes.length, sha256: digest(bytes) }])),
  });
  assertNoSecrets(canonical(descriptor), "skill.descriptor");
  if (nativeName) assertPortableMembers(members);
  return { descriptor, members: Object.fromEntries([...members].map(([name, bytes]) => [name, bytes.toString("base64")])),
    candidate_digest: digest(canonical(descriptor)), content_digest: contentDigest(content) };
}

export function signaturePayload(descriptor: Descriptor): JcsValue {
  return { profile: "qoopia-skill-signature/1", descriptor } as unknown as JcsValue;
}
export function sealPackage(descriptor: Descriptor, members: Record<string, string>, key: KeyObject, kid: string): Buffer {
  const { jws } = signManifest(signaturePayload(descriptor), key, kid);
  return Buffer.from(canonical({ format: "qoopia-skill-package/1", signature_profile: "qoopia-skill-signature/1", descriptor, members, signature: jws }));
}
export function parsePackage(bytes: Buffer, expectedDigest: string, publicKey: string, expectedKid: string) {
  if (bytes.length > 96 * 1024 * 1024) throw new QoopiaError("SIZE_LIMIT", "Serialized package exceeds 96 MiB");
  if (digest(bytes) !== expectedDigest) throw new QoopiaError("CHECKSUM_MISMATCH", "Transport digest mismatch");
  const parsed = z.object({
    format: z.literal("qoopia-skill-package/1"), signature_profile: z.literal("qoopia-skill-signature/1"),
    descriptor: descriptorSchema, members: z.record(z.string()), signature: z.string().max(4096),
  }).strict().safeParse(parseJsonStrict(utf8Decode(bytes)));
  if (!parsed.success) throw new QoopiaError("QUARANTINED", "Invalid package profile or descriptor");
  const p = parsed.data;
  if (!bytes.equals(Buffer.from(canonical(p)))) throw new QoopiaError("QUARANTINED", "Package encoding must be canonical UTF-8 JCS without trailing bytes");
  const check = verifyJws(signaturePayload(p.descriptor), p.signature, publicKey);
  if (!check.ok || check.kid !== expectedKid) throw new QoopiaError("UNTRUSTED_SIGNING_KEY", "Package signer mismatch or invalid signature");
  const members = new Map<string, Buffer>();
  if (canonical(Object.keys(p.members).sort()) !== canonical(Object.keys(p.descriptor.members).sort())) {
    throw new QoopiaError("CHECKSUM_MISMATCH", "Descriptor member set mismatch");
  }
  for (const [name, encoded] of Object.entries(p.members)) {
    const b = Buffer.from(encoded, "base64"), covered = p.descriptor.members[name]!;
    if (b.toString("base64") !== encoded || b.length !== covered.size || digest(b) !== covered.sha256) {
      throw new QoopiaError("CHECKSUM_MISMATCH", "Covered member bytes mismatch");
    }
    members.set(name, b);
  }
  checkMembers(members);
  return { ...p, decodedMembers: members, candidate_digest: digest(canonical(p.descriptor)), package_digest: expectedDigest };
}

/** Final bytes are screened again at activation, including recursively decoded archives. */
export function assertPortableMembers(members: Map<string, Buffer>, depth = 0, budget={bytes:0,files:0}): void {
  checkMembers(members);
  if (depth > 3) throw new QoopiaError("SIZE_LIMIT", "Nested portable archive limit");
  for (const [name, bytes] of members) {
    if((budget.bytes+=bytes.length)>64*1024*1024 || ++budget.files>512)throw new QoopiaError('SIZE_LIMIT','Aggregate nested portable archive limit');
    for (const value of [name, bytes.toString("utf8")]) {
      assertNoSecrets(value, "portable member");
      if (redactSensitive(value).categories.length) throw new QoopiaError("QUARANTINED", "Portable member requires redaction and a new candidate");
    }
    if (/\.(tar\.gz|tgz|gz)$/i.test(name) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      assertPortableMembers(new Map([[name.replace(/\.(gz|tgz)$/i, ".tar"), gunzipLimited(bytes)]]), depth + 1,budget);
    } else if (/\.tar$/i.test(name)||bytes.subarray(257,263).equals(Buffer.from("ustar\0"))) assertPortableMembers(readTar(bytes), depth + 1,budget);
    else if (/\.(zip|7z|rar)$/i.test(name) || bytes.subarray(0, 2).toString() === "PK") {
      throw new QoopiaError("UNSUPPORTED", "Opaque nested archives cannot enter a native projection");
    }
  }
}
