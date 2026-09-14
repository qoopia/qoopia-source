import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import type { AuthContext } from "../src/auth/middleware.ts";
import { createNote } from "../src/services/notes.ts";
import { createNoteRelation, getSupersedeChain } from "../src/services/note-relations.ts";

const PROPERTY_SEEDS = [17, 101, 20260717];
let actor: AuthContext;

function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "V4 Domain Property", slug: "v4-domain-property" });
  const agent = createAgent({ name: "v4-property", workspaceSlug: ws.slug });
  actor = {
    agent_id: agent.id,
    agent_name: agent.name,
    workspace_id: ws.id,
    type: "standard",
    source: "api-key",
  };
});
describe("V4 deterministic relation properties", () => {
  for (const seed of PROPERTY_SEEDS) {
    test(`seed ${seed}: random acyclic chains have one deterministic head and reject back-edges`, () => {
      const random = rng(seed);
      const size = 8 + Math.floor(random() * 9);
      const ids = Array.from({ length: size }, (_, index) =>
        createNote({
          workspace_id: actor.workspace_id,
          agent_id: actor.agent_id,
          text: `property ${seed} note ${index}`,
        }).id
      );
      // A linear chain in a seed-derived insertion order exercises traversal
      // independently from lexical ULID ordering.
      for (let index = 1; index < ids.length; index++) {
        createNoteRelation({
          auth: actor,
          source_note_id: ids[index]!,
          target_note_id: ids[index - 1]!,
          relation_type: "supersedes",
        });
      }
      const state = getSupersedeChain({ auth: actor, note_id: ids[Math.floor(random() * ids.length)]! });
      expect(state.note_ids).toEqual([...ids].sort());
      expect(state.active_heads).toEqual([ids.at(-1)!]);
      expect(state.conflict).toBe(false);
      expect(() => createNoteRelation({
        auth: actor,
        source_note_id: ids[0]!,
        target_note_id: ids.at(-1)!,
        relation_type: "supersedes",
      })).toThrow(/cycle/);
    });
  }

  test("multiple random heads are never silently selected", () => {
    const root = createNote({ workspace_id: actor.workspace_id, agent_id: actor.agent_id, text: "property root" }).id;
    const heads = Array.from({ length: 12 }, (_, index) =>
      createNote({ workspace_id: actor.workspace_id, agent_id: actor.agent_id, text: `property head ${index}` }).id
    );
    for (const head of heads) {
      createNoteRelation({
        auth: actor,
        source_note_id: head,
        target_note_id: root,
        relation_type: "supersedes",
      });
    }
    const state = getSupersedeChain({ auth: actor, note_id: root });
    expect(state.active_heads).toEqual([...heads].sort());
    expect(state.conflict).toBe(true);
  });
});
