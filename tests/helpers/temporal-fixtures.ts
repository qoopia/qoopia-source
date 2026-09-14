/**
 * Общие фикстуры для V4.1 (би-темпоральные факты).
 *
 * Каждая фикстура — отдельная scratch-БД во временном каталоге; тесты
 * никогда не трогают ни рабочую БД, ни общий handle из db/connection.ts.
 * Соединение конфигурируется `configureWritableDatabase`, поэтому
 * `PRAGMA foreign_keys` включён — FK/триггерные проверки R5 идут на том же
 * режиме, что и продакшн-соединение.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrationsToDatabase } from "../../src/db/v4-migrations.ts";
import { configureWritableDatabase } from "../../src/db/sqlite.ts";
import {
  assertMigration033Gate,
  supersedeGraphDigest,
} from "../../src/db/migration-033-gate.ts";
import { applyMigration033Sql } from "../../src/db/migration-033-exec.ts";
import { DEFAULT_MAX_COMPONENT_SIZE } from "../../src/services/temporal-migration.ts";
import {
  buildStagingPlan,
  runPhaseA,
  runPhaseB,
  type StagingPlan,
} from "../../scripts/migrate-033-preflight.ts";

export const MIGRATIONS_DIR = path.resolve(import.meta.dir, "..", "..", "migrations");
export const ROLLBACK_033 = path.join(
  MIGRATIONS_DIR,
  "rollback",
  "033-notes-bitemporal.rollback.sql",
);
export const MIGRATION_033 = path.join(MIGRATIONS_DIR, "033-notes-bitemporal.sql");

const roots: string[] = [];

export interface Scratch {
  db: Database;
  filename: string;
  root: string;
}

/** Свежая БД, доведённая до указанной версии схемы (32 = до 033). */
export function scratchDatabase(targetVersion = 32): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-v41-"));
  roots.push(root);
  const filename = path.join(root, "fixture.db");
  const db = new Database(filename, { create: true });
  configureWritableDatabase(db);
  applyMigrationsToDatabase(db, { migrationsDir: MIGRATIONS_DIR, targetVersion });
  return { db, filename, root };
}

/**
 * Применить 033 к уже подготовленной scratch-БД (Phase C) ровно так же, как
 * это делают продакшн-раннеры: runner-level gate, затем пооператорное
 * исполнение с постусловиями внутри одной транзакции.
 */
export function applyMigration033(db: Database): void {
  assertMigration033Gate(db);
  const sql = fs.readFileSync(MIGRATION_033, "utf8");
  db.transaction(() => {
    applyMigration033Sql(db, sql);
  })();
}

/**
 * Phase A + Phase B одной вспомогательной функцией: staging всегда получает
 * дайджест ЖИВОГО графа, ровно как в `runPreflight`.
 */
export function stagePreflight(
  db: Database,
  plan?: StagingPlan,
  maxComponentSize = DEFAULT_MAX_COMPONENT_SIZE,
): void {
  // maxComponentSize записывается вместе со staging: gate пересчитывает план
  // именно с ним, иначе классификация oversize разошлась бы с записанной.
  const staged = plan ?? buildStagingPlan(db, runPhaseA(db, maxComponentSize));
  runPhaseB(db, staged, supersedeGraphDigest(db), maxComponentSize);
}

export function applyRollback033(db: Database): void {
  const sql = fs.readFileSync(ROLLBACK_033, "utf8");
  db.transaction(() => {
    db.exec(sql);
  })();
}

