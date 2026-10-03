import { describe, expect, test } from "bun:test";
import { logger, redactLogContext, sanitizeLogMessage } from "../src/utils/logger.ts";

const clientId = "qc_" + Buffer.alloc(16, 7).toString("base64url");

describe("logger secret masking keeps the diagnostic line [F-195]", () => {
  test("a public qc_ client id is masked in place, the rest of the line survives", () => {
    const out = sanitizeLogMessage(`OAuth authorize ENTER client=${clientId} redirect=https://claude.ai/cb has_state=y`);
    expect(out).toContain("OAuth authorize ENTER client=[REDACTED:qoopia-token]");
    expect(out).toContain("has_state=y");
    expect(out).not.toContain(clientId);
  });

  test("context strings are masked span-wise as well", () => {
    expect(redactLogContext({ detail: `client ${clientId} ok` })).toEqual({ detail: "client [REDACTED:qoopia-token] ok" });
  });

  test("masking runs before the length bound, so a token on the boundary leaks no fragment", () => {
    const out = sanitizeLogMessage("x".repeat(2_040) + " ghp_" + "A".repeat(36));
    expect(out).not.toMatch(/ghp_A/);
    expect(out).not.toContain("AAAA");
  });

  test("a private key block is masked as a whole, body included", () => {
    const out = sanitizeLogMessage("loaded -----BEGIN PRIVATE KEY-----\nMIIBody\n-----END PRIVATE KEY----- done");
    expect(out).not.toContain("MIIBody");
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).toContain("done");
  });
});

describe("logger output cannot forge lines [F-134]", () => {
  test("line terminators and other control characters are escaped", () => {
    const out = sanitizeLogMessage("grant_type=x\n2026-10-02T00:00:00.000Z INFO FORGED\r\nb\u2028c\u2029d\u0085e\u001b[31mf");
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(out).toContain("\\u000a2026-10-02T00:00:00.000Z INFO FORGED");
  });

  test("one logger call writes exactly one line", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => { lines.push(line); };
    try { logger.error("redirect_uri=a\nFORGED line", { reason: "b\nc" }); }
    finally { console.error = original; }
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });
});
