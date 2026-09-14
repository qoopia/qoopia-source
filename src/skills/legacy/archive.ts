// §4.1b archive profile (HIGH-5, normative). Package = plain directory or tar
// (POSIX ustar/pax), optionally gzip-compressed. Both packer and verifier
// enforce: relative UTF-8 NFC POSIX paths; forbidden entries; limits.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { isNFC, foldKey } from "./unicode.ts";
import { NotWellFormedText, assertWellFormedText } from "./outcome.ts";

/** The two §4.1b refusals, as a runtime constant so a guard test can compare
 *  them against §4.4.8's verdict vocabulary. §4.1b: every rule fails with
 *  `MALFORMED_ARCHIVE` except the *Limits*, which fail with `LIMIT_EXCEEDED`. */
export const ARCHIVE_ERROR_CODES = ["MALFORMED_ARCHIVE", "LIMIT_EXCEEDED"] as const;

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number];

export class ArchiveError extends Error {
  code: ArchiveErrorCode;
  constructor(code: ArchiveErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// pax keys whose presence does not change how entry bytes are interpreted.
// Anything else (linkpath, GNU.sparse.*, …) is refused rather than ignored;
// `size` is handled separately — permitted only when it agrees with the
// ustar header it accompanies (§4.1b).
const PAX_KNOWN_KEYS = new Set([
  "path", "comment", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset",
  "hdrcharset",
]);

// pax keys a GLOBAL extended header may carry with a non-empty value: they
// neither rename following entries (path, hdrcharset) nor change how their
// bytes are read (size, unknown keys), and §4.1b already ignores ownership
// and times for hashing — so ignoring them cannot make this reader disagree
// with a pax-aware consumer about what the archive contains.
const PAX_GLOBAL_IGNORABLE_KEYS = new Set([
  "comment", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset",
]);

/** pax ids are digit-only decimals; pax times may carry a fractional part. */
const PAX_INTEGER_KEYS = new Set(["uid", "gid"]);
const PAX_TIME_KEYS = new Set(["mtime", "atime", "ctime"]);

export const LIMITS = {
  maxFiles: 512,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxDecompressionRatio: 100,
} as const;

/** §4.1b path rules; violation → MALFORMED_ARCHIVE. */
export function checkPath(path: string): void {
  if (path.length === 0) throw new ArchiveError("MALFORMED_ARCHIVE", "empty path");
  // The rule is asked, not restated: `src/outcome.ts` holds the one definition
  // of "well-formed UTF-16" and this boundary translates its refusal into the
  // code an archive fault carries. Written here as `!path.isWellFormed()` it was
  // a second spelling of the same rule, free to drift from the first.
  try {
    assertWellFormedText(path, "an archive path");
  } catch (e) {
    if (!(e instanceof NotWellFormedText)) throw e;
    throw new ArchiveError("MALFORMED_ARCHIVE", `ill-formed Unicode in path: ${e.message}`);
  }
  // NUL and other C0/C1 controls are never legitimate path content and are the
  // classic way to make one path read differently to two consumers.
  if (/[\x00-\x1f\x7f-\u009f]/.test(path)) {
    throw new ArchiveError("MALFORMED_ARCHIVE", "control character in path");
  }
  if (path.includes("\\")) throw new ArchiveError("MALFORMED_ARCHIVE", `backslash in path: ${path}`);
  if (path.startsWith("/")) throw new ArchiveError("MALFORMED_ARCHIVE", `absolute path: ${path}`);
  // Windows-style roots and UNC/device prefixes, which are absolute to a
  // Windows consumer even though they carry no leading "/".
  if (/^[A-Za-z]:/.test(path)) throw new ArchiveError("MALFORMED_ARCHIVE", `drive-letter path: ${path}`);
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) throw new ArchiveError("MALFORMED_ARCHIVE", `.. segment: ${path}`);
  if (segments.some((s) => s === "" || s === ".")) throw new ArchiveError("MALFORMED_ARCHIVE", `empty/dot segment: ${path}`);
  // NFC judged against the committed tables, never the runtime (§4.1b)
  if (!isNFC(path)) throw new ArchiveError("MALFORMED_ARCHIVE", `path not NFC-normalized: ${path}`);
}

/**
 * §4.1b forbids exactly two collision classes — case-insensitive, and NFC/NFD —
 * and no others (§4.1b: the enumerated list is exhaustive, and
 * refusing input the profile does not forbid is as much a defect as accepting
 * input it does). The key is the Unicode default full case fold over the
 * canonical form, both computed from committed tables.
 */
function collisionKey(path: string): string {
  return foldKey(path);
}

export type PackageFiles = Map<string, Buffer>;

function addFile(files: PackageFiles, seenKeys: Set<string>, path: string, data: Buffer): void {
  checkPath(path);
  if (files.has(path)) throw new ArchiveError("MALFORMED_ARCHIVE", `duplicate member: ${path}`);
  const key = collisionKey(path);
  if (seenKeys.has(key)) throw new ArchiveError("MALFORMED_ARCHIVE", `case/normalization collision: ${path}`);
  seenKeys.add(key);
  if (data.length > LIMITS.maxFileBytes) throw new ArchiveError("LIMIT_EXCEEDED", `file > 4 MiB: ${path}`);
  files.set(path, data);
  if (files.size > LIMITS.maxFiles) throw new ArchiveError("LIMIT_EXCEEDED", "more than 512 files");
  let total = 0;
  for (const b of files.values()) total += b.length;
  if (total > LIMITS.maxTotalBytes) throw new ArchiveError("LIMIT_EXCEEDED", "total > 64 MiB");
}

/** Read a plain directory as a package (rejecting forbidden entry kinds).
 *  Directories participate in collision accounting exactly as in tar form. */
export function readDirectory(root: string): PackageFiles {
  const files: PackageFiles = new Map();
  const seen = new Set<string>();
  const inodes = new Map<string, string>();
  const walk = (rel: string) => {
    // read names as bytes: an ill-formed-UTF-8 filename must surface as
    // MALFORMED_ARCHIVE, not as a lossy string that later fails to open
    for (const raw of readdirSync(rel === "" ? root : join(root, rel), { encoding: "buffer" })) {
      // Bun returns plain Uint8Array here, Node returns Buffer — normalize
      const nameBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as Uint8Array);
      const name = utf8Strict(nameBuf, "directory entry name");
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, relPath));
      if (st.isSymbolicLink()) throw new ArchiveError("MALFORMED_ARCHIVE", `symlink: ${relPath}`);
      if (st.isDirectory()) {
        checkPath(relPath);
        const key = collisionKey(relPath);
        if (seen.has(key)) throw new ArchiveError("MALFORMED_ARCHIVE", `duplicate/colliding directory: ${relPath}`);
        seen.add(key);
        walk(relPath);
      } else if (st.isFile()) {
        // §4.1b forbids hardlinks WITHIN the package: two members must not be
        // the same file. A link count above one is not itself a violation —
        // the other name may live outside the package entirely — so identity
        // is tracked by (device, inode) across the members actually present.
        const inodeKey = `${st.dev}:${st.ino}`;
        if (inodes.has(inodeKey)) {
          throw new ArchiveError(
            "MALFORMED_ARCHIVE",
            `hardlinked members: ${relPath} and ${inodes.get(inodeKey)} are the same file`,
          );
        }
        inodes.set(inodeKey, relPath);
        addFile(files, seen, relPath, readFileSync(join(root, relPath)));
      } else throw new ArchiveError("MALFORMED_ARCHIVE", `non-regular entry: ${relPath}`);
    }
  };
  walk("");
  return files;
}

