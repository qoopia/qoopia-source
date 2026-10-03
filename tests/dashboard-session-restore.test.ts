import {test,expect} from 'bun:test';
import {dashboardSource} from './helpers/dashboard-source.ts';
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

// F-331: the boot check reads only r.ok; an unread body kept the request open until the 15 s timeout aborted it.
for(const authorized of [true,false])test('the session check releases the response bodies it does not read: '+(authorized?'signed in':'signed out'),async()=>{
 const released:string[]=[];
 const body=(name:string)=>({cancel:async()=>{released.push(name);}});
 await runInNewContext(restore,{
  setupCode:null,accountCode:null,accountSignIn:null,AbortSignal,finishAccountSignIn(){},BASE:'',$:()=>({}),
  fetch:async(url:string)=>url.endsWith('/identity')?{ok:false,body:body('identity')}:{ok:authorized,body:body('agents')},
  consumeSafeNext:()=>false,showApp(){},boot(){},showLogin(){},loginError(){},
 });
 expect(released.sort()).toEqual(['agents','identity']);
});

// F-324: a signed-in owner on a slow link sees a neutral check, not the sign-in card, until the check answers.
test('the sign-in card stays hidden while the session is being checked',()=>{
 const start=html.indexOf('  const $ = (s) => document.querySelector(s);'),end=html.indexOf('  // ---------- API ----------',start);
 const nodes:Record<string,any>={},inserted:string[]=[];
 const document={querySelector:(s:string)=>(nodes[s]??={style:{}}),body:{insertAdjacentHTML:(_:string,markup:string)=>inserted.push(markup)}};
 runInNewContext(html.slice(start,end),{document,QI:{msg:String}});
 expect(nodes['#loginView'].style.display).toBe('none');
 expect(inserted.join('')).toContain('Checking your session…');
 expect(inserted.join('')).toContain('role="status"');
});
