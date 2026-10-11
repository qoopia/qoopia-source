import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";
import { logActivity } from "./activity.ts";
import { hash } from "../utils/fs.ts";
import { EXCERPT_MAX, type FileTextStatus } from "./file-text-worker.ts";

// Owner-uploaded files (via dashboard) that any fleet agent can read (via MCP).
// Bytes live inline as a BLOB in the `files` table (migration 024).

const GET_MAX = 400_000; // chars returned inline by file_get

const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonl", "log", "yaml", "yml",
  "xml", "html", "htm", "css", "js", "ts", "tsx", "jsx", "py", "sh", "bash", "sql",
  "ini", "toml", "conf", "cfg", "env",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isTextual(mime: string, filename: string): boolean {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/javascript", "application/x-ndjson", "application/x-yaml"].includes(m)) return true;
  return TEXT_EXT.has(extOf(filename));
}

type Extracted = { text: string | null; status: FileTextStatus; reason?: "timeout" | "memory" | "output" | "crashed" };
const STATUSES = new Set<FileTextStatus>(["extracted", "partial", "empty", "unsupported", "unavailable", "failed"]);

/** Resident memory of a child in bytes; 0 when it cannot be read (gone, or no ps). */
async function residentBytes(pid: number) {
  try {
    if (process.platform === "linux") return Number(/VmRSS:\s+(\d+)/.exec(await fs.promises.readFile(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) * 1024;
    const ps = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return (Number((await new Response(ps.stdout).text()).trim()) || 0) * 1024;
  } catch { return 0; }
}

/** Bounded pool of extraction processes (src/services/file-text-worker.ts), one fresh process per
 * file. Bun Workers ignore resourceLimits and share the server's heap, so a parser that runs away
 * would stall or OOM the server; a process is killed at timeoutMs or memoryBytes RSS and the OS
 * reclaims everything. At most `concurrency` run and `queue` wait; past that a RATE_LIMITED
 * error asks the caller to retry. A killed or broken run is status 'failed' with its reason.
 * ponytail: RSS is sampled every 200 ms, so a burst inside one sample can overshoot the ceiling. */
export function fileTextWorkers(command: (kind: "docx" | "pdf") => string[],
  limits = { timeoutMs: 30_000, memoryBytes: 1024 ** 3, outputBytes: 4 * 1024 * 1024, concurrency: 2, queue: 4 }) {
  let running = 0;
  const waiting: (() => void)[] = [];
  async function once(kind: "docx" | "pdf", buf: Buffer): Promise<Extracted> {
    // Only what the parser needs: no server secrets, and no .env or bunfig picked up from the cwd.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", QOOPIA_FILE_TEXT_WORKER: kind };
    if (process.env.QOOPIA_BUNDLE_ASSETS) env.QOOPIA_BUNDLE_ASSETS = process.env.QOOPIA_BUNDLE_ASSETS;
    let child: Bun.Subprocess<Buffer, "pipe", "ignore">;
    // No process (fork limit, binary gone): the parser is unavailable, the upload still stores the file.
    try { child = Bun.spawn(command(kind), { cwd: os.tmpdir(), env, stdin: buf, stdout: "pipe", stderr: "ignore" }); }
    catch { return { text: null, status: "unavailable" }; }
    let reason: Extracted["reason"];
    const stop = (why: NonNullable<Extracted["reason"]>) => { reason ??= why; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    const watch = setInterval(() => void residentBytes(child.pid).then(rss => { if (rss > limits.memoryBytes) stop("memory"); }), 200);
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of child.stdout) {
        if ((size += chunk.length) > limits.outputBytes) { stop("output"); break; }
        chunks.push(chunk);
      }
      const code = await child.exited;
      if (reason) return { text: null, status: "failed", reason };
      const out = code === 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      if (!STATUSES.has(out?.status) || (out.text !== null && typeof out.text !== "string")) return { text: null, status: "failed", reason: "crashed" };
      return { text: out.text === null ? null : out.text.slice(0, EXCERPT_MAX), status: out.status };
    } catch {
      child.kill("SIGKILL");
      return { text: null, status: "failed", reason: reason ?? "crashed" };
    } finally { clearTimeout(timer); clearInterval(watch); }
  }
  return async function extract(kind: "docx" | "pdf", buf: Buffer): Promise<Extracted> {
    if (running < limits.concurrency) running++;
    else if (waiting.length >= limits.queue) throw new QoopiaError("RATE_LIMITED", "File text extraction is busy; retry the upload in a moment", { retryable: true });
    else await new Promise<void>(resolve => waiting.push(resolve)); // the finishing run hands over its slot
    try { return await once(kind, buf); }
    finally { const next = waiting.shift(); if (next) next(); else running--; }
  };
}

// The standalone binary runs the worker as itself: src/delivery/entry.ts dispatches on QOOPIA_FILE_TEXT_WORKER.
const extractInWorker = fileTextWorkers(() => import.meta.url.startsWith("file:///$bunfs/") ? [process.execPath]
  : [process.execPath, "--no-env-file", fileURLToPath(new URL("./file-text-worker.ts", import.meta.url))]);

// Best-effort text extraction: any parser failure is a status, so the upload still succeeds
// (the file is stored + downloadable). Throws only RATE_LIMITED when every worker slot is taken.
export async function parseFileText(mime: string, filename: string, buf: Buffer): Promise<Extracted> {
  if (isTextual(mime, filename)) return { text: buf.toString("utf8"), status: "extracted" };
  const ext = extOf(filename), m = (mime || "").toLowerCase();
  if (ext === "docx" || m.includes("officedocument.wordprocessingml")) return extractInWorker("docx", buf);
  if (ext === "pdf" || m === "application/pdf") return extractInWorker("pdf", buf);
  return { text: null, status: "unsupported" };
}

function rowMeta(r: any) {
  return {
    id: r.id,
    folder: r.folder,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    created_at: r.created_at,
    uploaded_by: r.uploaded_by ?? null,
    extraction_status:r.extraction_status??'unknown',
    readable: !!r.text_excerpt || isTextual(r.mime, r.filename),
  };
}

// ---- write path (dashboard, owner-only — caller enforces auth) ----

const UNSAFE_NAME = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u; // controls (NUL...) and bidi overrides

/** Normalised folder + filename of one upload, or INVALID_INPUT with a reason the
 * dashboard translates. Folders keep '/' (task outputs live in tasks/<id>); in
 * filenames '/' and '\' become '_'. */
export function validateFileUpload(p: { folder?: string; filename: string; bytes: Buffer }) {
  const folder = (p.folder || "inbox").trim() || "inbox";
  const filename = String(p.filename || "").trim().replace(/[/\\]/g, "_");
  if (folder.length > 200 || UNSAFE_NAME.test(folder) || folder.includes("\\") || folder.split("/").some(s => s === "" || s === "." || s === ".."))
    throw new QoopiaError("INVALID_INPUT", "invalid folder name", { reason: "invalid_folder" });
  if (!filename || filename.length > 180 || filename === "." || filename === ".." || UNSAFE_NAME.test(filename))
    throw new QoopiaError("INVALID_INPUT", `invalid file name: ${filename}`, { reason: "invalid_filename", file: filename });
  if (!p.bytes || p.bytes.length === 0) throw new QoopiaError("INVALID_INPUT", `empty file: ${filename}`, { reason: "empty_file", file: filename });
  return { folder, filename };
}

type UploadInput = {
  workspace_id: string;
  owner_agent_id: string;
  uploaded_by_agent_id: string;
  folder?: string;
  filename: string;
  mime?: string;
  bytes: Buffer;
  /** An agent replaces only what it wrote itself; the owner's dashboard upload replaces anything. */
  replace_own_only?: boolean;
  /** An append must still see the exact file it read before asynchronous extraction. */
  append_snapshot?: { id: string; sha256: string } | null;
};

export async function fileUpload(p: UploadInput) {
  return writeFile(p, await parseFileText(p.mime || "application/octet-stream", validateFileUpload(p).filename, p.bytes));
}

/** Every file is parsed before the first write, and all are written in one transaction:
 * a failure on any of them (a busy parser, a conflict) stores none. */
export async function fileUploadBatch(inputs: UploadInput[]) {
  const parsed: Extracted[] = [];
  for (const p of inputs) parsed.push(await parseFileText(p.mime || "application/octet-stream", validateFileUpload(p).filename, p.bytes));
  return db.transaction(() => inputs.map((p, i) => writeFile(p, parsed[i]!)))();
}

function writeFile(p: UploadInput, extracted: Extracted) {
  const { folder, filename } = validateFileUpload(p);
  const buf = p.bytes;
  const size = buf.length;
  const sha256 = hash(buf);
  const mime = p.mime || "application/octet-stream";
  const text_excerpt = extracted.text ? extracted.text.slice(0, EXCERPT_MAX) : null;
  const ts = nowIso();
  return db.transaction(() => {
    if (p.append_snapshot !== undefined) {
      const current = db.prepare(`SELECT id, sha256 FROM files WHERE workspace_id = ? AND folder = ? AND filename = ?`)
        .get(p.workspace_id, folder, filename) as { id: string; sha256: string } | null;
      if (current?.id !== p.append_snapshot?.id || current?.sha256 !== p.append_snapshot?.sha256) {
        throw new QoopiaError("CONFLICT", "The file changed while appending; retry this part against the current file");
      }
    }
    const written = db.prepare(
      `INSERT INTO files (id, workspace_id, owner_agent_id, folder, filename, mime, size, sha256, content, text_excerpt, uploaded_by_agent_id, created_at, extraction_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, folder, filename) DO UPDATE SET
         mime = excluded.mime, size = excluded.size, sha256 = excluded.sha256,
         content = excluded.content, text_excerpt = excluded.text_excerpt, extraction_status=excluded.extraction_status,
         uploaded_by_agent_id = excluded.uploaded_by_agent_id, created_at = excluded.created_at
       WHERE ? = 0 OR files.uploaded_by_agent_id = excluded.uploaded_by_agent_id`,
    ).run(ulid(), p.workspace_id, p.owner_agent_id, folder, filename, mime, size, sha256, buf, text_excerpt, p.uploaded_by_agent_id, ts, extracted.status, p.replace_own_only ? 1 : 0);
    // Checked by the write itself, so a file another author saves meanwhile is never replaced.
    if (!written.changes) throw new QoopiaError("CONFLICT", `${folder}/${filename} was written by someone else; choose another name or folder`);
    const row = db.prepare(`SELECT * FROM files WHERE workspace_id = ? AND folder = ? AND filename = ?`).get(p.workspace_id, folder, filename) as any;
    logActivity({ workspace_id: p.workspace_id, agent_id: p.uploaded_by_agent_id, action: "file_upload", entity_type: "file", entity_id: row.id, project_id: null, summary: `Uploaded ${filename} to ${folder}`, details: { folder, filename, mime, size } });
    return rowMeta(row);
  })();
}

export function fileDelete(p: { workspace_id: string; id: string; agent_id: string }) {
  const row = db.prepare(`SELECT id, folder, filename FROM files WHERE workspace_id = ? AND id = ?`).get(p.workspace_id, p.id) as any;
  if (!row) throw new QoopiaError("NOT_FOUND", "file not found");
  db.prepare(`DELETE FROM files WHERE workspace_id = ? AND id = ?`).run(p.workspace_id, p.id);
  logActivity({ workspace_id: p.workspace_id, agent_id: p.agent_id, action: "file_delete", entity_type: "file", entity_id: p.id, project_id: null, summary: `Deleted ${row.filename} from ${row.folder}`, details: { folder: row.folder, filename: row.filename } });
  return { deleted: true, id: p.id };
}

// ---- dashboard read path ----

export function fileListFolders(p: { workspace_id: string }) {
  const rows = db.prepare(
    `SELECT folder, COUNT(*) AS count, MAX(created_at) AS last_upload FROM files WHERE workspace_id = ? GROUP BY folder ORDER BY folder`,
  ).all(p.workspace_id);
  return { folders: rows };
}

export function fileListByFolder(p: { workspace_id: string; folder?: string; limit?: number }) {
  const limit = Math.min(Math.max(p.limit || 200, 1), 1000);
  const where = ["f.workspace_id = ?"];
  const params: any[] = [p.workspace_id];
  if (p.folder) { where.push("f.folder = ?"); params.push(p.folder); }
  const rows = db.prepare(
    `SELECT f.id, f.folder, f.filename, f.mime, f.size, f.created_at, f.text_excerpt IS NOT NULL AS text_excerpt, f.extraction_status, u.name AS uploaded_by
     FROM files f LEFT JOIN agents u ON u.id = f.uploaded_by_agent_id WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC LIMIT ?`,
  ).all(...params, limit) as any[];
  return { files: rows.map(rowMeta) };
}

export function fileGetForDownload(p: { workspace_id: string; id: string }): { filename: string; mime: string; size: number; content: Buffer } | null {
  const row = db.prepare(`SELECT filename, mime, size, content FROM files WHERE workspace_id = ? AND id = ?`).get(p.workspace_id, p.id) as any;
  if (!row) return null;
  return { filename: row.filename, mime: row.mime, size: row.size, content: Buffer.from(row.content) };
}

// ---- MCP write (any agent with write access) ----

const MAX_FILE_BYTES = 104_857_600; // the dashboard's per-upload limit

/** An agent saves into Files: its own folder by default, any sub-folder it names. It replaces only
 * a file it wrote itself, and deleting stays with the owner.
 * ponytail: one MCP request is at most 1 MB, so a bigger file arrives in parts with `append`;
 * each part re-reads the stored bytes. A streaming upload endpoint if agents send large files often. */
export async function filePut(p: { workspace_id: string; agent_id: string; agent_name: string; folder?: string; filename: string;
  content: string; encoding?: "utf8" | "base64"; mime?: string; append?: boolean }) {
  if (p.encoding === "base64" && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(p.content)) throw new QoopiaError("INVALID_INPUT", "content is not base64");
  const part = Buffer.from(p.content, p.encoding === "base64" ? "base64" : "utf8");
  // A part may be empty; a whole new file may not.
  const { folder, filename } = validateFileUpload({ folder: p.folder?.trim() || p.agent_name, filename: p.filename, bytes: p.append ? Buffer.alloc(1) : part });
  const before = p.append ? db.prepare(`SELECT id, sha256, content FROM files WHERE workspace_id = ? AND folder = ? AND filename = ? AND uploaded_by_agent_id = ?`)
    .get(p.workspace_id, folder, filename, p.agent_id) as { id: string; sha256: string; content: Uint8Array } | null : null;
  const bytes = before ? Buffer.concat([Buffer.from(before.content), part]) : part;
  if (bytes.length > MAX_FILE_BYTES) throw new QoopiaError("SIZE_LIMIT", "A file in Qoopia is at most 100 MB");
  return fileUpload({ workspace_id: p.workspace_id, owner_agent_id: p.agent_id, uploaded_by_agent_id: p.agent_id, folder, filename,
    mime: p.mime || Bun.file(filename).type, bytes, replace_own_only: true,
    append_snapshot: p.append ? before && { id: before.id, sha256: before.sha256 } : undefined });
}

// ---- MCP read tools (any fleet agent) ----

export function fileList(p: { workspace_id: string; folder?: string; owner?: string; limit?: number }) {
  const limit = Math.min(Math.max(p.limit || 200, 1), 500);
  const where = ["f.workspace_id = ?"];
  const params: any[] = [p.workspace_id];
  if (p.folder) { where.push("f.folder = ?"); params.push(p.folder); }
  if (p.owner) { where.push("o.name = ?"); params.push(p.owner); }
  // F-274: rowMeta only needs to know an excerpt exists; do not read up to 200k chars per row.
  const rows = db.prepare(
    `SELECT f.id, f.folder, f.filename, f.mime, f.size, f.created_at, f.text_excerpt IS NOT NULL AS text_excerpt, f.extraction_status, u.name AS uploaded_by
     FROM files f JOIN agents o ON o.id = f.owner_agent_id LEFT JOIN agents u ON u.id = f.uploaded_by_agent_id
     WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC LIMIT ?`,
  ).all(...params, limit) as any[];
  return { files: rows.map(rowMeta), count: rows.length, folders: fileListFolders(p).folders };
}

export function fileGet(p: { workspace_id: string; id?: string; folder?: string; filename?: string }) {
  let row: any;
  if (p.id) {
    row = db.prepare(`SELECT * FROM files WHERE workspace_id = ? AND id = ?`).get(p.workspace_id, p.id);
  } else if (p.folder && p.filename) {
    row = db.prepare(`SELECT * FROM files WHERE workspace_id = ? AND folder = ? AND filename = ?`).get(p.workspace_id, p.folder, p.filename);
  } else {
    throw new QoopiaError("INVALID_INPUT", "provide id, or folder + filename");
  }
  if (!row) throw new QoopiaError("NOT_FOUND", "file not found");
  const base = { extraction_status:row.extraction_status, id: row.id, folder: row.folder, filename: row.filename, mime: row.mime, size: row.size, created_at: row.created_at };
  // Text files are re-read from the original bytes (the stored excerpt stops at
  // EXCERPT_MAX); a UTF-8 window of 3 bytes per UTF-16 unit always covers GET_MAX.
  let text: string | null = null, cut = false;
  if (isTextual(row.mime, row.filename)) {
    const bytes = Buffer.from(row.content);
    text = bytes.subarray(0, 3 * GET_MAX).toString("utf8");
    cut = bytes.length > 3 * GET_MAX;
  } else if (row.text_excerpt) {
    text = row.text_excerpt;
    cut = row.extraction_status === "partial" || row.text_excerpt.length >= EXCERPT_MAX;
  }
  if (text != null) {
    const truncated = cut || text.length > GET_MAX;
    return { ...base, content: truncated ? text.slice(0, GET_MAX) : text, truncated };
  }
  return { ...base, content: null, note: "binary file — not text-extractable; download via dashboard", download_path: `/api/dashboard/files/${row.id}/download` };
}
