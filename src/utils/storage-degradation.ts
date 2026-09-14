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
