import { assetPath } from "../utils/assets.ts";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { db } from "../db/connection.ts";
import { QoopiaError, nowIso } from "../utils/errors.ts";
import { logActivity } from "./activity.ts";

// Owner-uploaded files (via dashboard) that any fleet agent can read (via MCP).
// Bytes live inline as a BLOB in the `files` table (migration 024).

const EXCERPT_MAX = 200_000; // chars of extracted text stored per file
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

// ponytail: extraction runs in-process. mammoth builds the whole DOM (~2-3 KB RSS
// per element), so a .docx is refused past these parsed-XML budgets and a PDF stops
// between pages; a child process with its own memory limit is the upgrade path.
const DOCX_XML_BYTES = 8 * 1024 * 1024;
const DOCX_XML_TAGS = 200_000;
const PDF_MAX_PAGES = 2_000;
const PDF_BUDGET_MS = 20_000;

/** mammoth's `file` input over the raw zip: only the parts mammoth reads are
 * inflated, and inflate stops (throws) once their total passes the budget. */
function boundedDocx(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (eocd < 0) throw new Error("not a zip archive");
  const parts = new Map<string, { method: number; start: number; size: number }>();
  for (let i = 0, p = buf.readUInt32LE(eocd + 16); i < buf.readUInt16LE(eocd + 10); i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const nameEnd = p + 46 + buf.readUInt16LE(p + 28), local = buf.readUInt32LE(p + 42);
    parts.set(buf.toString("utf8", p + 46, nameEnd), { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20),
      start: local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28) });
    p = nameEnd + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  let bytes = 0, tags = 0;
  return {
    exists: (name: string) => parts.has(name),
    async read(name: string, encoding?: string) {
      const part = parts.get(name);
      if (!part || (part.method !== 0 && part.method !== 8)) throw new Error("unreadable docx part");
      const raw = buf.subarray(part.start, part.start + part.size);
      const out = part.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: DOCX_XML_BYTES - bytes + 1 });
      if ((bytes += out.length) > DOCX_XML_BYTES) throw new Error("docx exceeds the extraction budget");
      for (let i = out.indexOf(0x3c); i >= 0 && tags <= DOCX_XML_TAGS; i = out.indexOf(0x3c, i + 1)) tags++;
      if (tags > DOCX_XML_TAGS) throw new Error("docx exceeds the extraction budget");
      return encoding ? out.toString(encoding as BufferEncoding) : new Uint8Array(out);
    },
  };
}

// Best-effort text extraction. Never throws — returns null on any failure so the
// upload always succeeds (the file is still stored + downloadable). 'partial'
// means a PDF stopped at its page, time or EXCERPT_MAX limit before the end.
export async function parseFileText(mime: string, filename: string, buf: Buffer): Promise<{text:string|null;status:'extracted'|'partial'|'empty'|'unsupported'|'unavailable'|'failed'}> {
  try {
    if (isTextual(mime, filename)) return {text:buf.toString('utf8'),status:'extracted'};
    const ext = extOf(filename);
    const m = (mime || "").toLowerCase();
    if (ext === "docx" || m.includes("officedocument.wordprocessingml")) {
      const mammoth: any = await import("mammoth").catch(() => null);
      if (!mammoth) return {text:null,status:'unavailable'};
      const r = await (mammoth.default?.extractRawText ?? mammoth.extractRawText)({ file: boundedDocx(buf) });
      return {text:r?.value?String(r.value):null,status:r?.value?'extracted':'empty'};
    }
    if (ext === "pdf" || m === "application/pdf") {
      const unpdf: any = await import("unpdf").catch(() => null);
      if (!unpdf) return {text:null,status:'unavailable'};
      if (process.env.QOOPIA_BUNDLE_ASSETS) await unpdf.definePDFJSModule(() => import(assetPath('vendor/pdfjs.mjs')));
      const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf));
      try {
        // Same text as unpdf.extractText({mergePages:true}), one page at a time.
        const pages: string[] = [], last = Math.min(pdf.numPages, PDF_MAX_PAGES), deadline = Date.now() + PDF_BUDGET_MS;
        let read = 0, chars = 0;
        while (read < last && chars <= EXCERPT_MAX && Date.now() < deadline) {
          const content = await (await pdf.getPage(++read)).getTextContent();
          const page = content.items.filter((item: any) => item.str != null).map((item: any) => item.str + (item.hasEOL ? "\n" : "")).join("");
          pages.push(page);
          chars += page.length;
        }
        const text = pages.join("\n").replace(/\s+/g, " ");
        return {text,status:read < pdf.numPages ? 'partial' : text ? 'extracted' : 'empty'};
      } finally {
        await pdf.destroy();
      }
    }
  } catch {
    return {text:null,status:'failed'};
  }
  return {text:null,status:'unsupported'};
}

