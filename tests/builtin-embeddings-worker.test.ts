import {expect,test} from 'bun:test';
import {inferenceWorker} from '../src/services/builtin-embeddings.ts';
import {fitPassage} from '../src/services/builtin-passage.ts';

// F-081: built-in inference blocks whatever thread runs it, so it must run in a
// worker. A fake worker that blocks for 300 ms per passage stands in for the model.
const fake=new URL('./helpers/slow-embed-worker.ts',import.meta.url);

test('built-in inference keeps the event loop responsive',async()=>{
  const client=inferenceWorker(fake,5_000);
  try {
    let maxGap=0,last=performance.now();
    const tick=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},5);
    const results=await Promise.all([client.run('','ab'),client.run('','abc'),client.run('','a')]);
    maxGap=Math.max(maxGap,performance.now()-last);clearInterval(tick);
    expect(results.map(r=>[r.vector.length,r.vector[0],r.end])).toEqual([[384,2,2],[384,3,3],[384,1,1]]);
    expect(maxGap).toBeLessThan(150);
  } finally {client.stop();}
});

test('a stuck inference times out, and the next request gets a fresh worker',async()=>{
  const client=inferenceWorker(fake,400);
  try {
    const started=performance.now();
    await expect(client.run('','stuck')).rejects.toThrow('timed out');
    expect(performance.now()-started).toBeLessThan(2_000);
    expect((await client.run('','x')).vector[0]).toBe(1);
  } finally {client.stop();}
});

test('stopping the worker rejects in-flight requests',async()=>{
  const client=inferenceWorker(fake,5_000);
  const pending=client.run('','stuck');
  client.stop();
  await expect(pending).rejects.toThrow('stopped');
});

test('the worker sees the environment the standalone launcher configured',async()=>{
  // configure() in src/delivery/entry.ts replaces process.env before the server starts.
  const original=process.env;
  process.env={...original,QOOPIA_BUNDLE_ASSETS:'/configured/bundle/assets'};
  const client=inferenceWorker(fake,5_000);
  try {await expect(client.run('','env')).rejects.toThrow('/configured/bundle/assets');}
  finally {client.stop();process.env=original;}
});

// The model files are not needed: one token per character stands in for the tokenizer.
test('a passage is cut to the model input, and a prefix that alone is too long is refused instead of looping [M8]',()=>{
  let calls=0;const encode=(text:string)=>{if(++calls>200)throw new Error('the fit never ends');return Array.from(text,()=>1);};
  expect(fitPassage(encode,'passage: ','short')).toMatchObject({end:5});
  const fitted=fitPassage(encode,'passage: ','x'.repeat(1800));
  expect(fitted.ids.length).toBeLessThanOrEqual(512);expect(fitted.end).toBeGreaterThan(300);
  // The same cut as before the guard: 1800 -> 1350 -> 1012 -> 759 -> 569 -> 426.
  expect(fitted.end).toBe(426);
  expect(()=>fitPassage(encode,'p'.repeat(600),'text')).toThrow('exceeds the built-in model input');
  expect(()=>fitPassage(encode,'p'.repeat(600),'')).toThrow('exceeds the built-in model input');
  expect(fitPassage(encode,'p'.repeat(511),'text')).toMatchObject({end:1});
  expect(calls).toBeLessThan(60);
});
