import { QoopiaError } from './errors.ts';

const ACTION='Free storage capacity, then restart Qoopia and verify /ready before resuming writes.';
let fullSince:string|null=null;

export function recordStorageWriteFailure(error:unknown):boolean {
  if(error instanceof QoopiaError)return false;
  const value=error as {code?:unknown,name?:unknown,message?:unknown};
  const full=error instanceof Error&&value.code==='SQLITE_FULL'&&value.name==='SQLiteError';
  if(full&&!fullSince)fullSince=new Date().toISOString();
  return full;
}

/** A file write that found the disk or the owner's quota full (STAGING_SPACE_INSUFFICIENT is our own check
 * before writing), in plain words. Writes are staged and SQLite rolls back, so what was saved stays. */
export function diskFull(error:unknown):QoopiaError|undefined {
  const value=error as {code?:unknown,message?:unknown}|null|undefined;
  return value?.code==='ENOSPC'||value?.code==='EDQUOT'||value?.message==='STAGING_SPACE_INSUFFICIENT'
    ?new QoopiaError('STORAGE_FULL','The disk is full: free some space, then retry. Your saved memory is safe.'):undefined;
}

export function storageDegradation(){
  return fullSince?{degraded:true,reason:'SQLITE_FULL',since:fullSince,action:ACTION}:{degraded:false as const};
}

export function assertStorageWriteAllowed(toolName:string):void {
  if(!fullSince)return;
  throw new QoopiaError('READ_ONLY_INSTANCE',`Storage degradation rejects write tool '${toolName}'. ${ACTION}`);
}

export function resetStorageDegradationForTests():void {
  if(process.env.NODE_ENV!=='test')throw new Error('Storage degradation reset is test-only');
  fullSince=null;
}