export function cleanupScratchRoots(): void {
  while (roots.length > 0) {
    const root = roots.pop()!;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export interface SeededWorkspace {
  workspace_id: string;
  agent_id: string;
}

export function seedWorkspace(db: Database, suffix: string): SeededWorkspace {
  const workspaceId = `ws-${suffix}`;
  const agentId = `agent-${suffix}`;
  db.query(`INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)`).run(
    workspaceId,
    `Workspace ${suffix}`,
    `workspace-${suffix}`,
  );
  db.query(
    `INSERT INTO agents (id, workspace_id, name, api_key_hash) VALUES (?, ?, ?, ?)`,
  ).run(agentId, workspaceId, `Agent ${suffix}`, `hash-${suffix}`);
  return { workspace_id: workspaceId, agent_id: agentId };
}

export interface SeedNoteInput {
  id: string;
  workspace_id: string;
  agent_id: string;
  /** Legacy-форма `…SZ`, как её пишет migration 001. */
  created_at?: string;
  text?: string;
  type?: string;
  metadata?: string;
  visibility?: "workspace" | "private";
  updated_at_ms?: number;
  deleted_at?: string | null;
}

export function seedNote(db: Database, input: SeedNoteInput): string {
  const createdAt = input.created_at ?? "2026-01-01T00:00:00Z";
  const updatedAtMs = input.updated_at_ms ?? Date.parse(createdAt);
  db.query(
    `INSERT INTO notes
       (id, workspace_id, agent_id, type, text, metadata, source, tags, visibility,
        deleted_at, created_at, updated_at, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'seed', '[]', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.workspace_id,
    input.agent_id,
    input.type ?? "memory",
    input.text ?? `text for ${input.id}`,
    input.metadata ?? "{}",
    input.visibility ?? "workspace",
    input.deleted_at ?? null,
    createdAt,
    createdAt,
    updatedAtMs,
  );
  return input.id;
}

export interface SeedRelationInput {
  workspace_id: string;
  agent_id: string;
  source_note_id: string;
  target_note_id: string;
  /** Каноническая форма `…SSSZ`, как её пишет migration 027. */
  created_at?: string;
}

let relationSeq = 0;

export function seedSupersedes(db: Database, input: SeedRelationInput): string {
  const id = `rel-${(relationSeq++).toString().padStart(6, "0")}`;
  db.query(
    `INSERT INTO note_relations
       (id, workspace_id, source_note_id, target_note_id, relation_type,
        created_by_agent_id, metadata, created_at)
     VALUES (?, ?, ?, ?, 'supersedes', ?, '{}', ?)`,
  ).run(
    id,
    input.workspace_id,
    input.source_note_id,
    input.target_note_id,
    input.agent_id,
    input.created_at ?? "2026-02-01T00:00:00.000Z",
  );
  return id;
}

/**
 * Минимальная linear-фикстура для граничных тестов времени: одна нота,
 * закрываемая одним supersedes-ребром, с явно заданными формами меток.
 * Возвращается уже со staging Phase B — остаётся применить Phase C.
 */
export function buildPlanFixture(input: {
  noteCreatedAt: string;
  relationCreatedAt: string;
}): { scratch: Scratch } {
  const scratch = scratchDatabase(32);
  const ws = seedWorkspace(scratch.db, `bnd-${boundarySeq++}`);
  seedNote(scratch.db, {
    id: "bnd-a",
    workspace_id: ws.workspace_id,
    agent_id: ws.agent_id,
    created_at: input.noteCreatedAt,
  });
  seedNote(scratch.db, {
    id: "bnd-b",
    workspace_id: ws.workspace_id,
    agent_id: ws.agent_id,
    created_at: input.noteCreatedAt,
  });
  seedSupersedes(scratch.db, {
    workspace_id: ws.workspace_id,
    agent_id: ws.agent_id,
    source_note_id: "bnd-b",
    target_note_id: "bnd-a",
    created_at: input.relationCreatedAt,
  });
  stagePreflight(scratch.db);
  return { scratch };
}

let boundarySeq = 0;

/**
 * Граф из ТЗ §10.1: linear-цепочка, split-head, цикл, oversize и линейная
 * цепочка целиком из private-нот (R6 — классификатор обязан её видеть).
 */
export interface TemporalGraphFixture extends SeededWorkspace {
  linear: string[];
  split: string[];
  cycle: string[];
  oversize: string[];
  private_chain: string[];
}

export function seedClassifierGraph(
  db: Database,
  suffix = "graph",
  oversizeNodes = 12,
): TemporalGraphFixture {
  const ws = seedWorkspace(db, suffix);
  const note = (id: string, visibility: "workspace" | "private" = "workspace") =>
    seedNote(db, { id, workspace_id: ws.workspace_id, agent_id: ws.agent_id, visibility });
  const edge = (source: string, target: string, createdAt?: string) =>
    seedSupersedes(db, {
      workspace_id: ws.workspace_id,
      agent_id: ws.agent_id,
      source_note_id: source,
      target_note_id: target,
      created_at: createdAt,
    });

  // linear: lin-c -> lin-b -> lin-a (одна активная голова lin-c)
  const linear = ["lin-a", "lin-b", "lin-c"];
  linear.forEach((id) => note(id));
  edge("lin-b", "lin-a", "2026-02-01T00:00:00.500Z");
  edge("lin-c", "lin-b", "2026-02-02T00:00:00.001Z");

  // split_head: два независимых преемника одного предшественника
  const split = ["spl-a", "spl-b", "spl-c"];
  split.forEach((id) => note(id));
  edge("spl-b", "spl-a");
  edge("spl-c", "spl-a");

  // cyclic: cyc-a -> cyc-b -> cyc-a (вставляется напрямую в обход сервиса)
  const cycle = ["cyc-a", "cyc-b"];
  cycle.forEach((id) => note(id));
  edge("cyc-a", "cyc-b");
  edge("cyc-b", "cyc-a");

  // oversize: цепочка длиннее maxComponentSize, передаваемого в тест
  const oversize: string[] = [];
  for (let index = 0; index < oversizeNodes; index++) {
    const id = `ovr-${index.toString().padStart(3, "0")}`;
    oversize.push(id);
    note(id);
    if (index > 0) edge(id, oversize[index - 1]!);
  }

  // private: цепочка целиком из private-нот
  const privateChain = ["prv-a", "prv-b"];
  privateChain.forEach((id) => note(id, "private"));
  edge("prv-b", "prv-a", "2026-02-03T00:00:00.999Z");

  return {
    ...ws,
    linear,
    split,
    cycle,
    oversize,
    private_chain: privateChain,
  };
}
