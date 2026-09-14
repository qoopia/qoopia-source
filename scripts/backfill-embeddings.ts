#!/usr/bin/env bun
/**
 * Backfill bge-m3 embeddings for every note that's missing one (or
 * whose text_hash no longer matches the live note text). Runs against
 * the same SQLite file the server uses — keep the server up; SQLite
 * WAL handles concurrent reads + this writer fine.
 *
 * Usage:
 *   bun run scripts/backfill-embeddings.ts                # all workspaces
 *   bun run scripts/backfill-embeddings.ts --workspace=<id>
 *   bun run scripts/backfill-embeddings.ts --limit=100    # stop after N
 *   bun run scripts/backfill-embeddings.ts --dry-run
 *
 * Designed to be re-runnable. Idempotent: upsertNoteEmbedding hashes
 * text and skips notes whose embedding is already current. Safe to
 * schedule via launchd every 5–15 min as a janitor.
 */
import { assertSchemaCurrent } from "../src/db/migrate.ts";
import { pendingNoteEmbeddings, upsertNoteEmbedding } from "../src/services/embedding-store.ts";
import { isEmbedderHealthy, EMBED_MODEL } from "../src/services/embeddings.ts";
import { logger } from "../src/utils/logger.ts";

interface Args {
  workspace?: string;
  limit: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { limit: 0, dryRun: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace=")) a.workspace = arg.slice(12);
    else if (arg.startsWith("--limit=")) a.limit = Number(arg.slice(8));
    else if (arg === "--dry-run") a.dryRun = true;
  }
  return a;
}

async function main() {
  const args = parseArgs();
  assertSchemaCurrent("embedding backfill");

  const healthy = await isEmbedderHealthy();
  if (!healthy && !args.dryRun) {
    logger.error(
      `Embedder unreachable at ${process.env.QOOPIA_EMBED_ENDPOINT || "default"}. Start it: brew services start ollama`,
    );
    process.exit(1);
  }

  const rows = pendingNoteEmbeddings(args.workspace, args.limit > 0 ? args.limit : Number.MAX_SAFE_INTEGER);

  logger.info(
    `backfill: ${rows.length} note(s) need embedding (model=${EMBED_MODEL}, dryRun=${args.dryRun})`,
  );
  if (args.dryRun) {
    for (const r of rows.slice(0, 20)) {
      console.log(`  ${r.id} ws=${r.workspace_id} chars=${r.text.length}`);
    }
    if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  const t0 = Date.now();
  for (const r of rows) {
    const res = await upsertNoteEmbedding(r.id, r.workspace_id, r.text);
    if (res.embedded) ok++;
    else if (res.error) failed++;
    if ((ok + failed) % 25 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      logger.info(
        `progress: ${ok + failed}/${rows.length} (ok=${ok} fail=${failed}) ${elapsed}s`,
      );
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info(
    `backfill done: ${ok} embedded, ${failed} failed, ${elapsed}s total`,
  );
}

main().catch((e) => {
  logger.error(`backfill crashed: ${e?.message || String(e)}`);
  process.exit(1);
});
