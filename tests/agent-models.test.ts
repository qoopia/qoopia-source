import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {availableAgentModels,modelPreference,selectAgentModel,turnModel} from '../src/services/agent-models.ts';

test('model selection uses paginated runtime catalog, persists per provider and resets Codex to its actual default',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-model-'));
 const rpc={async call(method:string,params:any){expect(method).toBe('model/list');return params.cursor?{data:[{model:'fast',displayName:'Fast',isDefault:true}],nextCursor:null}:{data:[{model:'careful',displayName:'Careful'},{model:'private',hidden:true}],nextCursor:'next'};}};
 try {
  expect((await availableAgentModels('codex',rpc)).map(m=>m.id)).toEqual(['careful','fast']);
  await selectAgentModel(folder,'codex',rpc,'careful');await selectAgentModel(folder,'claude_code',rpc,'opus');
  expect(modelPreference(folder,'codex')).toEqual({model:'careful'});
  expect(await turnModel(folder,'codex',rpc)).toBe('careful');
  expect(await turnModel(folder,'claude_code',rpc)).toBe('opus');
  await expect(selectAgentModel(folder,'codex',rpc,'private')).rejects.toThrow('available');
  expect(modelPreference(folder,'codex')?.model).toBe('careful');
  await selectAgentModel(folder,'codex',rpc,null);expect(await turnModel(folder,'codex',rpc)).toBe('fast');
  expect(modelPreference(folder,'claude_code')?.model).toBe('opus');
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('malformed or looping model catalogs fail explicitly',async()=>{
 await expect(availableAgentModels('codex',{call:async()=>({})})).rejects.toThrow('load models');
 await expect(availableAgentModels('codex',{call:async()=>({data:[],nextCursor:'same'})})).rejects.toThrow('load models');
});
