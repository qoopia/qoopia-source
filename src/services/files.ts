import { assetPath } from "../utils/assets.ts";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
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

// Best-effort text extraction. Never throws — returns null on any failure so the
// upload always succeeds (the file is still stored + downloadable).
export async function parseFileText(mime: string, filename: string, buf: Buffer): Promise<{text:string|null;status:'extracted'|'empty'|'unsupported'|'unavailable'|'failed'}> {
  try {
    if (isTextual(mime, filename)) return {text:buf.toString('utf8'),status:'extracted'};
    const ext = extOf(filename);
    const m = (mime || "").toLowerCase();
    if (ext === "docx" || m.includes("officedocument.wordprocessingml")) {
      const mammoth: any = await import("mammoth").catch(() => null);
      if (!mammoth) return {text:null,status:'unavailable'};
      const r = await (mammoth.default?.extractRawText ?? mammoth.extractRawText)({ buffer: buf });
      return {text:r?.value?String(r.value):null,status:r?.value?'extracted':'empty'};
    }
    if (ext === "pdf" || m === "application/pdf") {
      const unpdf: any = await import("unpdf").catch(() => null);
      if (!unpdf) return {text:null,status:'unavailable'};
      if (process.env.QOOPIA_BUNDLE_ASSETS) await unpdf.definePDFJSModule(() => import(assetPath('vendor/pdfjs.mjs')));
      const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf));
      const out = await unpdf.extractText(pdf, { mergePages: true });
      if (typeof out?.text === "string") return {text:out.text,status:out.text?'extracted':'empty'};
      if (Array.isArray(out?.text)) return {text:out.text.join('\n'),status:out.text.length?'extracted':'empty'};
      return {text:null,status:'empty'};
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

export async function fileUpload(p: {
  workspace_id: string;
  owner_agent_id: string;
  uploaded_by_agent_id: string;
  folder?: string;
  filename: string;
  mime?: string;
  bytes: Buffer;
}) {
  const folder = (p.folder || "inbox").trim() || "inbox";
  const filename = String(p.filename || "").trim().replace(/[\/\\]/g, "_");
  if (!filename) throw new QoopiaError("INVALID_INPUT", "filename is required");
  if (folder.length > 200) throw new QoopiaError("INVALID_INPUT", "folder name too long");
  const buf = p.bytes;
  if (!buf || buf.length === 0) throw new QoopiaError("INVALID_INPUT", "empty file");
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
  const rows = db.prepare(
    `SELECT f.id, f.folder, f.filename, f.mime, f.size, f.created_at, f.text_excerpt, f.extraction_status
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
  let text: string | null = row.text_excerpt;
  if (!text && isTextual(row.mime, row.filename)) {
    try { text = Buffer.from(row.content).toString("utf8"); } catch { text = null; }
  }
  if (text != null) {
    const truncated = text.length > GET_MAX;
    return { ...base, content: truncated ? text.slice(0, GET_MAX) : text, truncated };
  }
  return { ...base, content: null, note: "binary file — not text-extractable; download via dashboard", download_path: `/api/dashboard/files/${row.id}/download` };
}
