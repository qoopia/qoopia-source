/**
 * F-125: whoever starts a sign-in with the owner's address used to get the owner's
 * session as soon as the owner clicked Confirm in the e-mail. A bound request now
 * returns a one-time code to the screen that started it, and the broker's /confirm
 * refuses to confirm without that code (five wrong codes end the request). The
 * dashboard owner sign-in and the auth.qoopia.ai profile both bind their requests;
 * an unbound request (older clients, owner-initiated device enrolment) is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loginBroker } from "../src/identity/broker.ts";
import { localIdentityLogin, LOGIN_ORIGIN } from "../src/identity/local.ts";
import { db } from "../src/db/connection.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { bootstrapOwner } from "../src/auth/pairings.ts";
import { checkDashboardAuth } from "../src/dashboard-api.ts";
import { durableWrite, privateDirectory } from "../src/utils/fs.ts";
import { env } from "../src/utils/env.ts";

let root = "";
let OWNER_ID = "";
// The session is minted for a loopback standalone request, as in identity-login.test.ts.
const standalone = process.env.QOOPIA_STANDALONE;
beforeAll(() => {
  process.env.QOOPIA_STANDALONE = "true";
  runMigrations();
  const ws = createWorkspace({ name: "Confirm binding", slug: "f125-binding" });
  OWNER_ID = bootstrapOwner(db, "F125 owner", undefined, ws.id).agent_id;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-f125-"));
  privateDirectory(path.join(root, "config"));
  durableWrite(path.join(root, "config/owner-identity.json"), JSON.stringify({ ownerId: OWNER_ID, email: "owner@example.com" }));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (standalone === undefined) delete process.env.QOOPIA_STANDALONE; else process.env.QOOPIA_STANDALONE = standalone;
});

function brokerFixture() {
  const mails: string[] = [];
  const broker = loginBroker(new Database(":memory:"), { origin: LOGIN_ORIGIN, resendKey: "fixture", from: "Qoopia <login@mail.qoopia.ai>", googleClientId: "fixture", googleClientSecret: "fixture" },
    (async (_input: string | URL | Request, init?: RequestInit) => { mails.push(JSON.parse(String(init?.body)).text); return Response.json({ id: "sent" }); }) as typeof fetch);
  const transport = (async (input: string | URL | Request, init?: RequestInit) => broker(new Request(String(input), init), "server")) as typeof fetch;
  const link = () => new URL(mails.at(-1)!.match(/https:\/\/[^\s]+/)![0]);
  const confirm = async (body: Record<string, unknown>) => broker(new Request(LOGIN_ORIGIN + "/confirm", {
    method: "POST", headers: { origin: LOGIN_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
  }), "victim-browser");
  return { broker, transport, link, confirm };
}

function dashboardClient(login: ReturnType<typeof localIdentityLogin>) {
  const jar = new Map<string, string>();
  return async (route: string, body: Record<string, unknown> = {}) => {
    let status = 0, payload = "";
    const res = {
      setHeader: (name: string, value: string) => { if (name === "set-cookie") { const c = value.split(";")[0]!, i = c.indexOf("="); jar.set(c.slice(0, i), c.slice(i + 1)); } },
      writeHead: (code: number, headers?: Record<string, string>) => { status = code; if (headers?.["set-cookie"]) res.setHeader("set-cookie", headers["set-cookie"]); },
      end: (value: string) => { payload = value; },
    } as unknown as ServerResponse;
    const host = `127.0.0.1:${env.PORT}`;
    await login({ method: route ? "POST" : "GET", headers: { host, origin: `http://${host}`, cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage, res, route, body);
    return { status, data: JSON.parse(payload) as Record<string, unknown>, cookie: jar.get("qoopia_dash") };
  };
}

describe("F-125: a sign-in confirmation is bound to the screen that started it", () => {
  test("the owner's click without the initiator's code never signs the initiator in", async () => {
    const { transport, link, confirm } = brokerFixture();
    const attacker = dashboardClient(localIdentityLogin(root, db, transport));
    const started = await attacker("/start", { method: "email", email: "owner@example.com" });
    expect(started.status).toBe(200);
    expect(started.data.code).toMatch(/^\d{6}$/);
    expect(link().searchParams.get("code")).toBe("1");
    const token = link().hash.slice(1);
    const missing = await confirm({ token });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code_required: true });
    const wrong = String((Number(started.data.code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 3; i++) expect((await confirm({ token, code: wrong })).status).toBe(400);
    expect((await attacker("/poll")).data).toEqual({ pending: true });
    // The fifth failure ends the request: the right code no longer works and the initiator gets nothing.
    expect((await confirm({ token, code: wrong })).status).toBe(400);
    expect((await confirm({ token, code: started.data.code })).status).toBe(400);
    const poll = await attacker("/poll");
    expect(poll.status).toBe(400);
    expect(poll.cookie).toBeUndefined();
  });

  test("the owner who started it types the code shown on the dashboard and is signed in", async () => {
    const { transport, link, confirm } = brokerFixture();
    const owner = dashboardClient(localIdentityLogin(root, db, transport));
    const started = await owner("/start", { method: "email", email: "owner@example.com" });
    // A reload of the dashboard still shows the code of the pending sign-in.
    expect((await owner("")).data).toMatchObject({ pending: true, code: started.data.code });
    expect((await confirm({ token: link().hash.slice(1), code: started.data.code })).status).toBe(200);
    const poll = await owner("/poll");
    expect(poll.status).toBe(200);
    expect(checkDashboardAuth({ headers: { cookie: "qoopia_dash=" + poll.cookie } } as IncomingMessage)?.agent_id).toBe(OWNER_ID);
  });

  test("the profile portal binds its sign-in the same way", async () => {
    const { broker, link, confirm } = brokerFixture();
    const cookies: Record<string, string> = {};
    const call = async (route: string, body: unknown) => {
      const response = await broker(new Request(LOGIN_ORIGIN + route, { method: "POST", headers: { origin: LOGIN_ORIGIN, "content-type": "application/json", cookie: Object.entries(cookies).map(([k, v]) => k + "=" + v).join("; ") }, body: JSON.stringify(body) }), "browser");
      for (const value of response.headers.getSetCookie()) { const [key, ...rest] = value.split(";")[0]!.split("="); cookies[key!] = rest.join("="); }
      return response;
    };
    const started = await (await call("/profile/start", { method: "email", email: "someone@example.com" })).json() as { code: string };
    expect(started.code).toMatch(/^\d{6}$/);
    const token = link().hash.slice(1);
    expect((await confirm({ token })).status).toBe(400);
    expect((await call("/profile/poll", {})).status).toBe(202);
    expect((await confirm({ token, code: started.code })).status).toBe(200);
    expect((await call("/profile/poll", {})).status).toBe(200);
  });

  test("an unbound request still confirms with the link alone, and its page asks for no code", async () => {
    const { broker, link, confirm } = brokerFixture();
    const verifier = randomBytes(32).toString("base64url");
    const created = await broker(new Request(LOGIN_ORIGIN + "/requests", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "email", email: "device@example.com", challenge: createHash("sha256").update(verifier).digest("hex") }) }), "server");
    expect(await created.json()).not.toHaveProperty("confirm_code");
    expect(link().searchParams.has("code")).toBe(false);
    expect(await (await broker(new Request(LOGIN_ORIGIN + "/confirm" + link().search), "browser")).text()).not.toContain('id="code"');
    expect((await confirm({ token: link().hash.slice(1) })).status).toBe(200);
    expect(await (await broker(new Request(LOGIN_ORIGIN + "/confirm?lang=en&code=1"), "browser")).text()).toContain('id="code"');
  });
});
