import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assetPath} from '../src/utils/assets.ts';

// models/ is a gitignored build input (bun scripts/prepare-memory-model.ts).
// Fresh checkouts such as CI lack it; tests never download it.
const missing=['ort.wasm.bundle.min.mjs','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm',
  'multilingual-e5-small/model.onnx','multilingual-e5-small/tokenizer.json','multilingual-e5-small/tokenizer_config.json']
  .filter(file=>!fs.existsSync(assetPath('models/'+file)));
if(missing.length)console.warn(`SKIP built-in embedding test: models/${missing[0]} is missing; run bun scripts/prepare-memory-model.ts`);

// Explicit environment: never inherit a real QOOPIA_ROOT, ports or ~/.qoopia.
// Cold ONNX load plus several passages takes seconds; leave headroom for loaded hosts.
function probe(helper:string) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-builtin-embed-')));
  try {
    const run=spawnSync(process.execPath,[path.join(import.meta.dir,'helpers',helper)],{encoding:'utf8',timeout:55_000,
      env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),
        QOOPIA_BACKUP_DIR:path.join(root,'backups'),QOOPIA_LOG_LEVEL:'error',QOOPIA_SERVER_ROLE:'canonical',QOOPIA_PORT:'0',
        QOOPIA_AUTO_EMBED:'false',QOOPIA_EMBED_PROVIDER:'builtin'}});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

test.skipIf(missing.length>0)('built-in embeddings chunk notes, skip unchanged text, refuse stale writes and serve recall',()=>{
  const r=probe('builtin-embed-probe.ts');
  expect(r.first).toEqual({embedded:true,skipped:null});
  expect(r.again).toEqual({embedded:false,skipped:'hash'});
  expect(r.long).toEqual({embedded:true,skipped:null});
  expect(r.stale).toEqual({embedded:false,skipped:null});
  expect(r.chunks.backup).toEqual([{start_char:0,end_char:'Резервная копия базы данных хранится на сервере Corsair.'.length}]);
  // Token-bounded, overlapping passages cover the whole long note.
  const recipe=r.chunks.recipe as Array<{start_char:number;end_char:number}>;
  expect(recipe.length).toBeGreaterThan(1);
  expect(recipe[0]!.end_char).toBeLessThan(1800);
  expect(recipe[0]!.start_char).toBe(0);
  expect(recipe.at(-1)!.end_char).toBe(r.recipe_length);
  recipe.slice(1).forEach((chunk,i)=>{expect(chunk.start_char).toBeGreaterThan(recipe[i]!.start_char);expect(chunk.start_char).toBeLessThan(recipe[i]!.end_char);});
  expect(r.workspace).toBe(1+recipe.length);
  expect(r.all).toBe(1+recipe.length);
  expect(r.coverage).toMatchObject({total_notes:2,embedded:2,ratio:1,model:'multilingual-e5-small:761b726dd34f:q8:chunks-v1'});
  // No lexical overlap with the Russian note: only the vector channel can rank it first.
  expect(r.recall.mode).toBe('hybrid');
  expect(r.recall.ids[0]).toBe(r.ids.backup);
},60_000);

// F-081/F-307: neither ONNX/WASM inference nor building the 17 MB tokenizer may block
// the event loop that serves /health, including the first (cold) recall after start.
test.skipIf(missing.length>0)('built-in inference leaves the event loop responsive from a cold start',()=>{
  const r=probe('builtin-embed-lag-probe.ts');
  expect(r.passages).toBeGreaterThan(5);
  expect(r.max_gap_ms).toBeLessThan(200);
  expect(r.max_health_ms).toBeLessThan(250);
  // The tokenizer's ~200 MB of objects live in the worker, not on the main heap.
  expect(r.main_heap_mb).toBeLessThan(100);
},60_000);
