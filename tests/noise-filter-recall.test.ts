import {textHash} from "../src/services/embeddings.ts";
/**
 * Noise filter — vector channel filters (2026-05-13, feat/noise-filter-recall).
 *
 * Smoke-test on prod showed bge-m3 producing high cosine for very short
 * project-label notes ("FLOCK" 5ch, "OPENCLAW IS" 11ch, "LOCATIONS" 9ch)
 * — they polluted top-3 of every "rescued" query (крашнулся / упал /
 * починили / сломалась / postmortem). See docs/cosine-distribution-
 * 2026-05-13.txt for the per-query distribution.
 *
 * Three filters, applied only in the vector channel:
 *   1. Drop type='project' AND length(text) < QOOPIA_PROJECT_LABEL_MIN_CHARS
 *   2. Drop cosine < QOOPIA_VECTOR_COSINE_THRESHOLD (default 0.42)
 *   3. HYBRID_CHANNEL_TOPN reduced 50 → 20
 *
 * FTS5 is NOT touched — a literal-token query for "FLOCK" must still
 * surface the project via the FTS path.
 *
 * All tests stub Ollama via a local Bun.serve returning controlled
 * vectors (same pattern as tests/rrf-fusion.test.ts).
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
 * Stub Ollama. Query "wantvec-target" → unit vector on axis 0; this is
 * the direction our seeded "target" notes also point at, so they'll
 * score cosine ≈ 1.0 against the query. Any other query body returns
 * an orthogonal vector (axis 9) so unseeded notes score 0.0.
 */
function startStub() {
  return Bun.serve({
    port: 0,
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
          if (input.includes("wantvec-target")) vec[0] = 1;
          else if (input.includes("wantvec-topn")) vec[7] = 1;
          else vec[9] = 1;
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

/** Seed a deterministic unit-axis embedding for a note (bypass Ollama). */
function seedEmbedding(noteId: string, axis: number, magnitude = 1) {
  const v = new Float32Array(EMBED_DIM);
  v[axis] = magnitude;
  const blob = serializeEmbedding(v);
  db.prepare(
    `INSERT INTO notes_embeddings (note_id, workspace_id, embedding, dim, model, text_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET embedding=excluded.embedding`,
  ).run(noteId, WORKSPACE_ID, blob, EMBED_DIM, EMBED_MODEL, textHash((db.query("SELECT text FROM notes WHERE id=?").get(noteId) as {text:string}).text));
}

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Noise Filter", slug: "noise-filter" });
  WORKSPACE_ID = ws.id;
  const a = createAgent({ name: "noise-agent", workspaceSlug: ws.slug });
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

describe("project-label filter (vector channel)", () => {
  test("drops type='project' notes shorter than min length from vector channel", async () => {
    // Short project label — should be filtered out of the vector channel.
    const flock = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "FLOCK",
      type: "project",
    });
    // Aligned with the query vector — would normally win, but project + short.
    seedEmbedding(flock.id, 0);

    // A legitimate non-project short note aligned with the query — must pass.
    const shortLegit = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "Saule day off Friday",
      type: "memory",
    });
    seedEmbedding(shortLegit.id, 0);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target whatever",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    const ids = r.results.map((x) => x.id);
    expect(ids).not.toContain(flock.id);
    expect(ids).toContain(shortLegit.id);
  });

  test("long project notes (>=min chars) still pass through vector channel", async () => {
    const longProject = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "LOCATIONS_DETAIL — full description of the project including scope, owners, deadlines and current status across all regions.",
      type: "project",
    });
    seedEmbedding(longProject.id, 0);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target whatever",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.results.map((x) => x.id)).toContain(longProject.id);
  });
});

describe("cosine threshold filter (vector channel)", () => {
  test("drops near-zero / sub-threshold matches", async () => {
    // Aligned note — cosine ≈ 1.0, well above the 0.42 threshold.
    const winner = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "threshold-winner aligned candidate text",
      type: "memory",
    });
    seedEmbedding(winner.id, 0);

    // Orthogonal note — cosine = 0.0, must be filtered out by threshold.
    const loser = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "threshold-loser orthogonal candidate text",
      type: "memory",
    });
    seedEmbedding(loser.id, 100); // axis 100, query is axis 0 → cos=0

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      // Query body contains no FTS-overlap with either note text, so the
      // vector channel is the only path either could surface through.
      query: "wantvec-target",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    const ids = r.results.map((x) => x.id);
    expect(ids).toContain(winner.id);
    expect(ids).not.toContain(loser.id);
  });

  test("QOOPIA_VECTOR_COSINE_THRESHOLD is read at call time, not module load", async () => {
    // Note with cosine ≈ 1.0 against the query.
    const note = beforeAll_makeNote("threshold-callscoped marker");
    seedEmbedding(note.id, 0);

    // Tighten threshold above 1.0 → nothing should survive the filter.
    process.env.QOOPIA_VECTOR_COSINE_THRESHOLD = "1.1";
    try {
      const r = await recall({
        workspace_id: WORKSPACE_ID,
        caller_agent_id: AGENT_ID,
        is_admin: false,
        query: "wantvec-target",
        scope: "notes",
        mode: "hybrid",
        limit: 10,
      });
      // Vector channel returned nothing, FTS also has no token overlap
      // with "wantvec-target", so the note must NOT appear.
      expect(r.results.map((x) => x.id)).not.toContain(note.id);
    } finally {
      delete process.env.QOOPIA_VECTOR_COSINE_THRESHOLD;
    }
  });
});

