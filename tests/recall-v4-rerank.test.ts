import {textHash} from "../src/services/embeddings.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { db } from "../src/db/connection.ts";
import { createNote } from "../src/services/notes.ts";
import { createNoteRelation } from "../src/services/note-relations.ts";
import { recall } from "../src/services/recall.ts";
import { getRecallTrace } from "../src/services/recall-traces.ts";
import { EMBED_DIM, EMBED_MODEL, serializeEmbedding } from "../src/services/embeddings.ts";

type HistoryCase = {
  name: string;
  include_archived: boolean;
  include_history: boolean;
  latest_only: boolean | "omitted";
  valid: boolean;
  effective_latest_only?: boolean;
  error_code?: string;
};

type RerankCase = {
  name: string;
  rerank: "success" | "fallback";
  heads: 1 | 2;
  expected_source_ranks: Record<string, number>;
  expected_final_order: string[];
  fallback_reason: string | null;
};

const fixtureDir = path.join(import.meta.dir, "fixtures/v4/recall");
const historyCases = (JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "history-controls.json"), "utf8"),
) as { cases: HistoryCase[] }).cases;
const rerankCases = (JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "rerank-heads.json"), "utf8"),
) as { cases: RerankCase[] }).cases;

let stub: ReturnType<typeof Bun.serve>;
let rerankFails = false;

function seedEmbedding(workspaceId: string, noteId: string): void {
  const vector = new Float32Array(EMBED_DIM);
  vector[0] = 1;
  db.prepare(
    `INSERT INTO notes_embeddings (note_id, workspace_id, embedding, dim, model, text_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(noteId, workspaceId, serializeEmbedding(vector), EMBED_DIM, EMBED_MODEL, textHash((db.query("SELECT text FROM notes WHERE id=?").get(noteId) as {text:string}).text));
}

function fixtureAuth(name: string): AuthContext {
  const ws = createWorkspace({ name: `P04 ${name}`, slug: `p04-${name}` });
  const agent = createAgent({ name: `p04-${name}-agent`, workspaceSlug: ws.slug });
  return {
    agent_id: agent.id,
    agent_name: agent.name,
    workspace_id: ws.id,
    type: "standard",
    source: "api-key",
  };
}

beforeAll(() => {
  runMigrations();
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/embed") {
        const vector = new Array(EMBED_DIM).fill(0);
        vector[0] = 1;
        return Response.json({ model: EMBED_MODEL, embeddings: [vector] });
      }
      if (url.pathname === "/rerank") {
        if (rerankFails) return new Response("fixture failure", { status: 503 });
        return request.json().then((body: any) => {
          const documents = body.documents as string[];
          const indices = documents.map((_, index) => index).sort((a, b) => {
            const aStale = documents[a]!.includes("stale-source") ? 0 : 1;
            const bStale = documents[b]!.includes("stale-source") ? 0 : 1;
            return aStale - bStale || a - b;
          });
          return Response.json({
            results: indices.map((index, rank) => ({ index, score: 0.99 - rank * 0.1 })),
          });
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.QOOPIA_EMBED_ENDPOINT = `http://127.0.0.1:${stub.port}/api/embed`;
  process.env.QOOPIA_RERANK_JINA_ENDPOINT = `http://127.0.0.1:${stub.port}/rerank`;
  process.env.QOOPIA_EMBED_TIMEOUT_MS = "1000";
  process.env.QOOPIA_RERANK_TIMEOUT_MS = "1000";
  process.env.QOOPIA_V4_RELATIONS = "true";
  process.env.QOOPIA_V4_LATEST_ONLY = "true";
  process.env.QOOPIA_V4_RECALL_EXPLAIN = "true";
});

afterAll(() => {
  stub.stop();
  for (const name of [
    "QOOPIA_EMBED_ENDPOINT",
    "QOOPIA_RERANK_JINA_ENDPOINT",
    "QOOPIA_EMBED_TIMEOUT_MS",
    "QOOPIA_RERANK_TIMEOUT_MS",
    "QOOPIA_V4_RELATIONS",
    "QOOPIA_V4_LATEST_ONLY",
    "QOOPIA_V4_RECALL_EXPLAIN",
  ]) delete process.env[name];
});

