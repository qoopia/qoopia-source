/**
 * Dashboard files feature — service layer (migration 024 + services/files.ts).
 * Covers: text upload + inline read, binary upload + download_path, folders,
 * list, delete, and re-upload overwrite (UNIQUE workspace+folder+filename).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { fileUpload, fileGet, fileList, fileListByFolder, fileListFolders, fileGetForDownload, fileDelete, parseFileText } from "../src/services/files.ts";
import JSZip from "jszip";

let WS = "";
let OWNER = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "files-test" });
  WS = ws.id;
  OWNER = createAgent({ name: "owner-t", workspaceSlug: ws.slug }).id;
});

async function up(folder: string, filename: string, mime: string, body: Buffer) {
  return fileUpload({ workspace_id: WS, owner_agent_id: OWNER, uploaded_by_agent_id: OWNER, folder, filename, mime, bytes: body });
}

async function docx(documentXml: string, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentXml}</w:body></w:document>`);
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression }));
}

// One shared content stream drawn by every page: page count amplifies extraction work.
function pdf(pages: number, line: string, lines = 1): Buffer {
  const content = Array.from({ length: lines }, (_, i) => `BT /F1 8 Tf 5 ${130 - i * 12} Td (${line}) Tj ET`).join(" ");
  const kids = Array.from({ length: pages }, (_, i) => `${i + 5} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>")];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => { const at = out.length; out += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("files service", () => {
  test("DOCX extraction preserves normal text", async () => {
    const result = await parseFileText("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "normal.docx", await docx("<w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p>"));
    expect(result).toEqual({ text: "Hello DOCX\n\n", status: "extracted" });
  });

  test("DOCX extraction converts legacy Wingdings symbols to Unicode", async () => {
    const result = await parseFileText("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "symbol.docx", await docx('<w:p><w:r><w:sym w:font="Wingdings" w:char="F028"/></w:r></w:p>'));
    expect(result).toEqual({ text: "🕿\n\n", status: "extracted" });
  });

  test("DOCX zip bombs fail fast instead of being parsed", async () => {
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    // ~1.5 MB of empty paragraphs (a few KB zipped): mammoth would hold ~1 GB of DOM.
    const nodes = await docx("<w:p/>".repeat(250_000), "DEFLATE");
    // 24 MB of text in one run (~24 KB zipped).
    const bytes = await docx(`<w:p><w:r><w:t>${"a".repeat(24_000_000)}</w:t></w:r></w:p>`, "DEFLATE");
    expect(nodes.length + bytes.length).toBeLessThan(100_000);
    expect(await parseFileText(mime, "nodes.docx", nodes)).toEqual({ text: null, status: "failed" });
    expect(await parseFileText(mime, "bytes.docx", bytes)).toEqual({ text: null, status: "failed" });
  });

  test("PDF extraction reads page by page and stops at the stored excerpt size", async () => {
    expect(await parseFileText("application/pdf", "one.pdf", pdf(1, "Qoopia fixture PDF"))).toEqual({ text: "Qoopia fixture PDF", status: "extracted" });
    const result = await parseFileText("application/pdf", "many.pdf", pdf(2_000, "x".repeat(40), 10));
    expect(result.status).toBe("partial");
    expect(result.text!.length).toBeGreaterThan(190_000);
    expect(result.text!.length).toBeLessThan(205_000);
    const meta = await up("big", "many.pdf", "application/pdf", pdf(2_000, "x".repeat(40), 10));
    expect((fileGet({ workspace_id: WS, id: meta.id }) as any).truncated).toBe(true);
  });

  test("T-11 corrupted PDF reports extraction failure and preserves original bytes", async () => {
    const bytes=Buffer.from('%PDF-1.7\nsynthetic corrupt body');
    const meta=await up('broken','corrupt.pdf','application/pdf',bytes);
    expect(meta.extraction_status).toBe('failed');
    expect(fileGetForDownload({workspace_id:WS,id:meta.id})!.content).toEqual(bytes);
  });
  test("text upload is readable inline via file_get", async () => {
    await up("inbox", "plan.md", "text/markdown", Buffer.from("# Plan\nhello world"));
    const g: any = fileGet({ workspace_id: WS, folder: "inbox", filename: "plan.md" });
    expect(g.content).toContain("hello world");
    expect(g.mime).toBe("text/markdown");
  });

  test("octet-stream .txt detected as text by extension", async () => {
    await up("inbox", "note.txt", "application/octet-stream", Buffer.from("just text"));
    const g: any = fileGet({ workspace_id: WS, folder: "inbox", filename: "note.txt" });
    expect(g.content).toBe("just text");
  });

  test("binary file → no inline content, has download_path", async () => {
    await up("inbox", "pic.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const g: any = fileGet({ workspace_id: WS, folder: "inbox", filename: "pic.png" });
    expect(g.content).toBeNull();
    expect(g.download_path).toContain("/api/dashboard/files/");
  });

  test("file_get reports truncated whenever the returned text is cut", async () => {
    const mid: any = await up("big", "mid.txt", "text/plain", Buffer.from("m".repeat(300_000)));
    const g1: any = fileGet({ workspace_id: WS, id: mid.id });
    expect([g1.content.length, g1.truncated]).toEqual([300_000, false]);
    const large: any = await up("big", "large.txt", "text/plain", Buffer.from("l".repeat(500_000)));
    const g2: any = fileGet({ workspace_id: WS, id: large.id });
    expect([g2.content.length, g2.truncated]).toEqual([400_000, true]);
    const long: any = await up("big", "long.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      await docx(`<w:p><w:r><w:t>${"d".repeat(210_000)}</w:t></w:r></w:p>`));
    const g3: any = fileGet({ workspace_id: WS, id: long.id });
    expect([g3.content.length, g3.truncated]).toEqual([200_000, true]);
  });

  test("fileGet by id works", async () => {
    const m: any = await up("docs", "a.txt", "text/plain", Buffer.from("byid"));
    const g: any = fileGet({ workspace_id: WS, id: m.id });
    expect(g.content).toBe("byid");
  });

  test("folders list reflects uploads", () => {
    const f: any = fileListFolders({ workspace_id: WS });
    const names = f.folders.map((x: any) => x.folder);
    expect(names).toContain("inbox");
    expect(names).toContain("docs");
  });

  test("list by folder + MCP fileList", () => {
    const byFolder: any = fileListByFolder({ workspace_id: WS, folder: "inbox" });
    expect(byFolder.files.length).toBeGreaterThanOrEqual(3);
    const mcp: any = fileList({ workspace_id: WS, folder: "inbox" });
    expect(mcp.count).toBeGreaterThanOrEqual(3);
    expect(mcp.files[0]).toHaveProperty("filename");
  });

  test("download returns bytes", async () => {
    const m: any = await up("dl", "blob.bin", "application/octet-stream", Buffer.from("rawbytes"));
    const d = fileGetForDownload({ workspace_id: WS, id: m.id });
    expect(d).not.toBeNull();
    expect(d!.content.toString()).toBe("rawbytes");
  });

  test("re-upload same folder+filename overwrites (no duplicate)", async () => {
    await up("inbox", "plan.md", "text/markdown", Buffer.from("v2 content"));
    const list: any = fileListByFolder({ workspace_id: WS, folder: "inbox" });
    const plans = list.files.filter((f: any) => f.filename === "plan.md");
    expect(plans.length).toBe(1);
    const g: any = fileGet({ workspace_id: WS, folder: "inbox", filename: "plan.md" });
    expect(g.content).toBe("v2 content");
  });

  test("delete removes the file", async () => {
    const m: any = await up("tmp", "gone.txt", "text/plain", Buffer.from("x"));
    fileDelete({ workspace_id: WS, id: m.id, agent_id: OWNER });
    expect(() => fileGet({ workspace_id: WS, id: m.id })).toThrow();
  });

  test("workspace isolation: other workspace cannot read", async () => {
    const m: any = await up("inbox", "secret.txt", "text/plain", Buffer.from("mine"));
    const other = createWorkspace({ name: "files-other" });
    const list: any = fileListByFolder({ workspace_id: other.id, folder: "inbox" });
    expect(list.files.length).toBe(0);
    expect(() => fileGet({ workspace_id: other.id, id: m.id })).toThrow();
  });
});
