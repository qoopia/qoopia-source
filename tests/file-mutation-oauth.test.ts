import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { registerClient } from "../src/auth/oauth.ts";
import { sha256Hex } from "../src/auth/api-keys.ts";
import { fileUpload } from "../src/services/files.ts";
import { startHttpServer } from "../src/http.ts";

let server: Server, base = "", ws = "", steward = { id: "", api_key: "" }, client = "";
const exists = (id: string) => !!db.prepare("SELECT 1 FROM files WHERE id=?").get(id);
const upload = async (name: string) => (await fileUpload({ workspace_id: ws, owner_agent_id: steward.id, uploaded_by_agent_id: steward.id, folder: "inbox", filename: name, mime: "text/plain", bytes: Buffer.from(name) })) as { id: string };
function oauthToken(scope: string) {
  const token = `qa_files_${crypto.randomUUID()}`, iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  db.prepare(`INSERT INTO oauth_tokens (token_hash,client_id,agent_id,workspace_id,token_type,expires_at,revoked,created_at,granted_scope)
    VALUES (?,?,?,?,'access',?,0,?,?)`).run(sha256Hex(token), client, steward.id, ws, iso(Date.now() + 3600e3), iso(Date.now()), scope);
  return token;
}

beforeAll(async () => {
  runMigrations();
  const w = createWorkspace({ name: "File mutation OAuth", slug: "file-mutation-oauth" });
  ws = w.id;
  steward = createAgent({ name: "fmo-steward", workspaceSlug: w.slug, type: "steward" }) as typeof steward;
  client = registerClient({ client_name: "fmo", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
    { agent_id: steward.id, workspace_id: ws, agent_name: "fmo-steward", type: "steward", source: "api-key" }).client_id;
  server = startHttpServer();
  await new Promise<void>(r => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

test("OAuth tokens cannot delete or upload dashboard files, whatever their scope", async () => {
  for (const scope of ["mcp:read", "mcp:read mcp:write"]) {
    const token = oauthToken(scope), f = await upload(`victim-${scope}.txt`);
    const del = await fetch(`${base}/api/dashboard/files/${f.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(403);
    expect(exists(f.id)).toBe(true);
    const form = new FormData(); form.set("file", new File(["planted"], "planted.txt", { type: "text/plain" }));
    expect((await fetch(`${base}/api/dashboard/files`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form })).status).toBe(403);
  }
});

test("the owner's static key still manages files", async () => {
  const f = await upload("mine.txt");
  expect((await fetch(`${base}/api/dashboard/files/${f.id}`, { method: "DELETE", headers: { authorization: `Bearer ${steward.api_key}` } })).status).toBe(200);
  expect(exists(f.id)).toBe(false);
});

const post = (folder: string | null, files: [string, string][]) => {
  const form = new FormData();
  if (folder !== null) form.set("folder", folder);
  for (const [name, body] of files) form.append("file", new File([body], name, { type: "text/plain" }));
  return fetch(`${base}/api/dashboard/files`, { method: "POST", headers: { authorization: `Bearer ${steward.api_key}` }, body: form });
};
const stored = (filename: string) => (db.prepare("SELECT count(*) n FROM files WHERE workspace_id=? AND filename=?").get(ws, filename) as { n: number }).n;

test("a dashboard upload batch is validated before anything is written", async () => {
  const mixed = await post("batch", [["batch-good.txt", "good"], ["batch-empty.txt", ""]]);
  expect(mixed.status).toBe(400);
  // Bun parses an empty multipart file without its name, so the dashboard names it client-side.
  expect(await mixed.json()).toMatchObject({ error: "invalid_input", reason: "empty_file" });
  expect(stored("batch-good.txt")).toBe(0);
  expect((await post(null, [["lone-empty.txt", ""]])).status).toBe(400);
  expect(await (await post("x".repeat(201), [["long-folder.txt", "x"]])).json()).toMatchObject({ error: "invalid_input", reason: "invalid_folder" });
  const ok = await post("batch", [["batch-a.txt", "a"], ["batch-b.txt", "b"]]);
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { uploaded: unknown[] }).uploaded.length).toBe(2);
});

test("upload folder and file names are bounded and free of control and bidi characters", async () => {
  for (const folder of ["../../etc", "/abs", "a//b", "a\\b", "f\u0000x", "evil\u202Efdp.exe"])
    expect(await (await post(folder, [["n.txt", "x"]])).json(), folder).toMatchObject({ error: "invalid_input", reason: "invalid_folder" });
  for (const name of ["a\u001b[2Jb.txt", "\u202Etxt.exe", "n".repeat(181), ".."])
    expect(await (await post("inbox", [[name, "x"]])).json(), name).toMatchObject({ error: "invalid_input", reason: "invalid_filename" });
  expect((await post("tasks/abc", [["../../passwd", "x"]])).status).toBe(200);
  expect(db.prepare("SELECT folder, filename FROM files WHERE workspace_id=? AND folder='tasks/abc'").get(ws)).toEqual({ folder: "tasks/abc", filename: ".._.._passwd" });
  await expect(fileUpload({ workspace_id: ws, owner_agent_id: steward.id, uploaded_by_agent_id: steward.id, folder: "tasks/x", filename: "a\u0000.txt", bytes: Buffer.from("x") }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
});