describe("FTS5 channel unaffected", () => {
  test("literal FTS-matching project label still surfaces (FTS path)", async () => {
    // Project label that the vector filter WOULD drop. But the user
    // types the literal label as the query, so the FTS5 channel must
    // still return it. Vector channel filter applies only to vector
    // candidates — FTS is untouched.
    const proj = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "OPENCLAW",
      type: "project",
    });
    seedEmbedding(proj.id, 50); // orthogonal so vector filter would drop it too

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "openclaw",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.results.map((x) => x.id)).toContain(proj.id);
  });

  test("fts5-only mode is completely unchanged by the noise filters", async () => {
    const proj = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "FTSPATHPROJECT",
      type: "project",
    });
    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "ftspathproject",
      scope: "notes",
      mode: "fts5",
    });
    expect(r.mode).toBe("fts5");
    expect(r.results.map((x) => x.id)).toContain(proj.id);
  });
});

describe("hybrid channel topN", () => {
  test("QOOPIA_HYBRID_CHANNEL_TOPN is read at call time", async () => {
    // Seed two vector candidates with deterministic cosine ordering:
    //   top    → pure axis-0 (cos = 1.0 vs the query)
    //   second → tilted off-axis (cos < 1.0 vs the query)
    // With QOOPIA_HYBRID_CHANNEL_TOPN=1 only the top-1 vector candidate
    // enters fusion; `second` must NOT surface through the vector path.
    const top = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "topn-call-scope alpha note text payload",
      type: "memory",
    });
    const second = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "topn-call-scope beta different note text payload",
      type: "memory",
    });
    // Query "wantvec-topn" → axis 7 (unique to this test; isolates it
    // from prior tests in the same describe-file that seeded axis-0).
    seedEmbedding(top.id, 7); // cos = 1.0 vs query axis 7
    // For `second` we seed a tilted vector. Mix axis 7 + axis 5 → cos
    // with the query (axis 7) is 0.707, above threshold but below `top`.
    const tilted = new Float32Array(EMBED_DIM);
    tilted[7] = 0.707;
    tilted[5] = 0.707;
    const blob = serializeEmbedding(tilted);
    db.prepare(
      `INSERT INTO notes_embeddings (note_id, workspace_id, embedding, dim, model, text_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET embedding=excluded.embedding`,
    ).run(
      second.id,
      WORKSPACE_ID,
      blob,
      EMBED_DIM,
      EMBED_MODEL,
      textHash((db.query("SELECT text FROM notes WHERE id=?").get(second.id) as {text:string}).text),
    );

    process.env.QOOPIA_HYBRID_CHANNEL_TOPN = "1";
    try {
      const r = await recall({
        workspace_id: WORKSPACE_ID,
        caller_agent_id: AGENT_ID,
        is_admin: false,
        // Pure vector-only signal — no FTS overlap with the query.
        query: "wantvec-topn",
        scope: "notes",
        mode: "hybrid",
        limit: 10,
      });
      const ids = r.results.map((x) => x.id);
      expect(ids).toContain(top.id);
      expect(ids).not.toContain(second.id);
    } finally {
      delete process.env.QOOPIA_HYBRID_CHANNEL_TOPN;
    }
  });
});

// Helper — createNote shim used inside test bodies (defined late so the
// describe blocks above read naturally).
function beforeAll_makeNote(text: string) {
  return createNote({
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_ID,
    text,
    type: "memory",
  });
}

/**
 * Noise filter v2 (refs PR #25) — extend the short-text vector filter
 * from type='project' to type IN ('project','task') with default
 * length<40. type='memory' must remain UNTOUCHED so short memory
 * anchors ("Aidan port 18789", "Tailscale IP 100.81.108.26") still
 * surface via vector recall.
 *
 * Probe on prod showed two queries ("крашнулся", "починили") still
 * 0/3 relevant after PR #25 — noise came from short type='task'
 * completion-labels that bge-m3 collapses just like project labels.
 */
