#!/usr/bin/env bun
import {
  validateReleaseInputs,
  validateRuntimeConfiguration,
} from "../src/utils/runtime-config.ts";

const releaseInputsOnly = process.argv.includes("--release-inputs");

try {
  if (releaseInputsOnly) {
    const result = validateReleaseInputs();
    console.log(JSON.stringify({
      ok: true,
      mode: "release-inputs",
      image_ref: result.imageRef,
      release_sha: result.releaseSha,
      root: result.rootDir,
      server_role: result.serverRole,
      port: result.port,
    }, null, 2));
  } else {
    const paths = validateRuntimeConfiguration();
    console.log(JSON.stringify({
      ok: true,
      mode: process.env.NODE_ENV === "production" ? "production" : "development",
      root: paths.rootDir,
      data: paths.dataDir,
      logs: paths.logDir,
      backups: paths.backupDir,
      server_role: process.env.QOOPIA_SERVER_ROLE || null,
    }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
