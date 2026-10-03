import {afterEach,expect,test} from 'bun:test';
import {env} from '../src/utils/env.ts';
import {ownerIdentityRoot,standaloneRoot} from '../src/utils/standalone.ts';

const saved={QOOPIA_STANDALONE:process.env.QOOPIA_STANDALONE,QOOPIA_STANDALONE_LAYOUT:process.env.QOOPIA_STANDALONE_LAYOUT};
afterEach(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});

test('the layout root comes only from an installed layout; the owner identity otherwise lives in the server root',()=>{
  delete process.env.QOOPIA_STANDALONE;delete process.env.QOOPIA_STANDALONE_LAYOUT;
  expect(standaloneRoot()).toBeUndefined();expect(ownerIdentityRoot()).toBe(env.ROOT_DIR);
  process.env.QOOPIA_STANDALONE='true';
  expect(ownerIdentityRoot()).toBeUndefined(); // a standalone server started without its layout
  process.env.QOOPIA_STANDALONE_LAYOUT=JSON.stringify({root:'/opt/qoopia',logs:'/opt/qoopia/logs'});
  expect(standaloneRoot()).toBe('/opt/qoopia');expect(ownerIdentityRoot()).toBe('/opt/qoopia');
  delete process.env.QOOPIA_STANDALONE;
  expect(standaloneRoot()).toBe('/opt/qoopia');expect(ownerIdentityRoot()).toBe(env.ROOT_DIR);
});
