/**
 * Outbound calls to operator-configured endpoints (embedder, reranker, memory
 * client, ingest tailer) refuse redirects and read bounded response bodies,
 * like every other outbound call in src. A redirect would re-POST memory
 * content to an origin nobody configured and bypass the embed host allowlist.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { embedText } from "../src/services/embeddings.ts";
import { rerankResults } from "../src/services/recall/rerank.ts";
import type { ResultRow } from "../src/services/recall.ts";
import { readBoundedText } from "../src/utils/http-json.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  delete process.env.QOOPIA_EMBED_ENDPOINT;
  delete process.env.QOOPIA_EMBED_TIMEOUT_MS;
});

/** A redirector and the origin it points at; `hits` counts requests that reached the origin. */
function redirectPair() {
  const state = { hits: 0 };
  const origin = Bun.serve({ port: 0, fetch: () => { state.hits++; return Response.json({ results: [] }); } });
  const redirector = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${origin.port}/elsewhere` } }),
  });
  servers.push(origin, redirector);
  return { state, url: `http://127.0.0.1:${redirector.port}` };
}

describe("outbound fetches refuse redirects", () => {
  test("embedText does not follow a redirect off the configured endpoint", async () => {
    const { state, url } = redirectPair();
    process.env.QOOPIA_EMBED_ENDPOINT = `${url}/api/embed`;
    process.env.QOOPIA_EMBED_TIMEOUT_MS = "2000";
    await expect(embedText("note text that must stay on the configured host")).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(state.hits).toBe(0);
  });

  test("rerank falls back instead of following a redirect with note passages", async () => {
    const { state, url } = redirectPair();
    const rows = [{ id: "a", text: "alpha" }, { id: "b", text: "beta" }] as unknown as ResultRow[];
    const result = await rerankResults("query", rows, `${url}/rerank`, 2000, "jina");
    expect(result).toMatchObject({ mode: "rerank-fallback", fallback_reason: "rerank_exception" });
    expect(state.hits).toBe(0);
  });
});

describe("readBoundedText", () => {
  test("returns a body within the limit and refuses one over it, with or without Content-Length", async () => {
    expect(await readBoundedText(new Response("small"), 16)).toBe("small");
    await expect(readBoundedText(new Response("x".repeat(17)), 16)).rejects.toThrow(/exceeds 16 bytes/);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode("x".repeat(8)));
        controller.close();
      },
    });
    await expect(readBoundedText(new Response(stream), 16)).rejects.toThrow(/exceeds 16 bytes/);
  });
});

describe("ingest tailer endpoint", () => {
  // The tailer sends a bearer ingest key: only HTTPS or a loopback Qoopia, and
  // never a silent default (the legacy :3737 instance must not be contacted).
  function runTailer(url: string | undefined) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-tailer-endpoint-"));
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      CLAUDE_PROJECTS_DIR: path.join(root, "projects"),
      QOOPIA_CURSORS_PATH: path.join(root, "cursors.json"),
      QOOPIA_INGEST_KEY_PATH: path.join(root, "ingest.key"),
    };
    delete env.QOOPIA_URL;
    if (url !== undefined) env.QOOPIA_URL = url;
    try {
      return Bun.spawnSync({
        cmd: [process.execPath, "run", "src/ingest/tailer.ts"],
        cwd: path.join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test("refuses to start without QOOPIA_URL or with a non-HTTPS remote URL", () => {
    for (const url of [undefined, "http://qoopia.example.com", "ftp://127.0.0.1"]) {
      const result = runTailer(url);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/QOOPIA_URL/);
    }
  });
});

describe("provider responses (identity, Cloudflare, Telegram) are read with a size bound", () => {
  test("an oversized Cloudflare answer is refused instead of buffered", async () => {
    const { cloudflareTunnels } = await import("../src/identity/cloudflare.ts");
    const huge = new Response("x".repeat(2 * 1024 * 1024), { headers: { "content-type": "application/json" } });
    const provider = cloudflareTunnels({ account: "a".repeat(32), zone: "b".repeat(32), token: "synthetic" }, (async () => huge) as unknown as typeof fetch);
    await expect(provider.ensure("00000000-0000-4000-8000-000000000001", "device.example.test", "c2VjcmV0")).rejects.toThrow(/exceeds/);
  });
});
