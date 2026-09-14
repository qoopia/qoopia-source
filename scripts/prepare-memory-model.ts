import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const MEMORY_MODEL_FILES=[
  {file:'model.onnx',source:'onnx/model_quantized.onnx',size:118308185,sha256:'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'},
  {file:'tokenizer.json',source:'tokenizer.json',sha256:'0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'},
  {file:'tokenizer_config.json',source:'tokenizer_config.json',sha256:'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'},
] as const;
const revision='761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export async function prepareMemoryModel(destination=path.resolve('models')) {
  const dir=path.join(destination,'multilingual-e5-small');fs.mkdirSync(dir,{recursive:true});
  for(const file of MEMORY_MODEL_FILES) {
    const target=path.join(dir,file.file),digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    if(fs.existsSync(target)&&digest(fs.readFileSync(target))===file.sha256)continue;
    const response=await fetch(`https://huggingface.co/Xenova/multilingual-e5-small/resolve/${revision}/${file.source}`,{signal:AbortSignal.timeout(300_000)});
    if(!response.ok)throw new Error(`Model download HTTP ${response.status}`);
    const reader=response.body!.getReader(),parts:Uint8Array[]=[];let size=0;
    try {while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>128*1024*1024)throw new Error('Model response too large');parts.push(r.value);}}
    finally {await reader.cancel();}
    const bytes=Buffer.concat(parts);
    if(digest(bytes)!==file.sha256)throw new Error('Model checksum mismatch: '+file.file);
    fs.writeFileSync(target+'.tmp',bytes);fs.renameSync(target+'.tmp',target);
  }
  for(const file of ['ort.wasm.bundle.min.mjs','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])fs.copyFileSync(path.resolve('node_modules/onnxruntime-web/dist',file),path.join(destination,file));
  fs.writeFileSync(path.join(destination,'MODEL-NOTICE.json'),JSON.stringify({model:'intfloat/multilingual-e5-small',conversion:'Xenova/multilingual-e5-small',revision,license:'MIT',source:`https://huggingface.co/Xenova/multilingual-e5-small/tree/${revision}`,files:MEMORY_MODEL_FILES},null,2));
}
if(import.meta.main)await prepareMemoryModel();
