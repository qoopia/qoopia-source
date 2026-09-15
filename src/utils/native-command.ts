import {execFile} from 'node:child_process';

/** Bounded metadata probes must never block the HTTP server's event loop. */
export function nativeCommand(binary:string,args:string[],options:{cwd?:string;env:NodeJS.ProcessEnv;timeout?:number;maxBuffer?:number}) {
  return new Promise<{status:number|null;stdout:string;stderr:string}>(resolve=>{
    execFile(binary,args,{...options,encoding:'utf8',timeout:options.timeout??10_000,maxBuffer:options.maxBuffer??65_536,killSignal:'SIGKILL'},(error,stdout,stderr)=>{
      resolve({status:error?(typeof error.code==='number'?error.code:null):0,stdout,stderr});
    });
  });
}