/** Strict UTF-8 decode: reject byte sequences that are not valid UTF-8. */
function utf8Strict(buf: Buffer, what: string): string {
  const s = buf.toString("utf8");
  if (!Buffer.from(s, "utf8").equals(buf)) throw new ArchiveError("MALFORMED_ARCHIVE", `invalid UTF-8 in ${what}`);
  return s;
}

/** Parse a ustar numeric field: octal digits, optionally NUL/space padded. */
function octalField(header: Buffer, start: number, len: number, what: string, allowEmpty = false): number {
  const raw = header.subarray(start, start + len).toString("latin1");
  const trimmed = raw.replace(/[\0 ]+$/g, "").replace(/^ +/, "");
  if (trimmed === "") {
    if (allowEmpty) return 0;
    throw new ArchiveError("MALFORMED_ARCHIVE", `empty ${what} field`);
  }
  if (!/^[0-7]+$/.test(trimmed)) throw new ArchiveError("MALFORMED_ARCHIVE", `${what} field is not octal`);
  return parseInt(trimmed, 8);
}

/** Parse pax extended-header records: "<len> key=value\n" — LENGTHS ARE IN
 *  BYTES (parsing must run on the raw buffer, never on JS string indexes).
 *  POSIX requires at least one record; an empty payload is malformed. */
