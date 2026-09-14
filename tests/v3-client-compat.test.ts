import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const current = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../docs/v4/contracts/current-tools.json"), "utf8")) as {
  canonical_tools: Array<{ name: string; risk: string; input_schema: Record<string, unknown> }>;
};
const proposed = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../docs/v4/contracts/proposed-v4-tools.json"), "utf8")) as {
  canonical_tools: Array<{ name: string; risk: string; input_schema: Record<string, unknown> }>;
};

describe("P05 V3 client compatibility", () => {
  test("every existing tool keeps its risk and input schema", () => {
    const proposedByName = new Map(proposed.canonical_tools.map((item) => [item.name, item]));
    for (const before of current.canonical_tools) {
      const after = proposedByName.get(before.name);
      expect(after?.risk).toBe(before.risk);
      const schema = structuredClone(after?.input_schema);
      if (before.name === "recall") {
        const properties = schema?.properties as Record<string, unknown>;
        for (const field of ["latest_only", "include_history", "explain", "trace", "lifecycle"]) {
          delete properties[field];
        }
      }
      expect(schema).toEqual(before.input_schema);
    }
  });

  test("recall V4 fields are optional and deprecated aliases are absent", () => {
    const recall = proposed.canonical_tools.find((item) => item.name === "recall");
    expect(recall).toBeDefined();
    const required = (recall!.input_schema.required ?? []) as string[];
    for (const field of ["latest_only", "include_history", "explain", "trace", "lifecycle"]) {
      expect(required).not.toContain(field);
    }
    const names = proposed.canonical_tools.map((item) => item.name);
    for (const alias of ["note", "create", "list", "get", "update", "delete"]) {
      expect(names).not.toContain(alias);
    }
  });

  test("P1 checks its explicit safety delta and the otherwise frozen live V3/V4 surface", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "scripts/v4-contract-snapshot.ts", "--check", "--p1"],
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()).status).toBe("pass");
  });
});
