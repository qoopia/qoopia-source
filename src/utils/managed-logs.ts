import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath, privateDirectory, durableWrite, readJson, syncDirectory } from './fs.ts';

const DAY = 86_400_000;
const FORMAT = 'qoopia-application-logs/1';
type Ledger = { format: typeof FORMAT; files: Record<string, { dev: number; ino: number; created: number }> };
function directory(root: string, create: boolean) {
  const dir = safePath(path.join(root, 'application'));
  if (create) { privateDirectory(root); privateDirectory(dir); }
  if (fs.existsSync(dir)) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('LOG_DIRECTORY_UNSAFE');
  }
  return dir;
}
function ledger(dir: string): Ledger {
  const file = path.join(dir, 'ownership.json');
  if (!fs.existsSync(file)) {
    if (fs.readdirSync(dir).length) throw new Error('LOG_OWNERSHIP_MISSING');
    return { format: FORMAT, files: {} };
  }
  const stat = fs.lstatSync(safePath(file));
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('LOG_OWNERSHIP_UNSAFE');
  const v = readJson<Ledger>(file);
  if (v.format !== FORMAT || !v.files || typeof v.files !== 'object') throw new Error('LOG_OWNERSHIP_INVALID');
  for (const [name, item] of Object.entries(v.files)) {
    if (!/^app-[a-f0-9-]{36}\.jsonl$/.test(name) || !item || !Number.isFinite(item.created) || !Number.isInteger(item.dev) || !Number.isInteger(item.ino)) throw new Error('LOG_OWNERSHIP_INVALID');
  }
  return v;
}
/** Only fixed safe event metadata is persisted. Existing console redaction remains separate. */
export function appendManagedLog(root: string, level: string, messageDigest: string, now = Date.now()) {
  const dir = directory(root, true), state = ledger(dir);
  let name = Object.keys(state.files).find(n => Math.floor(state.files[n]!.created / DAY) === Math.floor(now / DAY));
  if (!name) {
    name = 'app-' + randomUUID() + '.jsonl';
    const file = path.join(dir, name);
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    const s = fs.fstatSync(fd); fs.closeSync(fd);
    state.files[name] = { dev: s.dev, ino: s.ino, created: now };
    durableWrite(path.join(dir, 'ownership.json'), JSON.stringify(state));
  }
  const file = safePath(path.join(dir, name));
  const fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd), own = state.files[name]!;
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.dev !== own.dev || s.ino !== own.ino || (s.mode & 0o077)) throw new Error('LOG_FILE_UNSAFE');
    fs.writeSync(fd, JSON.stringify({ at: new Date(now).toISOString(), level, event_sha256: messageDigest }) + '\n');
  } finally { fs.closeSync(fd); }
}
export function retainManagedLogs(root: string, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('LOG_CLOCK_INVALID');
  const dir = directory(root, false);
  if (!fs.existsSync(dir)) return { deleted: 0, retained: 0, days: 14, status: 'not_initialized' };
  const state = ledger(dir); let deleted = 0;
  for (const [name, own] of Object.entries(state.files)) {
    const file = safePath(path.join(dir, name));
    if (!fs.existsSync(file)) throw new Error('LOG_FILE_MISSING');
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.dev !== own.dev || s.ino !== own.ino || (s.mode & 0o077)) throw new Error('LOG_FILE_UNSAFE');
    // Both creation and last write must be strictly older; exact boundary and future files stay.
    if (Math.max(own.created, s.mtimeMs) < now - 14 * DAY) {
      fs.unlinkSync(file); delete state.files[name]; deleted++;
    }
  }
  if (deleted) { durableWrite(path.join(dir, 'ownership.json'), JSON.stringify(state)); syncDirectory(dir); }
  return { deleted, retained: Object.keys(state.files).length, days: 14, status: 'ok' };
}

export function inspectManagedLogs(root: string) {
  try {
    const dir=directory(root,false);
    if (!fs.existsSync(dir)) return {status:'unknown',reason:'LOGS_NOT_INITIALIZED',action:'Logs initialize on the first standalone log event.'};
    const state=ledger(dir);
    for (const [name,own] of Object.entries(state.files)) {
      const s=fs.lstatSync(safePath(path.join(dir,name)));
      if (!s.isFile() || s.nlink!==1 || s.uid!==process.getuid?.() || s.dev!==own.dev || s.ino!==own.ino || (s.mode&0o077)) throw new Error('unsafe');
    }
    return {status:'pass',reason:'LOG_OWNERSHIP_VERIFIED',action:'14-day deletion runs through maintenance.',managed_files:Object.keys(state.files).length};
  } catch {return {status:'fail',reason:'LOG_OWNERSHIP_INVALID',action:'Preserve files; inspect ownership or corruption before maintenance.'};}
}

export function previewManagedEvents(root: string) {
  if(inspectManagedLogs(root).status!=='pass')return [];
  const dir=directory(root,false),state=ledger(dir);
  const name=Object.keys(state.files).sort((a,b)=>state.files[b]!.created-state.files[a]!.created)[0];
  if(!name)return [];
  const file=safePath(path.join(dir,name)),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const size=fs.fstatSync(fd).size,bytes=Buffer.alloc(Math.min(size,8192));
    fs.readSync(fd,bytes,0,bytes.length,Math.max(0,size-bytes.length));
    return bytes.toString('utf8').split('\n').flatMap(line=>{
      try{
        const v=JSON.parse(line);
        if(typeof v.at!=='string'||!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v.at)||!['debug','info','warn','error'].includes(v.level)||typeof v.event_sha256!=='string'||! /^[a-f0-9]{64}$/.test(v.event_sha256))return [];
        return [{at:v.at as string,level:v.level as string,event_sha256:v.event_sha256 as string}];
      }catch{return [];}
    }).slice(-20);
  }finally{fs.closeSync(fd);}
}
