// Fake extraction worker for tests/file-text-worker.test.ts: the input bytes pick how the
// "parser" misbehaves; anything else is echoed back as extracted text.
const input = Buffer.from(await Bun.stdin.arrayBuffer()).toString("utf8");
const reply = (value: unknown) => Bun.write(Bun.stdout, typeof value === "string" ? value : JSON.stringify(value));
if (input === "hang") while (true);
if (input === "crash") process.exit(3);
if (input === "garbage") await reply("not json");
else if (input === "flood") await reply("x".repeat(8 * 1024 * 1024));
else if (input === "alloc") { const held: Float64Array[] = []; while (true) held.push(new Float64Array(1e5).fill(held.length)); }
else if (input === "env") await reply({ text: Object.keys(process.env).sort().join(","), status: "extracted" });
else {
  if (input.startsWith("slow:")) await Bun.sleep(400);
  await reply({ text: input, status: "extracted" });
}
process.exit(0);
