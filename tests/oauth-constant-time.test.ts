import { describe, expect, test } from "bun:test";
import { constantTimeHexEqual } from "../src/auth/oauth.ts";

describe("constantTimeHexEqual", () => {
  test("returns true for matching SHA-256 hex digests", () => {
    const digest =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(constantTimeHexEqual(digest, digest)).toBe(true);
  });

  test("returns false for mismatched same-length SHA-256 hex digests", () => {
    const left =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const right =
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    expect(constantTimeHexEqual(left, right)).toBe(false);
  });
});
