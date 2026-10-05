import path from 'node:path';
import { z } from 'zod';
import { durableWrite, privateDirectory, readJson } from '../utils/fs.ts';
import { readBoundedText } from '../utils/http-json.ts';

const targetSchema = z.object({ format: z.literal('qoopia-server-workspace/1'), url: z.string() }).strict();
const targetFile = (root: string) => path.join(root, 'server-workspace.json');

export function serverWorkspaceUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/dashboard'].includes(url.pathname)) {
    throw new Error('Use the HTTPS address of your Qoopia server, without credentials or query parameters');
  }
  return new URL('/dashboard', url.origin).href;
}

export function readServerWorkspace(root: string) {
  let value: unknown;
  try { value = readJson(targetFile(root)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error; // A damaged selection must never silently create a second workspace.
  }
  return serverWorkspaceUrl(targetSchema.parse(value).url);
}

export function selectServerWorkspace(root: string, input: string) {
  const url = serverWorkspaceUrl(input);
  privateDirectory(root);
  durableWrite(targetFile(root), JSON.stringify({ format: 'qoopia-server-workspace/1', url }) + '\n');
  return { url, data_location: 'server', local_data_preserved: true };
}

export type ServerReachability = 'reachable' | 'not_qoopia' | 'unreachable';
/** Read-only: GET <origin>/health with no credentials, cookies or redirects and a short deadline.
 * A Qoopia server answers JSON naming its version, status and role; anything else is not one. */
export async function probeServerWorkspace(input: string, request: typeof fetch = fetch, timeoutMs = 3000): Promise<ServerReachability> {
  let response: Response;
  try {
    response = await request(new URL('/health', serverWorkspaceUrl(input)).href,
      { headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch { return 'unreachable'; }
  try {
    const body = JSON.parse(await readBoundedText(response, 65_536)) as Record<string, unknown> | null;
    return response.ok && typeof body?.version === 'string' && typeof body.status === 'string' && typeof body.server_role === 'string' ? 'reachable' : 'not_qoopia';
  } catch { return 'not_qoopia'; }
}
