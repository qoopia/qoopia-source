/** Shared request and response plumbing of the HTTP server: CORS allowlist, client IP,
 * bounded body reads, JSON/text/HTML replies and the security headers of every HTML page. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isHttps } from "../dashboard-api.ts";
import { env } from "../utils/env.ts";

// --- CORS allowlist ---
export const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
  "https://console.anthropic.com",
  "https://chat.openai.com",
  "https://chatgpt.com",
  "https://www.chatgpt.com",
]);

export function getAllowedOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (!origin) return "";
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

// --- Client IP extraction ---
// Trust proxy-hop headers ONLY when TRUST_PROXY=true AND the connection arrives
// from one of TRUSTED_PROXIES (default: loopback). Иначе — socket address, чтобы
// предотвратить header spoofing от сетевого атакующего.
export const TRUSTED_PROXIES_SET = new Set(env.TRUSTED_PROXIES);
export function getClientIp(req: IncomingMessage): string {
  const remote = req.socket?.remoteAddress || "unknown";
  if (env.TRUST_PROXY && TRUSTED_PROXIES_SET.has(remote)) {
    return (
      (req.headers["cf-connecting-ip"] as string) ||
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      remote
    );
  }
  // Direct connection, untrusted source, or TRUST_PROXY=false — socket only
  return remote;
}

export const MAX_BODY_BYTES = 1_048_576; // 1 MB

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error("payload_too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export const MAX_UPLOAD_BYTES = 104_857_600; // 100 MB per request (dashboard file upload)

export async function readBodyLimited(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) {
      req.destroy();
      throw new Error("payload_too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "x-content-type-options": "nosniff",
  };
  if (req) {
    const origin = getAllowedOrigin(req);
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
  }
  res.writeHead(status, headers);
  res.end(payload);
}

export function text(res: ServerResponse, status: number, body: string, req?: IncomingMessage) {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  if (req) {
    const origin = getAllowedOrigin(req);
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function sendHtml(res: ServerResponse, status: number, body: string, req: IncomingMessage) {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(req),
  };
  res.writeHead(status, headers);
  res.end(body);
}

export function nodeReqToFetchRequest(req: IncomingMessage, body?: Buffer): Request {
  const url = `http://local${req.url || "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else if (typeof v === "string") headers.set(k, v);
  }
  const init: RequestInit = {
    method: req.method || "GET",
    headers,
  };
  if (body && body.length > 0 && req.method !== "GET" && req.method !== "HEAD") {
    init.body = body;
  }
  return new Request(url, init);
}

/**
 * QSA-G / Codex QSA-007: HTML responses (dashboard + OAuth consent) must
 * carry a hardened CSP and HSTS-on-https so a successful XSS in the rendered
 * page can't exfiltrate or redirect, and downgrade attacks are refused by
 * the browser on subsequent loads.
 *
 * Notes on the policy choices:
 *   - script-src is 'self' only. No page served with these headers carries an inline script:
 *     the dashboard loads /brand/dashboard.js and the OAuth consent pages have none. An
 *     injected <script> or inline handler therefore does not run.
 *   - style-src keeps 'unsafe-inline'. The dashboard builds markup with style="" attributes
 *     and the consent pages ship an inline <style>; that is a known, narrower exception
 *     (no script execution), not a claim of complete protection. frame-ancestors 'none'
 *     still blocks clickjacking, and form-action 'self' contains POST exfil via an injected <form>.
 *   - HSTS only when isHttps(req) — emitting it on plain http would either
 *     be ignored (per RFC 6797) or, worse, "stick" if the request was
 *     proxied by a TLS-terminating tunnel and break local debugging.
 */
export function securityHeaders(req: IncomingMessage, allowNavOrigin?: string): Record<string, string> {
  // OAuth consent fix: the approve form's submission redirects (302 chain:
  // /approve → /oauth/authorize/finalize → client callback) to the registered
  // client redirect_uri, which is cross-origin (e.g. https://claude.ai).
  // Chrome/Safari enforce form-action across the whole redirect
  // chain, so with a bare 'self' the post-approve cross-origin redirect is
  // SILENTLY BLOCKED — the Approve button appears to do nothing, the client
  // never receives the code, and the browser retries (storm) / shows "already
  // used". The consent page therefore must allow the OAuth client's origin.
  const extra = allowNavOrigin ? ` ${allowNavOrigin}` : "";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    `form-action 'self'${extra}`,
    // `navigate-to` is deliberately absent: it was dropped from CSP Level 3 and never shipped
    // outside one Chrome experiment, so every browser now logs it as unrecognised. A directive
    // that only ever produces a console error hides the violations worth seeing, and what it
    // aimed at — a redirect driven by injected inline script — is already refused by
    // script-src 'self'; form-action still contains an injected <form>.
  ].join("; ");
  const headers: Record<string, string> = {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (isHttps(req)) {
    headers["strict-transport-security"] =
      "max-age=15552000; includeSubDomains";
  }
  return headers;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
