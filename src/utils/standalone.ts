/** Where an installed (standalone) Qoopia keeps its files. */
import { env } from "./env.ts";

/** The installed layout's root; undefined when this process does not run from one. */
export function standaloneRoot(): string | undefined {
  const layout = process.env.QOOPIA_STANDALONE_LAYOUT;
  return layout ? JSON.parse(layout).root : undefined;
}

/** Where the owner identity lives: the standalone layout root, or the server root.
 * Undefined for a standalone server started without its layout. */
export function ownerIdentityRoot(): string | undefined {
  return process.env.QOOPIA_STANDALONE === "true" ? standaloneRoot() : env.ROOT_DIR;
}
