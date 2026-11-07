import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import {QoopiaError} from '../utils/errors.ts';

export const CODE_LIMITS = {time_ms:10_000,calls:50,concurrency:4,output_bytes:20_000,memory_bytes:32*1024*1024,stack_bytes:512*1024} as const;
export type CodeLimits={[K in keyof typeof CODE_LIMITS]:number};
let engine:ReturnType<typeof newQuickJSWASMModuleFromVariant>|undefined;
/** A separate WASM runtime per request. Only JSON crosses the boundary; no host objects or evaluators.
 * Host calls cannot be interrupted mid-handler, so at most `concurrency` run at once; the rest wait and
 * never start once the run ends. The signal tells dispatch the run is over and its result is discarded. */
export async function executeCode(code:string, names:string[], dispatch:(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>, limits:CodeLimits=CODE_LIMITS) {
  const module=await (engine??=newQuickJSWASMModuleFromVariant(variant)),runtime=module.newRuntime();
  runtime.setMemoryLimit(limits.memory_bytes);runtime.setMaxStackSize(limits.stack_bytes);
  const deadline=Date.now()+limits.time_ms,stop=new AbortController(),waiting:(()=>void)[]=[];let live=true,calls=0,outputBytes=0,running=0;
  const slot=async()=>{while(running>=limits.concurrency){await new Promise<void>(resolve=>waiting.push(resolve));if(!live)throw new Error('Code Mode stopped');}running++;};
  const release=()=>{running--;waiting.shift()?.();};
  runtime.setInterruptHandler(()=>Date.now()>=deadline);
  // QuickJS's module loader stays unset. Dynamic imports fail closed.
  const vm=runtime.newContext(),pending=new Set<Promise<void>>(),deferreds=new Set<ReturnType<typeof vm.newPromise>>(),logs:string[]=[];
  const budget=(text:string)=>{outputBytes+=Buffer.byteLength(text);if(outputBytes>limits.output_bytes)throw new QoopiaError('SIZE_LIMIT','Code Mode output budget exceeded');return text;};
  const api=vm.newObject();
  try {
    for(const name of names){
      const fn=vm.newFunction(name,(arg)=>{
        if(!live||Date.now()>=deadline)throw new Error('Code Mode time limit exceeded');
        if(++calls>limits.calls)throw new Error('Code Mode call limit exceeded');
        const serialized=vm.dump(arg??vm.undefined);
        if(!serialized||typeof serialized!=='object'||Array.isArray(serialized))throw new Error('Tool arguments must be an object');
        const deferred=vm.newPromise();deferreds.add(deferred);
        const run=async()=>{await slot();try{if(!live||Date.now()>=deadline)throw new Error('Code Mode stopped');return await dispatch(name,serialized,stop.signal);}finally{release();}};
        const job=run().then(result=>{
          if(!live)return;
          // Tool errors, including confirmation requests, remain failures inside the sandbox.
          const encoded=JSON.stringify(result);
          if(Buffer.byteLength(encoded)>limits.memory_bytes/2)throw new Error('Tool result exceeds Code Mode memory budget');
          const value=vm.unwrapResult(vm.evalCode('('+encoded+')'));deferred.resolve(value);value.dispose();
        }).catch(()=>{if(live){const error=vm.newError('Tool call refused or failed');deferred.reject(error);error.dispose();}}).finally(()=>pending.delete(job));
        pending.add(job);return deferred.handle;
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
      while(true){
        if(Date.now()>=deadline)throw new QoopiaError('SIZE_LIMIT','Code Mode time limit exceeded');
        const jobs=runtime.executePendingJobs(100);if(jobs.error){jobs.error.dispose();throw new QoopiaError('INVALID_INPUT','Code Mode execution failed');}
        const state=vm.getPromiseState(promise);
        if(state.type==='fulfilled'){try {const text=budget(vm.getString(state.value));let parsed:any;try{parsed=JSON.parse(text);}catch{throw new QoopiaError('INVALID_INPUT','Code Mode result is not JSON');}
          // Guest code can redefine JSON.stringify or toJSON; only its own result crosses, never extra top-level keys.
          const output={result:parsed&&typeof parsed==='object'&&Object.hasOwn(parsed,'result')?parsed.result:null,logs,calls};if(Buffer.byteLength(JSON.stringify(output))>limits.output_bytes)throw new QoopiaError('SIZE_LIMIT','Code Mode output budget exceeded');return output;}finally{state.value.dispose();}}
        if(state.type==='rejected'){const message=String(vm.dump(state.error)?.message??'Code Mode execution failed').slice(0,300);state.error.dispose();throw new QoopiaError('INVALID_INPUT',message);}
        // Give I/O a turn, including promises intentionally left pending by guest code. This host
        // timer is never exposed to the guest; the interrupt also stops tight synchronous loops.
        await new Promise<void>(resolve=>setTimeout(resolve,1));
      }
    } finally {promise.dispose();}
  } finally {live=false;stop.abort();for(const resume of waiting.splice(0))resume();for(const d of deferreds)d.dispose();api.dispose();vm.dispose();runtime.dispose();}
}
