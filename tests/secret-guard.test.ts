import { afterEach, describe, expect, test } from "bun:test";
import {
  assertNoSecrets,
  detectSecretLabels,
  redactSensitive,
} from "../src/utils/secret-guard.ts";
import { QoopiaError } from "../src/utils/errors.ts";

const SAMPLE_QOOPIA = "q_EXAMPLE_PLACEHOLDER_KEY1";
const SAMPLE_GITHUB = "ghp_1234567890ABCDEF1234567890ABCDEF1234";
const SAMPLE_OPENAI = "sk-1234567890ABCDEFGHIJKLMN";
const SAMPLE_OPENAI_PROJECT =
  "sk-proj-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcd123456";
const SAMPLE_AWS_ACCESS = "AKIA1234567890ABCDEF";
const SAMPLE_AWS_SECRET =
  "aws_secret_access_key = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureValue123";
const SAMPLE_ANTHROPIC =
  "sk-ant-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd123456";
const SAMPLE_SLACK = "xoxb-1234567890-ABCDEFGHIJKLMN-opqrsTUV";
const SAMPLE_STRIPE_SECRET = "sk_live_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SAMPLE_STRIPE_PUBLIC = "pk_live_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SAMPLE_SSH = "-----BEGIN OPENSSH PRIVATE KEY-----";

const EXTRA_ENV_KEY = "QOOPIA_SECRET_PATTERNS_EXTRA";
const originalExtra = process.env[EXTRA_ENV_KEY];

afterEach(() => {
  if (originalExtra === undefined) delete process.env[EXTRA_ENV_KEY];
  else process.env[EXTRA_ENV_KEY] = originalExtra;
});

function captureWarnings(run: () => void): string[] {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

describe("detectSecretLabels", () => {
  test.each([
    ["qoopia-token", SAMPLE_QOOPIA, "hello world"],
    ["github-pat", SAMPLE_GITHUB, "ghp_short_token"],
    ["openai-key", SAMPLE_OPENAI, "sk-short"],
    ["openai-project-key", SAMPLE_OPENAI_PROJECT, "sk-proj-short"],
    ["aws-access-key-id", SAMPLE_AWS_ACCESS, "AKIA1234"],
    ["aws-secret-access-key", SAMPLE_AWS_SECRET, "aws_secret_access_key = short"],
    ["jwt", SAMPLE_JWT, "not.a.jwt"],
    ["anthropic-key", SAMPLE_ANTHROPIC, "sk-ant-short"],
    ["slack-token", SAMPLE_SLACK, "xoxb-short"],
    ["stripe-secret-key", SAMPLE_STRIPE_SECRET, "sk_test_1234"],
    ["stripe-public-key", SAMPLE_STRIPE_PUBLIC, "pk_test_1234"],
    ["ssh-private-key", SAMPLE_SSH, "-----BEGIN CERTIFICATE-----"],
  ])("detects %s and ignores negative sample", (label, positive, negative) => {
    expect(detectSecretLabels(positive)).toContain(label);
    expect(detectSecretLabels(negative)).not.toContain(label);
  });

  test("finds multiple secret classes in one string", () => {
    const text = `${SAMPLE_GITHUB} ${SAMPLE_OPENAI} ${SAMPLE_SLACK}`;
    expect(detectSecretLabels(text)).toEqual([
      "github-pat",
      "openai-key",
      "slack-token",
    ]);
  });

  test("supports JSON custom regex detectors from env", () => {
    process.env.QOOPIA_SECRET_PATTERNS_EXTRA = JSON.stringify([
      { label: "custom-json", pattern: "MYCUSTOMSECRET[0-9]{4}" },
    ]);
    expect(detectSecretLabels("prefix MYCUSTOMSECRET1234 suffix")).toContain(
      "custom-json",
    );
  });

  test("supports JSON custom regex with commas inside character classes", () => {
    process.env.QOOPIA_SECRET_PATTERNS_EXTRA = JSON.stringify([
      { label: "comma-class", pattern: "foo[a,b]bar" },
    ]);
    expect(detectSecretLabels("prefix fooabar suffix")).toContain("comma-class");
  });

  test("skips broken custom regex with warning instead of throwing", () => {
    process.env.QOOPIA_SECRET_PATTERNS_EXTRA = JSON.stringify([
      { label: "broken-json", pattern: "foo[" },
    ]);
    const warnings = captureWarnings(() => {
      expect(detectSecretLabels("plain text only")).toEqual([]);
    });
    expect(
      warnings.some((line) => line.includes("Skipping invalid QOOPIA_SECRET_PATTERNS_EXTRA detector 'broken-json'")),
    ).toBe(true);
  });

  test("legacy CSV custom regex still works with deprecation warning", () => {
    process.env.QOOPIA_SECRET_PATTERNS_EXTRA = "MYCUSTOMSECRET[0-9]{4}";
    const warnings = captureWarnings(() => {
      expect(detectSecretLabels("prefix MYCUSTOMSECRET1234 suffix")).toContain(
        "custom-secret-1",
      );
    });
    expect(
      warnings.some((line) => line.includes("legacy CSV format is deprecated")),
    ).toBe(true);
  });

  test("empty string, long plain text, and unicode are accepted", () => {
    expect(detectSecretLabels("")).toEqual([]);
    expect(detectSecretLabels("обычный текст без секретов".repeat(400))).toEqual(
      [],
    );
    expect(detectSecretLabels("纯文本 без токенов and emojis are absent")).toEqual(
      [],
    );
  });
});

describe("assertNoSecrets", () => {
  test("throws INVALID_INPUT with detector label and context only", () => {
    try {
      assertNoSecrets(`here is ${SAMPLE_OPENAI}`, "note.metadata");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QoopiaError);
      expect((err as QoopiaError).code).toBe("INVALID_INPUT");
      expect((err as Error).message).toContain("openai-key");
      expect((err as Error).message).toContain("note.metadata");
      expect((err as Error).message).not.toContain(SAMPLE_OPENAI);
    }
  });

  test("accepts normal text without detector hits", () => {
    expect(() =>
      assertNoSecrets("hello world this is a normal note", "note.text"),
    ).not.toThrow();
  });
});

