import {envFlag} from "../utils/env.ts";
/**
 * Embedding service — talks to local Ollama for bge-m3 vectors.
 *
 * Why this file exists:
 *   FTS5 in notes_fts has no morphology and no synonyms. The 20-query
 *   baseline (docs/recall-baseline.txt) showed 4 mono-term queries
 *   permanently at 0 hits even after the OR-default sanitizer. Hybrid
 *   recall via RRF (k=60) needs a vector channel; this module provides
 *   the channel.
 *
 * Why Ollama + bge-m3:
 *   - Runs locally on M2 Mini, no external paid SKU.
 *   - bge-m3 is multilingual (ru/kk/en) and ranks well on MIRACL/MKQA
 *     for short-text retrieval — matches the Qoopia note corpus shape.
 *   - 1024-d float32 → 4 KiB per note → 3 MiB for 737 notes. Cheap.
 *
 * Failure model:
 *   Ollama down → embedText() throws QoopiaError("EMBEDDING_FAILED").
 *   Callers (notes.ts createNote/updateNote, recall.ts hybrid path)
 *   catch and degrade — the note still saves, recall still returns
 *   FTS-only results. No write blocks on the embedder.
 */
import { createHash } from "node:crypto";
import { QoopiaError } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";

export const EMBED_PROVIDER = process.env.QOOPIA_EMBED_PROVIDER || (process.env.QOOPIA_EMBED_ENDPOINT ? 'ollama' : 'builtin');
export const EMBED_MODEL = EMBED_PROVIDER==='builtin' ? 'multilingual-e5-small:761b726dd34f:q8:chunks-v1' : process.env.QOOPIA_EMBED_MODEL || 'bge-m3';
export const EMBED_DIM = EMBED_PROVIDER==='builtin' ? 384 : 1024;
export function autoEmbedEnabled() { return envFlag(process.env.QOOPIA_AUTO_EMBED, EMBED_PROVIDER==='builtin'); }

// Endpoint + timeout are read at CALL TIME, not module load. Tests mutate
// process.env to point at a stub server or a dead port; capturing at module
// load would freeze those values for the rest of the process and let CI
// (no Ollama) accidentally fall back to fts5-fallback when the test expects
// the stub to answer. Function-scoped reads keep the tests honest.
function rawEmbedEndpoint(): string {
  return process.env.QOOPIA_EMBED_ENDPOINT || "http://127.0.0.1:11434/api/embed";
}

function embedAllowRemote(): boolean {
  return process.env.QOOPIA_EMBED_ALLOW_REMOTE === "1";
}

function embedAllowedHosts(): Set<string> {
  return new Set(
    (process.env.QOOPIA_EMBED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host === "::ffff:7f00:1"
  );
}

export function resolveEmbedEndpoint(): URL {
  const raw = rawEmbedEndpoint();
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new QoopiaError(
      "EMBEDDING_FAILED",
      `Invalid QOOPIA_EMBED_ENDPOINT: ${raw}`,
    );
  }

  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new QoopiaError(
      "EMBEDDING_FAILED",
      `Unsupported embedding endpoint protocol: ${endpoint.protocol}`,
    );
  }

  const hostname = endpoint.hostname.toLowerCase();
  if (isLoopbackHost(hostname)) {
    return endpoint;
  }

  if (!embedAllowRemote()) {
    throw new QoopiaError(
      "EMBEDDING_FAILED",
      "Remote embedding endpoint refused: set QOOPIA_EMBED_ALLOW_REMOTE=1 to allow non-loopback hosts",
    );
  }

  const allowlist = embedAllowedHosts();
  if (allowlist.size === 0) {
    throw new QoopiaError(
      "EMBEDDING_FAILED",
      "Remote embedding endpoint refused: set QOOPIA_EMBED_HOSTS to an explicit hostname allowlist or '*' for high-risk any-remote mode",
    );
  }
  if (allowlist.has("*")) {
    // High-risk sentinel: always emit a warning, even when normal log level
    // filtering would suppress warnings. Operators should not miss this mode.
    console.warn(
      `Embedding endpoint remote allowlist is wildcard '*' — high-risk any-remote mode enabled hostname=${hostname}`,
    );
    logger.warn(
      "Embedding endpoint remote allowlist is wildcard '*' — high-risk any-remote mode enabled",
      { hostname },
    );
    return endpoint;
  }
  if (!allowlist.has(hostname)) {
    throw new QoopiaError(
      "EMBEDDING_FAILED",
      `Remote embedding endpoint host '${hostname}' is not in QOOPIA_EMBED_HOSTS`,
    );
  }

  return endpoint;
}
function embedTimeoutMs(): number {
  return Number(process.env.QOOPIA_EMBED_TIMEOUT_MS || 5000);
}

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

