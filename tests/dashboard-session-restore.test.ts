import {test,expect} from 'bun:test';
import {dashboardSource} from './helpers/dashboard-source.ts';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=dashboardSource;
const start=html.lastIndexOf('  (async()=>{');
const end=html.indexOf('\n})();',start);
const restore=html.slice(start,end);
for(const scenario of [
  {name:'local owner cookie survives reload without email binding',authorized:true,linked:false,pending:false},
  {name:'email-linked owner cookie survives reload',authorized:true,linked:true,pending:false},
  {name:'email binding alone cannot authenticate a revoked session',authorized:false,linked:true,pending:false},
  {name:'unauthenticated pending email login continues confirmation',authorized:false,linked:false,pending:true},
])test(scenario.name,async()=>{
  const events:string[]=[];
  await runInNewContext(restore,{
    setupCode:null,accountCode:null,accountSignIn:null,AbortSignal,finishAccountSignIn(){},BASE:'',$:()=>({}),
    fetch:async(url:string)=>url.endsWith('/identity')?{ok:true,json:async()=>({linked:scenario.linked,pending:scenario.pending})}:{ok:scenario.authorized},
    consumeSafeNext:()=>false,showApp:()=>events.push('app'),boot:()=>events.push('boot'),showLogin:()=>events.push('login'),awaitEmailConfirmation:async()=>events.push('confirm'),loginError:()=>events.push('error'),
  });
  expect(events).toEqual(scenario.authorized?['app','boot']:scenario.pending?['login','confirm']:['login']);
});

for(const signin of ['account','complete'])test('account continuation starts again safely: '+signin,async()=>{
 const events:string[]=[];
 await runInNewContext(restore,{
  setupCode:null,accountCode:null,accountSignIn:signin,AbortSignal,BASE:'',$:()=>({}),
  fetch:async(url:string)=>url.endsWith('/identity')?{ok:true,json:async()=>({linked:true,pending:true})}:{ok:false},
  showLogin:()=>events.push('login'),startAccountLogin:async()=>events.push('account'),awaitEmailConfirmation:async()=>events.push('email'),loginError:()=>events.push('error'),
 });
 expect(events).toEqual(['login','account']);
});
