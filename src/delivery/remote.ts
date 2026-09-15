import path from 'node:path';
import { z } from 'zod';
import { durableWrite, privateDirectory, readJson } from '../utils/fs.ts';

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
