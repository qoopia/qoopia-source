export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (!relevant.length) return 1;
  const found = new Set(retrieved.slice(0, k));
  return relevant.filter((id) => found.has(id)).length / relevant.length;
}

export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  const wanted = new Set(relevant);
  const index = retrieved.findIndex((id) => wanted.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function ndcgAtK(retrieved: string[], relevant: string[], k: number): number {
  const wanted = new Set(relevant);
  let dcg = 0;
  for (let index = 0; index < Math.min(k, retrieved.length); index++) {
    if (wanted.has(retrieved[index]!)) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(k, relevant.length); index++) {
    ideal += 1 / Math.log2(index + 2);
  }
  return ideal === 0 ? 1 : dcg / ideal;
}

export function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function stableResultSignature(rows: Array<{ case_id: string; ids: string[] }>): string {
  return rows
    .map((row) => `${row.case_id}:${row.ids.join(",")}`)
    .sort()
    .join("\n");
}

