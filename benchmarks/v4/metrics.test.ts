import { describe, expect, test } from "bun:test";
import { mean, ndcgAtK, percentile, recallAtK, reciprocalRank, stableResultSignature } from "./metrics.ts";

describe("P09 metric formula qualification", () => {
  test("Recall@k handles single and multiple relevant rows", () => {
    expect(recallAtK(["a", "b", "c"], ["b"], 1)).toBe(0);
    expect(recallAtK(["a", "b", "c"], ["b"], 2)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["b", "d"], 3)).toBe(0.5);
  });

  test("MRR and nDCG use one-based rank discounts", () => {
    expect(reciprocalRank(["a", "b", "c"], ["b"])).toBe(0.5);
    expect(reciprocalRank(["a"], ["z"])).toBe(0);
    expect(ndcgAtK(["a", "b", "c"], ["a", "b"], 3)).toBeCloseTo(1, 8);
    expect(ndcgAtK(["z", "a", "b"], ["a", "b"], 3)).toBeLessThan(1);
  });

  test("nearest-rank percentiles, means and signatures are deterministic", () => {
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
    expect(mean([1, 2, 3])).toBe(2);
    expect(stableResultSignature([
      { case_id: "b", ids: ["2"] },
      { case_id: "a", ids: ["1", "3"] },
    ])).toBe("a:1,3\nb:2");
  });
});

