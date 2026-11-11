/** Code Mode's sandbox host: guest JavaScript runs in this process, started by src/mcp/code-mode.ts, never
 * in the server. The interpreter's own deadline does not reach every guest: a native builtin walking a huge
 * array-like never returns to it. Bun cannot stop a thread that is running; a process can be killed. One
 * run at a time. A tool call is a message to the server, which holds the caller's authority and the
 * database; the result comes back as JSON text. No database or secrets here.
 * Standalone binary: src/delivery/entry.ts runs runCodeModeHost() when QOOPIA_CODE_MODE_HOST is set. */
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import {QoopiaError} from '../utils/errors.ts';
import type {CodeLimits} from './code-mode.ts';
// In the standalone binary the CommonJS variant arrives wrapped in {default}. newVariant copied the wrapper,
// the loader then unwrapped the original variant, and the cap was dropped without a word: 2 GB again.
const base=(variant as {default?:typeof variant}).default??variant;
/** A WebAssembly instance of its own for every run, its memory capped at twice the guest limit (the engine
 * and its stack live there too). QuickJS's own limit refuses one large allocation but lets many small ones
 * pass: on the shared instance one call took 2 GB of the server's memory, and a run that ran out left the
 * engine broken for every run after it. Creating an instance costs about 10 ms [5.0.25]. */
const instance=(limits:CodeLimits)=>newQuickJSWASMModuleFromVariant(newVariant(base,
  {wasmMemory:new WebAssembly.Memory({initial:256,maximum:Math.max(256,Math.ceil(limits.memory_bytes*2/65536))})}));
