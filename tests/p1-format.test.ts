import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { canonical, digest } from "../src/skills/commands.ts";
import { compileContent, sealPackage, parsePackage, checkMembers } from "../src/skills/format.ts";
import { keyFromSeedHex, signManifest, manifestHash, signingInput } from "../src/skills/legacy/signing.ts";
import { readDirectory, readTar, writeTar, gunzipLimited, checkPath } from "../src/skills/legacy/archive.ts";
import { jcsBytes, parseJsonStrict, utf8Decode } from "../src/skills/legacy/jcs.ts";
import { completeContent } from "./helpers/p1-fixtures.ts";

test("T-11: new package v1 golden encoding is frozen before migration and uses a separate signing profile", () => {
  const expected = JSON.parse(readFileSync(new URL("./fixtures/p1/package-v1-digests.json", import.meta.url), "utf8"));
  const bytes = readFileSync(new URL("./fixtures/p1/package-v1.json", import.meta.url));
  const k = keyFromSeedHex(expected.seed), c = compileContent(completeContent, "1.0.0", "MIT");
  expect(c.content_digest).toBe(expected.content_digest); expect(c.candidate_digest).toBe(expected.candidate_digest);
  expect(sealPackage(c.descriptor, c.members, k.privateKey, "fixture-publisher").equals(bytes)).toBe(true);
  expect(digest(bytes)).toBe(expected.package_digest); expect(bytes.length).toBe(expected.byte_length);
  expect(parsePackage(bytes, expected.package_digest, expected.public_key, "fixture-publisher").decodedMembers.size).toBe(2);
  for (const extra of [{ "fixture.txt": "one" }, { "fixture.txt": "two" }]) {
    expect(compileContent(completeContent, "1.0.0", "MIT", extra).candidate_digest).not.toBe(expected.candidate_digest);
  }
  const tampered = JSON.parse(bytes.toString()); tampered.members["SKILL.md"] = Buffer.from("Changed").toString("base64");
  const wrong = Buffer.from(canonical(tampered));
  expect(() => parsePackage(wrong, digest(wrong), expected.public_key, "fixture-publisher")).toThrow("mismatch");
  expect(() => parsePackage(Buffer.concat([bytes, Buffer.from("\n")]), digest(Buffer.concat([bytes, Buffer.from("\n")])), expected.public_key, "fixture-publisher")).toThrow("canonical");
});

test("T-11: original Skillonomia TV-01 intermediate bytes and detached JWS remain exact", () => {
  const files = readDirectory(new URL("./fixtures/p1/legacy-tv-01/package", import.meta.url).pathname);
  const m = JSON.parse(files.get("skill.json")!.toString());
  const key = keyFromSeedHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  expect(key.publicKeyB64url).toBe("A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg");
  expect(jcsBytes(m).length).toBe(1889);
  expect(manifestHash(m)).toBe("5498c4f560409b1dbdf78794d5072a36672e54c825dbad6d0f1b89ea5fd794d0");
  expect(signingInput(m, "tv-key-1").input).toBe("eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0.VJjE9WBAmx2994eU1QcqNmcuVMgl261tDxuJ6l_XlNA");
  expect(signManifest(m, key.privateKey, "tv-key-1").jws).toBe(files.get("SIGNATURE.jws")!.toString());
  expect(digest(files.get("SKILL.md")!)).toBe("9aa9fcc8c19358ef683f752e3dc2f5462661f3e4770a80b484737d8528cafbbb");
  expect(() => parseJsonStrict('{"a":1,"a":2}')).toThrow();
  expect(() => utf8Decode(Buffer.from([0xc0, 0xaf]))).toThrow();
});

function editHeader(input: Buffer, change: (header: Buffer) => void): Buffer {
  const bytes = Buffer.from(input), header = bytes.subarray(0, 512);
  change(header); header.fill(32, 148, 156);
  const sum = header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0");
  header.write(`${sum}\0 `, 148, "ascii"); return bytes;
}
test("T-11: hostile legacy archive paths, links/devices, collisions, encoding and explicit limits are refused", () => {
  const valid = writeTar(new Map([["safe", Buffer.from("x")]]));
  for (const name of ["../escape", "/absolute", "C:/drive", "\\\\server\\share", "a/../b", "e\u0301", "bad\0name", "\ud800"]) {
    expect(() => checkPath(name)).toThrow();
  }
  for (const flag of ["1", "2", "3", "4", "6", "7"]) expect(() => readTar(editHeader(valid, (h) => { h[156] = flag.charCodeAt(0); }))).toThrow();
  expect(() => readTar(editHeader(valid, (h) => { h.fill(0, 0, 100); h.write("../escape", 0); }))).toThrow();
  expect(() => readTar(editHeader(valid, (h) => { h[0] = 0xff; }))).toThrow();
  const second = writeTar(new Map([["SAFE", Buffer.from("y")]]));
  expect(() => readTar(Buffer.concat([valid.subarray(0, -1024), second]))).toThrow();
  const many = new Map(Array.from({ length: 512 }, (_, i) => [`member-${i}`, Buffer.alloc(0)] as const));
  expect(() => readTar(Buffer.concat([writeTar(many).subarray(0, -1024), writeTar(new Map([["member-512", Buffer.alloc(0)]]))]))).toThrow("512");
  expect(() => writeTar(new Map([["large", Buffer.alloc(4 * 1024 * 1024 + 1)]]))).toThrow("4 MiB");
  expect(() => gunzipLimited(gzipSync(Buffer.alloc(1024 * 1024)))).toThrow("ratio");
  expect(() => checkMembers(new Map([["nested.tar", writeTar(many)]]))).toThrow("Aggregate");
});
