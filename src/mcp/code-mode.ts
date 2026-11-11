import os from 'node:os';
import {AsyncResource} from 'node:async_hooks';
import {fileURLToPath} from 'node:url';
import {QoopiaError} from '../utils/errors.ts';

export const CODE_LIMITS = {time_ms:10_000,calls:50,concurrency:4,output_bytes:20_000,memory_bytes:32*1024*1024,stack_bytes:512*1024} as const;
export type CodeLimits={[K in keyof typeof CODE_LIMITS]:number};
// The standalone binary runs the host as itself: src/delivery/entry.ts dispatches on QOOPIA_CODE_MODE_HOST.
const command=import.meta.url.startsWith('file:///$bunfs/')?[process.execPath]
  :[process.execPath,'--no-env-file',fileURLToPath(new URL('./code-mode-host.ts',import.meta.url))];
interface Host {child:Bun.Subprocess;receive?:(message:any)=>void;gone?:()=>void}
/** Sandbox processes (src/mcp/code-mode-host.ts). Starting one costs several runs, so one stays warm between
 * them; it does not keep the server alive and ends with it. At most HOSTS run at once and the rest wait
 * inside their own time limit: a caller cannot turn concurrent runs into a pile of processes. */
const HOSTS=4,hosts=new Set<Host>(),waiting:(()=>void)[]=[];let idle:Host|undefined,active=0;
function spawn() {
  const host={} as Host;
  // Only what the sandbox needs: no server secrets, and no .env or bunfig picked up from the cwd.
  host.child=Bun.spawn(command,{cwd:os.tmpdir(),env:{PATH:process.env.PATH??'/usr/bin:/bin',QOOPIA_CODE_MODE_HOST:'1'},stdin:'ignore',stdout:'ignore',stderr:'ignore',
    serialization:'json',ipc:message=>host.receive?.(message),
    onExit:()=>{hosts.delete(host);if(idle===host)idle=undefined;host.gone?.();}});
  host.child.unref();hosts.add(host);
  return host;
}
/** Sandbox processes still alive, the warm one included (tests). */
export const codeHosts=()=>[...hosts].map(host=>host.child.pid);
/** Guest code runs in a process of its own: on the server's thread `for(;;){}` held every other request
 * until the deadline, and a native builtin over a huge array-like held it for good. At the deadline the
 * process is killed. Only JSON crosses the boundary. Tool calls are dispatched here, in the server; they
 * cannot be interrupted mid-handler, so at most `concurrency` run at once; the rest wait and never start
 * once the run ends. The signal tells dispatch the run is over and its result is discarded. */
export async function executeCode(code:string, names:string[], dispatch:(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>, limits:CodeLimits=CODE_LIMITS) {
  const deadline=Date.now()+limits.time_ms;
  if(active<HOSTS)active++;else await new Promise<void>(resolve=>waiting.push(resolve)); // the finishing run hands over its slot
  const stop=new AbortController(),queued:(()=>void)[]=[];let live=true,calls=0,running=0,reusable=false,host:Host|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const slot=async()=>{while(running>=limits.concurrency){await new Promise<void>(resolve=>queued.push(resolve));if(!live)throw new Error('Code Mode stopped');}running++;};
  const release=()=>{running--;queued.shift()?.();};
  try {
    if(Date.now()>=deadline)throw new QoopiaError('SIZE_LIMIT','Code Mode time limit exceeded');
    const sandbox=host=idle??spawn();idle=undefined;
    const text=await new Promise<string>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new QoopiaError('SIZE_LIMIT','Code Mode time limit exceeded')),deadline-Date.now());
      sandbox.gone=()=>reject(new Error('Code Mode sandbox stopped unexpectedly'));
      // Bound to the caller's async context: dispatch must see the request it belongs to.
      sandbox.receive=AsyncResource.bind((data:{done?:string;error?:{code?:QoopiaError['code'];message:string};call?:number;name:string;args:Record<string,unknown>})=>{
        if(data.call===undefined){
          // The guest's own mistake leaves the sandbox clean; a limit does not prove it.
          reusable=typeof data.done==='string'||data.error?.code==='INVALID_INPUT';
          if(typeof data.done==='string')resolve(data.done);else reject(data.error?.code?new QoopiaError(data.error.code,data.error.message):new Error(data.error?.message));
          return;
        }
        const reply=(encoded?:string)=>{if(live)try{sandbox.child.send({id:data.call,encoded});}catch{/* The sandbox is gone; its exit ends the run. */}};
        // The host enforces these first; a message that breaks them is refused, not dispatched.
        if(++calls>limits.calls||!names.includes(data.name)||!data.args||typeof data.args!=='object'||Array.isArray(data.args)){reply();return;}
        const run=async()=>{await slot();try{if(!live||Date.now()>=deadline)throw new Error('Code Mode stopped');return await dispatch(data.name,data.args,stop.signal);}finally{release();}};
        run().then(result=>{
          const encoded=JSON.stringify(result);
          if(Buffer.byteLength(encoded)>limits.memory_bytes/2)throw new Error('Tool result exceeds Code Mode memory budget');
          reply(encoded);
        }).catch(()=>reply());
      });
      sandbox.child.send({code,names,limits,deadline});
    });
    if(Buffer.byteLength(text)>limits.output_bytes)throw new QoopiaError('SIZE_LIMIT','Code Mode output budget exceeded');
    const output=JSON.parse(text) as {result:any;logs:string[];calls:number};
    return {result:output.result,logs:output.logs,calls:output.calls};
  } finally {
    live=false;stop.abort();clearTimeout(timer);for(const resume of queued.splice(0))resume();
    if(host){
      host.receive=host.gone=undefined;
      // Only a sandbox whose run ended in order is used again; any other is killed and replaced.
      if(reusable&&!idle)idle=host;else{host.child.kill('SIGKILL');if(!reusable)idle??=spawn();}
    }
    const next=waiting.shift();if(next)next();else active--;
  }
}
