import { Database } from 'bun:sqlite';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './commands.ts';
import { assertPortableMembers, checkMembers } from './format.ts';
import { checkPath } from './legacy/archive.ts';
import { QoopiaError, type QoopiaErrorCode } from '../utils/errors.ts';

export type FileMap=Record<string,{sha256:string;size:number}>;
interface Owned { installation:string; runtime:string; skill_id:string; version_id:string; projection_digest:string; operation_id:string; epoch:number; files:FileMap; removed?:boolean; }
interface Ledger { format:'qoopia-native-ledger/1'; installation:string; runtime:string; targets:Record<string,Owned>; }
interface Journal { format:'qoopia-native-journal/1'; target:string; stage:string; backup:string; old:Owned|null; next:Owned; }
export type Boundary='staged'|'intent'|'old_renamed'|'new_renamed'|'readback'|'ledger_committed';
export interface NativeOperation { root:string; installation:string; runtime:string; target:string; skill_id:string; version_id:string;
  projection_digest:string; operation_id:string; epoch:number; files:Map<string,Buffer>; guard:()=>void; fault?:(boundary:Boundary)=>void; }
function refuse(code:QoopiaErrorCode,message:string):never {throw new QoopiaError(code,message);}
export function existingRoot(root:string):string {
  if(!isAbsolute(root))refuse('INVALID_INPUT','Managed root must be an absolute, existing directory');
  const real=realpathSync(root);
  // /tmp may itself resolve to /private/tmp on macOS. Reject links beneath that system alias.
  let cursor=real;
  while(cursor!==dirname(cursor)){if(lstatSync(cursor).isSymbolicLink())refuse('FORBIDDEN','Managed root must not traverse symlinks');cursor=dirname(cursor);}
  if(!lstatSync(real).isDirectory() || (lstatSync(real).mode&0o022)!==0)refuse('FORBIDDEN','Managed root must be a directory not writable by other users');
  if((process.platform==='darwin'?resolve(root).replace(/^\/tmp\//,'/private/tmp/'):resolve(root))!==real)refuse('FORBIDDEN','Managed root cannot be an alias');
  return real;
}
function pathIn(root:string,name:string,createParents=false):string{
  checkPath(name);
  const target=join(root,name),rel=relative(root,target);
  if(rel.startsWith('..')||isAbsolute(rel))refuse('FORBIDDEN','Path escaped managed root');
  const pieces=name.split('/');let cursor=root;
  for(let i=0;i<pieces.length;i++){
    cursor=join(cursor,pieces[i]!);
    if(!existsSync(cursor)){
      // lstat catches dangling links which existsSync intentionally follows.
      try{lstatSync(cursor);refuse('MANUAL_DRIFT','Dangling native link is not managed');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(createParents && i<pieces.length-1){mkdirSync(cursor,{mode:0o700});syncDir(dirname(cursor));}else continue;
    }
    if(existsSync(cursor)){
      const stat=lstatSync(cursor);
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1)))refuse('MANUAL_DRIFT','Symlinks, hardlinks and special files are not managed');
      if(i<pieces.length-1&&!stat.isDirectory())refuse('MANUAL_DRIFT','Native parent is not a directory');
    }
  }
  return target;
}
function syncDir(dir:string){const fd=openSync(dir,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function durable(file:string,bytes:string|Buffer){
  const tmp=file+'.tmp-'+randomUUID();const fd=openSync(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,file);syncDir(dirname(file));
}
// Public projection/adoption hashing always rejects links, with no exclusions.
export function hashTree(root:string):FileMap{return hashNativeTree(root);}
/** Only the run adapter supplies these trusted current/immutable attempt bindings.
 * Bookkeeping is not frozen content or filesystem-write evidence. Never follow it. */
export function createRunSnapshot(root:string,attempts:readonly {loadout_id:string;attempt_id:string}[]){
  if(existingRoot(root)!==root)refuse('MANUAL_DRIFT','Run snapshot root must be canonical');
  const homes=new Set<string>(),pins=new Map<string,{dev:number;ino:number}>();
  const directory=(path:string)=>{
    let stat;try{stat=lstatSync(path);}catch{refuse('MANUAL_DRIFT','Runtime bookkeeping boundary disappeared');}
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0||realpathSync(path)!==path)
      refuse('MANUAL_DRIFT','Runtime bookkeeping boundary is not an owned canonical directory');
    return stat;
  };
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  for(const a of attempts){
    if(!uuid.test(a.loadout_id)||!uuid.test(a.attempt_id))refuse('MANUAL_DRIFT','Invalid runtime bookkeeping attempt binding');
    const session=join(root,'sessions',a.loadout_id),home=join(session,`native-${a.attempt_id}`);
    for(const path of [root,join(root,'sessions'),session,home]){const stat=directory(path);pins.set(path,{dev:stat.dev,ino:stat.ino});}
    homes.add(home);
  }
  const validate=()=>{for(const [path,pin] of pins){const stat=directory(path);if(stat.dev!==pin.dev||stat.ino!==pin.ino)refuse('MANUAL_DRIFT','Runtime bookkeeping boundary was replaced');}};
  return ()=>{validate();const files=hashNativeTree(root,homes);validate();return files;};
}
export interface NativeBinaryPin {path:string;dev:number;ino:number;uid:number;}
const codexArg0Names=['apply_patch','applypatch','codex-execve-wrapper'] as const;
function codexArg0(home:string,expected?:NativeBinaryPin){
  const ownedDirectory=(path:string)=>{
    let stat;try{stat=lstatSync(path);}catch{refuse('MANUAL_DRIFT','Codex bookkeeping boundary disappeared');}
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0||realpathSync(path)!==path)
      refuse('MANUAL_DRIFT','Codex bookkeeping boundary is not an owned canonical directory');
    return stat;
  };
  const arg0=join(home,'.codex','tmp','arg0');
  for(const path of [home,join(home,'.codex'),join(home,'.codex','tmp'),arg0])ownedDirectory(path);
  const generatedNames=readdirSync(arg0);
  if(generatedNames.length!==1)refuse('MANUAL_DRIFT','Codex bookkeeping must contain one exact generated directory');
  const generated=join(arg0,generatedNames[0]!);ownedDirectory(generated);
  if(canonical(readdirSync(generated).sort())!==canonical([...codexArg0Names,'.lock'].sort()))
    refuse('MANUAL_DRIFT','Codex bookkeeping contains unexpected entries');
  const lockStat=lstatSync(join(generated,'.lock'));
  if(!lockStat.isFile()||lockStat.isSymbolicLink()||lockStat.uid!==process.getuid?.()||lockStat.nlink!==1||lockStat.size!==0||(lockStat.mode&0o777)!==0o600)
    refuse('MANUAL_DRIFT','Codex bookkeeping lock file is not the exact owned private file');
  let installed:NativeBinaryPin|undefined;
  const links=codexArg0Names.map(name=>{
    const path=join(generated,name),stat=lstatSync(path);
    if(!stat.isSymbolicLink()||stat.uid!==process.getuid?.())refuse('MANUAL_DRIFT','Codex bookkeeping alias is not an owned symlink');
    const target=readlinkSync(path);
    if(!isAbsolute(target)||realpathSync(target)!==target)refuse('MANUAL_DRIFT','Codex bookkeeping target is not canonical');
    const targetStat=lstatSync(target),pin={path:target,dev:targetStat.dev,ino:targetStat.ino,uid:targetStat.uid};
    if(!targetStat.isFile()||targetStat.isSymbolicLink()||targetStat.nlink!==1||targetStat.uid!==process.getuid?.()||
      (targetStat.mode&0o111)===0||(targetStat.mode&0o022)!==0)refuse('MANUAL_DRIFT','Codex bookkeeping target is not the owned installed executable');
    installed??=pin;
    if(canonical(pin)!==canonical(installed)||expected&&canonical(pin)!==canonical(expected))
      refuse('MANUAL_DRIFT','Codex bookkeeping aliases do not target the exact installed executable');
    return path;
  });
  return {generated,installed:installed!,links};
}
/** Metadata from the exact successful version probe; no target or credential bytes are read. */
export function codexBookkeepingBinary(home:string):NativeBinaryPin{return codexArg0(home).installed;}
/** Strict Codex still hashes every ordinary HOME entry and omits only three pinned vendor aliases. */
export function createStrictCodexRunSnapshot(root:string,attempts:readonly {loadout_id:string;attempt_id:string}[],installed:NativeBinaryPin){
  if(existingRoot(root)!==root)refuse('MANUAL_DRIFT','Run snapshot root must be canonical');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const homes=attempts.map(a=>{
    if(!uuid.test(a.loadout_id)||!uuid.test(a.attempt_id))refuse('MANUAL_DRIFT','Invalid runtime bookkeeping attempt binding');
    return join(root,'sessions',a.loadout_id,`native-${a.attempt_id}`);
  });
  const initial=homes.map(home=>codexArg0(home,installed)),pins=new Map(initial.map(v=>[v.generated,{dev:lstatSync(v.generated).dev,ino:lstatSync(v.generated).ino}]));
  const validate=()=>{
    const links=new Map<string,string>();
    for(const home of homes){const current=codexArg0(home,installed),pin=pins.get(current.generated);
      if(!pin||lstatSync(current.generated).dev!==pin.dev||lstatSync(current.generated).ino!==pin.ino)refuse('MANUAL_DRIFT','Codex bookkeeping boundary was replaced');
      for(const path of current.links)links.set(path,installed.path);
    }
    return links;
  };
  return ()=>{const links=validate(),files=hashNativeTree(root,new Set(),links);validate();return files;};
}
function hashNativeTree(root:string,bookkeeping:ReadonlySet<string>=new Set(),allowedLinks:ReadonlyMap<string,string>=new Map()):FileMap{
  const files:FileMap={};let total=0;
  const walk=(dir:string,prefix:string,depth:number)=>{
    if(depth>20)refuse('SIZE_LIMIT','Native tree depth exceeded');
    for(const n of readdirSync(dir).sort()){
      const name=prefix?`${prefix}/${n}`:n;checkPath(name);const p=join(dir,n),st=lstatSync(p);
      if(st.isSymbolicLink()){
        if(allowedLinks.get(p)===readlinkSync(p))continue;
        refuse('MANUAL_DRIFT','Native tree contains a link or special file');
      }
      if(!st.isDirectory()&&(!st.isFile()||st.nlink!==1))refuse('MANUAL_DRIFT','Native tree contains a link or special file');
      if(st.isDirectory()){if(!bookkeeping.has(p))walk(p,name,depth+1);}
      else{
        if(st.size>4*1024*1024 || (total+=st.size)>64*1024*1024 || Object.keys(files).length>=512)refuse('SIZE_LIMIT','Native tree exceeds package limits');
        const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const bytes=readFileSync(fd);files[name]={size:bytes.length,sha256:digest(bytes)};}finally{closeSync(fd);}
      }
    }
  };
  if(existsSync(root)){if(!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())refuse('MANUAL_DRIFT','Native target is not a directory');walk(root,'',0);}return files;
}
function same(root:string,files:FileMap){return existsSync(root)&&canonical(hashTree(root))===canonical(files);}
function removeExact(root:string,files:FileMap){
  if(!same(root,files))refuse('MANUAL_DRIFT','Cleanup refused: owned bytes were edited');
  for(const name of Object.keys(files))unlinkSync(pathIn(root,name));
  const prune=(dir:string)=>{for(const n of readdirSync(dir)){const p=join(dir,n);if(lstatSync(p).isDirectory())prune(p);}if(!readdirSync(dir).length)rmdirSync(dir);};
  prune(root);syncDir(dirname(root));
}
function control(root:string,installation:string,runtime:string):{dir:string;ledger:Ledger}{
  const dir=pathIn(root,'.qoopia');
  if(!existsSync(dir)){
    mkdirSync(dir,{mode:0o700});syncDir(root);
    durable(join(dir,'ledger.json'),canonical({format:'qoopia-native-ledger/1',installation,runtime,targets:{}}));
  }
  pathIn(root,'.qoopia/ledger.json');
  if(!existsSync(join(dir,'ledger.json')))refuse('CONFLICT','Existing control directory has no ownership ledger; adoption preview required');
  const ledger=JSON.parse(readFileSync(join(dir,'ledger.json'),'utf8')) as Ledger;
  if(ledger.format!=='qoopia-native-ledger/1'||ledger.installation!==installation||ledger.runtime!==runtime)refuse('CONFLICT','Managed root belongs to another installation/runtime');
  return {dir,ledger};
}
function recoverLocked(root:string,dir:string,ledger:Ledger){
  const journalFile=pathIn(root,'.qoopia/journal.json');
  if(!existsSync(journalFile))return;
  const j=JSON.parse(readFileSync(journalFile,'utf8')) as Journal;
  if(j.format!=='qoopia-native-journal/1' || j.next.installation!==ledger.installation || j.next.runtime!==ledger.runtime || !j.stage.startsWith('.qoopia/stage-') || !j.backup.startsWith('.qoopia/backup-'))refuse('QUARANTINED','Invalid projection recovery journal');
  const target=pathIn(root,j.target),stage=pathIn(root,j.stage),backup=pathIn(root,j.backup);
  if(same(target,j.next.files)){
    ledger.targets[j.target]=j.next;durable(join(dir,'ledger.json'),canonical(ledger));
    if(existsSync(backup)){if(!j.old)refuse('MANUAL_DRIFT','Unexpected projection backup');removeExact(backup,j.old.files);}
  }else if(!existsSync(target) && j.old && same(backup,j.old.files)){
    renameSync(backup,target);syncDir(dirname(target));syncDir(dir);
  }else if(!existsSync(target) && !j.old){
    // Initial activation crashed before the new rename; absence is the whole old projection.
  }else if(!j.old || !same(target,j.old.files))refuse('MANUAL_DRIFT','Recovery found user edits; preserved all copies for inspection');
  if(existsSync(stage))removeExact(stage,j.next.files);
  unlinkSync(journalFile);syncDir(dir);
}
function locked<T>(rootArg:string,installation:string,runtime:string,fn:(root:string,dir:string,ledger:Ledger)=>T):T{
  const root=existingRoot(rootArg),{dir}=control(root,installation,runtime);
  const lockPath=pathIn(root,'.qoopia/coordinator.sqlite');
  const lock=new Database(lockPath,{create:true});
  try{
    lock.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS coordinator(id INTEGER PRIMARY KEY);');
    // SQLite's OS byte-range exclusive writer lock is released by the OS on crash.
    // ponytail: local filesystems only; distributed/shared-FS coordination is unsupported.
    return lock.transaction(()=>{
      const {ledger}=control(root,installation,runtime);recoverLocked(root,dir,ledger);return fn(root,dir,ledger);
    }).immediate();
  }finally{lock.close();}
}
export function recoverProjection(root:string,installation:string,runtime:string){return locked(root,installation,runtime,()=>({recovered:true}));}
export function materializeOwned(op:NativeOperation){
  checkMembers(op.files);assertPortableMembers(op.files);
  const files:FileMap=Object.fromEntries([...op.files].map(([n,b])=>[n,{size:b.length,sha256:digest(b)}]));
  if(digest(canonical(files))!==op.projection_digest)refuse('CHECKSUM_MISMATCH','Projection bytes differ from consent');
  if(!Number.isSafeInteger(op.epoch)||op.epoch<1)refuse('INVALID_INPUT','Positive fencing epoch required');
  return locked(op.root,op.installation,op.runtime,(root,dir,ledger)=>{
    op.guard();
    const target=pathIn(root,op.target,true),old=ledger.targets[op.target]??null;
    if(old?.removed)refuse('STALE_REVISION','Removed native target is fenced; open a new session');
    if(old && (op.epoch<old.epoch || (op.epoch===old.epoch && (old.projection_digest!==op.projection_digest || old.operation_id!==op.operation_id))))refuse('STALE_REVISION','Durable native fencing rejected an old worker');
    if(old && !same(target,old.files))refuse('MANUAL_DRIFT','Managed files changed; preserve a fork or restore the reviewed bytes before update');
    if(!old && existsSync(target))refuse('CONFLICT','Same-name directory is user-owned; choose a new name or approve adoption preview');
    if(old && old.projection_digest===op.projection_digest && old.epoch===op.epoch)return {state:'projection_readback',projection_digest:op.projection_digest,replayed:true};
    const next:Owned={installation:op.installation,runtime:op.runtime,skill_id:op.skill_id,version_id:op.version_id,projection_digest:op.projection_digest,operation_id:op.operation_id,epoch:op.epoch,files};
    const stageName=`.qoopia/stage-${randomUUID()}`,backupName=`.qoopia/backup-${randomUUID()}`;
    const stage=pathIn(root,stageName);mkdirSync(stage,{mode:0o700});syncDir(dir);
    for(const [name,bytes]of op.files){const p=pathIn(stage,name,true),fd=openSync(p,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}syncDir(dirname(p));}
    syncDir(stage);op.fault?.('staged');
    if(!same(stage,files))refuse('CHECKSUM_MISMATCH','Staged readback failed');
    op.guard();
    durable(join(dir,'journal.json'),canonical({format:'qoopia-native-journal/1',target:op.target,stage:stageName,backup:backupName,old,next}));op.fault?.('intent');
    if(old){renameSync(target,pathIn(root,backupName));syncDir(dirname(target));syncDir(dir);}op.fault?.('old_renamed');
    renameSync(stage,target);syncDir(dirname(target));syncDir(dir);op.fault?.('new_renamed');
    if(!same(target,files))refuse('CHECKSUM_MISMATCH','Final native readback failed');op.fault?.('readback');
    ledger.targets[op.target]=next;durable(join(dir,'ledger.json'),canonical(ledger));op.fault?.('ledger_committed');
    if(old)removeExact(pathIn(root,backupName),old.files);
    unlinkSync(join(dir,'journal.json'));syncDir(dir);
    return {state:'projection_readback',projection_digest:op.projection_digest,replayed:false};
  });
}
export function previewAdoption(rootArg:string,targetName:string){
  const root=existingRoot(rootArg),target=pathIn(root,targetName);
  if(!existsSync(target))refuse('NOT_FOUND','Adoption target must already exist');
  const files=hashTree(target);
  return {target:targetName,files,preview_digest:digest(canonical({target:targetName,files})),effect:'Take ownership of exactly these unchanged files; subsequent replacement is a separate operation'};
}
export function adoptOwned(input:{root:string;installation:string;runtime:string;target:string;preview_digest:string;skill_id:string;version_id:string;operation_id:string}){
  return locked(input.root,input.installation,input.runtime,(root,dir,ledger)=>{
    const preview=previewAdoption(root,input.target);
    if(preview.preview_digest!==input.preview_digest)refuse('STALE_REVISION','Adoption preview changed; nothing was taken over');
    const owned=ledger.targets[input.target];
    if(owned){if(owned.operation_id===input.operation_id&&canonical(owned.files)===canonical(preview.files))return preview;refuse('CONFLICT','Target already has managed ownership');}
    ledger.targets[input.target]={installation:input.installation,runtime:input.runtime,skill_id:input.skill_id,version_id:input.version_id,
      operation_id:input.operation_id,epoch:0,files:preview.files,projection_digest:digest(canonical(preview.files))};
    durable(join(dir,'ledger.json'),canonical(ledger));return preview;
  });
}
export function removeOwned(rootArg:string,installation:string,runtime:string,targetName:string,guard:()=>void){
  return locked(rootArg,installation,runtime,(root,dir,ledger)=>{
    guard();const owned=ledger.targets[targetName];if(!owned)return {removed:[],retained:[]};
    const target=pathIn(root,targetName),removed:string[]=[],retained:string[]=[];
    for(const [name,expected]of Object.entries(owned.files)){
      let path:string;try{path=pathIn(target,name);}catch{retained.push(name);continue;}
      if(!existsSync(path))continue;
      const st=lstatSync(path);if(!st.isFile()||st.nlink!==1){retained.push(name);continue;}
      if(st.size!==expected.size||digest(readFileSync(path))!==expected.sha256){retained.push(name);continue;}
      unlinkSync(path);syncDir(dirname(path));removed.push(name);
    }
    const prune=(dir:string)=>{if(!existsSync(dir))return;for(const n of readdirSync(dir)){const p=join(dir,n),st=lstatSync(p);if(st.isDirectory()&&!st.isSymbolicLink())prune(p);}if(!readdirSync(dir).length){rmdirSync(dir);syncDir(dirname(dir));}};
    prune(target);
    if(!retained.length){owned.files={};owned.removed=true;}
    else owned.files=Object.fromEntries(retained.map(n=>[n,owned.files[n]!]));
    durable(join(dir,'ledger.json'),canonical(ledger));return {removed,retained};
  });
}
