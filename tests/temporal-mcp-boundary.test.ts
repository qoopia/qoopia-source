/**
 * HIGH-2 (fix-pass #2) — идемпотентность `note_create` НА MCP-ГРАНИЦЕ.
 *
 * В прошлом проходе реестр идемпотентности жил в сервисе и покрывался
 * прямыми вызовами `createNote`, но MCP-инструмент `note_create` ни
 * ОБЪЯВЛЯЛ поле `idempotency_key` в схеме, ни ПРОБРАСЫВАЛ его в хендлере.
 * Для клиента функции не существовало, то есть §6.3/§10.4/§11 не выполнялись
 * на реальном интерфейсе. Тест `temporal-parity-surface` при этом
 * утверждал ровно пять V4.1-полей и маскировал пропуск.
 *
 * Здесь проверяется ИМЕННО путь через `ToolDef.handler` — тот же объект,
 * который регистрируется в MCP-сервере, — а не сервисная функция.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import {
  bitemporalToolFields,
  effectiveToolSchema,
  findTool,
  type ToolDef,
} from "../src/mcp/tools.ts";

let auth: AuthContext;

function enableFlag(): void {
  process.env.QOOPIA_V4_BITEMPORAL = "1";
}

afterEach(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
});

afterAll(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
});

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Temporal MCP", slug: "temporal-mcp" });
  const agent = createAgent({ name: "temporal-mcp-agent", workspaceSlug: workspace.slug });
  auth = {
    workspace_id: workspace.id,
    agent_id: agent.id,
    agent_name: agent.name,
    type: "standard",
    source: "api-key",
  };
});

function noteCreate(): ToolDef {
  const tool = findTool("note_create");
  if (!tool) throw new Error("note_create is not registered");
  return tool;
}

/** Вызов ровно тем путём, которым его делает MCP-сервер. */
function callCreate(args: Record<string, unknown>) {
  return noteCreate().handler(args, auth) as {
    id: string;
    created: boolean;
    updated_at_ms: number;
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "OK";
  } catch (error) {
    return String((error as { code?: string }).code ?? "ERROR");
  }
}