/**
 * Embed a single text into a 1024-d float32 vector via Ollama.
 * Throws QoopiaError("EMBEDDING_FAILED", ...) on any network/model
 * error — callers must catch and degrade.
 */
export async function embedText(text: string): Promise<Float32Array> {
  if (!text || text.trim().length === 0) {
    throw new QoopiaError("INVALID_INPUT", "text is required for embedding");
  }
  if (EMBED_PROVIDER==='builtin') return (await (await import('./builtin-embeddings.ts')).embedBuiltin(text,true))[0]!.vector;
  const trimmed = text.slice(0, 8192); // bge-m3 has 8192-token context

  const endpoint = resolveEmbedEndpoint();
  const timeoutMs = embedTimeoutMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: trimmed }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const requestId =
        res.headers.get("x-request-id") ||
        res.headers.get("request-id") ||
        "";
      throw new QoopiaError(
        "EMBEDDING_FAILED",
        requestId
          ? `Embedder HTTP ${res.status} request_id=${requestId}`
          : `Embedder HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as OllamaEmbedResponse;
    const vec = json.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM || !vec.every(v => typeof v === "number" && Number.isFinite(v)) || !vec.some(v => v !== 0)) {
      throw new QoopiaError(
        "EMBEDDING_FAILED",
        `unexpected vector shape: got ${vec?.length} expected ${EMBED_DIM}`,
      );
    }
    return new Float32Array(vec);
  } catch (e: any) {
    if (e instanceof QoopiaError) throw e;
    if (e?.name === "AbortError") {
      throw new QoopiaError(
        "EMBEDDING_FAILED",
        `Ollama timeout after ${timeoutMs}ms`,
      );
    }
    throw new QoopiaError(
      "EMBEDDING_FAILED",
      `Ollama request failed: ${e?.message || String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Pack a Float32Array into a Buffer suitable for the BLOB column. */
export function serializeEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Unpack a BLOB row back into a Float32Array. */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  // Buffer may be a slice — copy into an aligned ArrayBuffer.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy);
}

/**
 * Cosine similarity. bge-m3 vectors are NOT pre-normalised, so we
 * compute the full formula. Returns a value in [-1, 1]; for hybrid
 * recall we only use it for ranking, not as a probability.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `cosineSim dim mismatch: ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Hex sha256 of the text — used to skip re-embedding unchanged notes. */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Probe Ollama once at startup / cron — used by recall.ts to decide
 * whether to even attempt the vector channel. No exception propagation;
 * a `false` from this call means "fall back to FTS5 only".
 */
export async function isEmbedderHealthy(): Promise<boolean> {
  try {
    if(EMBED_PROVIDER==='builtin') { await embedText('memory');return true; }
    const endpoint = resolveEmbedEndpoint();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const versionUrl = new URL(endpoint.toString());
    versionUrl.pathname = versionUrl.pathname.replace(/\/api\/embed$/, "/api/version");
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch (e) {
    logger.warn(`embedder health probe failed: ${(e as Error).message}`);
    return false;
  }
}
