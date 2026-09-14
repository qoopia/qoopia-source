/**
 * Пересчитать `manifest.sha256.json` для готового каталога evidence.
 *
 * Нужен потому, что `test.log` / `typecheck.log` / `lint.log` появляются в
 * bundle уже после генератора: их пишет тот же прогон валидации, который
 * должен видеть финальное дерево. Манифест обязан покрывать и их.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const index = process.argv.indexOf("--dir");
if (index < 0 || !process.argv[index + 1]) throw new Error("--dir <evidence dir> is required");
const dir = path.resolve(process.argv[index + 1]!);

const files: Record<string, { sha256: string; bytes: number }> = {};
function walk(current: string, prefix = ""): void {
  for (const entry of fs
    .readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, relative);
      continue;
    }
    if (relative === "manifest.sha256.json") continue;
    const content = fs.readFileSync(absolute);
    files[relative] = {
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
    };
  }
}
walk(dir);
fs.writeFileSync(
  path.join(dir, "manifest.sha256.json"),
  `${JSON.stringify({ algorithm: "sha256", files }, null, 2)}\n`,
);
process.stdout.write(`manifest rewritten for ${Object.keys(files).length} files\n`);
