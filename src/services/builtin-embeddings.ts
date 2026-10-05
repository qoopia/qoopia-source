const BUILTIN_DIM=384;
/** One inference worker. Loading the tokenizer and ONNX/WASM inference block their thread
 * for up to seconds, so they must not share the event loop that serves HTTP (F-081, F-307).
 * A run that exceeds timeoutMs rejects and the worker is replaced; an idle worker does not
 * keep the process alive. */
export function inferenceWorker(url:URL|string,timeoutMs:number) {
  let worker:Worker|undefined,seq=0;
  const waiting=new Map<number,{resolve:(result:{vector:Float32Array;end:number})=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  /** `terminate:false` only releases the worker (shutdown): process.exit ends it anyway, and Bun 1.3 skips
   * every 'exit' listener when process.exit follows terminating a worker that ran ONNX. */
  function stop(reason='Built-in embedding worker stopped',terminate=true) {
    worker?.unref();if(terminate)worker?.terminate();worker=undefined;
    for(const w of waiting.values()){clearTimeout(w.timer);w.reject(new Error(reason));}
    waiting.clear();
  }
  function spawn() {
    // The standalone launcher replaces process.env (configure() in src/delivery/entry.ts); a
    // worker would otherwise see the original environment and miss QOOPIA_BUNDLE_ASSETS.
    const spawned=new Worker(url,{env:{...process.env} as Record<string,string>});
    spawned.onmessage=({data}:MessageEvent<{id:number;vector?:Float32Array;end?:number;error?:string}>)=>{
      const w=waiting.get(data.id);if(!w)return;
      waiting.delete(data.id);clearTimeout(w.timer);if(!waiting.size)spawned.unref();
      if(data.vector)w.resolve({vector:data.vector,end:data.end!});else w.reject(new Error(data.error));
    };
    spawned.onerror=event=>{if(worker===spawned)stop('Built-in embedding worker failed: '+event.message);};
    return spawned;
  }
  /** Embeds `prefix` plus the head of `text` that fits the model; `end` is how much of `text` it covers. */
  function run(prefix:string,text:string) {
    const id=++seq,current=worker??=spawn();
    return new Promise<{vector:Float32Array;end:number}>((resolve,reject)=>{
      waiting.set(id,{resolve,reject,timer:setTimeout(()=>{if(worker===current)stop('Built-in embedding timed out');},timeoutMs)});
      current.ref();current.postMessage({id,prefix,text});
    });
  }
  return {run,stop};
}
// The standalone binary embeds the worker as an extra compile entrypoint
// (scripts/build-bundle.ts) under its virtual root, the entrypoints' common src/.
const inference=inferenceWorker(import.meta.url.startsWith('file:///$bunfs/')?'./services/builtin-embeddings-worker.ts'
  :new URL('./builtin-embeddings-worker.ts',import.meta.url),60_000);
export function stopBuiltinEmbeddings(){inference.stop(undefined,false);}
interface EmbeddedChunk {start:number;end:number;vector:Float32Array}
function normalize(v:Float32Array) {
  const norm=Math.sqrt(v.reduce((n,x)=>n+x*x,0));
  if (!norm||!Number.isFinite(norm)) throw new Error('Invalid built-in embedding');
  return v.map(x=>x/norm);
}
/** Pinned E5 recipe: query/passage prefix, masked mean pooling, L2 normalization.
 * One CPU execution at a time avoids parallel ONNX heaps on modest machines. */
let pending=Promise.resolve(),queued=0;
export async function embedBuiltin(text:string,query=false):Promise<EmbeddedChunk[]> {
    const chunks:EmbeddedChunk[]=[];
    const heading=query?'':text.split('\n',1)[0]!.slice(0,120);
    for (let start=0;start<text.length;) {
      const prefix=query?'query: ':'passage: '+(start>0?heading+'\n':'');
      // Share the worker per passage, so interactive queries can run between
      // archival chunks instead of waiting behind an entire long document.
      if(queued>=32)throw new Error('Embedding queue full; durable indexing will retry');
      queued++;const previous=pending;let unlock!:()=>void;pending=new Promise<void>(resolve=>{unlock=resolve;});
      await previous;
      let end:number;
      try {
        // The worker shrinks the window to the model's 512 tokens.
        const result=await inference.run(prefix,text.slice(start,start+(query?8192:1800)));
        if(result.vector.length!==BUILTIN_DIM)throw new Error('Built-in model output shape changed');
        end=start+result.end;
        chunks.push({start,end,vector:normalize(result.vector)});
      } finally {queued--;unlock();}
      if(query||end===text.length)break;
      start=Math.max(start+1,end-120);
    }
    return chunks;
}
