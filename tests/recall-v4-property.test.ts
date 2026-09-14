import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { createNote } from "../src/services/notes.ts";
import { createNoteRelation } from "../src/services/note-relations.ts";
import { recall } from "../src/services/recall.ts";

let auth: AuthContext;

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "P04 Property", slug: "p04-property" });
  const agent = createAgent({ name: "p04-property-agent", workspaceSlug: ws.slug });
  auth = {
    agent_id: agent.id,
    agent_name: agent.name,
    workspace_id: ws.id,
    type: "standard",
    source: "api-key",
  };
  process.env.QOOPIA_V4_RELATIONS = "true";
  process.env.QOOPIA_V4_LATEST_ONLY = "true";
  process.env.QOOPIA_V4_RECALL_EXPLAIN = "true";
});

afterAll(() => {
  delete process.env.QOOPIA_V4_RELATIONS;
  delete process.env.QOOPIA_V4_LATEST_ONLY;
  delete process.env.QOOPIA_V4_RECALL_EXPLAIN;
});

describe("P04 deterministic relation expansion properties", () => {
  for (const seed of [17, 101, 20260717]) {
    test(`seed ${seed}: repeated multi-head recall is deterministic and never resurrects the ancestor`, async () => {
      const marker = `p04property${seed}`;
      const old = createNote({
        workspace_id: auth.workspace_id,
        agent_id: auth.agent_id,
        text: `${marker} obsolete ancestor`,
      }).id;
      const heads: string[] = [];
      let state = seed >>> 0;
      const count = 3 + (seed % 4);
      for (let index = 0; index < count; index++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const head = createNote({
          workspace_id: auth.workspace_id,
          agent_id: auth.agent_id,
          text: `head ${state} for ${seed}`,
        }).id;
        heads.push(head);
        createNoteRelation({ auth, source_note_id: head, target_note_id: old, relation_type: "supersedes" });
      }
      const call = () => recall({
        workspace_id: auth.workspace_id,
        caller_agent_id: auth.agent_id,
        is_admin: false,
        query: marker,
        mode: "fts5" as const,
        latest_only: true,
        explain: true,
        limit: 20,
      });
      const first = await call();
      const second = await call();
      expect(first.results.map((row) => row.id)).toEqual(second.results.map((row) => row.id));
      expect(first.results.map((row) => row.id)).not.toContain(old);
      expect(new Set(first.results.map((row) => row.id))).toEqual(new Set(heads));
      for (const row of first.results as any[]) {
        expect(row.explain.reason_codes).toContain("multiple_active_heads");
      }
    });
  }
});
