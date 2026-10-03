import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWriteProbe,
  evaluateReadiness,
  readSchemaVersion,
} from "../src/utils/health-metadata.ts";

describe("health metadata", () => {
  test("returns the current schema version", () => {
    const database = {
      prepare: () => ({ get: () => ({ version: 32 }) }),
    };
    expect(readSchemaVersion(database)).toBe(32);
  });

  test("returns null instead of breaking liveness when schema metadata is unavailable", () => {
    const database = {
      prepare: () => {
        throw new Error("schema metadata unavailable");
      },
    };
    expect(readSchemaVersion(database)).toBeNull();
  });
});

describe("readiness evaluation", () => {
  test("is ready only with a positive readable schema and no pending migrations", () => {
    const database = {
      prepare: () => ({ get: () => ({ version: 32 }) }),
    };

    expect(evaluateReadiness(database, () => [])).toEqual({
      ready: true,
      schema_version: 32,
      checks: {
        schema_version: "ok",
        pending_migrations: "ok",
        storage: "ok",
      },
    });
  });

  test("fails closed when the schema is readable but not initialized", () => {
    const database = {
      prepare: () => ({ get: () => ({ version: 0 }) }),
    };

    expect(evaluateReadiness(database, () => [])).toEqual({
      ready: false,
      schema_version: 0,
      checks: {
        schema_version: "uninitialized",
        pending_migrations: "ok",
        storage: "ok",
      },
    });
  });

  test("fails closed without exposing database schema read exceptions", () => {
    const database = {
      prepare: () => {
        throw new Error("secret database failure detail");
      },
    };

    const result = evaluateReadiness(database, () => []);
    expect(result).toEqual({
      ready: false,
      schema_version: null,
      checks: {
        schema_version: "unavailable",
        pending_migrations: "ok",
        storage: "ok",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret database failure detail");
  });

  test("fails closed without exposing pending-migration inspection exceptions", () => {
    const database = {
      prepare: () => ({ get: () => ({ version: 32 }) }),
    };

    const result = evaluateReadiness(database, () => {
      throw new Error("secret migration failure detail");
    });
    expect(result).toEqual({
      ready: false,
      schema_version: 32,
      checks: {
        schema_version: "ok",
        pending_migrations: "unavailable",
        storage: "ok",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret migration failure detail");
  });

  test("fails closed when the schema is newer than the newest migration this build ships", () => {
    const database = {
      prepare: () => ({ get: () => ({ version: 48 }) }),
    };

    expect(evaluateReadiness(database, () => [], { latestShippedMigration: () => 47 })).toEqual({
      ready: false,
      schema_version: 48,
      checks: {
        schema_version: "ahead",
        pending_migrations: "ok",
        storage: "ok",
      },
    });
    expect(evaluateReadiness(database, () => [], { latestShippedMigration: () => 48 }).ready).toBe(true);
  });

  test("fails closed when any migration is pending without exposing migration names", () => {
    const database = {
      prepare: () => ({ get: () => ({ version: 31 }) }),
    };

    const result = evaluateReadiness(database, () => ["032-secret-migration.sql"]);
    expect(result).toEqual({
      ready: false,
      schema_version: 31,
      checks: {
        schema_version: "ok",
        pending_migrations: "pending",
        storage: "ok",
      },
    });
    expect(JSON.stringify(result)).not.toContain("032-secret-migration.sql");
  });
});

describe("write capability and free space", () => {
  const database = { prepare: () => ({ get: () => ({ version: 32 }) }) };

  test("a database that refuses writes or a nearly full volume is not ready", () => {
    expect(evaluateReadiness(database, () => [], { probeWrite: () => "readonly" })).toEqual({
      ready: false,
      schema_version: 32,
      checks: { schema_version: "ok", pending_migrations: "ok", storage: "ok", db_write: "readonly" },
    });
    expect(evaluateReadiness(database, () => [], { probeWrite: () => "ok", freeBytes: () => 0, minFreeBytes: 1 })).toEqual({
      ready: false,
      schema_version: 32,
      checks: { schema_version: "ok", pending_migrations: "ok", storage: "low_space", db_write: "ok" },
    });
    expect(evaluateReadiness(database, () => [], { probeWrite: () => "ok", freeBytes: () => 2, minFreeBytes: 1 }).ready).toBe(true);
  });

  test("the probe sees a read-only connection and a lock held across probes, never a brief one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoopia-write-probe-")), file = path.join(dir, "probe.db");
    const live = new Database(file, { create: true });
    live.exec("PRAGMA journal_mode = WAL");
    live.exec("PRAGMA busy_timeout = 5000");
    let clock = 0;
    const probe = createWriteProbe(live, 5000, () => clock);
    try {
      expect(probe()).toBe("ok");
      live.exec("PRAGMA query_only = ON");
      expect(probe()).toBe("ok"); // cached for 10 s
      clock += 10_000;
      expect(probe()).toBe("readonly");
      live.exec("PRAGMA query_only = OFF");
      const other = new Database(file);
      other.exec("BEGIN IMMEDIATE");
      clock += 10_000;
      expect(probe()).toBe("ok"); // one busy probe may be a backup step or an operator's sqlite3
      clock += 10_000;
      expect(probe()).toBe("busy");
      other.exec("ROLLBACK");
      other.close();
      clock += 10_000;
      expect(probe()).toBe("ok");
      expect(live.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      expect(live.inTransaction).toBe(false);
    } finally {
      live.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
