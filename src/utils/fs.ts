import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function safePath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('An absolute path is required');
  const target = process.platform === 'darwin' ? path.resolve(input).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : path.resolve(input);
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const s = fs.lstatSync(cursor);
      if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw new Error('Links and special files are refused');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return target;
}
export function privateDirectory(input: string) {
  const p = safePath(input);
  if (!fs.existsSync(p)) {
    const missing:string[]=[];let cursor=p;while(!fs.existsSync(cursor)){missing.push(cursor);cursor=path.dirname(cursor);}
    for(const directory of missing.reverse()){fs.mkdirSync(directory,{mode:0o700});syncDirectory(path.dirname(directory));}
  }
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('Directory must be owned by this user with mode 0700');
  return p;
}
export function syncDirectory(p: string) { const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** Additional staged files only: originals already consume available blocks.
 * This is a preflight, not a reservation; fsync/rename failures still refuse safely.
 */
export function preflightSpace(target: string, memberBytes: number[]) {
  let ancestor = safePath(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const space = fs.statfsSync(ancestor);
  const required = memberBytes.reduce((total, bytes) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('STAGING_SIZE_INVALID');
    return total + Math.ceil(bytes / space.bsize) * space.bsize;
  }, 0);
  if (!Number.isSafeInteger(required) || required > space.bavail * space.bsize) throw new Error('STAGING_SPACE_INSUFFICIENT');
  return {required_bytes:required,available_bytes:space.bavail * space.bsize};
}
export function durableWrite(file: string, value: string | Uint8Array, mode = 0o600) {
  safePath(file);
  preflightSpace(path.dirname(file), [typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength]);
  const temporary = file + '.stage-' + randomUUID();
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, value); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
}
export function durableCopyFile(source: string, file: string, expectedSize: number, expectedSha256: string, mode = 0o600) {
  source = safePath(source); file = safePath(file);
  if (source === file || fs.existsSync(file)) throw new Error('Copy destination must be new');
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Copy identity invalid');
  preflightSpace(path.dirname(file), [expectedSize]);
  const temporary = file + '.stage-' + randomUUID(), chunk = Buffer.allocUnsafe(1024 * 1024), digest = createHash('sha256');
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output: number | undefined;
  const identity = () => {
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Copy source unsafe');
    return {dev:stat.dev,ino:stat.ino,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs};
  };
  try {
    const before = identity();
    if (before.size !== expectedSize) throw new Error('Copy source changed or checksum mismatch');
    output = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
    let total = 0;
    while (true) {
      const bytes = fs.readSync(input, chunk, 0, chunk.length, null);
      if (!bytes) break;
      digest.update(chunk.subarray(0, bytes));
      for (let offset = 0; offset < bytes;) offset += fs.writeSync(output, chunk, offset, bytes - offset);
      total += bytes;
    }
    const after = identity();
    if (total !== expectedSize || digest.digest('hex') !== expectedSha256 || JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Copy source changed or checksum mismatch');
    fs.fchmodSync(output, mode); fs.fsyncSync(output); fs.closeSync(output); output = undefined;
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  } catch (error) {
    if (output !== undefined) { try { fs.closeSync(output); } catch {} }
    try { fs.unlinkSync(temporary); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup; }
    throw error;
  } finally { fs.closeSync(input); }
}
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export class JsonReadError extends Error {
  constructor(readonly code: 'JSON_TOO_LARGE' | 'JSON_UNSAFE' | 'JSON_CHANGED') { super(code); }
}
/** Fixed budget, including if the file grows after fstat; never trust a manifest's size as a budget. */
export function readJsonBytes(p: string): Buffer {
  safePath(p);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new JsonReadError('JSON_UNSAFE');
    if (before.size > MAX_JSON_BYTES) throw new JsonReadError('JSON_TOO_LARGE');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    const after = fs.fstatSync(fd);
    if (length > MAX_JSON_BYTES || after.size > MAX_JSON_BYTES) throw new JsonReadError('JSON_TOO_LARGE');
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new JsonReadError('JSON_CHANGED');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
export function readJson<T>(p: string): T { return JSON.parse(readJsonBytes(p).toString('utf8')); }
export function memberPath(root: string, member: string) {
  if (!member || member.includes('\\') || member.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(member)) throw new Error('Invalid artifact member');
  return safePath(path.join(root, member));
}
export function inventory(root: string, exclude = new Set<string>()) {
  const result: Record<string, { size: number; sha256: string; mode: number }> = {};
  let total = 0;
  const walk = (dir: string, prefix = '', depth = 0) => {
    if (depth > 24) throw new Error('Artifact depth exceeded');
    for (const n of fs.readdirSync(dir).sort()) {
      const name = prefix + n, p = memberPath(root, name), s = fs.lstatSync(p);
      if (s.isDirectory()) walk(p, name + '/', depth + 1);
      else if (!exclude.has(name)) {
        if (Object.keys(result).length >= 10000 || (total += s.size) > 750 * 1024 * 1024) throw new Error('Artifact size exceeded');
        result[name] = { size: s.size, sha256: hash(fs.readFileSync(p)), mode: s.mode & 0o777 };
      }
    }
  };
  safePath(root); walk(root); return result;
}
export function copyInventory(source: string, target: string, members: ReturnType<typeof inventory>) {
  preflightSpace(target, Object.values(members).map(record => record.size));
  privateDirectory(target);
  for (const [name, record] of Object.entries(members)) {
    const bytes = fs.readFileSync(memberPath(source, name));
    if (hash(bytes) !== record.sha256 || bytes.length !== record.size) throw new Error('Artifact changed while copying');
    const to = memberPath(target, name); privateDirectory(path.dirname(to)); durableWrite(to, bytes, record.mode);
  }
}

/** Full byte verification in bounded chunks, yielding between filesystem reads. */
export async function inventoryAsync(root:string,exclude=new Set<string>()) {
  const result:ReturnType<typeof inventory>={};let total=0,count=0;
  async function walk(dir:string,prefix='',depth=0):Promise<void>{
    if(depth>24)throw new Error('Artifact depth exceeded');
    for(const n of (await fs.promises.readdir(dir)).sort()){
      const name=prefix+n,p=memberPath(root,name),s=await fs.promises.lstat(p);
      if(s.isDirectory()){await walk(p,name+'/',depth+1);continue;}
      if(exclude.has(name))continue;
      if(!s.isFile()||s.nlink!==1)throw new Error('Artifact must be a regular unlinked file');
      if(++count>10000||(total+=s.size)>750*1024*1024)throw new Error('Artifact size exceeded');
      const handle=await fs.promises.open(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{
        const before=await handle.stat();
        if(before.dev!==s.dev||before.ino!==s.ino)throw new Error('Artifact changed while reading');
        const digest=new Bun.CryptoHasher('sha256'),buffer=Buffer.alloc(256*1024);let size=0;
        while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
          size+=bytesRead;if(size>s.size)throw new Error('Artifact changed while reading');digest.update(buffer.subarray(0,bytesRead));
        }
        const after=await handle.stat(),current=await fs.promises.lstat(memberPath(root,name));
        if(size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs||current.ino!==s.ino||current.dev!==s.dev)throw new Error('Artifact changed while reading');
        result[name]={size,sha256:digest.digest('hex'),mode:s.mode&0o777};
      }finally{await handle.close();}
    }
  }
  safePath(root);await walk(root);return result;
}
