#!/usr/bin/env bun
/**
 * Cosine distribution probe — feeds each of the 5 "rescued" queries
 * through bge-m3 and dumps the top-30 nearest notes with type / length /
 * snippet / cosine. Output is human-eyeballed to pick a threshold for
 * the noise filter in src/services/recall.ts.
 *
 * Usage:
 *   bun run scripts/measure-cosine-distribution.ts \
 *       > docs/cosine-distribution-2026-05-13.txt
 *
 * Requires Ollama + bge-m3 running on QOOPIA_EMBED_ENDPOINT (default
 * http://127.0.0.1:11434/api/embed). The script reads embeddings from
 * the live ~/.qoopia/data/qoopia.db — it does NOT mutate any rows.
 */
import { assertSchemaCurrent } from "../src/db/migrate.ts";
import { db } from "../src/db/connection.ts";
import { cosineSim, embedText } from "../src/services/embeddings.ts";
import { loadAllEmbeddings } from "../src/services/embedding-store.ts";

const QUERIES = ["крашнулся", "упал", "починили", "сломалась", "postmortem"];
const TOPN = 30;

async function main() {
  assertSchemaCurrent("cosine distribution probe");
  const embs = loadAllEmbeddings();
  if (embs.length === 0) {
    console.error("no embeddings in DB — nothing to measure");
    process.exit(1);
  }
  // Join with notes for type + text length + snippet.
  const meta = new Map<string, { type: string; text: string; len: number }>();
  const rows = db
    .prepare(
      `SELECT id, type, text FROM notes WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; type: string; text: string }>;
  for (const r of rows) {
    meta.set(r.id, { type: r.type, text: r.text, len: r.text.length });
  }

  console.log(`# Cosine distribution probe`);
  console.log(`# Date: ${new Date().toISOString()}`);
  console.log(`# Corpus: ${embs.length} embeddings, ${meta.size} live notes`);
  console.log(`# Model: bge-m3 (1024-d)`);
  console.log(`# Top-${TOPN} per query, columns: rank | cos | type | len | id | text[:60]`);

  for (const q of QUERIES) {
    let queryVec: Float32Array;
    try {
      queryVec = await embedText(q);
    } catch (e: any) {
      console.error(`embed("${q}") failed: ${e?.message || e}`);
      continue;
    }
    const scored = embs.map((e) => ({
      id: e.note_id,
      sim: cosineSim(queryVec, e.vector),
    }));
    scored.sort((a, b) => b.sim - a.sim);
    console.log(`\n=== "${q}" — top ${TOPN} of ${scored.length} ===`);
    scored.slice(0, TOPN).forEach((s, i) => {
      const m = meta.get(s.id);
      const type = m?.type ?? "?";
      const len = m?.len ?? 0;
      const snip = (m?.text ?? "").replace(/\s+/g, " ").slice(0, 60);
      console.log(
        `${String(i + 1).padStart(2)} | ${s.sim.toFixed(4)} | ${type.padEnd(10)} | len=${String(len).padStart(5)} | ${s.id} | ${snip}`,
      );
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