function raw(id: string) {
  return db
    .prepare(
      `SELECT metadata, updated_at_ms, invalidated_at_ms, supersedes_id
         FROM notes WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

describe("HIGH-2 — note_create idempotency is reachable through MCP", () => {
  test("the flag-ON inputSchema exposes idempotency_key", () => {
    enableFlag();
    const schema = Object.keys(effectiveToolSchema(noteCreate()));
    expect(schema).toContain("idempotency_key");
    // И оно приходит именно из V4.1-расширения, а не из базовой схемы.
    expect(Object.keys(bitemporalToolFields("note_create"))).toContain("idempotency_key");
    expect(Object.keys(noteCreate().rawSchema)).not.toContain("idempotency_key");
  });

  test("(a) an identical replay through MCP returns the same note id", () => {
    enableFlag();
    const key = "mcp-idem-plain";
    const first = callCreate({ text: "mcp idempotent body", type: "memory", idempotency_key: key });
    const second = callCreate({ text: "mcp idempotent body", type: "memory", idempotency_key: key });
    expect(second.id).toBe(first.id);
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE text = ? AND workspace_id = ?`)
      .get("mcp idempotent body", auth.workspace_id) as { c: number };
    expect(rows.c).toBe(1);
  });

  test("(a) an identical supersession replay through MCP does not close the predecessor twice", () => {
    enableFlag();
    const predecessor = callCreate({ text: "mcp predecessor", type: "memory" });
    const args = {
      text: "mcp successor",
      type: "memory",
      idempotency_key: "mcp-idem-supersede",
      supersedes_id: predecessor.id,
      expected_superseded_updated_at_ms: predecessor.updated_at_ms,
    };
    const first = callCreate(args);
    const afterFirst = raw(predecessor.id);
    const second = callCreate(args);
    const afterSecond = raw(predecessor.id);

    expect(second.id).toBe(first.id);
    expect(afterSecond.invalidated_at_ms).toBe(afterFirst.invalidated_at_ms as number);
    expect(afterSecond.updated_at_ms).toBe(afterFirst.updated_at_ms as number);

    const successors = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE supersedes_id = ?`)
      .get(predecessor.id) as { c: number };
    expect(successors.c).toBe(1);
    const relations = db
      .prepare(
        `SELECT COUNT(*) AS c FROM note_relations
          WHERE target_note_id = ? AND relation_type = 'supersedes'`,
      )
      .get(predecessor.id) as { c: number };
    expect(relations.c).toBe(1);
    const provenance = db
      .prepare(`SELECT COUNT(*) AS c FROM note_temporal_provenance WHERE note_id = ?`)
      .get(predecessor.id) as { c: number };
    expect(provenance.c).toBe(1);
    const activity = db
      .prepare(
        `SELECT COUNT(*) AS c FROM activity
          WHERE workspace_id = ? AND action = 'note_superseded' AND entity_id = ?`,
      )
      .get(auth.workspace_id, first.id) as { c: number };
    expect(activity.c).toBe(1);
  });

  test("(b) the same key with a different payload is IDEMPOTENCY_MISMATCH (§8)", () => {
    enableFlag();
    const key = "mcp-idem-mismatch";
    callCreate({ text: "mcp first payload", type: "memory", idempotency_key: key });
    expect(
      codeOf(() => callCreate({ text: "mcp second payload", type: "memory", idempotency_key: key })),
    ).toBe("IDEMPOTENCY_MISMATCH");
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE text = ? AND workspace_id = ?`)
      .get("mcp second payload", auth.workspace_id) as { c: number };
    expect(rows.c).toBe(0);
  });

  test("(c) flag OFF hides idempotency_key and still refuses temporal params", () => {
    delete process.env.QOOPIA_V4_BITEMPORAL;
    expect(Object.keys(effectiveToolSchema(noteCreate()))).not.toContain("idempotency_key");
    expect(
      codeOf(() => callCreate({ text: "mcp off key", type: "memory", idempotency_key: "mcp-off" })),
    ).toBe("FEATURE_DISABLED");

    const base = callCreate({ text: "mcp off predecessor", type: "memory" });
    expect(
      codeOf(() =>
        callCreate({
          text: "mcp off successor",
          type: "memory",
          supersedes_id: base.id,
          expected_superseded_updated_at_ms: base.updated_at_ms,
        }),
      ),
    ).toBe("FEATURE_DISABLED");
    expect(codeOf(() => callCreate({ text: "mcp off subject", type: "memory", subject_key: "a.b" })))
      .toBe("FEATURE_DISABLED");
  });

  test("(c) flag OFF output of note_create is unchanged field-for-field", () => {
    delete process.env.QOOPIA_V4_BITEMPORAL;
    const created = callCreate({ text: "mcp off parity", type: "memory" });
    expect(Object.keys(created).sort()).toEqual([
      "created",
      "created_at",
      "id",
      "type",
      "updated_at",
      "updated_at_ms",
      "visibility",
      "workspace_id",
    ]);
    // notes.metadata по-прежнему не трогается ни одним путём (R2).
    expect(raw(created.id).metadata).toBe("{}");
  });
});

/**
 * Объявить поле в схеме и НЕ пробросить его в хендлер — тот же невидимый для
 * клиента результат, что и не объявить вовсе. Проверка поведенческая: каждому
 * V4.1-полю подставляется заведомо негодное значение, отвергнуть которое умеет
 * только `createNote`. Если хендлер поле теряет, нота создаётся успешно и тест
 * падает. Список берётся из самой схемы, поэтому новое поле без записи ниже
 * тоже уронит тест.
 */
describe("HIGH-2 — every declared V4.1 note_create field actually reaches the service", () => {
  const POISON: Record<string, unknown> = {
    supersedes_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    expected_superseded_updated_at_ms: 1,
    subject_key: "Not A Valid Key!",
    valid_from: "not-a-timestamp",
    valid_until: "not-a-timestamp",
    idempotency_key: "not a valid key!",
  };

  test("a poisoned value for each field is rejected by createNote, not silently dropped", () => {
    enableFlag();
    const declared = Object.keys(bitemporalToolFields("note_create")).sort();
    expect(declared.length).toBeGreaterThan(0);
    const results: Record<string, string> = {};
    for (const field of declared) {
      expect(Object.hasOwn(POISON, field)).toBe(true);
      results[field] = codeOf(() =>
        callCreate({
          text: `forwarding probe ${field}`,
          type: "memory",
          [field]: POISON[field],
        }),
      );
    }
    for (const [field, code] of Object.entries(results)) {
      // "OK" означало бы, что поле до сервиса не дошло.
      expect({ field, code }).not.toEqual({ field, code: "OK" });
      expect(["INVALID_INPUT", "NOT_FOUND"]).toContain(code);
    }
    // Ни одна проба не создала ноту.
    const leaked = db
      .prepare(
        `SELECT COUNT(*) AS c FROM notes WHERE workspace_id = ? AND text LIKE 'forwarding probe %'`,
      )
      .get(auth.workspace_id) as { c: number };
    expect(leaked.c).toBe(0);
  });
});
