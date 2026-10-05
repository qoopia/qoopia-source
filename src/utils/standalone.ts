/** Where an installed (standalone) Qoopia keeps its files. */
import { env } from "./env.ts";

/** The installed layout's root; undefined when this process does not run from one. */
export function standaloneRoot(): string | undefined {
  const layout = process.env.QOOPIA_STANDALONE_LAYOUT;
  return layout ? JSON.parse(layout).root : undefined;
}

/** The origin clients on this machine use. An installed Qoopia serves them over loopback even when a
 * tunnel set PUBLIC_URL: the tunnel edge publishes only the MCP and OAuth routes, never /memory/*. */
export function localServiceOrigin(): string {
  return process.env.QOOPIA_STANDALONE === "true" ? `http://127.0.0.1:${env.PORT}` : new URL(env.PUBLIC_URL).origin;
}

/** Where the owner identity lives: the standalone layout root, or the server root.
 * Undefined for a standalone server started without its layout. */
export function ownerIdentityRoot(): string | undefined {
  return process.env.QOOPIA_STANDALONE === "true" ? standaloneRoot() : env.ROOT_DIR;
}
