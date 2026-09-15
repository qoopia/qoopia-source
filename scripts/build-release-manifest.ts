#!/usr/bin/env bun
/**
 * Builds marketing-site/release.json from the real published artefacts.
 *
 * Every field in that file used to be typed by hand: version, tag, date,
 * source sha, two file names, two byte counts, two sha256 digests and two
 * URLs. It is also the file the release health monitor compares against the
 * running server, so a typo there reads as a production alert or, worse, as a
 * false all-clear. Sizes and digests are now measured from the files that were
 * actually uploaded, and the URLs are derived from the tag and file name.
 *
 * Usage:
 *   bun run scripts/build-release-manifest.ts \
 *     --source <40-char commit sha> \
 *     --mac <path to .dmg> --linux <path to .tar.gz> --publisher-public-key <trusted.pem> \
 *     [--version X.Y.Z] [--date YYYY-MM-DD] [--out marketing-site/release.json]
 *
 * --version defaults to package.json. The tag is always "v" + version: the two
 * are not independently typeable.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { verifyBundle } from "../src/delivery/bundle.ts";

function command(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Package inspection failed: ${name}: ${result.stderr ?? result.error}`);
  return result.stdout;
}

export function inspectReleaseArtifact(file: string, target: "darwin-arm64" | "linux-x64", publicKey: string) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-release-inspect-"));
  let mounted = false;
  try {
    let root: string;
    if (target === "darwin-arm64") {
      const mount = path.join(temp, "mount");
      command("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, file]);
      mounted = true;
      root = path.join(mount, "Qoopia.app/Contents/Resources/bundle");
    } else {
      const entries = command("tar", ["-tzf", file]).trim().split("\n");
      if (entries.some(name => path.isAbsolute(name) || name.split("/").includes(".."))) throw new Error("Unsafe archive path");
      const listing = command("tar", ["-tvzf", file]).trim().split("\n");
      if (listing.some(line => !["-", "d"].includes(line[0]!))) throw new Error("Archive links and special files are forbidden");
      command("tar", ["-xzf", file, "-C", temp]);
      const candidates = [temp, ...fs.readdirSync(temp).map(name => path.join(temp, name))];
      const found = candidates.filter(dir => fs.existsSync(path.join(dir, "manifest.json")));
      if (found.length !== 1) throw new Error("Expected exactly one bundle in archive");
      root = found[0]!;
    }
    return verifyBundle(root, publicKey, false, target).manifest;
  } finally {
    if (mounted) command("hdiutil", ["detach", path.join(temp, "mount")]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function assertReleaseIdentity(manifests: ReturnType<typeof inspectReleaseArtifact>[], version: string, source: string) {
  for (const manifest of manifests) {
    if (manifest.version !== version || manifest.build_sha !== source) throw new Error("Package version/source does not match release");
  }
  if (new Set(manifests.map(m => m.source_digest)).size !== 1) throw new Error("Package source inventories disagree");
}


const DOWNLOAD_BASE = "https://github.com/qoopia/qoopia-downloads/releases/download";
const REQUIREMENTS = {
  mac: "Apple Silicon Mac, macOS 15.0 or newer. Intel Macs and Windows are not supported.",
  linux: "Linux x64 with glibc 2.34 or newer. Not every Linux distribution is supported.",
} as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function measure(file: string, version: string, expectSuffix: string) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`artefact not found: ${resolved}`);
  const name = path.basename(resolved);
  if (!name.endsWith(expectSuffix)) throw new Error(`${name} does not end with ${expectSuffix}`);
  if (name !== `qoopia-${version}-${expectSuffix === ".dmg" ? "darwin-arm64.dmg" : "linux-x64.tar.gz"}`) throw new Error(`${name} does not carry version ${version}`);
  const bytes = fs.readFileSync(resolved);
  return {
    file: name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function buildReleaseManifest(input: {
  version: string; source: string; date: string; mac: string; linux: string; publisherPublicKey: string;
}) {
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error("version must be X.Y.Z");
  if (!/^[0-9a-f]{40}$/.test(input.source)) throw new Error("source must be an exact 40-character commit sha");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must be YYYY-MM-DD");
  const tag = `v${input.version}`;
  const mac = measure(input.mac, input.version, ".dmg");
  const linux = measure(input.linux, input.version, ".tar.gz");
  const publicKey = fs.readFileSync(input.publisherPublicKey, "utf8");
  assertReleaseIdentity([
    inspectReleaseArtifact(path.resolve(input.mac), "darwin-arm64", publicKey),
    inspectReleaseArtifact(path.resolve(input.linux), "linux-x64", publicKey),
  ], input.version, input.source);
  const url = (file: string) => `${DOWNLOAD_BASE}/${tag}/${file}`;
  return {
    schema: 1,
    version: input.version,
    tag,
    date: input.date,
    source: input.source,
    availability: "public",
    packages: {
      mac: { label: "macOS Apple Silicon", format: "DMG", ...mac, url: url(mac.file), requirements: REQUIREMENTS.mac },
      linux: { label: "Linux x64", format: "TAR.GZ", ...linux, url: url(linux.file), requirements: REQUIREMENTS.linux },
    },
  };
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string };
  const version = arg("version") ?? pkg.version;
  if (version !== pkg.version) {
    throw new Error(`--version ${version} disagrees with package.json ${pkg.version}; bump the package first`);
  }
  const source = arg("source"), mac = arg("mac"), linux = arg("linux"), publisherPublicKey = arg("publisher-public-key");
  if (!source || !mac || !linux || !publisherPublicKey) {
    throw new Error("usage: build-release-manifest --source SHA --mac FILE.dmg --linux FILE.tar.gz --publisher-public-key FILE.pem [--version X.Y.Z] [--date YYYY-MM-DD] [--out PATH]");
  }
  const manifest = buildReleaseManifest({
    version, source, mac, linux, publisherPublicKey,
    date: arg("date") ?? new Date().toISOString().slice(0, 10),
  });
  const out = path.resolve(arg("out") ?? path.join(repoRoot, "marketing-site/release.json"));
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${out}\n`);
}
