import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { ulid } from "ulid";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db/connection.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { v4Metrics } from "../utils/observability.ts";

const EVENT_TYPES = new Set([
  "candidate_proposed", "candidate_reviewed", "note_superseded",
  "feedback_recorded", "export_created", "import_planned", "conflict_detected",
]);
const FORBIDDEN_PAYLOAD_KEY = /(?:^|_)(?:body|content|text|query|authorization|cookie|password|secret|token|api_key|private_key)(?:$|_)/i;
const PRIVATE_V4 = [
  [0x0a000000, 0xff000000], [0x7f000000, 0xff000000],
  [0xa9fe0000, 0xffff0000], [0xac100000, 0xfff00000],
  [0xc0a80000, 0xffff0000], [0x00000000, 0xff000000],
] as const;

export interface OutboxDestination {
  id: string;
  url: string;
  allowed_hosts: string[];
  signing_key: Uint8Array;
}

export const OUTBOX_MAX_ATTEMPTS = 5;

function assertMetadataOnly(value: unknown, path = "payload", depth = 0): void {
  if (depth > 8) throw new QoopiaError("SIZE_LIMIT", "outbox payload nesting exceeds 8 levels");
  if (typeof value === "string") {
    assertNoSecrets(value, path);
    if (value.length > 2_048) throw new QoopiaError("SIZE_LIMIT", `${path} string exceeds 2048 bytes`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new QoopiaError("SIZE_LIMIT", `${path} array exceeds 100 items`);
    value.forEach((item, index) => assertMetadataOnly(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) throw new QoopiaError("SIZE_LIMIT", `${path} object exceeds 100 keys`);
    for (const [key, child] of entries) {
      if (FORBIDDEN_PAYLOAD_KEY.test(key)) {
        throw new QoopiaError("INVALID_INPUT", `outbox payload key is not metadata-only: ${key}`);
      }
      assertMetadataOnly(child, `${path}.${key}`, depth + 1);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const numeric = (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
    return PRIVATE_V4.some(([base, mask]) => (numeric & mask) === base);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  return true;
}

async function resolvedDestination(
  destination: OutboxDestination,
  resolver: (hostname: string) => Promise<Array<{ address: string }>> = async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(destination.url);
  } catch {
    throw new QoopiaError("INVALID_INPUT", "outbox destination URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new QoopiaError("FORBIDDEN", "outbox destination requires credential-free HTTPS URL");
  }
  if (url.port && url.port !== "443") throw new QoopiaError("FORBIDDEN", "outbox destination port is not allowlisted");
  const allowed = new Set(destination.allowed_hosts.map((host) => host.toLowerCase()));
  if (destination.signing_key.byteLength < 32) {
    throw new QoopiaError("FORBIDDEN", "outbox signing key must contain at least 32 bytes");
  }
  if (!allowed.has(url.hostname.toLowerCase())) throw new QoopiaError("FORBIDDEN", "outbox destination host is not allowlisted");
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new QoopiaError("FORBIDDEN", "private outbox destination is forbidden");
  const resolved = await resolver(url.hostname);
  if (resolved.length === 0 || resolved.some(({ address }) => isPrivateAddress(address))) {
    throw new QoopiaError("FORBIDDEN", "outbox destination resolved to a private or unusable address");
  }
  return { url, addresses: resolved.map(({ address }) => address) };
}

export async function validateOutboxDestination(
  destination: OutboxDestination,
  resolver?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<URL> {
  return (await resolvedDestination(destination, resolver)).url;
}

export function enqueueMemoryEvent(input: {
  workspace_id: string;
  event_type: string;
  aggregate_kind: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  destination_id?: string;
  idempotency_key: string;
  database?: Database;
}): { id: string; state: "pending"; reused: boolean } {
  if (process.env.QOOPIA_V4_EVENT_OUTBOX !== "true") {
    throw new QoopiaError("FORBIDDEN", "QOOPIA_V4_EVENT_OUTBOX is disabled");
  }
  if (!EVENT_TYPES.has(input.event_type)) throw new QoopiaError("INVALID_INPUT", "unsupported outbox event_type");
  assertMetadataOnly(input.payload);
  const payload = JSON.stringify(input.payload);
  if (Buffer.byteLength(payload) > 16_384) throw new QoopiaError("SIZE_LIMIT", "outbox payload exceeds 16 KiB");
  const database = input.database ?? defaultDb;
  const existing = database.query(
    `SELECT id, event_type, aggregate_kind, aggregate_id, payload, destination_id, state
       FROM memory_event_outbox WHERE workspace_id = ? AND idempotency_key = ?`,
  ).get(input.workspace_id, input.idempotency_key) as Record<string, unknown> | null;
  if (existing) {
    if (existing.event_type !== input.event_type || existing.aggregate_kind !== input.aggregate_kind ||
        existing.aggregate_id !== input.aggregate_id || existing.payload !== payload ||
        (existing.destination_id ?? null) !== (input.destination_id ?? null)) {
      throw new QoopiaError("CONFLICT", "outbox idempotency key reused with different input");
    }
    return { id: String(existing.id), state: "pending", reused: true };
  }
  const id = ulid();
  database.query(
    `INSERT INTO memory_event_outbox
       (id, workspace_id, event_type, aggregate_kind, aggregate_id, payload,
        destination_id, state, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, input.workspace_id, input.event_type, input.aggregate_kind, input.aggregate_id,
    payload, input.destination_id ?? null, input.idempotency_key, nowIso(), nowIso());
  v4Metrics.increment("v4_outbox_enqueued_total", { event_type: input.event_type });
  return { id, state: "pending", reused: false };
}

export function leaseMemoryEvent(input: {
  workspace_id: string;
  destination_id: string;
  lease_owner: string;
  lease_ms?: number;
  database?: Database;
}): Record<string, unknown> | null {
  const database = input.database ?? defaultDb;
  const now = Date.now();
  const nowText = new Date(now).toISOString();
  const expires = new Date(now + (input.lease_ms ?? 30_000)).toISOString();
  return database.transaction(() => {
    const row = database.query(
      `SELECT * FROM memory_event_outbox
        WHERE workspace_id = ? AND destination_id = ? AND attempt_count < ?
          AND ((state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (state = 'leased' AND lease_expires_at <= ?))
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(input.workspace_id, input.destination_id, OUTBOX_MAX_ATTEMPTS, nowText, nowText) as Record<string, unknown> | null;
    if (!row) return null;
    const updated = database.query(
      `UPDATE memory_event_outbox
          SET state='leased', lease_owner=?, lease_expires_at=?, attempt_count=attempt_count+1,
              next_attempt_at=NULL, last_error_code=NULL, updated_at=?
        WHERE id=? AND workspace_id=? AND state=?`,
    ).run(input.lease_owner, expires, nowText, String(row.id), input.workspace_id, String(row.state));
    if (updated.changes !== 1) return null;
    return database.query("SELECT * FROM memory_event_outbox WHERE id=? AND workspace_id=?")
      .get(String(row.id), input.workspace_id) as Record<string, unknown>;
  })();
}

export function markMemoryEventDelivered(input: {
  workspace_id: string;
  id: string;
  lease_owner: string;
  database?: Database;
}): void {
  const database = input.database ?? defaultDb;
  const result = database.query(
    `UPDATE memory_event_outbox
        SET state='delivered', delivered_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE id=? AND workspace_id=? AND state='leased' AND lease_owner=?`,
  ).run(nowIso(), nowIso(), input.id, input.workspace_id, input.lease_owner);
  if (result.changes !== 1) throw new QoopiaError("CONFLICT", "outbox delivery lease is stale");
}

export function markMemoryEventFailed(input: {
  workspace_id: string;
  id: string;
  lease_owner: string;
  error_code: string;
  database?: Database;
}): "failed" | "dead_letter" {
  const database = input.database ?? defaultDb;
  if (!/^[A-Z0-9_]{1,100}$/.test(input.error_code)) throw new QoopiaError("INVALID_INPUT", "outbox error_code is invalid");
  return database.transaction(() => {
    const row = database.query(
      `SELECT attempt_count FROM memory_event_outbox
        WHERE id=? AND workspace_id=? AND state='leased' AND lease_owner=?`,
    ).get(input.id, input.workspace_id, input.lease_owner) as { attempt_count: number } | null;
    if (!row) throw new QoopiaError("CONFLICT", "outbox failure lease is stale");
    const state = row.attempt_count >= OUTBOX_MAX_ATTEMPTS ? "dead_letter" : "failed";
    const next = state === "failed" ? new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** row.attempt_count)).toISOString() : null;
    database.query(
      `UPDATE memory_event_outbox
          SET state=?, next_attempt_at=?, last_error_code=?, lease_owner=NULL,
              lease_expires_at=NULL, updated_at=? WHERE id=? AND workspace_id=?`,
    ).run(state, next, input.error_code, nowIso(), input.id, input.workspace_id);
    v4Metrics.increment("v4_outbox_delivery_total", { result: state, error_code: input.error_code });
    return state;
  })();
}

function postPinnedHttps(url: URL, address: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: address,
      port: 443,
      servername: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      timeout: 5_000,
      signal: AbortSignal.timeout(5_000),
      headers: { ...headers, host: url.host, "content-length": String(Buffer.byteLength(body)) },
    }, (response) => {
      const status = response.statusCode ?? 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) request.destroy(new Error("receipt too large"));
      });
      response.once("error", reject);
      response.once("end", () => resolve({ status, body }));
    });
    request.once("timeout", () => request.destroy(new Error("outbox delivery timeout")));
    request.once("error", reject);
    request.end(body);
  });
}