/** Tool calls of the current run awaiting the server's answer; no text means refused or failed. */
const replies=new Map<number,(encoded?:string)=>void>();let seq=0;
/** A separate WASM runtime per request. Only JSON crosses the boundary; no host objects or evaluators. */
async function run(code:string, names:string[], limits:CodeLimits, deadline:number) {
  const module=await instance(limits),runtime=module.newRuntime();
  runtime.setMemoryLimit(limits.memory_bytes);runtime.setMaxStackSize(limits.stack_bytes);
  let calls=0,outputBytes=0,exhausted=false;
  runtime.setInterruptHandler(()=>Date.now()>=deadline);
  // QuickJS's module loader stays unset. Dynamic imports fail closed.
  const vm=runtime.newContext(),deferreds=new Set<ReturnType<typeof vm.newPromise>>(),logs:string[]=[];
  const budget=(text:string)=>{outputBytes+=Buffer.byteLength(text);if(outputBytes>limits.output_bytes)throw new QoopiaError('SIZE_LIMIT','Code Mode output budget exceeded');return text;};
  const api=vm.newObject();
  try {
    for(const name of names){
      const fn=vm.newFunction(name,(arg)=>{
        if(Date.now()>=deadline)throw new Error('Code Mode time limit exceeded');
        if(++calls>limits.calls)throw new Error('Code Mode call limit exceeded');
        const serialized=vm.dump(arg??vm.undefined);
        if(!serialized||typeof serialized!=='object'||Array.isArray(serialized))throw new Error('Tool arguments must be an object');
        const deferred=vm.newPromise(),id=++seq;deferreds.add(deferred);
        replies.set(id,encoded=>{
          // Tool errors, including confirmation requests, remain failures inside the sandbox.
          try{if(encoded===undefined)throw new Error('refused');const value=vm.unwrapResult(vm.evalCode('('+encoded+')'));deferred.resolve(value);value.dispose();}
          // In a sandbox that is out of memory even the refusal cannot be created: the run ends as over its limit.
          catch{try{const error=vm.newError('Tool call refused or failed');deferred.reject(error);error.dispose();}catch{exhausted=true;}}
        });
        process.send!({call:id,name,args:serialized});return deferred.handle;
      });
      vm.setProp(api,name,fn);fn.dispose();
    }
    vm.setProp(vm.global,'qoopia',api);
    const log=vm.newFunction('__log',(value)=>{logs.push(budget(vm.getString(value)));return vm.undefined;});
    vm.setProp(vm.global,'__log',log);log.dispose();
    // JSON.stringify runs inside the interpreter under the same interrupt/memory limit. Logs are
    // encoded there too: dumping an arbitrary guest object must never execute code in the host.
    const compiled=vm.evalCode(`globalThis.console=Object.freeze({log:(...args)=>__log(JSON.stringify(args))});\n(async()=>{const value=await (async()=>{${code}\n})();return JSON.stringify({result:value===undefined?null:value});})()`);
    if(compiled.error){const message=String(vm.dump(compiled.error)?.message??'Code Mode compilation failed').slice(0,300);compiled.error.dispose();throw new QoopiaError('INVALID_INPUT',message);}
    const promise=compiled.value;
    try {
      // Code that closes the wrapper leaves a plain value here; its handle is the same one, never disposed twice.
      if((vm.getPromiseState(promise) as {notAPromise?:boolean}).notAPromise)throw new QoopiaError('INVALID_INPUT','Code Mode code must stay inside its own function');
      while(true){
        if(exhausted)throw new QoopiaError('SIZE_LIMIT','Code Mode memory limit exceeded');
        if(Date.now()>=deadline)throw new QoopiaError('SIZE_LIMIT','Code Mode time limit exceeded');
        const jobs=runtime.executePendingJobs(100);if(jobs.error){jobs.error.dispose();throw new QoopiaError('INVALID_INPUT','Code Mode execution failed');}
        const state=vm.getPromiseState(promise);
        if(state.type==='fulfilled'){try {const text=budget(vm.getString(state.value));let parsed:any;try{parsed=JSON.parse(text);}catch{throw new QoopiaError('INVALID_INPUT','Code Mode result is not JSON');}
          // Guest code can redefine JSON.stringify or toJSON; only its own result crosses, never extra top-level keys.
          const output={result:parsed&&typeof parsed==='object'&&Object.hasOwn(parsed,'result')?parsed.result:null,logs,calls};if(Buffer.byteLength(JSON.stringify(output))>limits.output_bytes)throw new QoopiaError('SIZE_LIMIT','Code Mode output budget exceeded');return output;}finally{state.value.dispose();}}
        if(state.type==='rejected'){const message=String(vm.dump(state.error)?.message??'Code Mode execution failed').slice(0,300);state.error.dispose();throw new QoopiaError('INVALID_INPUT',message);}
        // Give messages a turn: tool results, and promises intentionally left pending by guest code. This
        // timer is never exposed to the guest; the interrupt also stops tight synchronous loops.
        await new Promise<void>(resolve=>setTimeout(resolve,1));
      }
    } finally {promise.dispose();}
  } catch(error) {
    // The engine's own failure (memory access outside its capped memory, a handle lost with it) is the guest's
    // limit, not a server error. The instance is thrown away with the run.
    if(error instanceof QoopiaError)throw error;
    if(error instanceof WebAssembly.RuntimeError||error instanceof Error&&error.name.startsWith('QuickJS'))throw new QoopiaError('SIZE_LIMIT','Code Mode memory limit exceeded');
    throw error;
  } finally {
    replies.clear();
    try{for(const d of deferreds)d.dispose();api.dispose();vm.dispose();runtime.dispose();}catch{/* An exhausted instance cannot be tidied; it is unreachable after this run. */}
  }
}
export function runCodeModeHost() {
  // The guest can hold this thread past its deadline while the server, which would end this process, is
  // gone or busy: a second thread ends it then.
  const watchdog=new Worker(URL.createObjectURL(new Blob(
    ["let deadline=Infinity;onmessage=event=>{deadline=event.data;};setInterval(()=>{if(Date.now()>deadline)process.kill(process.pid,'SIGKILL');},250);"],{type:'text/javascript'})));
  process.on('disconnect',()=>process.exit(0));
  process.on('message',async(data:{id:number;encoded?:string}|{code:string;names:string[];limits:CodeLimits;deadline:number})=>{
    if('id' in data){const reply=replies.get(data.id);replies.delete(data.id);reply?.(data.encoded);return;}
    watchdog.postMessage(data.deadline+1_000);
    try{process.send!({done:JSON.stringify(await run(data.code,data.names,data.limits,data.deadline))});}
    catch(error){process.send!({error:error instanceof QoopiaError?{code:error.code,message:error.message}:{message:String((error as Error)?.message??error)}});}
    finally{watchdog.postMessage(Infinity);}
  });
}
if(import.meta.main)runCodeModeHost();