function parsePaxRecords(data: Buffer, what: string): Array<[string, string]> {
  if (data.length === 0) throw new ArchiveError("MALFORMED_ARCHIVE", `${what} with no records`);
  const records: Array<[string, string]> = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp === -1) throw new ArchiveError("MALFORMED_ARCHIVE", "bad pax record");
    const lenStr = utf8Strict(data.subarray(p, sp), "pax length");
    const recLen = /^\d+$/.test(lenStr) ? parseInt(lenStr, 10) : NaN;
    if (!Number.isFinite(recLen) || recLen <= 0 || p + recLen > data.length) {
      throw new ArchiveError("MALFORMED_ARCHIVE", "bad pax record length");
    }
    if (data[p + recLen - 1] !== 0x0a) throw new ArchiveError("MALFORMED_ARCHIVE", "pax record not newline-terminated");
    const rec = utf8Strict(data.subarray(sp + 1, p + recLen - 1), "pax record");
    const eq = rec.indexOf("=");
    if (eq === -1) throw new ArchiveError("MALFORMED_ARCHIVE", "pax record without '='");
    records.push([rec.slice(0, eq), rec.slice(eq + 1)]);
    p += recLen;
  }
  return records;
}

/** A recognized key with a malformed value is still a malformed archive,
 *  even though this profile ignores the value itself. */
function checkPaxValueShape(key: string, value: string): void {
  if (PAX_INTEGER_KEYS.has(key) && !/^\d+$/.test(value)) {
    throw new ArchiveError("MALFORMED_ARCHIVE", `pax record ${key} is not a decimal integer: ${value}`);
  }
  if (PAX_TIME_KEYS.has(key) && !/^\d+(\.\d+)?$/.test(value)) {
    throw new ArchiveError("MALFORMED_ARCHIVE", `pax record ${key} is not a valid number: ${value}`);
  }
}

function verifyHeaderChecksum(header: Buffer): void {
  const stored = octalField(header, 148, 8, "checksum");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  if (stored !== sum) throw new ArchiveError("MALFORMED_ARCHIVE", "header checksum mismatch");
}

