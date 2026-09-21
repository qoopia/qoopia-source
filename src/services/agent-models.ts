import fs from 'node:fs';
import path from 'node:path';
import {durableWrite,readJsonBytes} from '../utils/fs.ts';
import {QoopiaError} from '../utils/errors.ts';

type Provider='codex'|'claude_code';
type Model={id:string;name:string;isDefault?:boolean};
type Rpc={call(method:string,params:unknown):Promise<any>};
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value);
const file=(folder:string,provider:Provider)=>path.join(folder,provider+'-model.json');
/** A non-secret preference in the existing private owner directory; no database migration. */
export function modelPreference(folder:string,provider:Provider):{model:string|null}|undefined {
  const name=file(folder,provider);if(!fs.existsSync(name))return;
  const data=JSON.parse(readJsonBytes(name).toString());
  if(data.model!==null&&!valid(data.model))throw new QoopiaError('INVALID_INPUT','Invalid saved model selection');
  return {model:data.model};
}
export async function availableAgentModels(provider:Provider,rpc:Rpc):Promise<Model[]> {
  // Official Claude Code aliases; the subscription decides access and resolves the version.
  if(provider==='claude_code')return [{id:'sonnet',name:'Claude Sonnet'},{id:'opus',name:'Claude Opus'}];
  const models:Model[]=[],seen=new Set<string>();let cursor:string|undefined;
  do {
    const result=await rpc.call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
    if(!Array.isArray(result.data))throw new QoopiaError('NOT_READY','Could not load models. Try again.');
    for(const m of result.data)if(valid(m.model)&&!m.hidden&&!models.some(v=>v.id===m.model))models.push({id:m.model,name:typeof m.displayName==='string'?m.displayName:m.model,isDefault:!!m.isDefault});
    cursor=typeof result.nextCursor==='string'?result.nextCursor:undefined;
    if(cursor){if(seen.has(cursor)||seen.size>=10)throw new QoopiaError('NOT_READY','Could not load models. Try again.');seen.add(cursor);}
  }while(cursor);
  return models;
}
export async function selectAgentModel(folder:string,provider:Provider,rpc:Rpc,model:string|null) {
  if(model!==null&&!(await availableAgentModels(provider,rpc)).some(m=>m.id===model))throw new QoopiaError('INVALID_INPUT','Choose a model available to this subscription');
  durableWrite(file(folder,provider),JSON.stringify({model}));
}
export async function turnModel(folder:string,provider:Provider,rpc:Rpc):Promise<string|undefined> {
  const preference=modelPreference(folder,provider);
  if(!preference)return;
  if(preference.model)return preference.model;
  // Codex null means "keep the previous model", so resetting requires its actual default id.
  if(provider==='codex'){
    const model=(await availableAgentModels(provider,rpc)).find(m=>m.isDefault)?.id;
    if(!model)throw new QoopiaError('NOT_READY','Could not load models. Try again.');
    return model;
  }
}