describe("P04 frozen history-control matrix", () => {
  for (const fixture of historyCases) {
    test(fixture.name, async () => {
      const auth = fixtureAuth(`history-${fixture.name}`);
      createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: `p04historymatrix ${fixture.name}`,
      });
      const request: any = {
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: false,
        query: "p04historymatrix",
        mode: "fts5",
        include_archived: fixture.include_archived,
        include_history: fixture.include_history,
        explain: true,
      };
      if (fixture.latest_only !== "omitted") request.latest_only = fixture.latest_only;
      if (!fixture.valid) {
        try {
          await recall(request);
          throw new Error("expected frozen invalid combination to fail");
        } catch (error) {
          expect((error as { code: string }).code).toBe(fixture.error_code!);
        }
        return;
      }
      const result = await recall(request);
      expect(result.effective_options.latest_only).toBe(fixture.effective_latest_only!);
      expect((result.results[0] as any).explain.source_rank).toBe(1);
    });
  }
});

describe("P04 rerank success/fallback before relation-head injection", () => {
  for (const fixture of rerankCases) {
    test(fixture.name, async () => {
      rerankFails = fixture.rerank === "fallback";
      const auth = fixtureAuth(`rerank-${fixture.name}`);
      const marker = `p04rerank${fixture.name.replace(/[^a-z]/g, "")}`;
      const decoy = createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: `${marker} ${marker} ${marker} decoy-direct`,
      });
      const stale = createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: `${marker} stale-source`,
      });
      seedEmbedding(auth.workspace_id, decoy.id);
      seedEmbedding(auth.workspace_id, stale.id);

      const headOld = createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: `current head old for ${fixture.name}`,
      });
      createNoteRelation({
        auth,
        source_note_id: headOld.id,
        target_note_id: stale.id,
        relation_type: "supersedes",
      });
      let headNew: typeof headOld | null = null;
      if (fixture.heads === 2) {
        headNew = createNote({
          workspace_id: auth.workspace_id,
          agent_id: auth.agent_id,
          text: `current head new for ${fixture.name}`,
        });
        createNoteRelation({
          auth,
          source_note_id: headNew.id,
          target_note_id: stale.id,
          relation_type: "supersedes",
        });
      }
      const fixed = Date.now() + 10_000;
      db.prepare(`UPDATE notes SET updated_at_ms = ? WHERE workspace_id = ? AND id = ?`)
        .run(fixed + 1, auth.workspace_id, headOld.id);
      if (headNew) {
        db.prepare(`UPDATE notes SET updated_at_ms = ? WHERE workspace_id = ? AND id = ?`)
          .run(fixed + 2, auth.workspace_id, headNew.id);
      }

      const result = await recall({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: false,
        query: marker,
        scope: "notes",
        mode: "hybrid",
        deep: true,
        latest_only: true,
        explain: true,
        trace: true,
        limit: 10,
      });
      const roles = new Map<string, string>([
        [decoy.id, "decoy"],
        [headOld.id, fixture.heads === 1 ? "head" : "head_old"],
        ...(headNew ? [[headNew.id, "head_new"]] as Array<[string, string]> : []),
      ]);
      expect(result.results.map((row) => roles.get(row.id))).toEqual(fixture.expected_final_order);
      for (const row of result.results as any[]) {
        expect(row.explain.source_rank).toBe(fixture.expected_source_ranks[roles.get(row.id)!]);
      }
      expect(result.results.map((row) => row.id)).not.toContain(stale.id);

      const trace = getRecallTrace({ auth, trace_id: result.trace_id! });
      const direct = trace.items.find((item) => item.result_id === decoy.id)!;
      expect(direct.source_channel).toBe("both");
      expect(direct.fts_rank).not.toBeNull();
      expect(direct.vector_rank).not.toBeNull();
      expect(direct.fts_score).not.toBeNull();
      expect(direct.vector_score).not.toBeNull();
      if (fixture.rerank === "success") {
        expect(direct.rerank_score).not.toBeNull();
        expect(direct.reason_codes).not.toContain("rerank_http_error");
      } else {
        expect(direct.rerank_score).toBeNull();
        expect(direct.reason_codes).toContain(fixture.fallback_reason!);
      }
      const injected = trace.items.filter((item) => item.result_id !== decoy.id);
      for (const item of injected) {
        expect(item.fts_rank).toBeNull();
        expect(item.vector_rank).toBeNull();
        expect(item.rerank_score).toBeNull();
        expect(item.rrf_score).toBeGreaterThan(0);
      }
    });
  }
});
