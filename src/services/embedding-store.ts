/**
 * Embedding store — DB layer for notes_embeddings (migration 012).
 *
 * recall.ts hybrid path loads the full set of vectors for a workspace,
 * computes cosine similarity in JS against the query vector, and feeds
 * the top-N into RRF fusion against the FTS5 channel. With 737 notes ×
 * 1024 floats this is ~3 MiB of memory per query and ~10ms of CPU —
 * acceptable without sqlite-vec or any extension.
 */
import { db } from "../db/connection.ts";
import {
  EMBED_PROVIDER,
  EMBED_DIM,
  EMBED_MODEL,
  autoEmbedEnabled,
  deserializeEmbedding,
  embedText,
  serializeEmbedding,
  textHash,
} from "./embeddings.ts";
import { logger } from "../utils/logger.ts";

const inFlight = new Map<string, ReturnType<typeof embedNote>>();
let lastNoteEmbedding: "ok" | "unavailable" | undefined;
/** Passive state for /health from the last note indexing attempt; it never loads a model and
 * carries no error text (that holds local paths). Recall falls back to FTS meanwhile. */
export function embeddingHealth(): "ok" | "unavailable" | "not_loaded" | "disabled" {
  return !autoEmbedEnabled() ? "disabled" : lastNoteEmbedding ?? "not_loaded";
}
/**
 * Compute and upsert the embedding for a note. Idempotent on
 * (note_id, text_hash, model) — skips the Ollama call when the text
 * hash matches the stored row. Never throws — failures are logged and
 * swallowed so the calling write path (createNote/updateNote) doesn't
 * block on the embedder. The vector channel simply lacks this note
 * until backfill or the next update fixes it.
 *
 * The write path's fire-and-forget call and the maintenance tick race on every
 * new note; concurrent calls for the same text share one inference run.
 */
