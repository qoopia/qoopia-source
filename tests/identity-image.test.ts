// The sign-in image bundles only what deploy/identity.Dockerfile copies into its build stage. A helper
// moved out of those paths broke the 5.0.16 image while every other check stayed green.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("the sign-in service bundles from exactly the files its image copies", () => {
  const repo = path.join(import.meta.dir, ".."), dockerfile = fs.readFileSync(path.join(repo, "deploy/identity.Dockerfile"), "utf8");
  const build = dockerfile.slice(dockerfile.indexOf(" AS build"), dockerfile.indexOf(" AS runtime"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-identity-image-"));
  try {
    for (const line of build.split("\n").filter((l) => /^COPY [^-]/.test(l))) {
      const parts = line.split(/\s+/).slice(1), target = parts.pop()!;
      for (const source of parts) {
        const to = target.endsWith("/") ? path.join(root, target, path.basename(source)) : path.join(root, target);
        fs.cpSync(path.join(repo, source), to, { recursive: true });
      }
    }
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"));
    const result = Bun.spawnSync({ cmd: [process.execPath, "build", "src/identity/broker.ts", "--target=bun", "--outfile", path.join(root, "broker.js")], cwd: root, stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
