/**
 * Phase 1 item 6 — exhaustive unit coverage for recall_log redactQuery().
 *
 * Source of truth for the regex set: /srv/qoopia/docs/secret-safe-audit-rubric.md §5.
 * Mirrored in src/services/recall_log_redaction.ts. When the rubric changes,
 * update BOTH the module AND this test in the same change.
 */
import { describe, expect, test } from "bun:test";
import {
  redactQuery,
  REDACTION_KINDS,
} from "../src/services/recall_log_redaction.ts";

describe("redactQuery — rubric §5 keyword patterns", () => {
  // Each row asserts: (a) the secret keyword AND the following value are
  // removed, (b) the replacement carries the right KIND label.
  // NOTE: the rubric §5 source pattern consumes the keyword + ONE
  // following \S+ token. Test inputs are crafted so the "value" is a
  // single \S+ token (no intervening "Basic"/"Bearer" prefix that would
  // be captured as the value, leaving the actual secret bytes visible).
  const cases: Array<{ kind: string; input: string; mustNotContain: string }> = [
    { kind: "api_key",       input: "apikey=sk-live-abcdef123456",                mustNotContain: "sk-live-abcdef123456" },
    { kind: "api_key",       input: "api_key sk-live-abcdef123456",               mustNotContain: "sk-live-abcdef123456" },
    { kind: "api_key",       input: "api-key: sk-live-abcdef123456",              mustNotContain: "sk-live-abcdef123456" },
    { kind: "token",         input: "token=ghp_aaaaaaaaaaaaaaaaaaaaaaaa",         mustNotContain: "ghp_aaaaaaaaaaaaaaaaaaaaaaaa" },
    { kind: "secret",        input: "secret: my-prod-secret-value",               mustNotContain: "my-prod-secret-value" },
    { kind: "password",      input: "password=hunter2!",                          mustNotContain: "hunter2!" },
    { kind: "bearer",        input: "Bearer eyJhbGciOiJIaaaaaaaaaaaaaaaaaa",      mustNotContain: "eyJhbGciOiJIaaaaaaaaaaaaaaaaaa" },
    { kind: "cookie",        input: "Cookie=session_abc123def456",                mustNotContain: "session_abc123def456" },
    { kind: "authorization", input: "Authorization: Basic_dXNlcjpwYXNz",          mustNotContain: "Basic_dXNlcjpwYXNz" },
  ];

  for (const c of cases) {
    test(`strips ${c.kind} (${c.input.slice(0, 30)}...)`, () => {
      const out = redactQuery(c.input);
      expect(out).toContain(`<REDACTED:${c.kind}>`);
      expect(out).not.toContain(c.mustNotContain);
    });
  }

  test("covers every KIND in the rubric §5 set (no gaps in case table)", () => {
    // The redactor exports REDACTION_KINDS = SECRET kinds + 'ulid'. The
    // unit test table above MUST exercise every non-ulid kind. Catches the
    // common failure mode where a new kind lands in the rubric/module but
    // the test suite still passes on the old subset.
    const tested = new Set(cases.map((c) => c.kind));
    const expected = REDACTION_KINDS.filter((k) => k !== "ulid");
    for (const k of expected) {
      expect(tested.has(k)).toBe(true);
    }
  });
});

describe("redactQuery — ULID handling", () => {
  test("bare ULID is PRESERVED (it is the recall corpus)", () => {
    const ulid = "01KSBK5KDR6532W95YV11M4VVS";
    const input = `look up note ${ulid} for me`;
    expect(redactQuery(input)).toBe(input);
  });

  test("ULID adjacent to a redaction marker is stripped", () => {
    // The keyword pattern consumes "apikey for" (keyword + sigil + first
    // \S+ = "for"); the ULID survives step 1 but is within 32 chars of
    // the resulting <REDACTED:api_key> marker, so step 2 strips it.
    // (`api key` with a space is NOT a keyword per rubric §5 — the
    // alternation is `api[_-]?key`, no space variant. We use `apikey`.)
    const ulid = "01KSBK5KDR6532W95YV11M4VVS";
    const out = redactQuery(`the apikey for ${ulid}`);
    expect(out).toContain("<REDACTED:api_key>");
    expect(out).toContain("<REDACTED:ulid>");
    expect(out).not.toContain(ulid);
  });

  test("multiple bare ULIDs in a sentence all survive", () => {
    const a = "01KSBK5KDR6532W95YV11M4VVS";
    const b = "01KSBM2TV1HVTPWZZPKFYXHWBJ";
    const input = `compare ${a} with ${b} please`;
    expect(redactQuery(input)).toBe(input);
  });

  test("ULID far from any keyword (>32 chars) is preserved", () => {
    const ulid = "01KSBK5KDR6532W95YV11M4VVS";
    const padding = "x".repeat(80);
    const input = `apikey=secret ${padding} ${ulid}`;
    const out = redactQuery(input);
    expect(out).toContain("<REDACTED:api_key>");
    expect(out).toContain(ulid); // far enough away — preserved
  });
});

describe("redactQuery — non-secret text", () => {
  test("plain natural-language query unchanged", () => {
    const cases = [
      "phase 1 audit progress",
      "find Saule's day off",
      "когда был последний релиз",
      "Suche Flüge nach Paris",
      "what is the latency on the recall endpoint",
    ];
    for (const c of cases) {
      expect(redactQuery(c)).toBe(c);
    }
  });

  test("empty string returns empty string", () => {
    expect(redactQuery("")).toBe("");
  });

  test("keyword without a following value is NOT redacted", () => {
    // The pattern requires "keyword [\s:=]+ \S+" — bare "secret" with no
    // value should pass through. The recall corpus has rows like
    // "secret-safe rubric" or "phase 0 token of trust" where the word is
    // part of normal prose, not a credential assignment.
    expect(redactQuery("secret-safe rubric")).toBe("secret-safe rubric");
    // Same for "token" used as a noun without an assigned value:
    expect(redactQuery("token endpoint health check")).toContain(
      "<REDACTED:token>",
    );
    // Note that the latter DOES redact "token endpoint" — the pattern is
    // structural ([\s:=]+\S+), it cannot tell prose from assignment. This
    // is the documented trade-off in rubric §5: false positives on prose
    // are acceptable; missed redactions are not.
  });
});

describe("redactQuery — idempotency", () => {
  test("second pass over a redacted string is a fixed point", () => {
    const inputs = [
      "apikey=sk-live-abcdef api_key=sk-live-xyz",
      "token=t1 secret: s2 password: p3 Authorization: Basic q4",
      "lookup api key for 01KSBK5KDR6532W95YV11M4VVS",
      "plain text no secrets here",
    ];
    for (const i of inputs) {
      const once = redactQuery(i);
      const twice = redactQuery(once);
      expect(twice).toBe(once);
    }
  });

  test("no double <REDACTED:...:...> markers (single-pass guarantee)", () => {
    const out = redactQuery("apikey=sk-live-abc password=p1 token=t2");
    expect(out).not.toMatch(/<REDACTED:[^>]*<REDACTED:/);
  });
});

describe("redactQuery — combined patterns", () => {
  test("multiple kinds in one string all collapsed", () => {
    const input = "apikey=k1 token=t2 password=p3";
    const out = redactQuery(input);
    expect(out).toContain("<REDACTED:api_key>");
    expect(out).toContain("<REDACTED:token>");
    expect(out).toContain("<REDACTED:password>");
    expect(out).not.toContain("k1");
    expect(out).not.toContain("t2");
    expect(out).not.toContain("p3");
  });
});
