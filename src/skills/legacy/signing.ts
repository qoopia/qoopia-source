// §4.3 signing profile — byte-precise (BLOCKER-4). Two independent
// implementations MUST produce identical bytes; Appendix F TV-01 is the proof.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { jcsBytes, type JcsValue } from "./jcs.ts";

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/** §4.3.2: manifest_hash = lowercase-hex SHA-256 of JCS(skill.json). */
export function manifestHash(manifest: JcsValue): string {
  return sha256(jcsBytes(manifest)).toString("hex");
}

/** §4.3.2: content_hash = lowercase-hex SHA-256 over JCS bytes of the integrity list. */
export function contentHash(integrity: Array<{ path: string; sha256: string }>): string {
  return sha256(jcsBytes(integrity as unknown as JcsValue)).toString("hex");
}

/** §4.3.4: protected header bytes — EXACTLY this UTF-8, JCS order, no other members. */
export function protectedHeaderBytes(kid: string): Buffer {
  return Buffer.from(`{"alg":"EdDSA","kid":${JSON.stringify(kid)}}`, "utf8");
}

/** §4.3.5: signing input = ASCII( B64URL(P) + "." + B64URL(D) ), D = raw 32-byte SHA-256(JCS(M)). */
export function signingInput(manifest: JcsValue, kid: string): { input: string; d: Buffer; p: Buffer } {
  const p = protectedHeaderBytes(kid);
  const d = sha256(jcsBytes(manifest));
  return { input: `${b64url(p)}.${b64url(d)}`, d, p };
}

/** Deterministic Ed25519 key from a 32-byte raw seed (test vectors / seed package). */
export function keyFromSeedHex(seedHex: string): { privateKey: KeyObject; publicKeyB64url: string } {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyB64url: b64url(spki.subarray(spki.length - 32)) };
}

/** §4.3.6: SIGNATURE.jws = compact DETACHED serialization  B64URL(P) + ".." + B64URL(sig). */
export function signManifest(manifest: JcsValue, privateKey: KeyObject, kid: string): {
  jws: string;
  manifest_hash: string;
  signing_input: string;
} {
  const { input, p } = signingInput(manifest, kid);
  const sig = edSign(null, Buffer.from(input, "ascii"), privateKey);
  return {
    jws: `${b64url(p)}..${b64url(sig)}`,
    manifest_hash: manifestHash(manifest),
    signing_input: input,
  };
}

export interface JwsCheck {
  ok: boolean;
  kid?: string;
  reason?: string;
}

const B64URL_STRICT = /^[A-Za-z0-9_-]+$/;

/** Strict unpadded base64url decode: rejects padding, non-URL alphabet, and non-canonical encodings. */
function b64urlDecodeStrict(s: string): Buffer | null {
  if (!B64URL_STRICT.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s) return null; // canonical round-trip
  return buf;
}

/** Parse + verify a compact detached JWS against a manifest and a raw Ed25519 public key (b64url, 32B).
 *  Byte-exact profile: no whitespace tolerance, no padding, unpadded base64url only. */
export function verifyJws(manifest: JcsValue, jws: string, publicKeyB64url?: string): JwsCheck {
  if (jws !== jws.trim() || /\s/.test(jws)) return { ok: false, reason: "whitespace in serialization" };
  const parts = jws.split(".");
  if (parts.length !== 3 || parts[1] !== "") return { ok: false, reason: "not compact detached (P..sig)" };
  const [pB64, , sigB64] = parts;
  const pBytes = b64urlDecodeStrict(pB64);
  if (!pBytes) return { ok: false, reason: "protected header not strict unpadded base64url" };
  let header: unknown;
  try {
    header = JSON.parse(pBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "protected header not JSON" };
  }
  if (
    typeof header !== "object" ||
    header === null ||
    Array.isArray(header) ||
    (header as any).alg !== "EdDSA" ||
    typeof (header as any).kid !== "string" ||
    Object.keys(header as object).length !== 2
  ) {
    return { ok: false, reason: "protected header must be exactly {alg:EdDSA, kid}" };
  }
  const kid = (header as any).kid as string;
  // byte-exactness: header must equal the canonical serialization for this kid
  if (!pBytes.equals(protectedHeaderBytes(kid))) {
    return { ok: false, kid, reason: "protected header bytes not canonical" };
  }
  // Parse-only mode stops here: the kid must be resolvable (§4.4 step 3) BEFORE
  // the signature is judged, so an unknown kid yields UNKNOWN_KEY rather than
  // being masked by a malformed signature component.
  if (publicKeyB64url === undefined) return { ok: true, kid };

  const sigBytes = b64urlDecodeStrict(sigB64);
  if (!sigBytes || sigBytes.length !== 64) {
    return { ok: false, kid, reason: "signature not strict unpadded base64url of 64 bytes" };
  }
  // Registered public keys are stored in the same strict encoding as everything
  // else in the profile: unpadded base64url of the raw 32 bytes.
  const raw = b64urlDecodeStrict(publicKeyB64url);
  if (!raw || raw.length !== 32) {
    return { ok: false, kid, reason: "registered public key not strict unpadded base64url of 32 bytes" };
  }
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  const { input } = signingInput(manifest, kid);
  const ok = edVerify(null, Buffer.from(input, "ascii"), publicKey, sigBytes);
  return ok ? { ok: true, kid } : { ok: false, kid, reason: "signature invalid" };
}
