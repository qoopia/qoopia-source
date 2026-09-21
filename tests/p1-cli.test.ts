import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerFixture, completeContent } from "./helpers/p1-fixtures.ts";
import { Database } from "bun:sqlite";

test("T-05/T-22: actual CLI process uses the shared writer and rechecks current authorization", async () => {
  const { database, owner } = ownerFixture(46), directory = mkdtempSync(join(tmpdir(), "p1-cli-"));
  try {
    const data = join(directory, "data"); mkdirSync(data);
    const filename = join(data, "qoopia.db"); writeFileSync(filename, database.serialize());
    const input = join(directory, "input.json");
    writeFileSync(input, JSON.stringify({ slug: "cli-fixture", content: completeContent, expected_revision: 0, idempotency_key: "cli-create" }));
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe", env: {
        PATH: process.env.PATH!, NODE_ENV: "test", TMPDIR: tmpdir(), QOOPIA_DATA_DIR: data,
        QOOPIA_LOG_DIR: join(directory, "logs"), QOOPIA_BACKUP_DIR: join(directory, "backups"),
        QOOPIA_API_KEY: owner.api_key, QOOPIA_LOG_LEVEL: "error",
      } });
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
    };
    const first = await invoke("skill", "revise", "--input", input);
    expect(first.stderr).toBe(""); expect(first.code).toBe(0);
    const result = JSON.parse(first.stdout);
    const replay = await invoke("skill", "revise", "--input", input);
    expect(replay.code).toBe(0); expect(JSON.parse(replay.stdout).operation_id).toBe(result.operation_id);
    const pairingPath = join(directory, "pairing.json");
    writeFileSync(pairingPath, JSON.stringify({ name: "CLI agent", runtime_id: "fixture", profile: "memory-reader", expected_revision: 1, idempotency_key: "cli-pairing" }));
    const pairing = await invoke("pairing", "create", "--input", pairingPath);
    expect(pairing.code).toBe(0);
    writeFileSync(pairingPath, JSON.stringify({ code: JSON.parse(pairing.stdout).one_time_code }));
    const enrolled = await invoke("pairing", "redeem", "--input", pairingPath);
    expect(enrolled.code).toBe(0); expect(JSON.parse(enrolled.stdout).data.profile).toBe("memory-reader");
    expect((await invoke("pairing", "redeem", "--input", pairingPath)).code).toBe(1);
    const current = new Database(filename);
    current.query("UPDATE agents SET active=0 WHERE id=?").run(owner.agent_id);
    const revoked = await invoke("skill", "revise", "--input", input);
    expect(revoked.code).toBe(1); expect(revoked.stdout).toBe("");
    expect(current.query("SELECT count(*) AS n FROM authority_commands").get()).toEqual({ n: 3 });
    current.close();
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