describe("noise filter v2 — task type extension", () => {
  test("drops short type='task' notes (len<40) from vector channel", async () => {
    const shortTaskText = "Deploy staging health checks"; // 28 chars
    expect(shortTaskText.length).toBeLessThan(40);
    const shortTask = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: shortTaskText,
      type: "task",
    });
    seedEmbedding(shortTask.id, 0); // would otherwise win the vector channel

    // Sentinel — a memory note that DOES want to win, to guarantee the
    // query actually drove the vector channel for this test.
    const sentinel = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "v2-task-filter sentinel memory anchor",
      type: "memory",
    });
    seedEmbedding(sentinel.id, 0);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target v2taskfilter",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    const ids = r.results.map((x) => x.id);
    expect(ids).not.toContain(shortTask.id);
    expect(ids).toContain(sentinel.id);
  });

  test("long type='task' notes (len>=40) pass through vector channel", async () => {
    const longTaskText =
      "Investigate Aidan reconnect storm — 18:42 crash, root cause unknown, postmortem pending owner assignment.";
    expect(longTaskText.length).toBeGreaterThanOrEqual(40);
    const longTask = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: longTaskText,
      type: "task",
    });
    seedEmbedding(longTask.id, 0);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target v2longtask",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.results.map((x) => x.id)).toContain(longTask.id);
  });

  test("short type='memory' notes (len<40) are NOT dropped — regression guard", async () => {
    // Short memory anchors are the primary recall target — the v2 filter
    // must not touch them. This guards against accidentally widening
    // the type set in future.
    const shortMemoryText = "Aidan port 18789"; // 16 chars
    expect(shortMemoryText.length).toBeLessThan(40);
    const shortMemory = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: shortMemoryText,
      type: "memory",
    });
    seedEmbedding(shortMemory.id, 0);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target memoryanchor",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.results.map((x) => x.id)).toContain(shortMemory.id);
  });

  test("v1 project filter still works at the new default len<40 — regression guard for PR #25", async () => {
    const shortProjectText = "FLOCKv2 short label"; // 19 chars
    expect(shortProjectText.length).toBeLessThan(40);
    const shortProject = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: shortProjectText,
      type: "project",
    });
    seedEmbedding(shortProject.id, 0);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target v2projguard",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.results.map((x) => x.id)).not.toContain(shortProject.id);
  });

  test("QOOPIA_VECTOR_TYPE_FILTER_MAX_LEN is read at call time (narrowing the filter)", async () => {
    // Under the default 40 but above a 20-char override.
    const midTaskText = "Wire prom alerts midlen"; // 23 chars
    expect(midTaskText.length).toBeGreaterThanOrEqual(20);
    expect(midTaskText.length).toBeLessThan(40);
    const midTask = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: midTaskText,
      type: "task",
    });
    seedEmbedding(midTask.id, 0);

    // Sanity check: at the default (40), this task is dropped.
    const before = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "wantvec-target callscopelen",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(before.results.map((x) => x.id)).not.toContain(midTask.id);

    // Narrow the filter — note length 23 >= 20, so it should now pass.
    process.env.QOOPIA_VECTOR_TYPE_FILTER_MAX_LEN = "20";
    try {
      const after = await recall({
        workspace_id: WORKSPACE_ID,
        caller_agent_id: AGENT_ID,
        is_admin: false,
        query: "wantvec-target callscopelen",
        scope: "notes",
        mode: "hybrid",
        limit: 10,
      });
      expect(after.results.map((x) => x.id)).toContain(midTask.id);
    } finally {
      delete process.env.QOOPIA_VECTOR_TYPE_FILTER_MAX_LEN;
    }
  });

  test("FTS5 keyword channel still surfaces a filtered short task — regression guard", async () => {
    // Short task that the v2 vector filter WILL drop. The user types
    // a literal token from the task body, so the FTS5 channel must
    // still surface it. The vector filter applies only to vector
    // candidates — FTS5 is untouched.
    const filteredTaskText = "GitHubSyncFtsToken настроен"; // 27 chars
    expect(filteredTaskText.length).toBeLessThan(40);
    const filteredTask = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: filteredTaskText,
      type: "task",
    });
    // Seed orthogonal so the vector path can't surface it either.
    seedEmbedding(filteredTask.id, 80);

    const r = await recall({
      workspace_id: WORKSPACE_ID,
      caller_agent_id: AGENT_ID,
      is_admin: false,
      query: "githubsyncftstoken",
      scope: "notes",
      mode: "hybrid",
      limit: 10,
    });
    expect(r.results.map((x) => x.id)).toContain(filteredTask.id);
  });
});
