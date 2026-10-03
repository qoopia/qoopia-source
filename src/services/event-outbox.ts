import { createHmac } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { QoopiaError } from "../utils/errors.ts";
import { assertNoSecrets } from "../utils/secret-guard.ts";
import { hash } from "../utils/fs.ts";

const FORBIDDEN_PAYLOAD_KEY = /(?:^|_)(?:body|content|text|query|authorization|cookie|password|secret|token|api_key|private_key)(?:$|_)/i;
// Non-public destinations (RFC 6890 special-purpose ranges). BlockList also
// matches IPv4-mapped IPv6 (::ffff:a.b.c.d, any notation) against the IPv4
// rules, so ::ffff:0:0/96 must not be added: it would block every IPv4.
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6");

export interface OutboxDestination {
  id: string;
  url: string;
  allowed_hosts: string[];
  signing_key: Uint8Array;
}

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
  // BlockList misses upper-case IPv4-mapped forms and scoped (%zone) addresses.
  const normalized = address.toLowerCase().replace(/%.*$/, "");
  const family = isIP(normalized);
  if (family === 0) return true;
  return PRIVATE_ADDRESSES.check(normalized, family === 6 ? "ipv6" : "ipv4");
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
  const literal = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(literal) && isPrivateAddress(literal)) throw new QoopiaError("FORBIDDEN", "private outbox destination is forbidden");
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
    const digest = hash(body);
    if (receipt?.accepted !== true || receipt.event_id !== input.row.id || receipt.payload_sha256 !== digest) {
      throw new QoopiaError("CONFLICT", "receiver acceptance does not match event and digest");
    }
    return { status, signature, receipt: { event_id: input.row.id, payload_sha256: digest, accepted: true } };
  }
  // Legacy memory events report transport status only; this is not a receiver receipt.
  return { status, signature };
}
