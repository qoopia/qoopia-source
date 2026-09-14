import {expect,test} from 'bun:test';
import {parseMemoryJson} from '../src/services/memory-model.ts';
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