/** Parse tar bytes (POSIX ustar/pax; GNU longname 'L' supported) under §4.1b rules. */
export function readTar(tarBytes: Buffer): PackageFiles {
  const files: PackageFiles = new Map();
  const seen = new Set<string>();
  let off = 0;
  let paxPathOverride: string | null = null;
  let paxSizeOverride: number | null = null;
  let pendingPax = false;
  let sawEndMarker = false;

  const readStr = (buf: Buffer, start: number, len: number, what: string): string => {
    const slice = buf.subarray(start, start + len);
    const nul = slice.indexOf(0);
    return utf8Strict(slice.subarray(0, nul === -1 ? len : nul), what);
  };

  while (off + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) {
      // end-of-archive: two zero blocks, and nothing but padding after them —
      // trailing non-zero bytes would be content this reader never accounts for
      const second = tarBytes.subarray(off + 512, off + 1024);
      if (second.length === 512 && second.every((b) => b === 0)) sawEndMarker = true;
      if (sawEndMarker && !tarBytes.subarray(off + 1024).every((b) => b === 0)) {
        throw new ArchiveError("MALFORMED_ARCHIVE", "data after end-of-archive marker");
      }
      break;
    }
    // POSIX: an extended header must be followed by the file header it
    // describes. An orphan one means the archive is structurally truncated.
    if (pendingPax && !"xg".includes(String.fromCharCode(header[156]!))) pendingPax = false;
    verifyHeaderChecksum(header);
    // §4.1b accepts POSIX ustar/pax ONLY: magic "ustar\0" with version "00".
    // GNU tar's "ustar  \0" and v7 headers carry different field semantics
    // (notably sparse and long-name extensions) that this profile excludes.
    const magic = header.subarray(257, 263).toString("latin1");
    const version = header.subarray(263, 265).toString("latin1");
    if (magic !== "ustar\0") throw new ArchiveError("MALFORMED_ARCHIVE", "not a POSIX ustar/pax header");
    if (version !== "00") throw new ArchiveError("MALFORMED_ARCHIVE", `unsupported ustar version ${JSON.stringify(version)}`);
    const rawName = readStr(header, 0, 100, "name");
    // Every ustar numeric field must be octal for the header to be conforming.
    // Their VALUES are irrelevant here (§4.1b ignores mode/ownership/time for
    // hashing), but accepting a malformed field would call a non-conforming
    // header conforming — and a stricter extractor would then disagree with us.
    octalField(header, 100, 8, "mode");
    octalField(header, 108, 8, "uid", true); // may legitimately be blank
    octalField(header, 116, 8, "gid", true);
    octalField(header, 136, 12, "mtime", true);
    const size = octalField(header, 124, 12, "size");
    const typeflag = String.fromCharCode(header[156]!);
    const prefix = readStr(header, 345, 155, "prefix");
    // Remaining ustar header rules, so that a header this reader accepts is one
    // a conforming extractor would also accept (and read identically).
    octalField(header, 329, 8, "devmajor", true);
    octalField(header, 337, 8, "devminor", true);
    readStr(header, 265, 32, "uname"); // must be well-formed UTF-8
    readStr(header, 297, 32, "gname");
    if ((typeflag === "0" || typeflag === "\0" || typeflag === "5") && readStr(header, 157, 100, "linkname") !== "") {
      throw new ArchiveError("MALFORMED_ARCHIVE", "linkname set on a non-link entry");
    }
    // POSIX: a directory header's size is an allocation hint, not data logical
    // records, so it never advances the reader past following headers.
    const effectiveSize = typeflag === "5" ? 0 : size;
    const dataStart = off + 512;
    const dataEnd = dataStart + effectiveSize;
    if (dataEnd > tarBytes.length) throw new ArchiveError("MALFORMED_ARCHIVE", "truncated entry");
    const data = tarBytes.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(effectiveSize / 512) * 512;

    if (typeflag === "g") {
      // A global extended header applies to every entry after it. §4.1b does
      // not forbid the construct, so refusing it outright would be over-strict
      // (§4.1b) — but accepting-and-ignoring a record a pax-aware
      // consumer WOULD apply is exactly the two-readers-disagree failure. The
      // line: records that rename entries (path), change how their bytes are
      // read (size, unknown keys), or change how later header values decode
      // (hdrcharset) are refused; the rest is metadata this profile already
      // ignores for hashing, so ignoring it changes nothing.
      if (pendingPax) throw new ArchiveError("MALFORMED_ARCHIVE", "consecutive extended headers");
      for (const [key, value] of parsePaxRecords(data, "global extended header")) {
        // POSIX: an empty value DELETES the attribute. A global default this
        // profile refuses can never have been set, so a deletion of any
        // recognized key is always a no-op — valid, not malformed.
        if (value === "") {
          if (!PAX_KNOWN_KEYS.has(key) && key !== "size") {
            throw new ArchiveError("MALFORMED_ARCHIVE", `unsupported pax record: ${key}`);
          }
          continue;
        }
        if (!PAX_GLOBAL_IGNORABLE_KEYS.has(key)) {
          throw new ArchiveError("MALFORMED_ARCHIVE", `pax record not permitted in a global header: ${key}`);
        }
        checkPaxValueShape(key, value);
      }
      continue;
    }
    if (typeflag === "x") {
      // POSIX: an extended header describes the FILE header immediately
      // following it, so two extended headers in a row are malformed.
      if (pendingPax) throw new ArchiveError("MALFORMED_ARCHIVE", "consecutive extended headers");
      for (const [key, value] of parsePaxRecords(data, "extended header")) {
        if (key === "size") {
          // A size override that AGREES with the header it accompanies does
          // not change how the entry's bytes are read, and §4.1b does not
          // forbid it (§4.1b). One that disagrees would make a
          // pax-aware consumer read different bytes than this reader — it is
          // refused when the file header arrives and the values can be
          // compared.
          if (value === "") {
            paxSizeOverride = null;
            continue;
          }
          if (!/^\d+$/.test(value)) {
            throw new ArchiveError("MALFORMED_ARCHIVE", `pax record size is not a decimal integer: ${value}`);
          }
          paxSizeOverride = parseInt(value, 10);
          continue;
        }
        // Keys that change how the entry's BYTES are interpreted are not
        // supported by this profile; silently ignoring them would let the
        // archive read differently to a conformant extractor.
        if (!PAX_KNOWN_KEYS.has(key)) {
          throw new ArchiveError("MALFORMED_ARCHIVE", `unsupported pax record: ${key}`);
        }
        // POSIX: an empty value DELETES the attribute — a valid record, not a
        // malformed one. Only a non-empty value is checked for shape.
        if (value === "") {
          if (key === "path") paxPathOverride = null;
          continue;
        }
        checkPaxValueShape(key, value);
        if (key === "path") paxPathOverride = value;
      }
      pendingPax = true; // must be consumed by the next file header
      continue;
    }
    if (typeflag === "L" || typeflag === "K") {
      // GNU long-name/long-link extensions are outside the POSIX profile
      throw new ArchiveError("MALFORMED_ARCHIVE", "GNU long-name extension not permitted");
    }

    // Agreement with the header was the condition for accepting a pax size
    // record at all — a disagreeing override is the one construct that makes
    // two readers see different bytes.
    if (paxSizeOverride !== null && paxSizeOverride !== size) {
      throw new ArchiveError("MALFORMED_ARCHIVE", `pax size override disagrees with header size: ${paxSizeOverride} != ${size}`);
    }
    paxSizeOverride = null;
    const name = paxPathOverride ?? (prefix ? `${prefix}/${rawName}` : rawName);
    paxPathOverride = null;

    if (typeflag === "5") {
      // directory entries: path rules AND duplicate/collision accounting apply
      const dirPath = name.replace(/\/$/, "");
      checkPath(dirPath);
      const key = collisionKey(dirPath);
      if (seen.has(key)) throw new ArchiveError("MALFORMED_ARCHIVE", `duplicate/colliding directory: ${dirPath}`);
      seen.add(key);
      continue;
    }
    if (typeflag === "0" || typeflag === "\0") {
      addFile(files, seen, name, Buffer.from(data));
      continue;
    }
    const kinds: Record<string, string> = { "1": "hardlink", "2": "symlink", "3": "chardev", "4": "blockdev", "6": "fifo", "7": "reserved" };
    throw new ArchiveError("MALFORMED_ARCHIVE", `forbidden entry type ${kinds[typeflag] ?? typeflag}: ${name}`);
  }
  if (pendingPax) {
    throw new ArchiveError("MALFORMED_ARCHIVE", "extended header not followed by its file header");
  }
  if (!sawEndMarker) throw new ArchiveError("MALFORMED_ARCHIVE", "missing end-of-archive marker (truncated tar)");
  return files;
}

