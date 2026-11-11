/**
 * In-memory sliding-window rate limiter keyed by client (limitKey: an IPv4 address, an IPv6 /64).
 * No dependencies. Cleans up expired entries on each check.
 */

import { isIP } from "node:net";

/** The /64 of an IPv6 address, as `a:b:c:d::/64` (groups without leading zeros). */
export function ipv6Network(address: string): string {
  const v = address.toLowerCase().replace(/%.*$/, "");
  const [head = "", tail = ""] = v.split("::"), h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** What a per-client limit counts by. One IPv6 client holds a whole /64, so a limit keyed by the full
 * address is spent by nobody: such a client is counted by its /64. An IPv4 address (also when a
 * dual-stack socket reports it as ::ffff:a.b.c.d), an `edge:` label or any other label counts as it is. */
export function limitKey(client: string): string {
  const label = client.startsWith("edge:") ? "edge:" : "", address = client.slice(label.length);
  return isIP(address) === 6 && !address.includes(".") ? label + ipv6Network(address) : client;
}

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

  allow(client: string): boolean {
    const key = limitKey(client);
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

  retryAfterSec(client: string): number {
    const bucket = this.buckets.get(limitKey(client));
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
