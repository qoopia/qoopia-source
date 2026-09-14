import { verifyReleaseBaseline } from "./utils/release-baseline.ts";
import { validateRuntimeConfiguration } from "./utils/runtime-config.ts";

// `bun run start` is always the sealed operational path, even if a caller
// forgot NODE_ENV. Validate the production contract before any DB module loads.
const releaseEnv = { ...process.env, NODE_ENV: "production" };
validateRuntimeConfiguration(releaseEnv);
verifyReleaseBaseline({ env: releaseEnv });
await import("./index.ts");
