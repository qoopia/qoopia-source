/** DOCX/PDF text extraction of untrusted uploads, run as its own process (src/services/files.ts
 * spawns it): a parser hang, crash or memory blow-up ends this process, never the server.
 * Reads the file on stdin, writes {text,status} JSON on stdout. No database or secrets here.
 * Standalone binary: src/delivery/entry.ts runs runFileTextWorker() when QOOPIA_FILE_TEXT_WORKER is set. */
import { inflateRawSync } from "node:zlib";
import { assetPath } from "../utils/assets.ts";

export type FileTextStatus = 'extracted'|'partial'|'empty'|'unsupported'|'unavailable'|'failed';
export const EXCERPT_MAX = 200_000; // chars of extracted text stored per file
// mammoth builds the whole DOM (~2-3 KB RSS per element), so a .docx is refused past these
// parsed-XML budgets; a PDF stops between pages. The process memory ceiling backs both.
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
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
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

/** 'partial' means the text stops at a page, time or EXCERPT_MAX limit before the end. */
export async function extractText(kind: 'docx'|'pdf', buf: Buffer): Promise<{text:string|null;status:FileTextStatus}> {
  try {
    if (kind === "docx") {
      const mammoth: any = await import("mammoth").catch(() => null);
      if (!mammoth) return {text:null,status:'unavailable'};
      const r = await (mammoth.default?.extractRawText ?? mammoth.extractRawText)({ file: boundedDocx(buf) });
      const text = r?.value ? String(r.value) : null;
      return {text:text?.slice(0, EXCERPT_MAX) ?? null,status:!text ? 'empty' : text.length > EXCERPT_MAX ? 'partial' : 'extracted'};
    }
    const unpdf: any = await import("unpdf").catch(() => null);
    if (!unpdf) return {text:null,status:'unavailable'};
    if (process.env.QOOPIA_BUNDLE_ASSETS) await unpdf.definePDFJSModule(() => import(assetPath('vendor/pdfjs.mjs')));
    // No font faces or system fonts: only text is read. verbosity 0 keeps pdf.js warnings off stderr.
    // A plain view, not a copy: pdf.js refuses Buffers, and the upload may be 100 MB.
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), { useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    try {
      // Same text as unpdf.extractText({mergePages:true}), one page at a time.
      const pages: string[] = [], last = Math.min(pdf.numPages, PDF_MAX_PAGES), deadline = Date.now() + PDF_BUDGET_MS;
      let read = 0, chars = 0, broken = 0;
      while (read < last && chars <= EXCERPT_MAX && Date.now() < deadline) {
        try {
          const content = await (await pdf.getPage(++read)).getTextContent();
          const page = content.items.filter((item: any) => item.str != null).map((item: any) => item.str + (item.hasEOL ? "\n" : "")).join("");
          pages.push(page);
          chars += page.length;
        } catch { broken++; } // one malformed page must not discard the rest of the document
      }
      if (broken && broken === read) return {text:null,status:'failed'};
      const text = pages.join("\n").replace(/\s+/g, " ");
      return {text:text.slice(0, EXCERPT_MAX),status:broken || read < pdf.numPages || text.length > EXCERPT_MAX ? 'partial' : text ? 'extracted' : 'empty'};
    } finally {
      await pdf.destroy();
    }
  } catch {
    return {text:null,status:'failed'};
  }
}

export async function runFileTextWorker() {
  const kind = process.env.QOOPIA_FILE_TEXT_WORKER === "pdf" ? "pdf" : "docx";
  const result = await extractText(kind, Buffer.from(await Bun.stdin.arrayBuffer()));
  // process.stdout, not Bun.write(Bun.stdout): in the compiled binary the latter stalls on a pipe past 128 KB.
  await new Promise(resolve => process.stdout.write(JSON.stringify(result), resolve));
  process.exit(0);
}

if (import.meta.main) await runFileTextWorker();
