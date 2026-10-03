// Fake inference worker for tests/builtin-embeddings-worker.test.ts: it blocks its
// own thread for each passage, as WASM inference does, and never answers 'stuck'.
// 'env' answers with the asset root the worker sees, as an error message.
declare const self: Worker;
self.onmessage=({data}:MessageEvent<{id:number;prefix:string;text:string}>)=>{
  if(data.text==='stuck')return;
  if(data.text==='env'){self.postMessage({id:data.id,error:String(process.env.QOOPIA_BUNDLE_ASSETS)});return;}
  const until=performance.now()+300;
  while(performance.now()<until);
  const vector=new Float32Array(384).fill(data.text.length);
  self.postMessage({id:data.id,vector,end:data.text.length},[vector.buffer]);
};