/** Gunzip with §4.1b decompression-ratio and size caps. */
export function gunzipLimited(gz: Buffer): Buffer {
  let out: Buffer;
  try {
    out = gunzipSync(gz, { maxOutputLength: LIMITS.maxTotalBytes + 1024 * 1024 });
  } catch (e: any) {
    if (e?.code === "ERR_BUFFER_TOO_LARGE" || /larger than|output length/i.test(String(e?.message))) {
      throw new ArchiveError("LIMIT_EXCEEDED", "decompressed size over cap");
    }
    throw new ArchiveError("MALFORMED_ARCHIVE", `gunzip failed: ${e.message}`);
  }
  if (out.length > gz.length * LIMITS.maxDecompressionRatio) {
    throw new ArchiveError("LIMIT_EXCEEDED", `decompression ratio > ${LIMITS.maxDecompressionRatio}:1`);
  }
  return out;
}

/** Read any supported package form: directory path, .tar, .tar.gz/.tgz bytes or path. */
export function readPackage(pathOrBytes: string | Buffer, kind?: "dir" | "tar" | "tar.gz"): PackageFiles {
  if (Buffer.isBuffer(pathOrBytes)) {
    if (kind === "tar.gz") return readTar(gunzipLimited(pathOrBytes));
    return readTar(pathOrBytes);
  }
  const path = pathOrBytes;
  const k = kind ?? (path.endsWith(".tar.gz") || path.endsWith(".tgz") ? "tar.gz" : path.endsWith(".tar") ? "tar" : "dir");
  if (k === "dir") return readDirectory(path);
  const bytes = readFileSync(path);
  return k === "tar.gz" ? readTar(gunzipLimited(bytes)) : readTar(bytes);
}

