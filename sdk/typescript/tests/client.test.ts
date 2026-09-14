import { describe, expect, test } from "bun:test";
import { QoopiaClient } from "../src/index.ts";

function ok(value: unknown) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Qoopia TypeScript SDK", () => {
  test("uses a runtime token provider and canonical MCP tools/call", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client = new QoopiaClient({
      endpoint: "https://qoopia.example/mcp",
      tokenProvider: () => "runtime-secret",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init });
        return ok({ items: [] });
      }) as unknown as typeof fetch,
    });
    expect(await client.recall<{ items: unknown[] }>({ query: "alpha" })).toEqual({ items: [] });
    expect(seen[0]?.url).toBe("https://qoopia.example/mcp");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer runtime-secret");
    expect(JSON.parse(String(seen[0]?.init?.body))).toMatchObject({
      method: "tools/call",
      params: { name: "recall", arguments: { query: "alpha" } },
    });
  });

  test("retries reads and idempotent writes, but not unsafe writes", async () => {
    let attempts = 0;
    const client = new QoopiaClient({
      endpoint: "https://qoopia.example/mcp",
      tokenProvider: () => "token",
      fetch: (async () => {
        attempts++;
        if (attempts % 2 === 1) throw new Error("temporary");
        return ok({ ok: true });
      }) as unknown as typeof fetch,
    });
    await client.recall({ query: "retry" });
    expect(attempts).toBe(2);
    await client.recallFeedback({ note_id: "n", feedback: "helpful", idempotency_key: "retry-key" });
    expect(attempts).toBe(4);
    await expect(client.noteSupersede({ source_note_id: "a" })).rejects.toThrow("temporary");
    expect(attempts).toBe(5);
  });

  test("errors never include the bearer token", async () => {
    const client = new QoopiaClient({
      endpoint: "https://qoopia.example/mcp",
      tokenProvider: () => "never-log-me",
      fetch: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch,
      maxAttempts: 1,
    });
    await expect(client.recall({ query: "x" })).rejects.not.toThrow("never-log-me");
  });
});
