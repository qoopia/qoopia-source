#!/usr/bin/env bun
/**
 * scripts/benchmark-tailer.ts
 *
 * Offline benchmark for extractText().
 * Usage: bun run scripts/benchmark-tailer.ts <path-to-jsonl>
 *
 * 1. Runs extractText on every line of the real JSONL.
 * 2. Prints extracted / skipped tables.
 * 3. Runs synthetic secret-detection tests.
 */

import fs from "node:fs";
import { extractText } from "../src/ingest/tailer.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun run scripts/benchmark-tailer.ts <path-to-jsonl>");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").split("\n");

type Extracted = { role: string; source: string; preview: string; uuid: string };
type Skipped = { reason: string };

const extracted: Extracted[] = [];
const skipped: Record<string, number> = {};

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  // Parse just enough to determine skip reason
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    skipped["parse_error"] = (skipped["parse_error"] ?? 0) + 1;
    continue;
  }

  const type = parsed.type;
  if (type !== "user" && type !== "assistant") {
    skipped[`not_dialogue_type:${type}`] = (skipped[`not_dialogue_type:${type}`] ?? 0) + 1;
    continue;
  }

  const result = extractText(trimmed);
  if (!result) {
    // Determine reason
    const content = parsed.message?.content;
    if (!content) {
      skipped["no_content"] = (skipped["no_content"] ?? 0) + 1;
    } else if (Array.isArray(content)) {
      const hasText = content.some((b: any) => b.type === "text");
      const hasToolUse = content.some((b: any) => b.type === "tool_use");
      const hasToolResult = content.some((b: any) => b.type === "tool_result");
      const hasThinking = content.some((b: any) => b.type === "thinking");
      if (hasToolResult) skipped["tool_result"] = (skipped["tool_result"] ?? 0) + 1;
      else if (hasThinking && !hasText) skipped["thinking_only"] = (skipped["thinking_only"] ?? 0) + 1;
      else if (hasToolUse && !hasText) {
        // tool_use not in whitelist
        const names = content.filter((b: any) => b.type === "tool_use").map((b: any) => b.name ?? "?");
        for (const n of names) skipped[`tool_use_not_whitelisted:${n}`] = (skipped[`tool_use_not_whitelisted:${n}`] ?? 0) + 1;
      } else {
        skipped["empty_text"] = (skipped["empty_text"] ?? 0) + 1;
      }
    } else {
      skipped["empty_string"] = (skipped["empty_string"] ?? 0) + 1;
    }
    continue;
  }

  extracted.push({
    uuid: parsed.uuid ?? "?",
    role: result.role,
    source: result.source,
    preview: result.text.slice(0, 80).replace(/\n/g, " "),
  });
}

// ---- Output ----

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("  EXTRACTED MESSAGES");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`${"role".padEnd(12)} ${"source".padEnd(12)} ${"uuid".padEnd(10)} preview`);
console.log("-".repeat(90));
for (const e of extracted) {
  console.log(`${e.role.padEnd(12)} ${e.source.padEnd(12)} ${e.uuid.slice(0, 8).padEnd(10)} ${e.preview}`);
}
console.log(`\n  Total extracted: ${extracted.length}`);

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("  SKIPPED (by reason)");
console.log("══════════════════════════════════════════════════════════════════════");
for (const [reason, count] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}
console.log(`\n  Total skipped: ${Object.values(skipped).reduce((a, b) => a + b, 0)}`);

// ---- Secret detection tests ----

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("  SECRET DETECTION TESTS");
console.log("══════════════════════════════════════════════════════════════════════");

const secretTests: Array<{ label: string; jsonl: string; shouldSkip: boolean }> = [
  {
    label: "Qoopia API key  → SKIP",
    shouldSkip: true,
    jsonl: JSON.stringify({
      type: "assistant", uuid: "test-secret-1", sessionId: "test", cwd: "/test",
      message: { role: "assistant", content: [{ type: "text", text: "my key is q_EXAMPLE_PLACEHOLDER_DO_NOT_USE" }] },
    }),
  },
  {
    label: "Anthropic key   → SKIP",
    shouldSkip: true,
    jsonl: JSON.stringify({
      type: "assistant", uuid: "test-secret-2", sessionId: "test", cwd: "/test",
      message: { role: "assistant", content: [{ type: "text", text: "use sk-ant-EXAMPLE_PLACEHOLDER_DO_NOT_USE_____ to authenticate" }] },
    }),
  },
  {
    label: "Bearer token    → SKIP",
    shouldSkip: true,
    jsonl: JSON.stringify({
      type: "assistant", uuid: "test-secret-3", sessionId: "test", cwd: "/test",
      message: { role: "assistant", content: [{ type: "text", text: "Authorization: bearer EXAMPLE_PLACEHOLDER_DO_NOT_USE_____" }] },
    }),
  },
  {
    label: "Commit SHA      → PASS (not a secret)",
    shouldSkip: false,
    jsonl: JSON.stringify({
      type: "assistant", uuid: "test-sha-1", sessionId: "test", cwd: "/test",
      message: { role: "assistant", content: [{ type: "text", text: "коммит 286e4d4dfba047c4bb7294bdeaa51efe68f6908a прошёл CI" }] },
    }),
  },
];

let allPassed = true;
for (const t of secretTests) {
  const result = extractText(t.jsonl);
  const wasSkipped = result === null;
  const pass = wasSkipped === t.shouldSkip;
  if (!pass) allPassed = false;
  const icon = pass ? "✅" : "❌";
  console.log(`  ${icon}  ${t.label.padEnd(26)} → got: ${wasSkipped ? "SKIP" : `PASS ("${result!.text.slice(0, 40)}")`}`);
}

console.log(`\n  Secret tests: ${allPassed ? "ALL PASSED ✅" : "SOME FAILED ❌"}`);
console.log("══════════════════════════════════════════════════════════════════════\n");

process.exit(allPassed ? 0 : 1);
