import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { fileTextWorkers } from "../src/services/files.ts";

// DOCX/PDF parsing runs in its own process: a fake worker stands in for a parser that
// hangs, crashes, floods its output or allocates without end.
const fake = fileURLToPath(new URL("./helpers/fake-file-text-worker.ts", import.meta.url));
const limits = { timeoutMs: 1_500, memoryBytes: 400 * 1024 ** 2, outputBytes: 1024 * 1024, concurrency: 2, queue: 1 };
const pool = (overrides = {}) => fileTextWorkers(() => [process.execPath, fake], { ...limits, ...overrides });
const run = (extract: ReturnType<typeof pool>, input: string) => extract("pdf", Buffer.from(input));

test("a hanging parser is killed at the timeout while the server keeps serving, and the next file extracts", async () => {
  const extract = pool();
  let maxGap = 0, last = performance.now();
  const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
  const started = performance.now();
  expect(await run(extract, "hang")).toEqual({ text: null, status: "failed", reason: "timeout" });
  clearInterval(tick);
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(maxGap).toBeLessThan(150);
  expect(await run(extract, "next")).toEqual({ text: "next", status: "extracted" });
});

test("a crashing or garbled parser is a failed status, and the next file extracts", async () => {
  const extract = pool();
  expect(await run(extract, "crash")).toEqual({ text: null, status: "failed", reason: "crashed" });
  expect(await run(extract, "garbage")).toEqual({ text: null, status: "failed", reason: "crashed" });
  expect(await run(extract, "after")).toEqual({ text: "after", status: "extracted" });
  // A worker that cannot even start is a status too, never an upload error.
  expect(await run(fileTextWorkers(() => ["/nonexistent/qoopia"], limits), "x")).toEqual({ text: null, status: "unavailable" });
});

test("a parser past the memory ceiling or the output cap is killed", async () => {
  const extract = pool({ timeoutMs: 20_000 });
  expect(await run(extract, "alloc")).toEqual({ text: null, status: "failed", reason: "memory" });
  expect(await run(extract, "flood")).toEqual({ text: null, status: "failed", reason: "output" });
}, 30_000);

test("at most `concurrency` parsers run, a short queue waits, and overflow is a retryable RATE_LIMITED", async () => {
  const extract = pool();
  const started = performance.now();
  const queued = [run(extract, "slow:1"), run(extract, "slow:2"), run(extract, "slow:3")];
  await expect(run(extract, "slow:4")).rejects.toMatchObject({ code: "RATE_LIMITED", details: { retryable: true } });
  expect((await Promise.all(queued)).map(r => r.text)).toEqual(["slow:1", "slow:2", "slow:3"]);
  expect(performance.now() - started).toBeGreaterThan(800); // the third waited for a slot
  expect(await run(extract, "free again")).toEqual({ text: "free again", status: "extracted" });
});

test("the parser process gets no server secrets", async () => {
  process.env.QOOPIA_BUNDLE_ASSETS = "/bundle/assets";
  try {
    const keys = (await run(pool(), "env")).text!.split(",");
    expect(keys).toContain("QOOPIA_BUNDLE_ASSETS");
    expect(keys).toContain("QOOPIA_FILE_TEXT_WORKER");
    expect(keys.some(k => /SECRET|TOKEN|KEY/.test(k))).toBe(false);
  } finally { delete process.env.QOOPIA_BUNDLE_ASSETS; }
});