describe("redactSensitive path boundaries", () => {
  test("Unix and Windows paths remain fully redacted, including internal backslash suffixes", () => {
    for (const path of [
      "/Users/harmless/private-leaf", "/home/harmless/private-leaf",
      "/private/tmp/harmless/private-leaf", "/tmp/harmless/private-leaf", "/var/tmp/harmless/private-leaf",
      "C:\\harmless\\private-leaf\\sensitive-suffix", "D:/harmless/private-leaf",
      "C:\\harmless\\private-leaf\\", "/tmp/harmless\\sensitive-suffix",
    ]) {
      expect(redactSensitive(path)).toEqual({ text: "[LOCAL_PATH]", categories: ["absolute-path"] });
    }
  });

  test("quoted paths keep JSON escape boundaries at multiple serialization depths without path or token bytes", () => {
    for (const path of ["/tmp/harmless/private-leaf", "C:\\harmless\\private-leaf\\sensitive-suffix"]) {
      for (const depth of [1, 2, 3, 4]) {
        let encoded = `quoted "${path}" and ${SAMPLE_GITHUB}`;
        for (let i = 0; i < depth; i++) encoded = JSON.stringify(encoded);
        const clean = redactSensitive(encoded);
        expect(clean.categories).toEqual(["absolute-path", "github-pat"]);
        expect(clean.text).not.toMatch(/harmless|private-leaf|sensitive-suffix/);
        expect(clean.text).not.toContain(SAMPLE_GITHUB);
        let decoded = clean.text;
        for (let i = 0; i < depth; i++) decoded = JSON.parse(decoded);
        expect(decoded).toBe('quoted "[LOCAL_PATH]" and [REDACTED:github-pat]');
      }
    }
  });
});
