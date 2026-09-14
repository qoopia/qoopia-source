/**
 * In-memory sliding-window rate limiter keyed by IP.
 * No dependencies. Cleans up expired entries on each check.
 */

interface Bucket {
  hits: number[];
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxHits: number;
  private lastCleanup = Date.now();

  constructor(opts: { windowMs: number; maxHits: number }) {
    this.windowMs = opts.windowMs;
    this.maxHits = opts.maxHits;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    if (now - this.lastCleanup > 60_000) {
      this.cleanup(cutoff);
      this.lastCleanup = now;
    }

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
    }

    bucket.hits = bucket.hits.filter((t) => t > cutoff);

    if (bucket.hits.length >= this.maxHits) return false;

    bucket.hits.push(now);
    return true;
  }

  retryAfterSec(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.hits.length === 0) return 0;
    const oldest = bucket.hits[0]!;
    const unlockAt = oldest + this.windowMs;
    return Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000));
  }

  /**
   * Test helper: clear all per-IP buckets so a parallel test file's prior
   * traffic does not poison the next file. Not exposed to runtime callers
   * (no HTTP path uses it). Intended only for `beforeAll`/`afterAll` hooks
   * in tests/*.
   */
  resetForTests(): void {
    this.buckets.clear();
    this.lastCleanup = Date.now();
  }

  private cleanup(cutoff: number) {
    for (const [key, bucket] of this.buckets) {
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) this.buckets.delete(key);
    }
  }
}

/**
 * Per-route бакеты. Каждый endpoint-класс получает свой счётчик — чтобы шумный
 * /mcp клиент не вытеснял ingest/OAuth/dashboard.
 */

/** Safety net: защита от общего abuse. Высокий лимит, ловит только патологию. */
export const globalLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 1000 });

/** MCP tool invocations (частые tools/call от агентов). */
export const mcpLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 300 });

/** Ingest pipeline (tailer bulk writes). */
export const ingestLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 500 });

/** Dashboard API (read-only list queries). */
export const dashboardLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 200 });

/** OAuth endpoints (атакуемые — credential stuffing, замер). */
export const authLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 20 });

/**
 * @deprecated used to be the single global limiter. Left as alias to globalLimiter
 * so existing imports keep working during migration. Prefer per-route limiters.
 */
export const apiLimiter = globalLimiter;
