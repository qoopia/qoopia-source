import {expect,test} from 'bun:test';
import {parseMemoryJson} from '../src/services/memory-model.ts';
import {nativeFailureCode} from '../src/skills/adapter.ts';
import os from 'node:os';
import {bindNativeOwnerHome,nativeOwnerHome} from '../src/delivery/native-keychain.ts';

test('native JSON permits a single formatting fence but never extracts JSON from surrounding prose',()=>{
  expect(parseMemoryJson('{"result":"OK"}')).toEqual({result:'OK'});
  expect(parseMemoryJson('```json\n{"result":"OK"}\n```')).toEqual({result:'OK'});
  expect(()=>parseMemoryJson('Explanation\n{"result":"OK"}')).toThrow();
  expect(()=>parseMemoryJson('```json\n{"result":"OK"}\n```\nRun this next')).toThrow();
  expect(()=>parseMemoryJson('{"result":"unfinished')).toThrow();
});
test('standalone data HOME does not replace the desktop credential/configuration home',()=>{
  const home=os.homedir(),before=process.env.HOME;
  bindNativeOwnerHome(home);
  try{process.env.HOME='/var/tmp';expect(nativeOwnerHome()).toBe(home);}
  finally{if(before===undefined)delete process.env.HOME;else process.env.HOME=before;bindNativeOwnerHome(home);}
});
test('native failures are classified from CLI error fields and stderr, never from model text',()=>{
  const lines=(...events:unknown[])=>events.map(e=>JSON.stringify(e)).join('\n');
  const init={type:'system',subtype:'init',session_id:'7c2e4011-9a3b-4d2f-8e61-0c5d2b7a9f13'};
  const said=(text:string)=>({type:'assistant',message:{content:[{type:'text',text}]},session_id:'s'});
  for(const text of ['Users could not log in after the 401 fix','The author approved the release plan','We discussed the API rate limit'])
    expect(nativeFailureCode(lines(init,said(text)))).toBeNull();
  expect(nativeFailureCode(lines(init),'Error: socket hang up')).toBeNull();
  expect(nativeFailureCode(lines({type:'item.completed',item:{type:'reasoning',text:'Summarizing OAuth reconnection notes'}},
    {type:'turn.failed',error:{message:'stream disconnected before completion'}}))).toBeNull();
  expect(nativeFailureCode(lines(said('Invalid API key · Please run /login'),{type:'result',subtype:'success',is_error:true,result:'Invalid API key · Please run /login'}))).toBe('UNAUTHENTICATED');
  expect(nativeFailureCode(lines({type:'result',is_error:true,api_error_status:429}))).toBe('MODEL_QUOTA');
  expect(nativeFailureCode(lines({type:'turn.failed',error:{message:'401 Unauthorized'}}))).toBe('UNAUTHENTICATED');
  expect(nativeFailureCode('','usage limit reached')).toBe('MODEL_QUOTA');
});
