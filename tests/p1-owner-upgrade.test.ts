import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p1Database } from "./helpers/p1-fixtures.ts";

// Source fixture revision: 1fbfdfc0de7c01c9913eb48e7b948a9808baf2bc.
for (const upgrade of [false, true]) test(`P1-A01/A02: ${upgrade ? "schema35 upgrade preserves executed old permissions" : "fresh install has a usable local human owner"}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "p1-owner-upgrade-")), data = join(directory, "data");
  mkdirSync(data);
  const filename = join(data, "qoopia.db"), fixtureFile = join(directory, "fixture.json"), ownerFile = join(directory, "owner.json");
  const environment = { PATH: process.env.PATH!, NODE_ENV: "test", TMPDIR: tmpdir(), QOOPIA_DATA_DIR: data,
    QOOPIA_LOG_DIR: join(directory, "logs"), QOOPIA_BACKUP_DIR: join(directory, "backups"), QOOPIA_LOG_LEVEL: "info",
    QOOPIA_SERVER_ROLE: "canonical", QOOPIA_INSTANCE_ID: "disposable-upgrade", QOOPIA_SKILLS: "true", QOOPIA_ENTITY_PAGES: "true" };
  const run = async (args: string[], overrides: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe", env: { ...environment, ...overrides } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  };
  const success = (result: { code: number; stdout: string; stderr: string }) => {
    // CLI owner/pairing stdout may contain disposable keys: never print that stdout in a failed assertion.
    expect(result.stderr).toBe(""); expect(result.code).toBe(0);
  };
  const record = (stage: string, result: { code: number; stdout: string; stderr: string }) => {
    // Only non-secret probe/migration output is eligible for optional execution evidence.
    const evidence = process.env.P1_CORRECTION_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, `${upgrade ? "upgrade" : "fresh"}-${stage}.json`), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    }
  };
  const probe = (mode: string, file = fixtureFile, overrides = {}) => run(["tests/helpers/p1-upgrade-probe.ts", mode, process.cwd(), file], overrides);
  try {
    if (upgrade) {
      const initial = p1Database(35); writeFileSync(filename, initial.serialize()); initial.close();
      // Audited source-only fixture of the pinned revision; no private Git history required.
      const oldRoot = join(directory, "schema35"); mkdirSync(oldRoot);
      const compressed = readFileSync(new URL("./fixtures/schema35-source.tar.gz", import.meta.url));
      expect(createHash("sha256").update(compressed).digest("hex")).toBe("c9fff1713f0cf1aa366125db4070204d31250aaa1beb014c9081a117bcfa24a2");
      expect(Bun.spawnSync(["tar", "-xf", "-", "-C", oldRoot], { stdin: gunzipSync(compressed) }).exitCode).toBe(0);
      symlinkSync(join(process.cwd(), "node_modules"), join(oldRoot, "node_modules"));
      const seed = await run(["tests/helpers/p1-upgrade-probe.ts", "seed", oldRoot, fixtureFile]);
      record("schema35", seed);
      success(seed); expect(seed.stdout).toContain('"alias_cases":30');
    }
    const migration = await run(["scripts/migrate.ts"]);
    record("migration", migration);
    success(migration);
    expect(migration.stdout).toContain("Migration036 backfill committed");
    expect(migration.stdout).toContain('"owner_mapping":"none"');
    expect(readdirSync(environment.QOOPIA_BACKUP_DIR).some((f) => f.endsWith(".db"))).toBe(true);
    if (upgrade) {
      const mapping = migration.stdout.split("\n").filter((line) => line.includes("Migration036 legacy permission mapping"));
      expect(mapping.length).toBe(19);
      expect(mapping.filter((line) => line.includes('"profile_allows_skill_write":true')).length).toBe(13);
      expect(mapping.some((line) => line.includes("api_key"))).toBe(false);
      const verified = await probe("verify"); record("schema36", verified); success(verified); expect(verified.stdout).toContain('"legacy_cases":75');
    }
    const d = new Database(filename);
    const oldPrincipals = d.query("SELECT * FROM agents ORDER BY id").all() as { id: string; name: string }[];
    const workspace = d.query("SELECT id FROM workspaces LIMIT 1").get() as { id: string } | null;
    const target = workspace ? ["--workspace-id", workspace.id] : ["--workspace-name", "Fresh fixture"];
    if (workspace) {
      expect((await run(["src/cli.ts", "owner", "bootstrap", "--name", oldPrincipals[0]!.name, ...target])).code).toBe(1);
      expect((await run(["src/cli.ts", "owner", "bootstrap", "--name", "Wrong workspace", "--workspace-id", "absent"])).code).toBe(1);
      expect((await run(["src/cli.ts", "owner", "bootstrap", "--name", "Implicit workspace", "--workspace-name", "Wrong"])).code).toBe(1);
    }
    const race = await Promise.all(["Explicit human", "Concurrent human"].map((name) => run(["src/cli.ts", "owner", "bootstrap", "--name", name, ...target])));
    expect(race.map((result) => result.code).sort()).toEqual([0, 1]);
    const created = race.find((result) => result.code === 0)!;
    success(created); const owner = JSON.parse(created.stdout);
    writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
    expect(d.query("SELECT principal_kind,authority_profile,legacy_skill_access FROM agents WHERE id=?").get(owner.agent_id))
      .toEqual({ principal_kind: "human", authority_profile: "owner", legacy_skill_access: 0 });
    expect(d.query("SELECT * FROM agents ORDER BY id").all().filter((a) => (a as { id: string }).id !== owner.agent_id)).toEqual(oldPrincipals);
    const beforeConflict = d.query("SELECT * FROM workspace_owners").all();
    // Two independent processes race an already claimed owner; both must refuse without mutation.
    const conflicts = await Promise.all(["Other human", "Replacement human"].map((name) => run(["src/cli.ts", "owner", "bootstrap", "--name", name, "--workspace-id", owner.workspace_id])));
    for (const conflict of conflicts) { expect(conflict.code).toBe(1); expect(conflict.stderr).toContain("already has an owner"); }
    expect((await run(["src/cli.ts", "owner", "bootstrap", "--name", "Promotion", "--workspace-id", owner.workspace_id, "--agent-id", owner.agent_id])).code).toBe(1);
    expect(d.query("SELECT * FROM workspace_owners").all()).toEqual(beforeConflict);
    const input = join(directory, "pairing.json");
    writeFileSync(input, JSON.stringify({ name: "CLI enrolled author", profile: "skill-author", runtime_id: "cli-fixture", expected_revision: 1, idempotency_key: "cli-pair" }));
    const pairing = await run(["src/cli.ts", "pairing", "create", "--input", input], { QOOPIA_API_KEY: owner.api_key }); success(pairing);
    writeFileSync(input, JSON.stringify({ code: JSON.parse(pairing.stdout).one_time_code }));
    success(await run(["src/cli.ts", "pairing", "redeem", "--input", input]));
    expect((await run(["src/cli.ts", "pairing", "redeem", "--input", input])).code).toBe(1);
    const ownerVerified = await probe("owner-verify", ownerFile); record("owner-verify", ownerVerified); success(ownerVerified);
    expect(ownerVerified.stdout).toContain('"sealed_bytes_unchanged":true');
    const readonly = { QOOPIA_SERVER_ROLE: "legacy-readonly" };
    const deniedOwner = await run(["src/cli.ts", "owner", "bootstrap", "--name", "Readonly", "--workspace-id", owner.workspace_id], readonly);
    expect(deniedOwner.code).toBe(1); expect(deniedOwner.stderr).toContain("rejects write");
    const readonlyProbe = await probe("readonly", ownerFile, readonly); record("readonly", readonlyProbe); success(readonlyProbe);
    const repeat = await run(["scripts/migrate.ts"]); success(repeat); expect(repeat.stdout).toContain("No pending migrations");
    expect(d.query("PRAGMA foreign_key_check").all()).toEqual([]);
    d.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
// This multi-process fixture also runs under x64 CPU emulation.
}, 120_000);
