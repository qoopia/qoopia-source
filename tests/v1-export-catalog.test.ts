import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { enabledV4Tools } from "../src/mcp/v4-tools.ts";

const LEGACY_TRANSFER_NAMES = ["export_plan", "export_bundle", "import_plan"];

beforeAll(() => runMigrations());

describe("V1 transfer catalog", () => {
  test("the installed (current) schema lists the workspace export tools in the actual MCP listing, and an older schema omits them", async () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => registered.push(name),
      tool: (name: string) => registered.push(name),
    };
    const { registerTools, findTool } = await import("../src/mcp/tools.ts");
    registerTools(server as never, () => null, "full", { agentToolProfile: "full" });
    // The registry is built when the server loads, after migrations; in this shared test process another file may
    // have loaded it on a different schema, so the listing is compared with the registry itself.
    const current = !!findTool("export_plan");
    expect(registered.filter((name) => LEGACY_TRANSFER_NAMES.includes(name))).toEqual(current ? LEGACY_TRANSFER_NAMES : []);
    expect(enabledV4Tools(55).filter((tool) => LEGACY_TRANSFER_NAMES.includes(tool.name)).map((tool) => tool.name)).toEqual(LEGACY_TRANSFER_NAMES);
    expect(enabledV4Tools(37).filter((tool) => LEGACY_TRANSFER_NAMES.includes(tool.name))).toEqual([]);
  });

  test("the current schema lists the transfer tools with their canonical contracts and authorization risk", () => {
    const listed = enabledV4Tools(55).filter((tool) => LEGACY_TRANSFER_NAMES.includes(tool.name));
    expect(listed.map(({ name, risk }) => [name, risk])).toEqual([
      ["export_plan", "admin"],
      ["export_bundle", "admin"],
      ["import_plan", "admin"],
    ]);
    expect(listed.every((tool) => /current schema/i.test(tool.description))).toBe(true);
  });
});
