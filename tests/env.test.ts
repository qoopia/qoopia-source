import { describe, expect, test } from "bun:test";
import { requireInt } from "../src/utils/env.ts";

describe("integer environment parsing", () => {
  test("accepts exact integers and defaults only empty values", () => {
    expect(requireInt("30", "TEST_VALUE", 7)).toBe(30);
    expect(requireInt("-1", "TEST_VALUE", 7)).toBe(-1);
    expect(requireInt("", "TEST_VALUE", 7)).toBe(7);
    expect(requireInt(undefined, "TEST_VALUE", 7)).toBe(7);
  });

  test("rejects truncated or unsafe numeric values", () => {
    expect(() => requireInt("1.5", "TEST_VALUE", 7)).toThrow("expected integer");
    expect(() => requireInt("30days", "TEST_VALUE", 7)).toThrow("expected integer");
    expect(() => requireInt("9007199254740993", "TEST_VALUE", 7)).toThrow(
      "expected safe integer",
    );
  });
});
