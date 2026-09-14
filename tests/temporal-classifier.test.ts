/**
 * ТЗ §10.1 (R6) — system-level классификатор `classifySupersedeComponents`.
 *
 * Проверяется: экспортируемость (compile-тест импорта), классы
 * linear/split_head/cyclic/oversize, ВИДИМОСТЬ private-узлов (в отличие от
 * `getSupersedeChain`), детерминированный `component_rep` и системная
 * граница — ни одна MCP-регистрация не вызывает классификатор.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  classifySupersedeComponents,
  DEFAULT_MAX_COMPONENT_SIZE,
  type SupersedeComponent,
} from "../src/services/temporal-migration.ts";
import {
  cleanupScratchRoots,
  scratchDatabase,
  seedClassifierGraph,
  seedNote,
  seedSupersedes,
  seedWorkspace,
} from "./helpers/temporal-fixtures.ts";

afterAll(() => cleanupScratchRoots());

function byRep(components: SupersedeComponent[]): Map<string, SupersedeComponent> {
  return new Map(components.map((component) => [component.component_rep, component]));
}

describe("R6 classifier — exported system-level API", () => {
  test("compile-test: the symbol is exported with the specified signature", () => {
    // Сам импорт наверху файла — и есть compile-тест: неэкспортированный
    // символ не прошёл бы typecheck. Здесь фиксируется контракт значения.
    expect(typeof classifySupersedeComponents).toBe("function");
    expect(classifySupersedeComponents.length).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_MAX_COMPONENT_SIZE).toBe(1000);
  });

  test("classifies linear / split_head / cyclic / oversize components", () => {
    const { db } = scratchDatabase(32);
    const fixture = seedClassifierGraph(db, "cls", 12);
    const components = classifySupersedeComponents(db, { maxComponentSize: 10 });
    const index = byRep(components);

    const linear = index.get("lin-a")!;
    expect(linear.klass).toBe("linear");
    expect(linear.node_ids).toEqual(["lin-a", "lin-b", "lin-c"]);
    expect(linear.active_head_ids).toEqual(["lin-c"]);
    expect(linear.truncated).toBe(false);

    const split = index.get("spl-a")!;
    expect(split.klass).toBe("split_head");
    expect(split.active_head_ids).toEqual(["spl-b", "spl-c"]);

    const cyclic = index.get("cyc-a")!;
    expect(cyclic.klass).toBe("cyclic");
    expect(cyclic.active_head_ids).toEqual([]);

    const oversize = index.get("ovr-000")!;
    expect(oversize.klass).toBe("oversize");
    expect(oversize.truncated).toBe(true);
    expect(oversize.node_ids.length).toBe(fixture.oversize.length);
  });

  test("private notes are visible to the classifier (unlike getSupersedeChain)", () => {
    const { db } = scratchDatabase(32);
    seedClassifierGraph(db, "prv", 12);
    const components = classifySupersedeComponents(db, { maxComponentSize: 10 });
    const priv = byRep(components).get("prv-a")!;
    expect(priv).toBeDefined();
    expect(priv.klass).toBe("linear");
    expect(priv.node_ids).toEqual(["prv-a", "prv-b"]);
    expect(priv.active_head_ids).toEqual(["prv-b"]);
    // Обе ноты private — visibility-scoped обход не увидел бы ни одной.
    const visibilities = db
      .query(`SELECT visibility FROM notes WHERE id IN ('prv-a','prv-b')`)
      .all() as Array<{ visibility: string }>;
    expect(visibilities.map((row) => row.visibility)).toEqual(["private", "private"]);
  });

  test("component_rep is the lexicographically smallest node and is deterministic", () => {
    const { db } = scratchDatabase(32);
    const ws = seedWorkspace(db, "det");
    for (const id of ["m-9", "m-1", "m-5"]) {
      seedNote(db, { id, workspace_id: ws.workspace_id, agent_id: ws.agent_id });
    }
    seedSupersedes(db, { ...ws, source_note_id: "m-5", target_note_id: "m-9" });
    seedSupersedes(db, { ...ws, source_note_id: "m-1", target_note_id: "m-5" });
    const first = classifySupersedeComponents(db);
    const second = classifySupersedeComponents(db);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.component_rep).toBe("m-1");
    expect(first[0]!.node_ids).toEqual(["m-1", "m-5", "m-9"]);
  });

  test("components never cross a workspace boundary and can be scoped", () => {
    const { db } = scratchDatabase(32);
    const a = seedWorkspace(db, "wsa");
    const b = seedWorkspace(db, "wsb");
    seedNote(db, { id: "a-1", workspace_id: a.workspace_id, agent_id: a.agent_id });
    seedNote(db, { id: "a-2", workspace_id: a.workspace_id, agent_id: a.agent_id });
    seedNote(db, { id: "b-1", workspace_id: b.workspace_id, agent_id: b.agent_id });
    seedNote(db, { id: "b-2", workspace_id: b.workspace_id, agent_id: b.agent_id });
    seedSupersedes(db, { ...a, source_note_id: "a-2", target_note_id: "a-1" });
    seedSupersedes(db, { ...b, source_note_id: "b-2", target_note_id: "b-1" });

    const all = classifySupersedeComponents(db);
    expect(all).toHaveLength(2);
    expect(all.map((component) => component.workspace_id)).toEqual([
      a.workspace_id,
      b.workspace_id,
    ]);

    const scoped = classifySupersedeComponents(db, { workspaceId: b.workspace_id });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.node_ids).toEqual(["b-1", "b-2"]);
  });

  test("an empty supersede graph yields no components and writes nothing", () => {
    const { db } = scratchDatabase(32);
    seedWorkspace(db, "empty");
    expect(classifySupersedeComponents(db)).toEqual([]);
    const relations = db.query(`SELECT COUNT(*) AS c FROM note_relations`).get() as { c: number };
    expect(relations.c).toBe(0);
  });
});

describe("R6 system-auth boundary", () => {
  test("no MCP tool module references the classifier", () => {
    const mcpDir = path.resolve(import.meta.dir, "..", "src", "mcp");
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(mcpDir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(mcpDir, entry), "utf8");
      if (
        source.includes("classifySupersedeComponents") ||
        source.includes("temporal-migration")
      ) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no registered MCP tool name exposes the classifier", async () => {
    const { V4_TOOL_NAMES } = await import("../src/mcp/v4-tools.ts");
    for (const name of V4_TOOL_NAMES) {
      expect(name).not.toContain("classify");
      expect(name).not.toContain("component");
    }
  });

  test("the classifier takes a raw Database and never an AuthContext", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "src", "services", "temporal-migration.ts"),
      "utf8",
    );
    // Комментарии сознательно объясняют, ПОЧЕМУ AuthContext не принимается,
    // поэтому проверяется код, а не текст: ни одного импорта auth-слоя.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("AuthContext");
    expect(code).not.toContain("auth/middleware");
    expect(code).not.toContain("getNote");
    expect(code).not.toContain("visibility");
    expect(code).toContain("db: Database");
  });
});
