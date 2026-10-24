/**
 * A read-only file mirror of a workspace's memory for a person to read [5.0.23]: one Markdown file per note in
 * force, grouped by agent and type, plus index.md. It is a copy, not a second source: edits to the files change
 * nothing in Qoopia, and a rerun into a new directory reflects the current memory. Secrets were already kept
 * out of notes by the write path; the files are created 0400 inside a 0700 directory.
 *
 *   bun scripts/memory-mirror.ts --workspace SLUG_OR_ID --out /absolute/new/directory
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db/connection.ts";

const args = process.argv.slice(2), value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const workspaceArg = value("--workspace"), out = value("--out");
if (!workspaceArg || !out || !path.isAbsolute(out)) throw new Error("Usage: --workspace SLUG_OR_ID --out /absolute/new/directory");
if (fs.existsSync(out)) throw new Error("The output directory must not exist yet: a mirror is written whole, never over another");
const ws = db.query("SELECT id, name, slug FROM workspaces WHERE id = ? OR slug = ?").get(workspaceArg, workspaceArg) as { id: string; name: string; slug: string } | null;
if (!ws) throw new Error("Workspace not found");

type Row = { id: string; agent: string | null; type: string; text: string; tags: string; visibility: string; source: string; subject_key: string | null; created_at: string; updated_at: string };
const rows = db.query(`SELECT n.id, a.name AS agent, n.type, n.text, n.tags, n.visibility, n.source, n.subject_key, n.created_at, n.updated_at
  FROM notes n LEFT JOIN agents a ON a.id = n.agent_id
  WHERE n.workspace_id = ? AND n.deleted_at IS NULL AND n.invalidated_at_ms IS NULL ORDER BY a.name, n.type, n.created_at, n.id`).all(ws.id) as Row[];
const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const index: string[] = [`# Qoopia memory — ${ws.name}`, "", `Read-only copy written ${new Date().toISOString()}; ${rows.length} notes in force. Editing these files changes nothing in Qoopia.`, ""];
let current = "";
for (const row of rows) {
  const dir = path.join(out, slug(row.agent ?? "unknown-agent"), slug(row.type));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${row.created_at.slice(0, 10)}-${row.id}.md`);
  const tags = JSON.parse(row.tags || "[]") as string[];
  const front = [`id: ${row.id}`, `agent: ${row.agent ?? "unknown"}`, `type: ${row.type}`, `visibility: ${row.visibility}`, `source: ${row.source}`,
    ...(row.subject_key ? [`subject_key: ${row.subject_key}`] : []), ...(tags.length ? [`tags: ${tags.join(", ")}`] : []), `created_at: ${row.created_at}`, `updated_at: ${row.updated_at}`];
  fs.writeFileSync(file, `---\n${front.join("\n")}\n---\n\n${row.text}\n`, { mode: 0o400, flag: "wx" });
  const group = `${row.agent ?? "unknown agent"} / ${row.type}`;
  if (group !== current) { index.push(`## ${group}`, ""); current = group; }
  index.push(`- [${(row.text.split("\n").find((l) => l.trim()) ?? row.id).trim().slice(0, 100).replace(/[[\]]/g, "")}](${path.relative(out, file)})`);
}
fs.writeFileSync(path.join(out, "index.md"), index.join("\n") + "\n", { mode: 0o400, flag: "wx" });
console.log(JSON.stringify({ workspace: ws.slug, notes: rows.length, out }));
