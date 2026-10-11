// GitHub issue #8: a start step that fails is reported, not swallowed, and never blocks start.
import { expect, spyOn, test } from "bun:test";
import { adopt } from "../src/delivery/entry.ts";

test("a failed start step leaves one redacted line naming the step and start continues", async () => {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    await adopt("memory_hooks", () => { throw new Error("hook file unreadable, key q_abcdefghijklmnopqrstuvwx123456"); });
    await adopt("agent_instructions", async () => undefined);
  } finally { spy.mockRestore(); }
  expect(lines).toHaveLength(1);
  const event = JSON.parse(lines[0]!);
  expect(event).toMatchObject({ event: "start_step_failed", step: "memory_hooks" });
  expect(event.reason).toContain("hook file unreadable");
  expect(event.reason).not.toContain("q_abcdefghijklmnopqrstuvwx123456");
});
