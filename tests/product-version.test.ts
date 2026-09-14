import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";
import { PRODUCT_VERSION } from "../src/utils/product-version.ts";

describe("product version", () => {
  test("runtime version has package.json as its single source of truth", () => {
    expect(PRODUCT_VERSION).toBe(packageJson.version);
    expect(PRODUCT_VERSION).toBe("5.0.0-p3.0");
  });
});