function rowMeta(r: any) {
  return {
    id: r.id,
    folder: r.folder,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    created_at: r.created_at,
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

export async function fileUpload(p: {
  workspace_id: string;
  owner_agent_id: string;
  uploaded_by_agent_id: string;
  folder?: string;
  filename: string;
  mime?: string;
  bytes: Buffer;
}) {
  const { folder, filename } = validateFileUpload(p);
  const buf = p.bytes;
  const size = buf.length;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const mime = p.mime || "application/octet-stream";
  const extracted = await parseFileText(mime, filename, buf);
  const text_excerpt = extracted.text ? extracted.text.slice(0, EXCERPT_MAX) : null;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO files (id, workspace_id, owner_agent_id, folder, filename, mime, size, sha256, content, text_excerpt, uploaded_by_agent_id, created_at, extraction_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, folder, filename) DO UPDATE SET
       mime = excluded.mime, size = excluded.size, sha256 = excluded.sha256,
       content = excluded.content, text_excerpt = excluded.text_excerpt, extraction_status=excluded.extraction_status,
       uploaded_by_agent_id = excluded.uploaded_by_agent_id, created_at = excluded.created_at`,
  ).run(ulid(), p.workspace_id, p.owner_agent_id, folder, filename, mime, size, sha256, buf, text_excerpt, p.uploaded_by_agent_id, ts, extracted.status);
  const row = db.prepare(`SELECT * FROM files WHERE workspace_id = ? AND folder = ? AND filename = ?`).get(p.workspace_id, folder, filename) as any;
  logActivity({ workspace_id: p.workspace_id, agent_id: p.uploaded_by_agent_id, action: "file_upload", entity_type: "file", entity_id: row.id, project_id: null, summary: `Uploaded ${filename} to ${folder}`, details: { folder, filename, mime, size } });
  return rowMeta(row);
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
  const where = ["workspace_id = ?"];
  const params: any[] = [p.workspace_id];
  if (p.folder) { where.push("folder = ?"); params.push(p.folder); }
  const rows = db.prepare(
    `SELECT id, folder, filename, mime, size, created_at, text_excerpt, extraction_status FROM files WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit) as any[];
  return { files: rows.map(rowMeta) };
}

export function fileGetForDownload(p: { workspace_id: string; id: string }): { filename: string; mime: string; size: number; content: Buffer } | null {
  const row = db.prepare(`SELECT filename, mime, size, content FROM files WHERE workspace_id = ? AND id = ?`).get(p.workspace_id, p.id) as any;
  if (!row) return null;
  return { filename: row.filename, mime: row.mime, size: row.size, content: Buffer.from(row.content) };
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
    `SELECT f.id, f.folder, f.filename, f.mime, f.size, f.created_at, f.text_excerpt IS NOT NULL AS text_excerpt, f.extraction_status
     FROM files f JOIN agents o ON o.id = f.owner_agent_id
     WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC LIMIT ?`,
  ).all(...params, limit) as any[];
  return { files: rows.map(rowMeta), count: rows.length };
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
