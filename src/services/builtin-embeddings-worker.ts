/** The built-in E5 model off the main thread: building the 250k-vocab tokenizer and
 * WASM inference each block their thread for up to seconds (F-081, F-307). The main
 * thread queues passages and normalizes; this worker owns the tokenizer and the single
 * model instance. */
import type * as Ort from 'onnxruntime-web';
import {Tokenizer} from '@huggingface/tokenizers';
import {pathToFileURL} from 'node:url';
import {assetPath} from '../utils/assets.ts';
declare const self: Worker;
let ort:typeof Ort;
let loaded:Promise<{encoder:Tokenizer;model:Ort.InferenceSession}>|undefined;
function load() {
  return loaded??= (async()=>{
    const root=assetPath('models/multilingual-e5-small');
    const encoder=new Tokenizer(await Bun.file(root+'/tokenizer.json').json(),await Bun.file(root+'/tokenizer_config.json').json());
    ort=await import(pathToFileURL(assetPath('models/ort.wasm.bundle.min.mjs')).href);
    ort.env.wasm.numThreads=1;
    ort.env.wasm.wasmPaths={mjs:pathToFileURL(assetPath('models/ort-wasm-simd-threaded.mjs')).href,
      wasm:pathToFileURL(assetPath('models/ort-wasm-simd-threaded.wasm')).href};
    return {encoder,model:await ort.InferenceSession.create(new Uint8Array(await Bun.file(root+'/model.onnx').arrayBuffer()),{executionProviders:['wasm']})};
  })().catch(error=>{loaded=undefined;throw error;});
}
/** One passage: `prefix` plus the longest head of `text` that fits 512 tokens. Replies
 * with the pooled vector and how many characters of `text` it covers. */
self.onmessage=async({data:{id,prefix,text}}:MessageEvent<{id:number;prefix:string;text:string}>)=>{
  const feeds:Record<string,Ort.Tensor>={};
  let outputs:Record<string,Ort.Tensor>={};
  try {
    const {encoder,model}=await load();
    let end=text.length,ids:number[];
    while (true) {
      ids=encoder.encode(prefix+text.slice(0,end)).ids;
      if(ids.length<=512)break;
      end=Math.max(1,Math.floor(end*0.75));
    }
    for(const name of model.inputNames) feeds[name]=new ort.Tensor('int64',
      BigInt64Array.from(name==='input_ids'?ids:ids.map(()=>name==='attention_mask'?1:0),BigInt),[1,ids.length]);
    outputs=await model.run(feeds);const out=outputs.last_hidden_state;
    if(!out)throw new Error('Built-in model output shape changed');
    // Masked mean pooling, same order as before the move: vectors stay bit-identical.
    const dim=out.dims[2]!,values=out.data as Float32Array,vector=new Float32Array(dim);
    for(let token=0;token<ids.length;token++)for(let d=0;d<dim;d++)vector[d]!+=values[token*dim+d]!/ids.length;
    self.postMessage({id,vector,end},[vector.buffer]);
  } catch(error) {
    self.postMessage({id,error:error instanceof Error?error.message:String(error)});
  } finally {for(const tensor of [...Object.values(outputs),...Object.values(feeds)])tensor.dispose();}
};
