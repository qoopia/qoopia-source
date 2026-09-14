import { afterEach, describe, expect, test } from "bun:test";
import {
  embedText,
  resolveEmbedEndpoint,
} from "../src/services/embeddings.ts";
import { QoopiaError } from "../src/utils/errors.ts";

const ENV_KEYS = [
  "QOOPIA_EMBED_ENDPOINT",
  "QOOPIA_EMBED_ALLOW_REMOTE",
  "QOOPIA_EMBED_HOSTS",
  "QOOPIA_EMBED_TIMEOUT_MS",
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  envSnapshot.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveEmbedEndpoint", () => {
  test("loopback endpoint passes without remote flag", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "http://127.0.0.1:11434/api/embed";
    delete process.env.QOOPIA_EMBED_ALLOW_REMOTE;
    delete process.env.QOOPIA_EMBED_HOSTS;

    expect(resolveEmbedEndpoint().toString()).toBe(
      "http://127.0.0.1:11434/api/embed",
    );
  });

  test("ipv6 loopback endpoint passes without remote flag", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "http://[::1]:11434/api/embed";
    delete process.env.QOOPIA_EMBED_ALLOW_REMOTE;
    delete process.env.QOOPIA_EMBED_HOSTS;

    expect(resolveEmbedEndpoint().toString()).toBe(
      "http://[::1]:11434/api/embed",
    );
  });

  test("ipv4-mapped ipv6 loopback endpoint passes without remote flag", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "http://[::ffff:127.0.0.1]:11434/api/embed";
    delete process.env.QOOPIA_EMBED_ALLOW_REMOTE;
    delete process.env.QOOPIA_EMBED_HOSTS;

    expect(resolveEmbedEndpoint().toString()).toBe(
      "http://[::ffff:7f00:1]:11434/api/embed",
    );
  });

  test("remote endpoint without allow flag is rejected", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "https://embeddings.example.com/api/embed";
    delete process.env.QOOPIA_EMBED_ALLOW_REMOTE;
    delete process.env.QOOPIA_EMBED_HOSTS;

    expect(() => resolveEmbedEndpoint()).toThrow(QoopiaError);
  });

  test("remote endpoint with allow flag + matching hostname passes", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "https://embeddings.example.com/api/embed";
    process.env.QOOPIA_EMBED_ALLOW_REMOTE = "1";
    process.env.QOOPIA_EMBED_HOSTS = "embeddings.example.com,embed-backup.example.com";

    expect(resolveEmbedEndpoint().hostname).toBe("embeddings.example.com");
  });

  test("remote endpoint with allow flag + empty hosts is rejected", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "https://embeddings.example.com/api/embed";
    process.env.QOOPIA_EMBED_ALLOW_REMOTE = "1";
    process.env.QOOPIA_EMBED_HOSTS = "";

    expect(() => resolveEmbedEndpoint()).toThrow(QoopiaError);
  });

  test("remote endpoint with allow flag + non-matching hostname is rejected", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "https://embeddings.example.com/api/embed";
    process.env.QOOPIA_EMBED_ALLOW_REMOTE = "1";
    process.env.QOOPIA_EMBED_HOSTS = "embed-backup.example.com";

    expect(() => resolveEmbedEndpoint()).toThrow(QoopiaError);
  });

  test("remote endpoint with wildcard hosts accepts any hostname and warns", () => {
    process.env.QOOPIA_EMBED_ENDPOINT = "https://any-remote.example.com/api/embed";
    process.env.QOOPIA_EMBED_ALLOW_REMOTE = "1";
    process.env.QOOPIA_EMBED_HOSTS = "*";

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      expect(resolveEmbedEndpoint().hostname).toBe("any-remote.example.com");
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((line) => line.includes("high-risk any-remote mode"))).toBe(true);
  });
});

describe("embedText upstream error handling", () => {
  test("error message logs status + request id without upstream body", async () => {
    const stub = Bun.serve({
      port: 0,
      fetch() {
        return new Response("TOP-SECRET-UPSTREAM-BODY", {
          status: 502,
          headers: { "x-request-id": "embed-req-123" },
        });
      },
    });

    process.env.QOOPIA_EMBED_ENDPOINT = `http://127.0.0.1:${stub.port}/api/embed`;
    process.env.QOOPIA_EMBED_TIMEOUT_MS = "1000";
    delete process.env.QOOPIA_EMBED_ALLOW_REMOTE;
    delete process.env.QOOPIA_EMBED_HOSTS;

    try {
      await expect(embedText("hello from allowlist test")).rejects.toThrow(
        /Embedder HTTP 502 request_id=embed-req-123/,
      );
      try {
        await embedText("hello from allowlist test");
      } catch (err) {
        expect((err as Error).message).not.toContain("TOP-SECRET-UPSTREAM-BODY");
      }
    } finally {
      stub.stop();
    }
  });
});