/** §4.3.2 integrity list: all regular files EXCEPT skill.json and SIGNATURE.jws, sorted byte-wise over UTF-8 path bytes. */
export function computeIntegrity(files: PackageFiles): Array<{ path: string; sha256: string }> {
  const entries = [...files.entries()]
    .filter(([p]) => p !== "skill.json" && p !== "SIGNATURE.jws")
    .map(([path, data]) => ({ path, sha256: createHash("sha256").update(data).digest("hex") }));
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  return entries;
}

/** Minimal conforming packer (ustar), used for fixtures and the seed package.
 *  Enforces the same §4.1b size profile as the verifier. */
export function writeTar(files: PackageFiles): Buffer {
  if (files.size > LIMITS.maxFiles) throw new ArchiveError("LIMIT_EXCEEDED", "packer: more than 512 files");
  let packTotal = 0;
  for (const [p, b] of files) {
    if (b.length > LIMITS.maxFileBytes) throw new ArchiveError("LIMIT_EXCEEDED", `packer: file > 4 MiB: ${p}`);
    packTotal += b.length;
  }
  if (packTotal > LIMITS.maxTotalBytes) throw new ArchiveError("LIMIT_EXCEEDED", "packer: total > 64 MiB");
  const seenPack = new Set<string>();
  for (const p of files.keys()) {
    const key = collisionKey(p);
    if (seenPack.has(key)) throw new ArchiveError("MALFORMED_ARCHIVE", `packer: colliding paths: ${p}`);
    seenPack.add(key);
  }
  const blocks: Buffer[] = [];
  const sorted = [...files.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8")));
  for (const [name, data] of sorted) {
    checkPath(name);
    if (Buffer.byteLength(name) > 100) throw new ArchiveError("MALFORMED_ARCHIVE", "packer: name > 100 bytes (use pax in v2)");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100); // mode (ignored for hashing)
    header.write("0000000\0", 108); // uid
    header.write("0000000\0", 116); // gid
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136); // mtime: epoch (determinism)
    header.write("        ", 148); // checksum placeholder
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data);
    const pad = Math.ceil(data.length / 512) * 512 - data.length;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