export async function deliverMemoryEvent(input: {
  row: { id: string; event_type: string; payload: string };
  destination: OutboxDestination;
  fetchImpl?: typeof fetch;
  requireReceipt?: boolean;
  resolver?: (hostname: string) => Promise<Array<{ address: string }>>;
}): Promise<{ status: number; signature: string; receipt?: { event_id: string; payload_sha256: string; accepted: true } }> {
  const { url, addresses } = await resolvedDestination(input.destination, input.resolver);
  assertMetadataOnly(JSON.parse(input.row.payload));
  const body = JSON.stringify({ id: input.row.id, event_type: input.row.event_type, payload: JSON.parse(input.row.payload) });
  const signature = createHmac("sha256", input.destination.signing_key).update(body).digest("base64url");
  const headers = {
    "content-type": "application/json",
    "x-qoopia-event-id": input.row.id,
    "x-qoopia-signature": `sha256=${signature}`,
  };
  const response = input.fetchImpl
    ? await input.fetchImpl(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000), headers, body })
    : null;
  const received = response ? { status: response.status, body: await response.text() }
    : await postPinnedHttps(url, addresses[0]!, headers, body);
  const { status } = received;
  if (status >= 300 && status < 400) {
    throw new QoopiaError("FORBIDDEN", "outbox redirects are forbidden");
  }
  if (status < 200 || status >= 300) throw new QoopiaError("CONFLICT", `outbox destination returned HTTP ${status}`);
  if (input.requireReceipt) {
    if (Buffer.byteLength(received.body) > 4096) throw new QoopiaError("SIZE_LIMIT", "receipt too large");
    let receipt;
    try { receipt = JSON.parse(received.body); } catch { throw new QoopiaError("CONFLICT", "receiver acceptance missing"); }
    const digest = createHash("sha256").update(body).digest("hex");
    if (receipt?.accepted !== true || receipt.event_id !== input.row.id || receipt.payload_sha256 !== digest) {
      throw new QoopiaError("CONFLICT", "receiver acceptance does not match event and digest");
    }
    return { status, signature, receipt: { event_id: input.row.id, payload_sha256: digest, accepted: true } };
  }
  // Legacy memory events report transport status only; this is not a receiver receipt.
  return { status, signature };
}
