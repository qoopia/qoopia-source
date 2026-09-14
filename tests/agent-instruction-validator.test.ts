import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  digestToolTree,
  validateAgentInstructionPaths,
} from "../src/utils/agent-instruction-validator.ts";

const roots: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-path-validator-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
describe("agent instruction path validation", () => {
  test("accepts provider-neutral paths that exist", () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, "tools/task_tools"), { recursive: true });
    fs.writeFileSync(path.join(root, "tools/AGENTS.md"), "# Tools\n");
    fs.writeFileSync(path.join(root, "tools/task_tools/AGENTS.md"), "# Tasks\n");
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      "Read `tools/AGENTS.md`, then `tools/task_tools/AGENTS.md`.\n",
    );

    const result = validateAgentInstructionPaths({ workspaceRoot: root });
    expect(result.ok).toBe(true);
    expect(result.checkedReferences).toHaveLength(2);
  });

  test("rejects the unresolved CLAUDE/GEMINI placeholder path", () => {
    const root = scratch();
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      "Read `tools/CLAUDE/GEMINI/AGENTS.md`.\n",
    );
    const result = validateAgentInstructionPaths({ workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("tools/CLAUDE/GEMINI/AGENTS.md");
  });
});

describe("fleet tool tree digest", () => {
  test("ignores declared local overlays but detects core drift", () => {
    const first = scratch();
    const second = scratch();
    for (const root of [first, second]) {
      fs.mkdirSync(path.join(root, "local"), { recursive: true });
      fs.writeFileSync(path.join(root, "core.py"), "same\n");
    }
    fs.writeFileSync(path.join(first, "local/config.json"), "one\n");
    fs.writeFileSync(path.join(second, "local/config.json"), "two\n");
    expect(digestToolTree(first, ["local/"])).toBe(
      digestToolTree(second, ["local/"]),
    );
    fs.writeFileSync(path.join(second, "core.py"), "drift\n");
    expect(digestToolTree(first, ["local/"])).not.toBe(
      digestToolTree(second, ["local/"]),
    );
  });
});
