import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { enabledV4Tools } from "../src/mcp/v4-tools.ts";

const LEGACY_TRANSFER_NAMES = ["export_plan", "export_bundle", "import_plan"];

beforeAll(() => runMigrations());

describe("V1 transfer catalog", () => {
  test("schema 37 omits schema-32-only workspace export tools from the actual MCP listing", async () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => registered.push(name),
      tool: (name: string) => registered.push(name),
    };
    const { registerTools } = await import("../src/mcp/tools.ts");
    registerTools(server as never, () => null, "full", { agentToolProfile: "full" });
    expect(registered.filter((name) => LEGACY_TRANSFER_NAMES.includes(name))).toEqual([]);
  });

  test("schema 32 retains the legacy canonical contracts and authorization risk", () => {
    const listed = enabledV4Tools(32).filter((tool) => LEGACY_TRANSFER_NAMES.includes(tool.name));
    expect(listed.map(({ name, risk }) => [name, risk])).toEqual([
      ["export_plan", "admin"],
      ["export_bundle", "admin"],
      ["import_plan", "admin"],
    ]);
    expect(listed.every((tool) => /legacy schema 32/i.test(tool.description))).toBe(true);
  });
});
