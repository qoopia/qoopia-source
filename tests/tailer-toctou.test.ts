/**
 * QRERUN-002 regression: prove the primitives that close the tailer
 * TOCTOU race actually behave as the fix in src/ingest/tailer.ts assumes.
 *
 * The fix in processNewLines:
 *   1. Re-runs isSafeWatchPath(filePath) immediately before open.
 *   2. Opens with O_RDONLY|O_NOFOLLOW so a swap-to-symlink mid-flight
 *      fails open() with ELOOP.
 *   3. Compares fdStat.{ino,dev} with a fresh lstat() of the path; if
 *      identity drifted, drops the event without enqueuing anything.
 *
 * processNewLines is internal so we exercise the primitives directly:
 * O_NOFOLLOW on a symlink throws ELOOP, and ino/dev comparison flags a
 * file-replace.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-toctou-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QRERUN-002: tailer TOCTOU primitives", () => {
  test("open(O_RDONLY|O_NOFOLLOW) refuses a symlink with ELOOP", async () => {
    const target = path.join(tmp, "target.txt");
    const link = path.join(tmp, "link.jsonl");
    fs.writeFileSync(target, "secret");
    fs.symlinkSync(target, link);

    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    let err: NodeJS.ErrnoException | null = null;
    try {
      const fd = await fs.promises.open(link, flags);
      await fd.close();
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(err).not.toBeNull();
    // POSIX: ELOOP. Some kernels surface EMLINK / ENOTSUP — either is a
    // refusal, which is what we want.
    expect(["ELOOP", "EMLINK", "ENOTSUP"]).toContain(err!.code as string);
  });

  test("open(O_RDONLY|O_NOFOLLOW) succeeds on a regular file", async () => {
    const file = path.join(tmp, "real.jsonl");
    fs.writeFileSync(file, "hello");
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const fd = await fs.promises.open(file, flags);
    const stat = await fd.stat();
    await fd.close();
    expect(stat.isFile()).toBe(true);
  });

  test("ino/dev mismatch detects file replacement", async () => {
    const file = path.join(tmp, "swap.jsonl");
    fs.writeFileSync(file, "v1");
    const fd = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const fdStat = await fd.stat();

    // Simulate the race: replace the file with a fresh inode while we
    // still hold the old fd.
    fs.unlinkSync(file);
    fs.writeFileSync(file, "v2-attacker-controlled");
    const newPathStat = fs.lstatSync(file);

    expect(newPathStat.ino).not.toBe(fdStat.ino);
    // Same device in this test, but the comparison still shows the
    // identity change via ino. The tailer's check is OR on either.
    await fd.close();
  });

  test("ino match for a stable file", async () => {
    const file = path.join(tmp, "stable.jsonl");
    fs.writeFileSync(file, "v1");
    const fd = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const fdStat = await fd.stat();
    const pathStat = fs.lstatSync(file);
    expect(pathStat.ino).toBe(fdStat.ino);
    expect(pathStat.dev).toBe(fdStat.dev);
    await fd.close();
  });
});
