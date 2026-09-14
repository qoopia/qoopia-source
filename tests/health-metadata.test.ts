import { describe, expect, test } from "bun:test";
import {
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
