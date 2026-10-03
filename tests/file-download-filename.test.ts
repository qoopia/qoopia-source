import { beforeAll, expect, test } from "bun:test";
import { validateHeaderValue, type IncomingMessage, type ServerResponse } from "node:http";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { fileUpload } from "../src/services/files.ts";
import { db } from "../src/db/connection.ts";
import { handleDashboardApi } from "../src/dashboard-api.ts";
import { attachmentDisposition } from "../src/utils/http-json.ts";

let ws = "", owner = { id: "", api_key: "" };
beforeAll(() => {
  runMigrations();
  const w = createWorkspace({ name: "Download filename", slug: "download-filename" });
  ws = w.id;
  owner = createAgent({ name: "download-owner", type: "steward", workspaceSlug: w.slug }) as typeof owner;
});

const names = ["Отчёт.txt", "invoice‮fdp.exe", "emoji 😀.txt", "lone \ud800 surrogate.txt", 'quote "x" \\ back.txt', "plain.txt"];

const RLO = String.fromCharCode(0x202e);

test("non-Latin-1 file names download with a valid Content-Disposition", async () => {
  for (const filename of names) {
    const meta = await fileUpload({ workspace_id: ws, owner_agent_id: owner.id, uploaded_by_agent_id: owner.id, folder: "dl", filename: filename.replace(RLO, ""), mime: "text/plain", bytes: Buffer.from("x") });
    // Upload now refuses bidi overrides (F-175); a row stored before that must still download.
    if (filename.includes(RLO)) { db.prepare("UPDATE files SET filename=? WHERE id=?").run(filename, meta.id); meta.filename = filename; }
    let status = 0;
    const headers: Record<string, string> = {};
    const req = { url: `/api/dashboard/files/${meta.id}/download`, method: "GET", headers: { authorization: "Bearer " + owner.api_key } } as unknown as IncomingMessage;
    const res = { writeHead(code: number, h: Record<string, string>) { status = code; Object.assign(headers, h); }, end() {} } as unknown as ServerResponse;
    expect(handleDashboardApi(req, res)).toBe(true);
    expect(status).toBe(200);
    for (const [name, value] of Object.entries(headers)) expect(() => validateHeaderValue(name, value)).not.toThrow();
    const decoded = decodeURIComponent(headers["content-disposition"]!.split("filename*=UTF-8''")[1]!);
    if (filename.isWellFormed()) expect(decoded).toBe(meta.filename);
  }
});

test("the ASCII fallback never breaks out of the quoted parameter", () => {
  expect(attachmentDisposition('a"b\\c\r\nd')).toStartWith('attachment; filename="a_b_c__d";');
});

test("an uploaded active type downloads as inert bytes in a sandbox (F-189)", async () => {
  for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml"]) {
    const meta = await fileUpload({ workspace_id: ws, owner_agent_id: owner.id, uploaded_by_agent_id: owner.id, folder: "dl", filename: "page-" + mime.replace(/\W/g, "") + ".html", mime, bytes: Buffer.from("<script>alert(1)</script>") });
    const headers: Record<string, string> = {};
    const req = { url: `/api/dashboard/files/${meta.id}/download`, method: "GET", headers: { authorization: "Bearer " + owner.api_key } } as unknown as IncomingMessage;
    const res = { writeHead(_code: number, h: Record<string, string>) { Object.assign(headers, h); }, end() {} } as unknown as ServerResponse;
    handleDashboardApi(req, res);
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(headers["content-disposition"]).toStartWith("attachment;");
  }
});
