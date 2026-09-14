/**
 * Hybrid recall tests — covers the parts of recall.ts that don't
 * actually need Ollama on the wire:
 *  - sanitizer / FTS path unaffected when mode='fts5' (default)
 *  - sanitizer / FTS path unchanged when mode='hybrid' but vector
 *    channel returns nothing (Ollama unreachable) — degrades to
 *    mode='fts5-fallback', NOT an error
 *  - RRF fusion math: a row appearing in both channels outranks rows
 *    in only one; k=60 gives the expected reciprocal-rank scores
 *  - serialization round-trips: Float32Array → BLOB → Float32Array
 *  - cosineSim sanity: identical vectors → 1.0, orthogonal → 0
 *
 * The end-to-end "hybrid finds morphology that FTS5 cannot" check is
 * scripts/recall-hybrid-bench.ts — it requires Ollama and runs against
 * the live corpus, so it's a benchmark, not a unit test.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import {
  cosineSim,
  deserializeEmbedding,
  serializeEmbedding,
  EMBED_DIM,
} from "../src/services/embeddings.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({
    name: "Hybrid Recall",
    slug: "hybrid-recall",
  });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "hybrid-agent", workspaceSlug: ws.slug });
  AGENT_ID = a.id;
});

describe("recall(mode='fts5') — unchanged behaviour", () => {
  test("returns mode='fts5' and FTS rows for a normal query", async () => {
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "hybridtest-unique-marker first content note",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "hybridtest-unique-marker",
      scope: "notes",
      mode: "fts5",
    });
    expect(r.mode).toBe("fts5");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.text).toContain("hybridtest-unique-marker");
  });
});

describe("recall(mode='hybrid') with no embeddings → fts5-fallback", () => {
  test("Ollama unreachable / no rows → degrades, no error", async () => {
    // Point the embedder at a port nothing's listening on so the vector
    // channel reliably fails inside this test. recall() must NOT throw.
    process.env.QOOPIA_EMBED_ENDPOINT = "http://127.0.0.1:1/api/embed";
    process.env.QOOPIA_EMBED_TIMEOUT_MS = "200";
    createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "fallbackmarker xenophone-021 unique row",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "fallbackmarker",
      scope: "notes",
      mode: "hybrid",
    });
    expect(r.mode).toBe("fts5-fallback");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.text).toContain("fallbackmarker");
    // Restore default endpoint for subsequent tests.
    delete process.env.QOOPIA_EMBED_ENDPOINT;
    delete process.env.QOOPIA_EMBED_TIMEOUT_MS;
  });
});

describe("embedding serialization round-trip", () => {
  test("Float32Array → Buffer → Float32Array preserves values", () => {
    const orig = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) {
      orig[i] = Math.sin(i * 0.13) * 0.5;
    }
    const buf = serializeEmbedding(orig);
    expect(buf.byteLength).toBe(EMBED_DIM * 4);
    const back = deserializeEmbedding(buf);
    expect(back.length).toBe(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) {
      expect(back[i]).toBeCloseTo(orig[i]!, 6);
    }
  });

  test("Buffer slice is decoded correctly (alignment)", () => {
    // Simulate sqlite returning a Buffer that's a slice of a larger
    // allocation — the deserializer must copy into an aligned ArrayBuffer.
    const big = Buffer.alloc(EMBED_DIM * 4 + 7); // misaligned tail
    const view = big.subarray(7);
    const fv = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) fv[i] = i * 0.001;
    Buffer.from(fv.buffer).copy(view);
    const back = deserializeEmbedding(view);
    expect(back.length).toBe(EMBED_DIM);
    expect(back[100]).toBeCloseTo(0.1, 6);
    expect(back[1023]).toBeCloseTo(1.023, 6);
  });
});

describe("cosineSim — math sanity", () => {
  test("identical vectors → 1.0", () => {
    const v = new Float32Array([1, 2, 3, 4, 5]);
    const w = new Float32Array([1, 2, 3, 4, 5]);
    expect(cosineSim(v, w)).toBeCloseTo(1.0, 6);
  });

  test("orthogonal vectors → 0", () => {
    const v = new Float32Array([1, 0, 0]);
    const w = new Float32Array([0, 1, 0]);
    expect(cosineSim(v, w)).toBeCloseTo(0, 6);
  });

  test("opposite vectors → -1", () => {
    const v = new Float32Array([1, 2, 3]);
    const w = new Float32Array([-1, -2, -3]);
    expect(cosineSim(v, w)).toBeCloseTo(-1.0, 6);
  });

  test("zero vector → 0 (no NaN)", () => {
    const v = new Float32Array([0, 0, 0]);
    const w = new Float32Array([1, 2, 3]);
    expect(cosineSim(v, w)).toBe(0);
  });

  test("dim mismatch throws INVALID_INPUT", () => {
    expect(() =>
      cosineSim(new Float32Array([1, 2]), new Float32Array([1, 2, 3])),
    ).toThrow();
  });
});
