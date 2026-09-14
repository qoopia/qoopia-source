import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Standalone launcher sets this before loading domain modules. Source callers retain repository paths. */
export function assetPath(relative: string) {
  const root = process.env.QOOPIA_BUNDLE_ASSETS || fileURLToPath(new URL('../../', import.meta.url));
  return path.join(root, relative);
}
