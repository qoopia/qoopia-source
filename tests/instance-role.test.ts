import { describe, expect, test } from "bun:test";
import { resolveServerRole } from "../src/utils/env.ts";

describe("Qoopia instance role", () => {
  test("production without an explicit role fails closed", () => {
    expect(resolveServerRole(undefined, "production")).toBe("legacy-readonly");
    expect(resolveServerRole("unexpected", "production")).toBe("legacy-readonly");
  });

  test("canonical writes require an explicit production role", () => {
    expect(resolveServerRole("canonical", "production")).toBe("canonical");
    expect(resolveServerRole("legacy-readonly", "production")).toBe(
      "legacy-readonly",
    );
  });

  test("test runtime retains writable fixtures", () => {
    expect(resolveServerRole(undefined, "test")).toBe("canonical");
  });
});
