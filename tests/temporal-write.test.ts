/**
 * ТЗ §10.4 — write-path: атомарность явной supersession, оптимистическая
 * конкуренция, идемпотентность и матрица ошибок §8.
 *
 * Флаг QOOPIA_V4_BITEMPORAL включается только внутри этих тестов и всегда
 * возвращается в исходное состояние.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { createNote, getNote } from "../src/services/notes.ts";
import { supersedeExistingNote } from "../src/services/note-temporal.ts";
import { QoopiaError } from "../src/utils/errors.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";

function enableFlag(): void {
  process.env.QOOPIA_V4_BITEMPORAL = "1";
}

afterEach(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
});

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Temporal Write", slug: "temporal-write" });
  WORKSPACE_ID = workspace.id;
  AGENT_ID = createAgent({ name: "temporal-writer", workspaceSlug: workspace.slug }).id;
});

afterAll(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
});

function note(text: string, extra: Record<string, unknown> = {}) {
  return createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_ID,
    text,
    type: "memory",
    ...extra,
  });
}

function raw(id: string) {
  return db
    .prepare(
      `SELECT metadata, updated_at, updated_at_ms, invalidated_at, invalidated_at_ms,
              valid_from, valid_from_ms, valid_until, valid_until_ms,
              subject_key, supersedes_id, created_at_ms
         FROM notes WHERE id = ?`,
    )
    .get(id) as Record<string, any>;
}

describe("Flag OFF", () => {
  test("temporal input is refused with FEATURE_DISABLED", () => {
    const base = note("flag off predecessor");
    for (const extra of [
      { supersedes_id: base.id, expected_superseded_updated_at_ms: base.updated_at_ms },
      { subject_key: "billing.plan" },
      { valid_from: "2026-01-01T00:00:00Z" },
      { valid_until: "2030-01-01T00:00:00Z" },
    ]) {
      let code = "";
      try {
        note("flag off attempt", extra);
      } catch (error) {
        code = (error as { code: string }).code;
      }
      expect(code).toBe("FEATURE_DISABLED");
    }
  });

  test("structural columns are still populated so valid_from_ms is never null", () => {
    const created = note("flag off structural");
    const row = raw(created.id);
    expect(row.created_at_ms).toBe(created.updated_at_ms);
    expect(row.valid_from_ms).toBe(created.updated_at_ms);
    expect(row.valid_from).toBe(created.created_at);
    expect(row.invalidated_at_ms).toBeNull();
    // Никаких темпоральных полей в сериализованном виде.
    const view = getNote(WORKSPACE_ID, created.id, AGENT_ID, false) as Record<string, unknown>;
    expect("valid_from" in view).toBe(false);
    expect("valid_until_inferred" in view).toBe(false);
  });
});

describe("Flag ON — atomic explicit supersession", () => {
  test("one transaction writes B, closes A, adds relation, provenance and activity", () => {
    enableFlag();
    const a = note("A: the office is on Abay 10", { subject_key: "office.address" });
    const b = note("B: the office moved to Dostyk 5", {
      supersedes_id: a.id,
      expected_superseded_updated_at_ms: a.updated_at_ms,
    });

    const rowA = raw(a.id);
    const rowB = raw(b.id);
    expect(rowA.invalidated_at_ms).not.toBeNull();
    expect(rowA.invalidated_at).toBe(new Date(rowA.invalidated_at_ms).toISOString());
    // valid_until предшественника = valid_from преемника.
    expect(rowA.valid_until_ms).toBe(rowB.valid_from_ms);
    expect(Date.parse(rowA.valid_until)).toBe(rowA.valid_until_ms);
    expect(rowB.supersedes_id).toBe(a.id);
    // subject_key наследуется по цепочке.
    expect(rowB.subject_key).toBe("office.address");

    const relation = db
      .prepare(
        `SELECT id FROM note_relations
          WHERE workspace_id = ? AND source_note_id = ? AND target_note_id = ?
            AND relation_type = 'supersedes'`,
      )
      .get(WORKSPACE_ID, b.id, a.id);
    expect(relation).toBeTruthy();

    const provenance = db
      .prepare(
        `SELECT workspace_id, invalidated_at_source, valid_until_source, valid_until_inferred
           FROM note_temporal_provenance WHERE note_id = ?`,
      )
      .get(a.id) as Record<string, any>;
    expect(provenance.workspace_id).toBe(WORKSPACE_ID);
    expect(provenance.invalidated_at_source).toBe("explicit_write");
    expect(provenance.valid_until_source).toBe("observed");
    expect(provenance.valid_until_inferred).toBe(0);

    const activity = db
      .prepare(
        `SELECT COUNT(*) AS c FROM activity
          WHERE workspace_id = ? AND action = 'note_superseded' AND entity_id = ?`,
      )
      .get(WORKSPACE_ID, b.id) as { c: number };
    expect(activity.c).toBe(1);
  });

  test("notes.metadata is never written by the supersession path (R2)", () => {
    enableFlag();
    const a = note("A metadata guard", { metadata: { status: "active", k: 1 } });
    const before = raw(a.id).metadata;
    const b = note("B metadata guard", {
      supersedes_id: a.id,
      expected_superseded_updated_at_ms: a.updated_at_ms,
    });
    expect(raw(a.id).metadata).toBe(before);
    expect(raw(b.id).metadata).toBe("{}");
    // Legacy-зеркало createNoteRelation здесь не применяется.
    expect(JSON.parse(raw(a.id).metadata).superseded_by).toBeUndefined();
    expect(JSON.parse(raw(a.id).metadata).status).toBe("active");
  });

  test("two writers on the same version yield exactly one PASS and one STALE_VERSION", () => {
    enableFlag();
    const a = note("A contended");
    const version = a.updated_at_ms;
    const outcomes: string[] = [];
    for (const label of ["first", "second"]) {
      try {
        note(`B ${label}`, {
          supersedes_id: a.id,
          expected_superseded_updated_at_ms: version,
        });
        outcomes.push("PASS");
      } catch (error) {
        outcomes.push((error as { code: string }).code);
      }
    }
    expect(outcomes).toEqual(["PASS", "STALE_VERSION"]);
    const closed = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE supersedes_id = ?`)
      .get(a.id) as { c: number };
    expect(closed.c).toBe(1);
  });

  test("an already-invalidated predecessor with a matching version is a CONFLICT", () => {
    enableFlag();
    const a = note("A already closed");
    note("B first closer", {
      supersedes_id: a.id,
      expected_superseded_updated_at_ms: a.updated_at_ms,
    });
    const current = raw(a.id);
    let code = "";
    try {
      note("B second closer", {
        supersedes_id: a.id,
        expected_superseded_updated_at_ms: current.updated_at_ms,
      });
    } catch (error) {
      code = (error as QoopiaError).code;
    }
    expect(code).toBe("CONFLICT");
  });

  test("a failed supersession rolls back the successor insert entirely", () => {
    enableFlag();
    const a = note("A rollback probe");
    const before = db.prepare(`SELECT COUNT(*) AS c FROM notes`).get() as { c: number };
    expect(() =>
      note("B never persisted", {
        supersedes_id: a.id,
        expected_superseded_updated_at_ms: a.updated_at_ms + 999,
      }),
    ).toThrow();
    const after = db.prepare(`SELECT COUNT(*) AS c FROM notes`).get() as { c: number };
    expect(after.c).toBe(before.c);
    expect(raw(a.id).invalidated_at_ms).toBeNull();
  });
});

describe("Flag ON — §8 error matrix", () => {
  function expectCode(fn: () => unknown, expected: string) {
    let code = "";
    try {
      fn();
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe(expected);
  }

  test("supersedes_id without the expected version is INVALID_INPUT", () => {
    enableFlag();
    const a = note("A no version");
    expectCode(() => note("B", { supersedes_id: a.id }), "INVALID_INPUT");
  });

  test("expected version without supersedes_id is INVALID_INPUT", () => {
    enableFlag();
    expectCode(() => note("B", { expected_superseded_updated_at_ms: 1 }), "INVALID_INPUT");
  });

  test("valid_until <= valid_from is INVALID_INPUT", () => {
    enableFlag();
    expectCode(
      () =>
        note("B bad interval", {
          valid_from: "2026-05-01T00:00:00Z",
          valid_until: "2026-05-01T00:00:00Z",
        }),
      "INVALID_INPUT",
    );
  });

  test("a future valid_from with supersedes_id is INVALID_INPUT", () => {
    enableFlag();
    const a = note("A future guard");
    expectCode(
      () =>
        note("B future", {
          supersedes_id: a.id,
          expected_superseded_updated_at_ms: a.updated_at_ms,
          valid_from: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      "INVALID_INPUT",
    );
  });

  test("a different subject_key along the chain is INVALID_INPUT", () => {
    enableFlag();
    const a = note("A subject", { subject_key: "billing.plan" });
    expectCode(
      () =>
        note("B subject", {
          supersedes_id: a.id,
          expected_superseded_updated_at_ms: a.updated_at_ms,
          subject_key: "billing.other",
        }),
      "INVALID_INPUT",
    );
  });

  test("an invalid subject_key shape is INVALID_INPUT and is not silently lowercased", () => {
    enableFlag();
    expectCode(() => note("B", { subject_key: "Billing.Plan" }), "INVALID_INPUT");
    expectCode(() => note("B", { subject_key: "-leading" }), "INVALID_INPUT");
    expectCode(() => note("B", { subject_key: "x".repeat(129) }), "INVALID_INPUT");
  });

  test("a missing or foreign predecessor is NOT_FOUND", () => {
    enableFlag();
    expectCode(
      () =>
        note("B orphan", {
          supersedes_id: "no-such-note",
          expected_superseded_updated_at_ms: 1,
        }),
      "NOT_FOUND",
    );
  });

  test("valid_from before the predecessor's valid_from is INVALID_INPUT", () => {
    enableFlag();
    const a = note("A ordering");
    expectCode(
      () =>
        note("B ordering", {
          supersedes_id: a.id,
          expected_superseded_updated_at_ms: a.updated_at_ms,
          valid_from: "2020-01-01T00:00:00Z",
        }),
      "INVALID_INPUT",
    );
  });
});

describe("Flag ON — note_supersede helper on an existing successor", () => {
  test("closes the predecessor without touching notes.metadata", () => {
    enableFlag();
    const a = note("A helper", { metadata: { status: "active" } });
    const b = note("B helper");
    const metadataBefore = raw(a.id).metadata;
    const result = supersedeExistingNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      is_admin: false,
      successor_id: b.id,
      predecessor_id: a.id,
      expected_updated_at_ms: a.updated_at_ms,
      relation_metadata: { mcp_idempotency_key: "helper-key-0001" },
    });
    expect(result.relation_id).toBeTruthy();
    expect(raw(a.id).metadata).toBe(metadataBefore);
    expect(raw(a.id).invalidated_at_ms).toBe(result.invalidated_at_ms);
    expect(raw(b.id).supersedes_id).toBe(a.id);
  });

  test("a stale expected version is STALE_VERSION", () => {
    enableFlag();
    const a = note("A helper stale");
    const b = note("B helper stale");
    let code = "";
    try {
      supersedeExistingNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        is_admin: false,
        successor_id: b.id,
        predecessor_id: a.id,
        expected_updated_at_ms: a.updated_at_ms + 5,
      });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("STALE_VERSION");
  });

  test("the helper is FEATURE_DISABLED while the flag is off", () => {
    const a = note("A helper off");
    const b = note("B helper off");
    let code = "";
    try {
      supersedeExistingNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        is_admin: false,
        successor_id: b.id,
        predecessor_id: a.id,
        expected_updated_at_ms: a.updated_at_ms,
      });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("FEATURE_DISABLED");
  });
});

/**
 * Регрессии независимого review (SHA 47875be), HIGH-2 и HIGH-3.
 */
