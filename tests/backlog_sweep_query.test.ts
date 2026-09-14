/**
 * Tests for the backlog sweep TEST_TOPIC_RE regex.
 * Phase 1 item 2 R3 — Leo BLOCK 2A fix verification.
 */
import { describe, expect, test } from "bun:test";
import { TEST_TOPIC_RE } from "../scripts/backlog_sweep_query.ts";

describe("TEST_TOPIC_RE", () => {
  test("matches SMOKE_ prefix", () => {
    expect(TEST_TOPIC_RE.test("SMOKE_FOO_PROOF")).toBe(true);
    expect(TEST_TOPIC_RE.test("SMOKE_anything")).toBe(true);
  });

  test("matches *_TEST_ in middle", () => {
    expect(TEST_TOPIC_RE.test("AUTH_REPAIR_SMOKE_TEST_3")).toBe(true);
    expect(TEST_TOPIC_RE.test("X_TEST_Y")).toBe(true);
  });

  test("matches WAKE_SLO_PROBE_ prefix", () => {
    expect(TEST_TOPIC_RE.test("WAKE_SLO_PROBE_C2L_123")).toBe(true);
    expect(TEST_TOPIC_RE.test("WAKE_SLO_PROBE_L2C_999")).toBe(true);
  });

  test("matches *_PROOF only when PROOF is at end", () => {
    expect(TEST_TOPIC_RE.test("SOMETHING_PROOF")).toBe(true);
    expect(TEST_TOPIC_RE.test("X_PROOF")).toBe(true);
  });

  test("rejects *_PROOF in middle (the Leo BLOCK case)", () => {
    expect(TEST_TOPIC_RE.test("SOME_PROOF_OF_CONCEPT_BUSINESS_TOPIC")).toBe(
      false,
    );
    expect(TEST_TOPIC_RE.test("PROOF_OF_X")).toBe(false);
  });

  test("rejects non-test business topics", () => {
    expect(TEST_TOPIC_RE.test("QUARTERLY_BUSINESS_REVIEW")).toBe(false);
    expect(TEST_TOPIC_RE.test("AgentComm v1 is configured")).toBe(false);
    expect(TEST_TOPIC_RE.test("URGENT: Report status")).toBe(false);
  });

  test("rejects topics that merely contain SMOKE somewhere", () => {
    expect(TEST_TOPIC_RE.test("MORNING_SMOKE_REPORT")).toBe(false);
  });

  test("rejects topics with literal $ char (not regex end-anchor)", () => {
    expect(TEST_TOPIC_RE.test("FOO_PROOF$BAR")).toBe(false);
  });
});
