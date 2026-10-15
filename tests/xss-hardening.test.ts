// Audit 5.0.21 A3c: HTML-injection hardening and a ratchet on raw HTML operands.
import { beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { registerClient } from "../src/auth/oauth.ts";
import { cspOrigin, securityHeaders } from "../src/http/respond.ts";
import { bridgeRelay } from "../src/bridges/relay.ts";
import { BRIDGE_RELAY } from "../src/bridges/protocol.ts";
import { htmlSinkOperands, SCANNED_SCRIPTS } from "./helpers/xss-sinks.ts";
import type { AuthContext } from "../src/auth/middleware.ts";

test("A3c: every raw HTML operand in the browser scripts is one already reviewed", () => {
  // A new operand fails here: escape it (esc/QI.msg/…) or, once reviewed, add it to the allowlist.
  const allowlist = JSON.parse(fs.readFileSync("tests/fixtures/xss-sink-allowlist.json", "utf8")) as Record<string, string[]>;
  for (const file of SCANNED_SCRIPTS) {
    const known = new Set(allowlist[file] ?? []);
    expect([file, htmlSinkOperands(file).filter((operand) => !known.has(operand))]).toEqual([file, []]);
  }
});

test("A3c-01: an agent name's initial is escaped before it reaches the avatar", () => {
  const source = fs.readFileSync("src/public/brand/dashboard.js", "utf8");
  const body = (name: string) => source.match(new RegExp(`  function ${name}\\(([^)]*)\\) \\{[\\s\\S]*?\\n  \\}|  function ${name}\\(([^)]*)\\) \\{.*\\}`))![0];
  const initial = new Function(`${body("esc")}\n${body("initial")}\nreturn initial;`)() as (name: string) => string;
  expect(initial("<x")).toBe("&lt;");
  expect(initial("alan")).toBe("A");
});

test("A3c-02: a redirect host that is not a plain name never registers nor reaches the CSP", () => {
  runMigrations();
  const ws = createWorkspace({ name: "XSS DCR", slug: "xss-dcr" });
  const steward = createAgent({ name: "xss-dcr-steward", workspaceSlug: ws.slug, type: "steward" });
  const auth = { agent_id: steward.id, agent_name: "xss-dcr-steward", workspace_id: ws.id, type: "steward", source: "api-key" } as AuthContext;
  for (const uri of ["https://*/cb", "https://x;sandbox/cb"]) {
    expect(() => registerClient({ client_name: "bad", redirect_uris: [uri] }, auth)).toThrow(/redirect URI host/);
    expect(cspOrigin(uri)).toBeUndefined();
    const csp = securityHeaders({ headers: {}, socket: {} } as never, uri)["content-security-policy"]!;
    expect(csp).toMatch(/form-action 'self'(;|$)/);
    expect(csp).not.toContain("sandbox");
  }
  expect(cspOrigin("https://claude.ai/api/mcp/auth_callback")).toBe("https://claude.ai");
  expect(cspOrigin("http://[::1]:8080/cb")).toBe("http://[::1]:8080");
});

test("A3c-03: the invite page copies only a well-formed invitation code", async () => {
  const relay = bridgeRelay(new Database(":memory:"));
  const html = await (await relay(new Request(BRIDGE_RELAY + "/invite"), "fixture")).text();
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!;
  const run = async (hash: string) => {
    const nodes: Record<string, any> = { "#invite": { value: "", select() {} }, "#copy": {}, "#status": { textContent: "" } };
    const copied: string[] = [];
    new Function("document", "location", "navigator", script)(
      { querySelector: (q: string) => nodes[q], body: { dataset: { invalid: "Invalid invitation", copied: "Copied." } } }, { hash }, { clipboard: { writeText: async (v: string) => { copied.push(v); } } });
    await nodes["#copy"].onclick();
    return { shown: nodes["#invite"].value, copied };
  };
  expect(await run("#<img src=x onerror=alert(1)>")).toEqual({ shown: "Invalid invitation", copied: [] });
  const good = "QPB1." + "a".repeat(43) + "." + "b".repeat(43);
  expect(await run("#" + good)).toEqual({ shown: good, copied: [good] });
});

beforeAll(() => runMigrations());