export function upsertNoteEmbedding(note_id: string, workspace_id: string, text: string) {
  const key = `${note_id}:${textHash(text)}`;
  let run = inFlight.get(key);
  if (!run) {
    run = embedNote(note_id, workspace_id, text).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
  }
  return run;
}
async function embedNote(
  note_id: string,
  workspace_id: string,
  text: string,
): Promise<{ embedded: boolean; skipped: "hash" | null; error?: string }> {
  try {
    const hash = await textHash(text);
    const existing = db
      .prepare(
        `SELECT text_hash, model FROM notes_embeddings WHERE note_id = ? LIMIT 1`,
      )
      .get(note_id) as { text_hash: string; model: string } | undefined;
    if (
      existing &&
      existing.text_hash === hash &&
      existing.model === EMBED_MODEL && (EMBED_PROVIDER!=='builtin'||!!db.query('SELECT 1 FROM note_embedding_chunks WHERE note_id=? LIMIT 1').get(note_id))
    ) {
      return { embedded: false, skipped: "hash" };
    }

    const chunks = EMBED_PROVIDER==='builtin' ? await (await import('./builtin-embeddings.ts')).embedBuiltin(text) : null;
    const vec = chunks?.[0]?.vector ?? await embedText(text);
    const blob = serializeEmbedding(vec);
    // Inference is asynchronous. An older result must not overwrite a newer edit
    // or resurrect an embedding after deletion.
    const live = db.query("SELECT text FROM notes WHERE id=? AND workspace_id=? AND deleted_at IS NULL")
      .get(note_id, workspace_id) as {text:string}|null;
    if (!live || textHash(live.text) !== hash) return { embedded:false, skipped:null };
    db.transaction(()=>{
    db.prepare(
      `INSERT INTO notes_embeddings (note_id, workspace_id, embedding, dim, model, text_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET
         embedding = excluded.embedding,
         dim = excluded.dim,
         model = excluded.model,
         text_hash = excluded.text_hash,
         embedded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    ).run(note_id, workspace_id, blob, EMBED_DIM, EMBED_MODEL, hash);
    if(chunks) {
      db.query('DELETE FROM note_embedding_chunks WHERE note_id=?').run(note_id);
      const insert=db.query('INSERT INTO note_embedding_chunks(note_id,chunk_no,start_char,end_char,embedding) VALUES(?,?,?,?,?)');
      chunks.forEach((chunk,i)=>insert.run(note_id,i,chunk.start,chunk.end,serializeEmbedding(chunk.vector)));
    }
    })();
    lastNoteEmbedding = "ok";
    return { embedded: true, skipped: null };
  } catch (e: any) {
    const msg = e?.message || String(e);
    lastNoteEmbedding = "unavailable";
    logger.warn(
      `upsertNoteEmbedding(${note_id}) failed (note still saved): ${msg}`,
    );
    return { embedded: false, skipped: null, error: msg };
  }
}


/**
 * Load all embeddings for a workspace into memory. Returns rows with
 * Float32Array decoded once so the caller can run cosineSim in a tight
 * loop. Filter on the active model — stale rows from a prior model
 * sit in the table until backfill rebuilds them.
 */
export function loadWorkspaceEmbeddings(workspace_id: string): Array<{
  note_id: string;
  vector: Float32Array;
}> {
  if (EMBED_PROVIDER==='builtin') return loadBuiltinChunks(workspace_id);
  const rows = db
    .prepare(
      `SELECT e.note_id, e.embedding, e.text_hash, ${VERSION} FROM notes_embeddings e
        JOIN notes n ON n.id=e.note_id AND n.workspace_id=e.workspace_id
        WHERE e.workspace_id = ? AND e.model = ? AND e.dim = ?`,
    )
    .all(workspace_id, EMBED_MODEL, EMBED_DIM) as Array<NoteVersion & {
    note_id: string;
    text_hash: string;
    embedding: Buffer;
  }>;
  return rows.filter(r => r.embedding.byteLength === EMBED_DIM * 4 && fresh(r.note_id, r)).map((r) => ({
    note_id: r.note_id,
    vector: deserializeEmbedding(r.embedding),
  }));
}

/**
 * Load embeddings across ALL workspaces — offline measurement and tests only
 * (scripts/measure-cosine-distribution.ts, archived at c44d6fc; see
 * docs/operations/evidence-archive.md). Recall never calls it: request
 * paths load per workspace (F-078).
 */
export function loadAllEmbeddings(): Array<{
  note_id: string;
  workspace_id: string;
  vector: Float32Array;
}> {
  if (EMBED_PROVIDER==='builtin') return loadBuiltinChunks();
  const rows = db
    .prepare(
      `SELECT e.note_id, e.workspace_id, e.embedding, e.text_hash, ${VERSION} FROM notes_embeddings e
        JOIN notes n ON n.id=e.note_id AND n.workspace_id=e.workspace_id
        WHERE e.model = ? AND e.dim = ?`,
    )
    .all(EMBED_MODEL, EMBED_DIM) as Array<NoteVersion & {
    note_id: string;
    workspace_id: string;
    text_hash: string;
    embedding: Buffer;
  }>;
  return rows.filter(r => r.embedding.byteLength === EMBED_DIM * 4 && fresh(r.note_id, r)).map((r) => ({
    note_id: r.note_id,
    workspace_id: r.workspace_id,
    vector: deserializeEmbedding(r.embedding),
  }));
}

/**
 * Compute and upsert the embedding for an entity page (Phase 2 Item C,
 * migration 021). Mirrors upsertNoteEmbedding — same idempotency key
 * (text_hash + model), same swallow-and-log failure mode, separate
 * destination table (entity_embeddings) because the FK target is
 * entity_pages(id), not notes(id).
 *
 * The caller is expected to pass a concatenated "title + summary +
 * slug" string so the embedder sees enough surface for bge-m3 to land
 * a useful vector on short entity rows (a one-line title alone
 * collapses to corpus-mean — same problem the noise filter v2 solved
 * for short project labels).
 */
export async function upsertEntityEmbedding(
  entity_id: string,
  workspace_id: string,
  text: string,
): Promise<{ embedded: boolean; skipped: "hash" | null; error?: string }> {
  try {
    const hash = await textHash(text);
    const existing = db
      .prepare(
        `SELECT text_hash, model FROM entity_embeddings WHERE entity_id = ? LIMIT 1`,
      )
      .get(entity_id) as { text_hash: string; model: string } | undefined;
    if (
      existing &&
      existing.text_hash === hash &&
      existing.model === EMBED_MODEL
    ) {
      return { embedded: false, skipped: "hash" };
    }
    const vec = EMBED_PROVIDER==='builtin'?(await (await import('./builtin-embeddings.ts')).embedBuiltin(text))[0]!.vector:await embedText(text);
    const live=db.query('SELECT title,summary,slug FROM entity_pages WHERE id=? AND workspace_id=?').get(entity_id,workspace_id) as {title:string;summary:string|null;slug:string}|null;
    if(!live||textHash(`${live.title}\n\n${live.summary??''}\n\nslug:${live.slug}`)!==hash)return {embedded:false,skipped:null};
    const blob = serializeEmbedding(vec);
    db.prepare(
      `INSERT INTO entity_embeddings (entity_id, workspace_id, embedding, dim, model, text_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         embedding = excluded.embedding,
         dim = excluded.dim,
         model = excluded.model,
         text_hash = excluded.text_hash,
         embedded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(entity_id, workspace_id, blob, EMBED_DIM, EMBED_MODEL, hash);
    return { embedded: true, skipped: null };
  } catch (e: any) {
    const msg = e?.message || String(e);
    logger.warn(
      `upsertEntityEmbedding(${entity_id}) failed (entity still saved): ${msg}`,
    );
    return { embedded: false, skipped: null, error: msg };
  }
}

/**
 * Load all entity-page embeddings for a workspace (active model only).
 * Mirrors loadWorkspaceEmbeddings for the entity channel; consumed by
 * recall.ts hybrid fusion.
 */
export function loadWorkspaceEntityEmbeddings(
  workspace_id: string,
): Array<{ entity_id: string; vector: Float32Array }> {
  const rows = db
    .prepare(
      `SELECT entity_id, embedding FROM entity_embeddings
        WHERE workspace_id = ? AND model = ? AND dim = ?`,
    )
    .all(workspace_id, EMBED_MODEL, EMBED_DIM) as Array<{
    entity_id: string;
    embedding: Buffer;
  }>;
  return rows.map((r) => ({
    entity_id: r.entity_id,
    vector: deserializeEmbedding(r.embedding),
  }));
}

/** Coverage for the dashboard memory-setup status — how much of the corpus is embedded. */
export function embeddingCoverage(workspace_id?: string): {
  total_notes: number;
  embedded: number;
  ratio: number;
  model: string;
} {
  const totalSql = workspace_id
    ? `SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL AND workspace_id = ?`
    : `SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL`;
  const total = workspace_id
    ? (db.prepare(totalSql).get(workspace_id) as { c: number }).c
    : (db.prepare(totalSql).get() as { c: number }).c;
  const current=db.query(`SELECT n.id,${VERSION},e.text_hash,e.model,e.dim,EXISTS(SELECT 1 FROM note_embedding_chunks c WHERE c.note_id=n.id) AS chunks FROM notes n JOIN notes_embeddings e ON e.note_id=n.id
    WHERE n.deleted_at IS NULL ${workspace_id?'AND n.workspace_id=?':''}`).all(...(workspace_id?[workspace_id]:[])) as Array<NoteVersion&{id:string;text_hash:string;model:string;dim:number;chunks:number}>;
  const embedded=current.filter(r=>r.model===EMBED_MODEL&&r.dim===EMBED_DIM&&(EMBED_PROVIDER!=='builtin'||r.chunks)&&fresh(r.id,r)).length;
  return {
    total_notes: total,
    embedded,
    ratio: total === 0 ? 0 : Number((embedded / total).toFixed(3)),
    model: EMBED_MODEL,
  };
}

/** The live notes are the durable work list; no second queue can lose pending edits. */
export function pendingNoteEmbeddings(workspace?:string, limit=32) {
  const rows=db.query(`SELECT n.id,n.workspace_id,${VERSION},e.text_hash,e.model,e.dim,EXISTS(SELECT 1 FROM note_embedding_chunks c WHERE c.note_id=n.id) AS chunks
    FROM notes n LEFT JOIN notes_embeddings e ON e.note_id=n.id
    WHERE n.deleted_at IS NULL ${workspace?'AND n.workspace_id=?':''} ORDER BY n.updated_at DESC`)
    .all(...(workspace?[workspace]:[])) as Array<NoteVersion&{id:string;workspace_id:string;text_hash:string|null;model:string|null;dim:number|null;chunks:number}>;
  // Text is read only for the notes actually returned for embedding.
  return rows.filter(r=>r.model!==EMBED_MODEL||r.dim!==EMBED_DIM||(EMBED_PROVIDER==='builtin'&&!r.chunks)||!fresh(r.id,r)).slice(0,limit)
    .flatMap(r=>{const live=db.query('SELECT text FROM notes WHERE id=?').get(r.id) as {text:string}|null;return live?[{id:r.id,workspace_id:r.workspace_id,text:live.text}]:[];});
}

function loadBuiltinChunks(workspace?:string) {
  const rows=db.query(`SELECT n.id AS note_id,n.workspace_id,${VERSION},e.text_hash,c.embedding
    FROM notes n JOIN notes_embeddings e ON e.note_id=n.id JOIN note_embedding_chunks c ON c.note_id=n.id
    WHERE e.model=? AND e.dim=? ${workspace?'AND n.workspace_id=?':''}`)
    .all(EMBED_MODEL,EMBED_DIM,...(workspace?[workspace]:[])) as Array<NoteVersion&{note_id:string;workspace_id:string;text_hash:string;embedding:Buffer}>;
  return rows.filter(r=>r.embedding.byteLength===EMBED_DIM*4&&fresh(r.note_id,r))
    .map(r=>({note_id:r.note_id,workspace_id:r.workspace_id,vector:deserializeEmbedding(r.embedding)}));
}

/** A note version without copying its text into JS (octet_length reads the record header). */
const VERSION='n.updated_at_ms AS version_ms,octet_length(n.text) AS version_bytes';
type NoteVersion={version_ms:number;version_bytes:number;text_hash:string|null};
// note_id -> [updated_at_ms, byte length, sha256(text)] of the version last hashed here.
// Note writers bump updated_at_ms, so a note is hashed once per edit instead of the whole
// corpus being re-read on every recall and 5 s maintenance tick (F-079/F-080).
// ponytail: a raw SQL edit that keeps both updated_at_ms and the byte length is trusted
// until restart; a write-time invalidation trigger (schema migration) removes that ceiling.
const hashed=new Map<string,[number,number,string]>();
function fresh(id:string,r:NoteVersion) {
  let hit=hashed.get(id);
  if(hit?.[0]!==r.version_ms||hit[1]!==r.version_bytes) {
    const live=db.query('SELECT text,updated_at_ms,octet_length(text) AS bytes FROM notes WHERE id=?').get(id) as {text:string;updated_at_ms:number;bytes:number}|null;
    if(!live)return false;
    hashed.set(id,hit=[live.updated_at_ms,live.bytes,textHash(live.text)]);
  }
  return r.text_hash===hit[2];
}
