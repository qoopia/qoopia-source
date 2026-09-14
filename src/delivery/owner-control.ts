import fs from 'node:fs';
import { dlopen, ptr } from 'bun:ffi';
import { z } from 'zod';
import { ownerSocketPath } from './platform-paths.ts';
import { assetPath } from '../utils/assets.ts';

export const ownerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('bootstrap'), name: z.string().trim().min(1).max(120), workspaceName: z.string().trim().min(1).max(120).optional(), workspaceId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ operation: z.literal('login'), ownerId: z.string().min(1).max(200).optional() }).strict(),
]);
export type OwnerRequest = z.infer<typeof ownerRequestSchema>;
export type OwnerResponse = { code: string; expiresInSeconds: number } | { error: string };
export function openOwnerPeer(library = assetPath(`native/owner-peer.${process.platform === 'darwin' ? 'dylib' : 'so'}`)) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('UID-authenticated owner IPC unavailable on this platform');
  return dlopen(library, {
    qp_listen: { args: ['ptr'], returns: 'i32' },
    qp_accept: { args: ['i32', 'u32'], returns: 'i32' },
    qp_connect: { args: ['ptr', 'u32'], returns: 'i32' },
    qp_peer: { args: ['i32', 'u32'], returns: 'i32' },
    qp_read: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    qp_write: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
    qp_close: { args: ['i32'], returns: 'void' },
  });
}
function checkSocket(file: string) {
  const s = fs.lstatSync(file);
  if (!s.isSocket() || s.uid !== process.getuid!() || (s.mode & 0o777) !== 0o600) throw new Error('Unsafe owner control socket');
  return s;
}
/** Caller holds the installation lifetime lock. Path protection supplements kernel UID checks. */
export function startOwnerControl(root: string, handle: (input: unknown) => OwnerResponse, library?: string) {
  const native = openOwnerPeer(library), api = native.symbols;
  const clients = new Map<number, { input: Buffer; output?: Buffer; deadline: number }>();
  let listener = -1;
  let file: string;
  try {
    file = ownerSocketPath(root, true);
    if (fs.existsSync(file)) { checkSocket(file); fs.unlinkSync(file); } // stale socket, under installation lock
    listener = api.qp_listen(ptr(Buffer.from(file + '\0')));
    if (listener < 0) throw new Error(`UID-authenticated owner IPC bind refused or unavailable (errno ${-listener})`);
    const created = checkSocket(file);
    const closeClient = (fd: number) => { api.qp_close(fd); clients.delete(fd); };
    const timer = setInterval(() => {
      for (let n = 0; n < 16 && clients.size < 16; n++) {
        const fd = api.qp_accept(listener, process.getuid!());
        if (fd === -2) break;
        if (fd < 0) continue; // foreign/unknown UID: already closed before any bytes read
        clients.set(fd, { input: Buffer.alloc(0), deadline: performance.now() + 5000 });
      }
      for (const [fd, client] of clients) {
        if (performance.now() >= client.deadline) { closeClient(fd); continue; }
        if (!client.output) {
          const buffer = Buffer.alloc(4097), n = api.qp_read(fd, ptr(buffer), buffer.length);
          if (n === -2) continue;
          if (n <= 0 || client.input.length + n > 4096) { closeClient(fd); continue; }
          client.input = Buffer.concat([client.input, buffer.subarray(0, n)]);
          const end = client.input.indexOf(10);
          if (end < 0) continue;
          let response: OwnerResponse;
          try {
            if (end !== client.input.length - 1) throw new Error('One request per connection');
            response = handle(JSON.parse(client.input.toString('utf8')));
          } catch { response = { error: 'Owner request refused; use explicit bootstrap once or select an existing active human owner' }; }
          client.input = Buffer.alloc(0);
          client.output = Buffer.from(JSON.stringify(response) + '\n');
        }
        const n = api.qp_write(fd, ptr(client.output), client.output.length);
        if (n === -2) continue;
        if (n <= 0 || n === client.output.length) closeClient(fd);
        else client.output = client.output.subarray(n);
      }
    }, 20);
    timer.unref();
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      clearInterval(timer);
      for (const fd of clients.keys()) closeClient(fd);
      api.qp_close(listener);
      const current = fs.existsSync(file) ? fs.lstatSync(file) : null;
      if (current?.ino === created.ino && current.dev === created.dev) fs.unlinkSync(file);
      native.close();
    };
  } catch (error) { if (listener >= 0) api.qp_close(listener); native.close(); throw error; }
}

export async function requestOwnerLogin(root: string, request: OwnerRequest, library?: string): Promise<OwnerResponse> {
  ownerRequestSchema.parse(request);
  const file = ownerSocketPath(root); checkSocket(file);
  const native = openOwnerPeer(library), api = native.symbols;
  const fd = api.qp_connect(ptr(Buffer.from(file + '\0')), process.getuid!());
  if (fd < 0) { native.close(); throw new Error('Owner IPC unavailable or server UID refused'); }
  try {
    let outgoing = Buffer.from(JSON.stringify(request) + '\n'), incoming = Buffer.alloc(0);
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (outgoing.length) {
        const n = api.qp_write(fd, ptr(outgoing), outgoing.length);
        if (n === -1 || n === 0) throw new Error('Owner IPC write refused');
        if (n > 0) outgoing = outgoing.subarray(n);
      } else {
        const buffer = Buffer.alloc(4097), n = api.qp_read(fd, ptr(buffer), buffer.length);
        if (n === -1 || n === 0) throw new Error('Owner IPC closed without a response');
        if (n > 0) {
          incoming = Buffer.concat([incoming, buffer.subarray(0, n)]);
          if (incoming.length > 4096) throw new Error('Owner IPC response too large');
          if (incoming.includes(10)) {
            return z.union([z.object({ code: z.string().regex(/^[a-f0-9]{32}$/), expiresInSeconds: z.literal(300) }).strict(), z.object({ error: z.string() }).strict()]).parse(JSON.parse(incoming.toString('utf8')));
          }
        }
      }
      await Bun.sleep(20);
    }
    throw new Error('Owner IPC timed out');
  } finally { api.qp_close(fd); native.close(); }
}
