import {Tokenizer} from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
let ort:typeof Ort;
import {pathToFileURL} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {assetPath} from '../utils/assets.ts';

export const BUILTIN_MODEL='multilingual-e5-small:761b726dd34f:q8:chunks-v1';
export const BUILTIN_DIM=384;
let loaded:Promise<{tokenizer:Tokenizer;session:Ort.InferenceSession}>|undefined;
function runtime() {
  return loaded??= (async()=>{
    ort=await import(pathToFileURL(assetPath('models/ort.wasm.bundle.min.mjs')).href);
    const root=assetPath('models/multilingual-e5-small');
    ort.env.wasm.numThreads=1;
    ort.env.wasm.wasmPaths={mjs:pathToFileURL(assetPath('models/ort-wasm-simd-threaded.mjs')).href,
      wasm:pathToFileURL(assetPath('models/ort-wasm-simd-threaded.wasm')).href};
    const tokenizer=new Tokenizer(await Bun.file(root+'/tokenizer.json').json(),await Bun.file(root+'/tokenizer_config.json').json());
    const session=await ort.InferenceSession.create(new Uint8Array(await Bun.file(root+'/model.onnx').arrayBuffer()),{executionProviders:['wasm']});
    return {tokenizer,session};
  })().catch(error=>{loaded=undefined;throw error;});
}
export interface EmbeddedChunk {start:number;end:number;vector:Float32Array}
function normalize(v:Float32Array) {
  const norm=Math.sqrt(v.reduce((n,x)=>n+x*x,0));
  if (!norm||!Number.isFinite(norm)) throw new Error('Invalid built-in embedding');
  return v.map(x=>x/norm);
}
/** Pinned E5 recipe: query/passage prefix, masked mean pooling, L2 normalization.
 * One CPU execution at a time avoids parallel ONNX heaps on modest machines. */
let pending=Promise.resolve(),queued=0;
export async function embedBuiltin(text:string,query=false):Promise<EmbeddedChunk[]> {
    const {tokenizer,session}=await runtime(),chunks:EmbeddedChunk[]=[];
    const heading=query?'':text.split('\n',1)[0]!.slice(0,120);
    for (let start=0;start<text.length;) {
      let end=Math.min(text.length,start+(query?8192:1800)),ids:number[];
      const prefix=query?'query: ':'passage: '+(start>0?heading+'\n':'');
      while (true) {
        ids=tokenizer.encode(prefix+text.slice(start,end)).ids;
        if(ids.length<=512)break;
        end=start+Math.max(1,Math.floor((end-start)*0.75));
      }
      // Share the worker per passage, so interactive queries can run between
      // archival chunks instead of waiting behind an entire long document.
      if(queued>=32)throw new Error('Embedding queue full; durable indexing will retry');
      queued++;const previous=pending;let unlock!:()=>void;pending=new Promise<void>(resolve=>{unlock=resolve;});
      await previous;
      const feeds:Record<string,Ort.Tensor>={};
      let outputs:Record<string,Ort.Tensor>={};
      try {
        for(const name of session.inputNames) feeds[name]=new ort.Tensor('int64',
          BigInt64Array.from(name==='input_ids'?ids:ids.map(()=>name==='attention_mask'?1:0),BigInt),[1,ids.length]);
        outputs=await session.run(feeds);const out=outputs.last_hidden_state;
        if(!out||out.dims[2]!==BUILTIN_DIM)throw new Error('Built-in model output shape changed');
        const values=out.data as Float32Array,v=new Float32Array(BUILTIN_DIM);
        for(let token=0;token<ids.length;token++)for(let d=0;d<BUILTIN_DIM;d++)v[d]!+=values[token*BUILTIN_DIM+d]!/ids.length;
        chunks.push({start,end,vector:normalize(v)});
      } finally {try{for(const tensor of [...Object.values(outputs),...Object.values(feeds)])tensor.dispose();}finally{queued--;unlock();}}
      // WASM inference resolves in microtasks. Yield between passages so a
      // long archival note cannot starve HTTP, native hooks or shutdown signals.
      await setImmediate();
      if(query||end===text.length)break;
      start=Math.max(start+1,end-120);
    }
    return chunks;
}
