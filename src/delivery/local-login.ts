import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { privateDirectory, safePath, durableWrite } from '../utils/fs.ts';

/** Installation lock is held by the caller. Keep login across process and bundle updates. */
export function localSessionSecret(root: string): string {
  const directory = privateDirectory(path.join(root, 'config'));
  const file = safePath(path.join(directory, 'dashboard-session.key'));
  if (!fs.existsSync(file)) durableWrite(file, randomBytes(32).toString('hex'));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size !== 64) throw new Error('Unsafe dashboard session key');
    const secret = fs.readFileSync(fd, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid dashboard session key');
    return secret;
  } finally { fs.closeSync(fd); }
}
const pending = new Map<string,{ownerId:string;expires:number}>();
const digest=(code:string)=>createHash('sha256').update(code).digest('hex');
/** Capability issued only by the local OS launcher; never an HTTP owner-create endpoint. */
export function issueLocalLogin(ownerId:string, now=Date.now()) {
  const code=randomBytes(16).toString('hex');pending.clear();pending.set(digest(code),{ownerId,expires:now+300000});return code;
}
export function consumeLocalLogin(code:string, now=Date.now()) {
  if(!/^[a-f0-9]{32}$/.test(code))return null;
  const k=digest(code),entry=pending.get(k);pending.delete(k);
  return entry&&entry.expires>now?entry.ownerId:null;
}

/** The password form and fetch path share the same bounded, single-field POST body. */
export function parseLocalLoginBody(bytes: Buffer, contentType: string | undefined): string {
  if (bytes.length > 1024) throw new Error('Login request too large');
  let code: unknown;
  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(bytes.toString('utf8'));
    if ([...form.keys()].length !== 1 || !form.has('code')) throw new Error('Invalid login form');
    code = form.get('code');
  } else if (type === 'application/json') {
    const body: unknown = JSON.parse(bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('code' in body)) throw new Error('Invalid login body');
    code = body.code;
  } else throw new Error('Unsupported login content type');
  if (typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) throw new Error('Invalid login code');
  return code;
}
