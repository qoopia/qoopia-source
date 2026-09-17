import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('../src/public/dashboard.html',import.meta.url),'utf8');
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
    setupCode:null,BASE:'',$:()=>({}),
    fetch:async(url:string)=>url.endsWith('/identity')?{ok:true,json:async()=>({linked:scenario.linked,pending:scenario.pending})}:{ok:scenario.authorized},
    consumeSafeNext:()=>false,showApp:()=>events.push('app'),boot:()=>events.push('boot'),showLogin:()=>events.push('login'),awaitEmailConfirmation:async()=>events.push('confirm'),loginError:()=>events.push('error'),
  });
  expect(events).toEqual(scenario.authorized?['app','boot']:scenario.pending?['login','confirm']:['login']);
});
