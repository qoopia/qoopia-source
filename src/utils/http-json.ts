/** HTTP plumbing shared by the dashboard API, the main server and the MCP edge: JSON replies and bounded request reads. */
import type { IncomingMessage, ServerResponse } from "node:http";

/** Why the server stopped reading a request body: over the route's limit (413) or arriving too slowly (408). */
export class RequestBodyError extends Error {
  constructor(readonly status: 408 | 413, readonly maxBytes: number) {
    super(status === 413 ? "payload_too_large" : "request_timeout");
  }
}

/** How long a client may hold a connection. Bun's node:http ignores requestTimeout,
 * headersTimeout, keepAliveTimeout and socket.setTimeout, so these are enforced in our own code.
 * A body gets a fixed allowance plus time at a minimum throughput, so a 100 MB upload on a slow
 * link still fits while a stalled body is cut off. Tests shorten them. */
export const REQUEST_TIMEOUTS = { bodyBaseMs: 15_000, bodyBytesPerSec: 64 * 1024, keepAliveIdleMs: 30_000 };

/** A request whose body was not read to the end (refused early, over the limit, too slow). After the
 * reply its socket is destroyed: Bun would otherwise keep reading and discarding the body without limit. */
export function unreadBody(req: IncomingMessage): boolean {
  const declared = req.headers["content-length"];
  const hasBody = (declared !== undefined && declared !== "0") || req.headers["transfer-encoding"] !== undefined;
  return hasBody && !req.readableEnded;
}

/** Bun's parser accepts repeated singleton headers: it frames the body by the first Content-Length
 * while req.headers reports the last, and the last Authorization wins. A proxy that picks the other
 * value would desync from us (request smuggling), so a request repeating one is refused. */
const SINGLETON_HEADERS = new Set(["content-length", "transfer-encoding", "authorization", "host"]);
export function repeatsSingletonHeader(req: IncomingMessage): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (!SINGLETON_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/** Read at most max request-body bytes within a deadline. It never destroys the socket and never
 * breaks out of a for-await over req: under Bun either one loses the 413/408 reply the caller sends. */
export function readRequestBody(req: IncomingMessage, max: number, deadlineMs?: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (declared > max) return Promise.reject(new RequestBodyError(413, max));
  const expected = declared >= 0 ? declared : max;
  deadlineMs ??= REQUEST_TIMEOUTS.bodyBaseMs + (expected * 1000) / REQUEST_TIMEOUTS.bodyBytesPerSec;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (error?: Error) => {
      clearTimeout(timer);
      req.off("data", onData).off("end", onEnd).off("error", done);
      if (!error) return resolve(Buffer.concat(chunks));
      req.pause(); // stop pulling bytes; the reply then closes the connection
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) done(new RequestBodyError(413, max));
      else chunks.push(chunk);
    };
    const onEnd = () => done();
    const timer = setTimeout(() => done(new RequestBodyError(408, max)), deadlineMs);
    req.on("data", onData).on("end", onEnd).on("error", done);
  });
}

/** A body that is a JSON object; null for invalid JSON, an array or any other value. Each caller keeps its own refusal. */
export function parseJsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

/** Content-Disposition for a download. Header values must be Latin-1, so non-ASCII
 * names travel in the RFC 5987 filename* parameter with an ASCII fallback. */
export function attachmentDisposition(name: string): string {
  const wellFormed = name.toWellFormed();
  const fallback = wellFormed.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(wellFormed).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Read an outbound fetch response as text, refusing more than maxBytes. The
 * limit is enforced while reading, so a missing or lying Content-Length cannot
 * make the server buffer an unbounded body. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new Error(`response body exceeds ${maxBytes} bytes`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Largest /memory/continuity request body the server reads. The memory hook client
 * sizes its batches from the same constant so the two limits cannot drift apart. */
export const CONTINUITY_MAX_BODY_BYTES = 512 * 1024;
/** Largest ordinary request body the server reads; the MCP edge refuses larger bodies with the same limit. */
export const MAX_BODY_BYTES = 1_048_576; // 1 MB
