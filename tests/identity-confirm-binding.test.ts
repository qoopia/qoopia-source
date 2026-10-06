/**
 * F-125: whoever starts a sign-in with the owner's address used to get the owner's session as
 * soon as the owner clicked the email. The first fix asked the owner to copy a six-digit code
 * between screens. Now a request is bound to the network it started from: the email link or the
 * Google sign-in completes it only from that network, with nothing to copy, and Google sends no
 * confirmation email at all. Clients up to 5.0.15 still ask for and get a code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loginBroker, signInNetwork } from "../src/identity/broker.ts";
import { DEVICE_CODE_LAUNCHER_ONLY, localIdentityLogin, LOGIN_ORIGIN, ownerIdentity } from "../src/identity/local.ts";
import { issueLocalLogin } from "../src/delivery/local-login.ts";
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
  // The dashboard below runs on loopback, so its sign-ins belong to the network the broker sees it
  // call from: "server". A confirmation from "server" is the same device; anything else is not.
  const confirm = async (body: Record<string, unknown>, ip = "victim-browser") => broker(new Request(LOGIN_ORIGIN + "/confirm", {
    method: "POST", headers: { origin: LOGIN_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
  }), ip);
  return { broker, transport, link, confirm, mails };
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

function googleFixture() {
  const mails: string[] = [];
  const broker = loginBroker(new Database(":memory:"), { origin: LOGIN_ORIGIN, resendKey: "fixture", from: "Qoopia <login@mail.qoopia.ai>", googleClientId: "fixture", googleClientSecret: "fixture" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture" });
      if (url.includes("openidconnect.googleapis.com")) return Response.json({ email: "owner@example.com", email_verified: true, sub: "google-owner" });
      mails.push(JSON.parse(String(init?.body)).subject); return Response.json({ id: "sent" });
    }) as typeof fetch);
  const transport = (async (input: string | URL | Request, init?: RequestInit) => broker(new Request(String(input), init), "server")) as typeof fetch;
  // The browser opens the Google link and comes back to the callback from the given network.
  const google = async (googleUrl: string, ip: string) => {
    const start = await broker(new Request(googleUrl), ip);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    return broker(new Request(LOGIN_ORIGIN + "/google/callback?state=" + state + "&code=fixture", { headers: { cookie } }), ip);
  };
  return { transport, google, mails };
}

describe("F-125: a sign-in counts only from the network where it started", () => {
  test("a link opened on another network signs nobody in, and there is no code to steal", async () => {
    const { transport, link, confirm } = brokerFixture();
    const attacker = dashboardClient(localIdentityLogin(root, db, transport));
    const started = await attacker("/start", { method: "email", email: "owner@example.com" });
    expect(started.status).toBe(200);
    expect(started.data).not.toHaveProperty("code");
    expect(link().searchParams.get("auto")).toBe("1");
    const refused = await confirm({ token: link().hash.slice(1) }, "victim-browser");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ same_device: true });
    const poll = await attacker("/poll");
    expect(poll.data).toEqual({ pending: true });
    expect(poll.cookie).toBeUndefined();
  });

  test("the owner opens the link on the device where they started and is in, with nothing to type", async () => {
    const { transport, link, confirm, mails } = brokerFixture();
    const owner = dashboardClient(localIdentityLogin(root, db, transport));
    await owner("/start", { method: "email", email: "owner@example.com" });
    expect((await owner("")).data).toMatchObject({ pending: true });
    expect((await confirm({ token: link().hash.slice(1) }, "server")).status).toBe(200);
    const poll = await owner("/poll");
    expect(poll.status).toBe(200);
    expect(checkDashboardAuth({ headers: { cookie: "qoopia_dash=" + poll.cookie } } as IncomingMessage)?.agent_id).toBe(OWNER_ID);
    // A first sign-in gets one welcome email, without a link to follow.
    expect(mails.at(-1)).toContain("Welcome to Qoopia");
    expect(mails.at(-1)).not.toContain("https://");
  });

  test("Google needs no email: on the starting network it signs in, from elsewhere it does not", async () => {
    const { transport, google, mails } = googleFixture();
    const owner = dashboardClient(localIdentityLogin(root, db, transport));
    const away = await owner("/start", { method: "google" });
    expect(away.data).not.toHaveProperty("code");
    const elsewhere = await google(String(away.data.googleUrl), "victim-browser");
    expect(elsewhere.status).toBe(403);
    expect((await owner("/poll")).data).toEqual({ pending: true });
    const here = await owner("/start", { method: "google" });
    const finished = await google(String(here.data.googleUrl), "server");
    expect(finished.status).toBe(200);
    expect(await finished.text()).toContain("You are signed in");
    const poll = await owner("/poll");
    expect(checkDashboardAuth({ headers: { cookie: "qoopia_dash=" + poll.cookie } } as IncomingMessage)?.agent_id).toBe(OWNER_ID);
    // No confirmation email at any point; only the first-sign-in welcome.
    expect(mails).toEqual(["Welcome to Qoopia"]);
  });

  test("the profile portal binds its sign-in the same way", async () => {
    const { broker, link, confirm } = brokerFixture();
    const cookies: Record<string, string> = {};
    const call = async (route: string, body: unknown) => {
      const response = await broker(new Request(LOGIN_ORIGIN + route, { method: "POST", headers: { origin: LOGIN_ORIGIN, "content-type": "application/json", cookie: Object.entries(cookies).map(([k, v]) => k + "=" + v).join("; ") }, body: JSON.stringify(body) }), "browser");
      for (const value of response.headers.getSetCookie()) { const [key, ...rest] = value.split(";")[0]!.split("="); cookies[key!] = rest.join("="); }
      return response;
    };
    const started = await (await call("/profile/start", { method: "email", email: "someone@example.com" })).json();
    expect(started).not.toHaveProperty("code");
    const token = link().hash.slice(1);
    expect((await confirm({ token }, "elsewhere")).status).toBe(400);
    expect((await call("/profile/poll", {})).status).toBe(202);
    expect((await confirm({ token }, "browser")).status).toBe(200);
    const signedIn = await call("/profile/poll", {});
    expect(signedIn.status).toBe(200);
    // One sign-in per device: the profile session lasts a year.
    expect(signedIn.headers.getSetCookie().find((c) => c.startsWith("__Host-qoopia_profile="))).toContain("Max-Age=31536000");
  });

  test("a client up to 5.0.15 still gets and needs its code; an unbound request still confirms with the link", async () => {
    const { broker, link, confirm } = brokerFixture();
    const request = (body: Record<string, unknown>) => broker(new Request(LOGIN_ORIGIN + "/requests", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "email", challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"), ...body }) }), "server");
    const legacy = await (await request({ email: "legacy@example.com", bind: true })).json() as { confirm_code: string };
    expect(legacy.confirm_code).toMatch(/^\d{6}$/);
    expect(link().searchParams.get("code")).toBe("1");
    expect(await (await confirm({ token: link().hash.slice(1) })).json()).toMatchObject({ code_required: true });
    expect((await confirm({ token: link().hash.slice(1), code: legacy.confirm_code })).status).toBe(200);
    expect(await (await request({ email: "device@example.com" })).json()).not.toHaveProperty("confirm_code");
    expect(link().searchParams.has("code")).toBe(false);
    expect(await (await broker(new Request(LOGIN_ORIGIN + "/confirm" + link().search), "browser")).text()).not.toContain('id="code"');
    expect((await confirm({ token: link().hash.slice(1) })).status).toBe(200);
  });
});

test("a sign-in network is the public IPv4 address or the IPv6 /64; private addresses say nothing", () => {
  expect(signInNetwork("203.0.113.7")).toBe("203.0.113.7");
  expect(signInNetwork("::ffff:203.0.113.7")).toBe("203.0.113.7");
  for (const local of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "::1", "fd00::1", "fe80::1"]) expect(signInNetwork(local), local).toBeNull();
  // One device's rotating IPv6 privacy addresses share their /64.
  expect(signInNetwork("2001:db8:abcd:12:1111::1")).toBe(signInNetwork("2001:0db8:abcd:0012:9999:8888:7777:6666"));
  expect(signInNetwork("2001:db8:abcd:12::1")).not.toBe(signInNetwork("2001:db8:abcd:13::1"));
});

// A device code is confirmed on a phone signed in to the account, on any network, and signs in whoever started
// it: only the launcher's claim, the owner's OS capability, may start one. A broker without device codes gives a
// clear refusal, never a hang.
describe("device code: the dashboard of a headless installation", () => {
  const launcher = async (transport: typeof fetch) => {
    const unlinked = fs.mkdtempSync(path.join(root, "device-"));
    const owner = dashboardClient(localIdentityLogin(unlinked, db, transport));
    expect((await owner("/setup", { code: issueLocalLogin(OWNER_ID) })).data).toEqual({ linked: false, setup: true });
    return { owner, unlinked };
  };
  test("the code confirmed on another network links the account and signs the owner in", async () => {
    const { broker, transport, link } = brokerFixture();
    const { owner, unlinked } = await launcher(transport);
    const started = await owner("/start", { method: "device" });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ verificationUri: LOGIN_ORIGIN + "/device", expiresIn: 600 });
    const code = String(started.data.userCode);
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(started.data.verificationUriComplete).toBe(LOGIN_ORIGIN + "/device?code=" + code);
    expect((await owner("/poll")).data).toEqual({ pending: true });
    // The phone signs in to its profile on its own network, then reviews and approves the code.
    const jar: Record<string, string> = {};
    const phone = async (route: string, body?: unknown) => {
      const response = await broker(new Request(LOGIN_ORIGIN + route, { method: body === undefined ? "GET" : "POST",
        headers: { cookie: Object.entries(jar).map(([k, v]) => k + "=" + v).join("; "), ...(body === undefined ? {} : { origin: LOGIN_ORIGIN, "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body) }), "203.0.113.50");
      for (const c of response.headers.getSetCookie()) { const [k, ...v] = c.split(";")[0]!.split("="); jar[k!] = v.join("="); }
      return response;
    };
    await phone("/profile/start", { method: "email", email: "owner@example.com" });
    await broker(new Request(LOGIN_ORIGIN + "/confirm", { method: "POST", headers: { origin: LOGIN_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: link().hash.slice(1) }) }), "203.0.113.50");
    expect((await phone("/profile/poll", {})).status).toBe(200);
    const review = await (await phone("/profile/device/lookup", { code })).json() as { label: string };
    expect(review.label).toStartWith("Qoopia ");
    expect((await phone("/profile/device/approve", { code })).status).toBe(200);
    const poll = await owner("/poll");
    expect(poll.status).toBe(200);
    expect(checkDashboardAuth({ headers: { cookie: "qoopia_dash=" + poll.cookie } } as IncomingMessage)?.agent_id).toBe(OWNER_ID);
    expect(ownerIdentity(unlinked)).toEqual({ ownerId: OWNER_ID, email: "owner@example.com" });
  });

  test("another OS user of a shared host gets no code to phish the owner with", async () => {
    // Any local account reaches the owner's loopback dashboard with its Host, Origin and CSRF header. Its code,
    // approved on a page naming this very host and network, handed it the linked owner's dashboard session.
    const { transport } = brokerFixture();
    let calls = 0;
    const intruder = dashboardClient(localIdentityLogin(root, db, ((...args: Parameters<typeof fetch>) => { calls++; return transport(...args); }) as typeof fetch));
    const started = await intruder("/start", { method: "device" });
    expect(started).toMatchObject({ status: 400, data: { error: DEVICE_CODE_LAUNCHER_ONLY } });
    expect(calls).toBe(0);
    const poll = await intruder("/poll");
    expect(poll.status).toBe(400);
    expect(poll.cookie).toBeUndefined();
  });

  test("a sign-in service without device codes gets a clear refusal", async () => {
    const legacy = (async () => Response.json({ error: "Invalid sign-in request" }, { status: 400 })) as unknown as typeof fetch;
    const { owner } = await launcher(legacy);
    const started = await owner("/start", { method: "device" });
    expect(started.status).toBe(400);
    expect(String(started.data.error)).toContain("does not offer code sign-in yet");
  });
});
