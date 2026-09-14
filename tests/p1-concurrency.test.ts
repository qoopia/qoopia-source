import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerFixture, completeContent } from "./helpers/p1-fixtures.ts";
import { reviseDraft, compileDraft } from "../src/skills/authority.ts";
import { Database } from "bun:sqlite";

test.each(["edit", "review"])("T-03: two actual Bun processes concurrently %s one SQLite head", async (operation) => {
  const { database: d, auth } = ownerFixture(), dir = mkdtempSync(join(tmpdir(), "p1-concurrency-"));
  try {
    const first = reviseDraft(auth, { slug: "parallel", expected_revision: 0, content: completeContent, idempotency_key: "create" }, d);
    const candidate = operation === "review" ? compileDraft(auth, { draft_id: first.data.draft_id, expected_revision: 1, version_label: "1", license: "MIT", idempotency_key: "compile" }, d) : null;
    const filename = join(dir, "fixture.db"); writeFileSync(filename, d.serialize());
    const clients = ["alpha", "beta"].map((name) => {
      const inputPath = join(dir, `${name}.json`);
      const input = candidate ? { version_id: candidate.data.version_id, expected_digest: candidate.data.candidate_digest, expected_revision: 0,
        kind: "content_review", decision: name === "alpha" ? "approve" : "reject", evidence_class: "self_reported", target_scope: "personal",
        capabilities: completeContent.requested_capabilities, expires_at_ms: Date.now() + 60_000, policy_epoch: 1, idempotency_key: name }
        : { slug: "parallel", draft_id: first.data.draft_id, expected_revision: 1, content: { ...completeContent, title: name }, idempotency_key: name };
      writeFileSync(inputPath, JSON.stringify({ auth, operation, input }));
      const child = Bun.spawn([process.execPath, "--preload", "./tests/setup.ts", "./tests/helpers/p1-concurrent-client.ts", filename, inputPath], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, TMPDIR: tmpdir(), NODE_ENV: "test" },
      });
      return { child, reader: child.stdout.getReader() };
    });
    for (const c of clients) expect(new TextDecoder().decode((await c.reader.read()).value)).toContain("ready");
    for (const c of clients) { c.child.stdin.write("go\n"); c.child.stdin.end(); }
    const results = await Promise.all(clients.map(async (c) => {
      let output = "";
      for (;;) { const r = await c.reader.read(); if (r.done) break; output += new TextDecoder().decode(r.value); }
      expect(await c.child.exited).toBe(0); return JSON.parse(output);
    }));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).code).toBe("STALE_REVISION");
    const stored = new Database(filename, { readonly: true });
    expect(stored.query("SELECT revision FROM skill_drafts").get()).toEqual({ revision: candidate ? 1 : 2 });
    expect(stored.query("SELECT count(*) AS n FROM authority_commands").get()).toEqual({ n: candidate ? 3 : 2 });
    if (candidate) expect(stored.query("SELECT count(*) AS n FROM skill_approvals").get()).toEqual({ n: 1 });
    stored.close();
  } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
