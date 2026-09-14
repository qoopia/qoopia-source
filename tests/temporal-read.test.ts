/**
 * ТЗ §10.2/§10.3/§10.6 — read-path.
 *
 * Проверяются: current-belief по умолчанию при флаге ON, границы
 * `valid_as_of`/`known_as_of`, их независимость, `include_history`,
 * различие deleted и invalidated, характеризационное отличие Flag-ON от
 * legacy `latest_only`, байт-идентичность вывода при выключенном флаге и
 * over-fetch векторного канала.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { db } from "../src/db/connection.ts";
import { createNote, getNote, listNotes } from "../src/services/notes.ts";
import { applyVectorTemporalWindow, recall } from "../src/services/recall.ts";
import { VECTOR_TEMPORAL_OVERFETCH } from "../src/services/recall/temporal-filter.ts";
import { isoFromEpochMs } from "../src/utils/temporal.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";
let OTHER_AGENT_ID = "";

const TERM = "zoltrix";

interface Chain {
  a: string;
  b: string;
  c: string;
  a_valid_from_ms: number;
  b_valid_from_ms: number;
  c_valid_from_ms: number;
  a_invalidated_ms: number;
  b_invalidated_ms: number;
}

function enableFlag(): void {
  process.env.QOOPIA_V4_BITEMPORAL = "1";
}

afterEach(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
});

afterAll(() => {
  delete process.env.QOOPIA_V4_BITEMPORAL;
  delete process.env.QOOPIA_V4_RELATIONS;
  delete process.env.QOOPIA_V4_LATEST_ONLY;
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

function temporalRow(id: string) {
  return db
    .prepare(
      `SELECT valid_from_ms, valid_until_ms, invalidated_at_ms, created_at_ms
         FROM notes WHERE id = ?`,
    )
    .get(id) as Record<string, number | null>;
}

let chain: Chain;

beforeAll(() => {
  runMigrations();
  const workspace = createWorkspace({ name: "Temporal Read", slug: "temporal-read" });
  WORKSPACE_ID = workspace.id;
  AGENT_ID = createAgent({ name: "temporal-reader", workspaceSlug: workspace.slug }).id;
  OTHER_AGENT_ID = createAgent({
    name: "temporal-reader-other",
    workspaceSlug: workspace.slug,
  }).id;

  // Цепочка A -> B -> C строится при включённом флаге, читается — в обоих.
  enableFlag();
  const a = note(`${TERM} revision one`);
  const b = note(`${TERM} revision two`, {
    supersedes_id: a.id,
    expected_superseded_updated_at_ms: a.updated_at_ms,
  });
  const c = note(`${TERM} revision three`, {
    supersedes_id: b.id,
    expected_superseded_updated_at_ms: db
      .prepare(`SELECT updated_at_ms FROM notes WHERE id = ?`)
      .get(b.id)!.updated_at_ms as number,
  });
  delete process.env.QOOPIA_V4_BITEMPORAL;

  const rowA = temporalRow(a.id);
  const rowB = temporalRow(b.id);
  const rowC = temporalRow(c.id);
  chain = {
    a: a.id,
    b: b.id,
    c: c.id,
    a_valid_from_ms: rowA.valid_from_ms!,
    b_valid_from_ms: rowB.valid_from_ms!,
    c_valid_from_ms: rowC.valid_from_ms!,
    a_invalidated_ms: rowA.invalidated_at_ms!,
    b_invalidated_ms: rowB.invalidated_at_ms!,
  };
});

async function ids(params: Record<string, unknown> = {}): Promise<string[]> {
  const response = await recall({
    workspace_id: WORKSPACE_ID,
    caller_agent_id: AGENT_ID,
    is_admin: false,
    query: TERM,
    limit: 50,
    ...params,
  } as never);
  return response.results.map((row) => row.id);
}

describe("Flag OFF read path", () => {
  test("all three revisions are returned and no temporal key is serialized", async () => {
    const results = await ids();
    expect(results).toContain(chain.a);
    expect(results).toContain(chain.b);
    expect(results).toContain(chain.c);
    const response = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: TERM,
    } as never);
    for (const row of response.results) {
      expect("valid_from" in row).toBe(false);
      expect("valid_until_inferred" in row).toBe(false);
    }
  });

  test("temporal parameters are refused with FEATURE_DISABLED", async () => {
    for (const params of [
      { valid_as_of: "2026-01-01T00:00:00Z" },
      { known_as_of: "2026-01-01T00:00:00Z" },
    ]) {
      let code = "";
      try {
        await ids(params);
      } catch (error) {
        code = (error as { code: string }).code;
      }
      expect(code).toBe("FEATURE_DISABLED");
    }
  });

  test("note_get and note_list stay byte-identical across the flag boundary", () => {
    const off = JSON.stringify(getNote(WORKSPACE_ID, chain.a, AGENT_ID, false));
    enableFlag();
    const on = JSON.parse(JSON.stringify(getNote(WORKSPACE_ID, chain.a, AGENT_ID, false)));
    delete process.env.QOOPIA_V4_BITEMPORAL;
    // Flag-ON — надмножество: удаление добавленных ключей возвращает Flag-OFF.
    for (const key of [
      "valid_from",
      "valid_until",
      "invalidated_at",
      "subject_key",
      "supersedes_id",
      "valid_until_inferred",
    ]) {
      expect(key in on).toBe(true);
      delete on[key];
    }
    expect(JSON.stringify(on)).toBe(off);
  });

  test("note_list Flag-OFF exposes no temporal key", () => {
    const page = listNotes({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      limit: 10,
    });
    for (const item of page.items) {
      expect("valid_from" in item).toBe(false);
    }
  });
});

describe("Flag ON — current belief and temporal modes (§3.2)", () => {
  test("default returns only the current head C", async () => {
    enableFlag();
    const results = await ids();
    expect(results).toContain(chain.c);
    expect(results).not.toContain(chain.a);
    expect(results).not.toContain(chain.b);
  });

  test("valid_as_of selects the revision true in the world at T", async () => {
    enableFlag();
    // Внутри интервала A: [a_valid_from, a_valid_until)
    const insideA = isoFromEpochMs(chain.a_valid_from_ms);
    expect(await ids({ valid_as_of: insideA })).toEqual([chain.a]);
    // Ровно на границе — интервал полуоткрытый, поэтому это уже B.
    const boundary = isoFromEpochMs(chain.b_valid_from_ms);
    expect(await ids({ valid_as_of: boundary })).toEqual([chain.b]);
    // Позже конца цепочки — текущая голова.
    const now = isoFromEpochMs(chain.c_valid_from_ms + 1000);
    expect(await ids({ valid_as_of: now })).toEqual([chain.c]);
  });

  test("known_as_of selects what the system knew at T", async () => {
    enableFlag();
    // В момент создания A система знала только A: B ещё не существовал.
    const atCreation = isoFromEpochMs(chain.a_valid_from_ms);
    expect(await ids({ known_as_of: atCreation })).toEqual([chain.a]);
    // В момент закрытия A знание уже переключилось на B.
    const atClose = isoFromEpochMs(chain.a_invalidated_ms);
    expect(await ids({ known_as_of: atClose })).toEqual([chain.b]);
  });

  test("known-time has no overlap window: B is known exactly when A stops being known", async () => {
    enableFlag();
    // Регрессия: раньше преемник создавался в `timestamp.ms`, а
    // предшественник закрывался в `timestamp.ms + 1`, поэтому в миллисекунду
    // создания B предикат `created_at_ms <= T AND T < invalidated_at_ms`
    // считал ИЗВЕСТНЫМИ ОБА убеждения. Теперь граница одна.
    expect(chain.a_invalidated_ms).toBe(chain.b_valid_from_ms);
    const switchMs = chain.a_invalidated_ms;
    for (const t of [switchMs - 1, switchMs, switchMs + 1]) {
      const known = await ids({ known_as_of: isoFromEpochMs(t) });
      expect(known).not.toEqual([]);
      // Ни в одной точке A и B не известны одновременно.
      expect(known.includes(chain.a) && known.includes(chain.b)).toBe(false);
    }
    expect(await ids({ known_as_of: isoFromEpochMs(switchMs - 1) })).toEqual([chain.a]);
    expect(await ids({ known_as_of: isoFromEpochMs(switchMs) })).toEqual([chain.b]);
  });

  test("valid_as_of and known_as_of are independent and compose as a conjunction", async () => {
    enableFlag();
    const validInA = isoFromEpochMs(chain.a_valid_from_ms);
    const validInB = isoFromEpochMs(chain.b_valid_from_ms);
    // Знание в момент, когда A ещё не закрыт, о том, что истинно в момент A.
    const knownWhileAOpen = isoFromEpochMs(chain.a_invalidated_ms - 1);
    expect(await ids({ valid_as_of: validInA, known_as_of: knownWhileAOpen })).toEqual([
      chain.a,
    ]);
    // Тот же момент знания, но вопрос о валидности в интервале B — пусто:
    // пока A открыт, B ещё не существует (B создаётся ровно тем же
    // transaction-time, которым закрывается A — см. тест о границе ниже).
    expect(await ids({ valid_as_of: validInB, known_as_of: knownWhileAOpen })).toEqual([]);
    // Ровно в момент переключения знания истинным и известным становится B.
    const knownAtSwitch = isoFromEpochMs(chain.a_invalidated_ms);
    expect(await ids({ valid_as_of: validInB, known_as_of: knownAtSwitch })).toEqual([
      chain.b,
    ]);
    // Конъюнкция пуста, когда знание предшествует появлению ревизии.
    const knownAtCreation = isoFromEpochMs(chain.a_valid_from_ms);
    expect(await ids({ valid_as_of: validInB, known_as_of: knownAtCreation })).toEqual([]);
    // Ни один из режимов не подразумевает другой: known_as_of «сейчас» даёт
    // всю известную сейчас историю, отфильтрованную только по valid-time.
    const knownNow = isoFromEpochMs(chain.b_invalidated_ms + 1000);
    expect(await ids({ known_as_of: knownNow })).toEqual([chain.c]);
  });

  test("include_history drops the temporal predicates entirely", async () => {
    enableFlag();
    process.env.QOOPIA_V4_RELATIONS = "true";
    const results = await ids({ include_history: true, include_archived: true });
    delete process.env.QOOPIA_V4_RELATIONS;
    expect(results).toContain(chain.a);
    expect(results).toContain(chain.b);
    expect(results).toContain(chain.c);
  });

  test("include_history combined with a temporal parameter is INVALID_INPUT", async () => {
    enableFlag();
    let code = "";
    try {
      await ids({ include_history: true, valid_as_of: "2026-01-01T00:00:00Z" });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("INVALID_INPUT");
  });

  test("an unparsable temporal parameter is INVALID_INPUT", async () => {
    enableFlag();
    let code = "";
    try {
      await ids({ valid_as_of: "2026-01-01 00:00:00" });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("INVALID_INPUT");
  });

  test("results carry valid_until_inferred from provenance", async () => {
    enableFlag();
    const response = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: TERM,
      valid_as_of: isoFromEpochMs(chain.a_valid_from_ms),
    } as never);
    expect(response.results).toHaveLength(1);
    // Явная запись — наблюдаемое valid-time, не выведенное.
    expect(response.results[0]!.valid_until_inferred).toBe(0);
    expect(response.results[0]!.supersedes_id).toBeNull();
  });
});

describe("Flag ON — deleted is independent of invalidated (§9.5)", () => {
  test("a soft-deleted current note is excluded while an invalidated one is a separate case", async () => {
    enableFlag();
    const term = "quintarex";
    const kept = note(`${term} kept`);
    const removed = note(`${term} removed`);
    db.prepare(`UPDATE notes SET deleted_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      removed.id,
    );
    db.prepare(`DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)`).run(
      removed.id,
    );
    const response = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: term,
    } as never);
    const found = response.results.map((row) => row.id);
    expect(found).toContain(kept.id);
    expect(found).not.toContain(removed.id);
    // invalidated_at и deleted_at независимы: удалённая нота не закрыта.
    expect(temporalRow(removed.id).invalidated_at_ms).toBeNull();
  });
});

describe("Flag ON — the single documented divergence from legacy latest_only (§7.2)", () => {
  test("replacement-unavailable: legacy shows the predecessor, current belief hides it", async () => {
    enableFlag();
    const term = "vantorix";
    const predecessor = note(`${term} public predecessor`);
    // Преемник private и принадлежит другому агенту: для нашего читателя
    // замена недоступна.
    const successor = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: OTHER_AGENT_ID,
      text: `${term} private successor`,
      type: "memory",
      visibility: "private",
      supersedes_id: predecessor.id,
      expected_superseded_updated_at_ms: predecessor.updated_at_ms,
      is_admin: false,
    });
    expect(temporalRow(predecessor.id).invalidated_at_ms).not.toBeNull();

    const currentBelief = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: term,
    } as never);
    expect(currentBelief.results.map((row) => row.id)).not.toContain(predecessor.id);

    // Legacy-путь: relation-aware latest_only с visibility-scoped цепочкой.
    delete process.env.QOOPIA_V4_BITEMPORAL;
    process.env.QOOPIA_V4_RELATIONS = "true";
    process.env.QOOPIA_V4_LATEST_ONLY = "true";
    const legacy = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: term,
      latest_only: true,
    } as never);
    delete process.env.QOOPIA_V4_RELATIONS;
    delete process.env.QOOPIA_V4_LATEST_ONLY;
    const legacyIds = legacy.results.map((row) => row.id);
    expect(legacyIds).toContain(predecessor.id);
    expect(legacyIds).not.toContain(successor.id);
  });

  test("a superseded node of a SKIPPED component is hidden too — no second divergence", async () => {
    // Регрессия независимого review. Миграция сознательно не бэкфиллит
    // split_head / cyclic / oversize (§5.3), поэтому у таких узлов
    // `invalidated_at_ms` остаётся NULL. Legacy `latest_only` выводит
    // активные головы из графа связей и такой узел прячет — если бы
    // Flag-ON показывал его, отличий стало бы ДВА вместо одного.
    enableFlag();
    const term = "krellton";
    const predecessor = note(`${term} skipped predecessor`);
    const headOne = note(`${term} skipped head one`);
    const headTwo = note(`${term} skipped head two`);
    // Legacy split-head компонента строится напрямую: два независимых
    // преемника одного предшественника, `notes` не мутируется.
    for (const [index, head] of [headOne, headTwo].entries()) {
      db.prepare(
        `INSERT INTO note_relations
           (id, workspace_id, source_note_id, target_note_id, relation_type,
            created_by_agent_id, metadata, created_at)
         VALUES (?, ?, ?, ?, 'supersedes', ?, '{}', ?)`,
      ).run(
        `rel-skipped-${index}-${predecessor.id}`,
        WORKSPACE_ID,
        head.id,
        predecessor.id,
        AGENT_ID,
        "2026-05-01T00:00:00.000Z",
      );
    }
    db.prepare(
      `INSERT OR REPLACE INTO note_temporal_provenance
         (note_id, workspace_id, backfill_class, skipped_reason)
       VALUES (?, ?, 'split_head', 'split_head_component')`,
    ).run(predecessor.id, WORKSPACE_ID);
    // Именно conservative-состояние миграции: нота НЕ закрыта.
    expect(temporalRow(predecessor.id).invalidated_at_ms).toBeNull();

    const currentBelief = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: term,
    } as never);
    const beliefIds = currentBelief.results.map((row) => row.id);
    expect(beliefIds).not.toContain(predecessor.id);
    expect(beliefIds).toContain(headOne.id);
    expect(beliefIds).toContain(headTwo.id);

    // Узел не потерян, только скрыт из current-belief: `notes` не мутирована
    // (R1 conservative), точечное чтение по-прежнему его отдаёт.
    expect(getNote(WORKSPACE_ID, predecessor.id, AGENT_ID, false).id).toBe(predecessor.id);

    // Legacy latest_only прячет его ровно так же -> расхождения нет.
    delete process.env.QOOPIA_V4_BITEMPORAL;
    process.env.QOOPIA_V4_RELATIONS = "true";
    process.env.QOOPIA_V4_LATEST_ONLY = "true";
    const legacy = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: term,
      latest_only: true,
    } as never);
    delete process.env.QOOPIA_V4_RELATIONS;
    delete process.env.QOOPIA_V4_LATEST_ONLY;
    expect(legacy.results.map((row) => row.id)).not.toContain(predecessor.id);
  });

  test("a skipped-component node with no incoming edge stays visible", async () => {
    // Голова skipped-компоненты помечена в provenance так же, но целью
    // supersedes-ребра не является — прятать её нельзя.
    enableFlag();
    const term = "orbulax";
    const head = note(`${term} skipped head`);
    db.prepare(
      `INSERT OR REPLACE INTO note_temporal_provenance
         (note_id, workspace_id, backfill_class, skipped_reason)
       VALUES (?, ?, 'cyclic', 'cyclic_component')`,
    ).run(head.id, WORKSPACE_ID);
    const response = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: term,
    } as never);
    expect(response.results.map((row) => row.id)).toContain(head.id);
  });
});

describe("channels and vector over-fetch (§7.3)", () => {
  test("the over-fetch factor is a named constant greater than one", () => {
    expect(VECTOR_TEMPORAL_OVERFETCH).toBeGreaterThan(1);
    expect(Number.isInteger(VECTOR_TEMPORAL_OVERFETCH)).toBe(true);
  });

  test("over-fetch rescues current rows that invalidated hits would displace", () => {
    // Реальный случай вытеснения, а не проверка константы: голова
    // косинусного ранжирования целиком состоит из ТЕМПОРАЛЬНО ЗАКРЫТЫХ нот,
    // и без over-fetch канал вернул бы пусто.
    enableFlag();
    const topN = 4;
    const invalidated: string[] = [];
    const current: string[] = [];
    for (let index = 0; index < topN; index++) {
      const a = note(`displace predecessor ${index}`);
      note(`displace successor ${index}`, {
        supersedes_id: a.id,
        expected_superseded_updated_at_ms: a.updated_at_ms,
      });
      expect(temporalRow(a.id).invalidated_at_ms).not.toBeNull();
      invalidated.push(a.id);
    }
    for (let index = 0; index < topN; index++) {
      current.push(note(`displace current ${index}`).id);
    }
    // Порядок = убывающий косинус: закрытые ноты ранжируются выше.
    const ranked = [...invalidated, ...current].map((note_id) => ({ note_id }));
    const filter = { current_only: true, valid_as_of_ms: null, known_as_of_ms: null };

    // Без over-fetch (окно ровно topN) канал отдал бы ноль строк.
    const naive = ranked
      .slice(0, topN)
      .filter((row) => current.includes(row.note_id));
    expect(naive).toHaveLength(0);

    // Продакшн-путь с over-fetch возвращает вытесненные актуальные строки.
    const rescued = applyVectorTemporalWindow(ranked, topN, filter);
    expect(rescued.map((row) => row.note_id)).toEqual(current);
    // И ни одной закрытой строки в результате.
    for (const id of invalidated) {
      expect(rescued.map((row) => row.note_id)).not.toContain(id);
    }
    // Глубина окна ограничена именно константой: 5*topN строк не спасти.
    const tooDeep = [
      ...invalidated,
      ...invalidated,
      ...invalidated,
      ...current,
    ].map((note_id) => ({ note_id }));
    expect(
      applyVectorTemporalWindow(tooDeep, topN, filter).length,
    ).toBeLessThan(current.length);
  });

  test("the FTS channel already excludes invalidated rows before fusion", async () => {
    enableFlag();
    const response = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: TERM,
      limit: 50,
    } as never);
    // Пул кандидатов канала ограничен предикатом, а не пост-фильтром: ни
    // одной закрытой строки в выдаче при limit, покрывающем всю цепочку.
    expect(response.results.map((row) => row.id)).toEqual([chain.c]);
  });
});