describe("HIGH-2 — note_create idempotency (§6.3, §8)", () => {
  function payload(text: string, key: string, extra: Record<string, unknown> = {}) {
    return {
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text,
      type: "memory",
      idempotency_key: key,
      ...extra,
    };
  }

  test("an identical replay returns the same note and inserts nothing twice", () => {
    enableFlag();
    const key = `idem-plain-${Date.now()}`;
    const first = createNote(payload("idempotent body", key));
    const second = createNote(payload("idempotent body", key));
    expect(second.id).toBe(first.id);
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE text = ? AND workspace_id = ?`)
      .get("idempotent body", WORKSPACE_ID) as { c: number };
    expect(rows.c).toBe(1);
  });

  test("an identical supersession replay does not close the predecessor twice", () => {
    enableFlag();
    const key = `idem-supersede-${Date.now()}`;
    const a = note("A idempotent predecessor");
    const body = payload("B idempotent successor", key, {
      supersedes_id: a.id,
      expected_superseded_updated_at_ms: a.updated_at_ms,
    });
    const first = createNote(body);
    const closedOnce = raw(a.id);
    // Повтор с тем же ключом: ни второй ноты B, ни второго закрытия A, ни
    // STALE_VERSION — полный no-op с прежним ответом.
    const second = createNote(body);
    expect(second.id).toBe(first.id);
    expect(raw(a.id).invalidated_at_ms).toBe(closedOnce.invalidated_at_ms);
    expect(raw(a.id).updated_at_ms).toBe(closedOnce.updated_at_ms);

    const successors = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE supersedes_id = ?`)
      .get(a.id) as { c: number };
    expect(successors.c).toBe(1);
    const relations = db
      .prepare(
        `SELECT COUNT(*) AS c FROM note_relations
          WHERE target_note_id = ? AND relation_type = 'supersedes'`,
      )
      .get(a.id) as { c: number };
    expect(relations.c).toBe(1);
    const provenance = db
      .prepare(`SELECT COUNT(*) AS c FROM note_temporal_provenance WHERE note_id = ?`)
      .get(a.id) as { c: number };
    expect(provenance.c).toBe(1);
    const activity = db
      .prepare(
        `SELECT COUNT(*) AS c FROM activity
          WHERE workspace_id = ? AND action = 'note_superseded' AND entity_id = ?`,
      )
      .get(WORKSPACE_ID, first.id) as { c: number };
    expect(activity.c).toBe(1);
  });

  test("the same key with a different payload is IDEMPOTENCY_MISMATCH", () => {
    enableFlag();
    const key = `idem-mismatch-${Date.now()}`;
    createNote(payload("first body", key));
    let code = "";
    try {
      createNote(payload("second body", key));
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("IDEMPOTENCY_MISMATCH");
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE text = ? AND workspace_id = ?`)
      .get("second body", WORKSPACE_ID) as { c: number };
    expect(rows.c).toBe(0);
  });

  test("a change in any temporal field also counts as a different payload", () => {
    enableFlag();
    const key = `idem-temporal-${Date.now()}`;
    createNote(payload("same text different subject", key, { subject_key: "billing.plan" }));
    let code = "";
    try {
      createNote(payload("same text different subject", key, { subject_key: "billing.tier" }));
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("IDEMPOTENCY_MISMATCH");
  });

  test("a malformed key is INVALID_INPUT and the flag gates the field entirely", () => {
    enableFlag();
    let code = "";
    try {
      createNote(payload("bad key", "not a valid key!"));
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("INVALID_INPUT");

    delete process.env.QOOPIA_V4_BITEMPORAL;
    code = "";
    try {
      createNote(payload("flag off key", `idem-off-${Date.now()}`));
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("FEATURE_DISABLED");
  });
});

describe("HIGH-3 — supersedeExistingNote invariants", () => {
  function supersede(successorId: string, predecessorId: string, expected: number) {
    return supersedeExistingNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      is_admin: false,
      successor_id: successorId,
      predecessor_id: predecessorId,
      expected_updated_at_ms: expected,
    });
  }

  test("retargeting an already-set supersedes_id is refused and the predecessor stays open", () => {
    enableFlag();
    const a1 = note("A1 retarget");
    const a2 = note("A2 retarget");
    const b = note("B retarget");
    supersede(b.id, a1.id, a1.updated_at_ms);
    const before = raw(a2.id);

    let code = "";
    try {
      supersede(b.id, a2.id, a2.updated_at_ms);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("CONFLICT");
    // Второй предшественник НЕ закрыт: связь успела бы порваться раньше.
    expect(raw(a2.id).invalidated_at_ms).toBe(before.invalidated_at_ms);
    expect(raw(a2.id).updated_at_ms).toBe(before.updated_at_ms);
    expect(raw(b.id).supersedes_id).toBe(a1.id);
    const relations = db
      .prepare(
        `SELECT COUNT(*) AS c FROM note_relations
          WHERE target_note_id = ? AND relation_type = 'supersedes'`,
      )
      .get(a2.id) as { c: number };
    expect(relations.c).toBe(0);
    const provenance = db
      .prepare(`SELECT COUNT(*) AS c FROM note_temporal_provenance WHERE note_id = ?`)
      .get(a2.id) as { c: number };
    expect(provenance.c).toBe(0);
  });

  test("a supersession that would close the cycle is refused, as on the legacy path", () => {
    enableFlag();
    const a = note("A cycle guard");
    const b = note("B cycle guard");
    supersede(b.id, a.id, a.updated_at_ms);
    const beforeB = raw(b.id);

    let message = "";
    let code = "";
    try {
      supersede(a.id, b.id, raw(b.id).updated_at_ms);
    } catch (error) {
      code = (error as { code: string }).code;
      message = (error as Error).message;
    }
    expect(code).toBe("CONFLICT");
    expect(message).toMatch(/cycle/);
    expect(raw(b.id).invalidated_at_ms).toBe(beforeB.invalidated_at_ms);
    expect(raw(a.id).supersedes_id).toBeNull();
  });

  test("a successor linked out-of-band is refused before the predecessor is closed", () => {
    enableFlag();
    const a = note("A out-of-band");
    const other = note("other out-of-band");
    const b = note("B out-of-band");
    // Кто-то проставил связь мимо сервиса — условие «ровно одна изменённая
    // строка» обязано остановить закрытие A.
    db.prepare(`UPDATE notes SET supersedes_id = ? WHERE id = ?`).run(other.id, b.id);
    const before = raw(a.id);

    let code = "";
    try {
      supersede(b.id, a.id, a.updated_at_ms);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("CONFLICT");
    expect(raw(a.id).invalidated_at_ms).toBe(before.invalidated_at_ms);
    expect(raw(a.id).invalidated_at_ms).toBeNull();
  });

  test("a note still cannot supersede itself", () => {
    enableFlag();
    const a = note("A self");
    let code = "";
    try {
      supersede(a.id, a.id, a.updated_at_ms);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("INVALID_INPUT");
  });
});

describe("MEDIUM-6 — real concurrency across two processes (§10.4)", () => {
  test("two independent writers on the same version yield exactly 1 PASS + 1 STALE_VERSION", async () => {
    enableFlag();
    const a = note("A cross-process contended");
    const version = a.updated_at_ms;
    delete process.env.QOOPIA_V4_BITEMPORAL;

    const barrier = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-conc-")),
      "barrier",
    );
    const probe = path.resolve(import.meta.dir, "..", "scripts/v41-concurrency-probe.ts");
    const labels = ["writer-1", "writer-2"];
    const children = labels.map((label) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          probe,
          "--label",
          label,
          "--workspace",
          WORKSPACE_ID,
          "--agent",
          AGENT_ID,
          "--predecessor",
          a.id,
          "--version",
          String(version),
          "--barrier",
          barrier,
        ],
        env: { ...process.env, QOOPIA_SERVER_ROLE: "canonical" },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    // Оба процесса открыли собственное соединение и ждут — снимаем барьер.
    const readyBy = Date.now() + 30_000;
    while (!labels.every((label) => fs.existsSync(`${barrier}.ready.${label}`))) {
      if (Date.now() > readyBy) throw new Error("probes did not reach the barrier");
      await Bun.sleep(10);
    }
    fs.writeFileSync(`${barrier}.go`, "go");

    const outcomes: string[] = [];
    for (const child of children) {
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) throw new Error(`probe produced no result: ${stderr}`);
      outcomes.push((JSON.parse(line) as { outcome: string }).outcome);
    }

    expect(outcomes.filter((o) => o === "PASS")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "STALE_VERSION")).toHaveLength(1);

    // Ровно одно закрытие, один преемник, одно ребро, одна строка provenance.
    const successors = db
      .prepare(`SELECT COUNT(*) AS c FROM notes WHERE supersedes_id = ?`)
      .get(a.id) as { c: number };
    expect(successors.c).toBe(1);
    const relations = db
      .prepare(
        `SELECT COUNT(*) AS c FROM note_relations
          WHERE target_note_id = ? AND relation_type = 'supersedes'`,
      )
      .get(a.id) as { c: number };
    expect(relations.c).toBe(1);
  }, 60_000);
});
