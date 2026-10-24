/**
 * 5.0.23: secrets as a type guarantee. Memory text reaches its tables only as Sanitized (made by the secret
 * guard alone), every write statement binds it through stored(), the owner can extend the detectors and
 * allow known non-secrets, and the hook client's cursor files keep no secret and no key.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectSecretLabels, redactMemory, sanitizedMemory, secretFree } from "../src/utils/secret-guard.ts";
import { writeState, type ClientState } from "../src/delivery/memory-client.ts";

const TABLES = "notes|session_messages|summaries|agent_comm_messages";
const WRITE = new RegExp(`(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+"?(?:${TABLES})\\b|UPDATE\\s+(?:${TABLES})\\s+SET\\s+[^\`'"]*?\\b(?:text|content|body)\\s*=\\s*\\?)`, "gi");

function runArguments(source: string, from: number): string {
  const start = source.indexOf(".run(", from);
  let depth = 0;
  for (let i = start + 4; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(start, i + 1);
  }
  return "";
}

test("every statement that writes memory text binds it through stored(), which takes only Sanitized", () => {
  const sites: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(".")) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(WRITE)) {
      const where = `${file}:${source.slice(0, m.index).split("\n").length}`;
      sites.push(where);
      let bound = runArguments(source, m.index!);
      // A statement may bind a parameter array prepared just before it: then the array must use stored().
      const spread = /^\.run\(\.\.\.(\w+)\)$/.exec(bound)?.[1];
      if (spread) {
        const at = source.indexOf(`const ${spread} =`, m.index!);
        bound = at < 0 ? "" : source.slice(at, source.indexOf(".run(", at));
      }
      expect(bound, where).toContain("stored(");
    }
  }
  // Notes, both session-message inserts, summaries, both AgentComm inserts and the agent-task transcript.
  expect(sites.length).toBeGreaterThanOrEqual(7);
  // The dynamic note update binds its text the same way.
  expect(fs.readFileSync("src/services/notes.ts", "utf8")).toContain("values.push(stored(nextText!))");
  // Only the guard makes the type.
  const makers = [...new Bun.Glob("src/**/*.ts").scanSync(".")].filter((f) => / as Sanitized\b/.test(fs.readFileSync(f, "utf8")));
  expect(makers).toEqual(["src/utils/secret-guard.ts"]);
});

test("secretFree refuses, sanitizedMemory cuts out; hex keys and prefixed tokens are found, digests and identifiers stay", () => {
  const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  expect(() => secretFree(`api_key: ${hex}`, "note.text")).toThrow("hex-key");
  expect(sanitizedMemory(`ключ: ${hex}`).text as string).toBe("[REDACTED:hex-key]");
  expect(detectSecretLabels(`commit ${hex}`)).toEqual([]);
  const aim = "ai" + "m_" + "Xk7Qm2PzR9vL4tB8nW1cY6hJ3sD5fG0aE2u";
  expect(detectSecretLabels(`token ${aim}`)).toContain("prefixed-token");
  expect(detectSecretLabels("snake_case_identifier_for_the_memory_worker_queue")).toEqual([]);
});

const saved = { extra: process.env.QOOPIA_SECRET_PATTERNS_EXTRA, allow: process.env.QOOPIA_SECRET_ALLOWLIST };
afterEach(() => {
  for (const [key, value] of [["QOOPIA_SECRET_PATTERNS_EXTRA", saved.extra], ["QOOPIA_SECRET_ALLOWLIST", saved.allow]] as const)
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test("the owner adds detectors and allows known non-secrets", () => {
  process.env.QOOPIA_SECRET_PATTERNS_EXTRA = JSON.stringify([{ label: "acme-key", pattern: "acme_[0-9]{10}" }]);
  expect(redactMemory("key acme_1234567890").text).toBe("key [REDACTED:acme-key]");
  const placeholder = "AI" + "za" + "SyPLACEHOLDERplaceholderPLACEHOLDER123";
  expect(detectSecretLabels(placeholder)).toContain("google-api-key");
  process.env.QOOPIA_SECRET_ALLOWLIST = JSON.stringify([placeholder, "re:^acme_0{10}$"]);
  expect(detectSecretLabels(`docs use ${placeholder}`)).toEqual([]);
  expect(redactMemory(`docs use ${placeholder}`).text).toBe(`docs use ${placeholder}`);
  expect(redactMemory("acme_0000000000 and acme_1234567890").text).toBe("acme_0000000000 and [REDACTED:acme-key]");
  // A broken allowlist allows nothing.
  process.env.QOOPIA_SECRET_ALLOWLIST = "{not json";
  expect(detectSecretLabels(placeholder)).toContain("google-api-key");
});

test("a hook cursor file keeps no secret a transcript carried", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-cursor-")), file = path.join(dir, "cursor.json");
  const token = "glp" + "at-" + "AbCdEf1234567890xYzQ";
  const state = { file: "", session: "codex:s", project: "/p", cursor: 0, part: 0, source: "hooks",
    pending: [{ id: "m1", role: "user", content: `deploy with ${token}`, timestamp: "2026-10-23T00:00:00.000Z" }],
    hook_prompt: { turn: "t1", prompt: `пароль: hunter2-${"FAKE"}` }, error: `Qoopia HTTP 500 ${token}` } as unknown as ClientState;
  writeState(file, state);
  const text = fs.readFileSync(file, "utf8");
  expect(text).not.toContain(token);expect(text).not.toContain("hunter2");
  expect(text).toContain("[REDACTED:gitlab-pat]");expect(text).toContain("[REDACTED:password]");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
