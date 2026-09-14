import { describe, expect, test } from "bun:test";
import {
  resolveRuntimePaths,
  validateReleaseInputs,
  validateRuntimeConfiguration,
} from "../src/utils/runtime-config.ts";

const SHA = "a".repeat(40);

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    QOOPIA_ROOT: "/srv/qoopia",
    QOOPIA_DATA_DIR: "/srv/qoopia/data",
    QOOPIA_LOG_DIR: "/srv/qoopia/logs",
    QOOPIA_BACKUP_DIR: "/srv/qoopia/backups",
    QOOPIA_SERVER_ROLE: "canonical",
    QOOPIA_PORT: "3738",
    QOOPIA_EXPECTED_RELEASE_SHA: SHA,
    QOOPIA_RELEASE_STAMP_PATH: "/app/release.json",
    QOOPIA_ADMIN_SECRET: "test-only-admin-secret",
    QOOPIA_PUBLIC_URL: "https://mcp.example.test",
    QOOPIA_AUTO_MIGRATE: "false",
    ...overrides,
  };
}

describe("runtime configuration", () => {
  test("derives one canonical directory layout from QOOPIA_ROOT", () => {
    expect(resolveRuntimePaths({ QOOPIA_ROOT: "/srv/qoopia" })).toEqual({
      rootDir: "/srv/qoopia",
      dataDir: "/srv/qoopia/data",
      logDir: "/srv/qoopia/logs",
      backupDir: "/srv/qoopia/backups",
    });
  });

  test("accepts a complete production configuration", () => {
    expect(validateRuntimeConfiguration(productionEnv()).rootDir).toBe(
      "/srv/qoopia",
    );
  });

  test("rejects implicit roles, path aliases, and startup migration", () => {
    expect(() => validateRuntimeConfiguration(productionEnv({
      QOOPIA_SERVER_ROLE: "",
      QOOPIA_DATA_DIR: "/data",
      QOOPIA_AUTO_MIGRATE: "true",
    }))).toThrow("QOOPIA_SERVER_ROLE");
    try {
      validateRuntimeConfiguration(productionEnv({
        QOOPIA_SERVER_ROLE: "",
        QOOPIA_DATA_DIR: "/data",
        QOOPIA_AUTO_MIGRATE: "true",
      }));
    } catch (error) {
      const message = String(error);
      expect(message).toContain("QOOPIA_DATA_DIR must resolve to /srv/qoopia/data");
      expect(message).toContain("QOOPIA_AUTO_MIGRATE must be false");
    }
  });

  test("does not print secret values in validation failures", () => {
    const secret = "do-not-echo-this-secret";
    expect(() => validateRuntimeConfiguration(productionEnv({
      QOOPIA_ADMIN_SECRET: secret,
      QOOPIA_PUBLIC_URL: "not-a-url",
    }))).toThrow(/QOOPIA_PUBLIC_URL/);
    try {
      validateRuntimeConfiguration(productionEnv({
        QOOPIA_ADMIN_SECRET: secret,
        QOOPIA_PUBLIC_URL: "not-a-url",
      }));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("release inputs", () => {
  test("accepts only immutable image references", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(validateReleaseInputs({
      QOOPIA_IMAGE_REF: `registry.example/qoopia@${digest}`,
      QOOPIA_RELEASE_SHA: SHA,
      QOOPIA_ROOT: "/srv/qoopia",
      QOOPIA_SERVER_ROLE: "canonical",
      QOOPIA_PORT: "3738",
    }).imageRef).toEndWith(digest);
    expect(validateReleaseInputs({
      QOOPIA_IMAGE_REF: digest,
      QOOPIA_RELEASE_SHA: SHA,
      QOOPIA_ROOT: "/srv/qoopia",
      QOOPIA_SERVER_ROLE: "canonical",
      QOOPIA_PORT: "3738",
    }).imageRef).toBe(digest);
  });

  test("rejects mutable tags", () => {
    expect(() => validateReleaseInputs({
      QOOPIA_IMAGE_REF: "qoopia:latest",
      QOOPIA_RELEASE_SHA: SHA,
      QOOPIA_ROOT: "/srv/qoopia",
      QOOPIA_SERVER_ROLE: "canonical",
      QOOPIA_PORT: "3738",
    })).toThrow("registry digest");
  });
});

test('standalone generation keeps installation backups/OS logs; malformed layout and mismatched paths still refuse',()=>{
 const root='/tmp/Installed Ж space',generation=root+'/generations/generation-'+'a'.repeat(36),logs='/tmp/Owner Logs Ж';
 const config=productionEnv({QOOPIA_STANDALONE:'true',QOOPIA_ROOT:generation,QOOPIA_DATA_DIR:generation+'/data',QOOPIA_BACKUP_DIR:root+'/backups',QOOPIA_LOG_DIR:logs,QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root,logs})});
 expect(validateRuntimeConfiguration(config).backupDir).toBe(root+'/backups');
 expect(()=>validateRuntimeConfiguration({...config,QOOPIA_DATA_DIR:root+'/foreign'})).toThrow();
 expect(()=>validateRuntimeConfiguration({...config,QOOPIA_BACKUP_DIR:generation+'/backups'})).toThrow();
 expect(()=>validateRuntimeConfiguration({...config,QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root:'/other',logs})})).toThrow('layout');
});
