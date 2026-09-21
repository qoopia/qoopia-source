import { bundleSchema } from '../src/delivery/bundle.ts';
import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";
import { PRODUCT_VERSION } from "../src/utils/product-version.ts";

describe("product version", () => {
  test("runtime version has package.json as its single source of truth", () => {
    expect(PRODUCT_VERSION).toBe(packageJson.version);
    expect(bundleSchema.shape.version.safeParse(PRODUCT_VERSION).success).toBe(true);
  });
});

test("5.0 patch bundles remain compatible without admitting another release line", () => {
  for (const version of ["5.0.0-p3.0", "5.0.1", "5.0.2", "5.0.3", "5.0.4", "5.0.5", "5.0.6", "5.0.7", "5.0.8", "5.0.9"]) expect(bundleSchema.shape.version.safeParse(version).success).toBe(true);
  for (const version of ["5.0.02", "5.1.0", "6.0.0", "5.0.2/invalid"]) expect(bundleSchema.shape.version.safeParse(version).success).toBe(false);
});
