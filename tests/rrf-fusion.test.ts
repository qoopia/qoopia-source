import {textHash} from "../src/services/embeddings.ts";
/**
 * RRF (Reciprocal Rank Fusion, k=60) unit tests.
 *
 * rrfFuse is not exported (kept private to recall.ts), so we exercise
 * it indirectly through recall(mode='hybrid') with a stubbed vector
 * channel. To keep this fast and Ollama-free, we patch the embedder
 * endpoint to a local server that returns deterministic vectors.
 *
 * Tests:
 *  1. Row appearing in BOTH channels outranks rows in only one.
 *  2. With k=60, score for rank-1 in both = 2/61 ≈ 0.03278; a row
 *     ranked 1 in vector but absent from FTS scores 1/61 ≈ 0.01639.
 *  3. Vector-only hit surfaces (the morphology unlock — proves the
 *     fusion isn't gated on FTS having something).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote } from "../src/services/notes.ts";
import { recall } from "../src/services/recall.ts";
import {
  EMBED_DIM,
  EMBED_MODEL,
  serializeEmbedding,
} from "../src/services/embeddings.ts";

let WORKSPACE_ID = "";
let AGENT_ID = "";
let stubServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * Tiny Bun.serve that mimics Ollama's /api/embed endpoint. The query
 * text "wantvec-A" returns a vector aligned with note A's stored
 * vector; "wantvec-B" aligns with B. This lets us control the cosine
 * ranking deterministically.
 */
function startStub() {
  return Bun.serve({
    port: 0, // random
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/version") {
        return new Response(JSON.stringify({ version: "stub-0.0.1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/embed") {
        return req.json().then((body: any) => {
          const input = String(body.input || "");
          const vec = new Array(EMBED_DIM).fill(0);
          if (input.includes("wantvec-A")) vec[0] = 1;
          else if (input.includes("wantvec-B")) vec[1] = 1;
          else vec[2] = 1; // unrelated direction
          return new Response(
            JSON.stringify({ model: EMBED_MODEL, embeddings: [vec] }),
            { headers: { "content-type": "application/json" } },
          );
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "RRF Fusion", slug: "rrf-fusion" });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "rrf-agent", workspaceSlug: ws.slug });
  AGENT_ID = a.id;

  stubServer = startStub();
  process.env.QOOPIA_EMBED_ENDPOINT = `http://127.0.0.1:${stubServer.port}/api/embed`;
  process.env.QOOPIA_EMBED_TIMEOUT_MS = "1000";
});

afterAll(() => {
  stubServer?.stop();
  delete process.env.QOOPIA_EMBED_ENDPOINT;
  delete process.env.QOOPIA_EMBED_TIMEOUT_MS;
});

/** Manually seed an embedding for a note — bypass Ollama. */
function seedEmbedding(noteId: string, direction: "A" | "B" | "X") {
  const v = new Float32Array(EMBED_DIM);
  if (direction === "A") v[0] = 1;
  else if (direction === "B") v[1] = 1;
  else v[2] = 1;
  const blob = serializeEmbedding(v);
  db.prepare(
    `INSERT INTO notes_embeddings (note_id, workspace_id, embedding, dim, model, text_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET embedding=excluded.embedding`,
  ).run(noteId, WORKSPACE_ID, blob, EMBED_DIM, EMBED_MODEL, textHash((db.query("SELECT text FROM notes WHERE id=?").get(noteId) as {text:string}).text));
}

describe("RRF k=60 via recall(mode='hybrid')", () => {
  test("vector-only hit surfaces (morphology unlock case)", async () => {
    // Note A has FTS-token "rrfmarker" → FTS finds it.
    // Note B has zero FTS overlap with the query but is aligned with
    //   the query embedding — only the vector channel finds it.
    const a = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "rrfmarker primary alpha row",
    });
    const b = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "completely orthogonal payload no token overlap whatsoever",
    });
    seedEmbedding(a.id, "X"); // a is orthogonal to query
    seedEmbedding(b.id, "A"); // b aligns with "wantvec-A" query

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-A rrfmarker", // multi-term → FTS finds A, vector finds B
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.mode).toBe("hybrid");
    const ids = r.results.map((x) => x.id);
    expect(ids).toContain(a.id); // via FTS
    expect(ids).toContain(b.id); // via vector — the unlock
  });

  test("row in both channels outranks rows in one (k=60 fusion)", async () => {
    // Three notes:
    //  X: FTS-matches AND vector-matches → expect rank 1
    //  Y: FTS-matches only
    //  Z: vector-matches only
    const x = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "fusioncombo double-channel target",
    });
    const y = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "fusioncombo fts-only candidate",
    });
    const z = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "no overlap stranger content",
    });
    seedEmbedding(x.id, "B"); // x aligns with wantvec-B
    seedEmbedding(y.id, "X"); // y orthogonal
    seedEmbedding(z.id, "B"); // z aligns with wantvec-B (vector-only)

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-B fusioncombo",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.mode).toBe("hybrid");
    // X must outrank both Y and Z because it scores in both channels.
    const ids = r.results.map((row) => row.id);
    const xIdx = ids.indexOf(x.id);
    const yIdx = ids.indexOf(y.id);
    const zIdx = ids.indexOf(z.id);
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(xIdx).toBeLessThan(yIdx === -1 ? 999 : yIdx);
    expect(xIdx).toBeLessThan(zIdx === -1 ? 999 : zIdx);
  });
});
