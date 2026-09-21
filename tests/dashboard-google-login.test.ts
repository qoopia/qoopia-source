import { test, expect } from 'bun:test';
import {dashboardSource} from './helpers/dashboard-source.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const html=dashboardSource;
const source=html.slice(html.indexOf('  let loginPoll=0;'),html.indexOf("  $('#emailLoginForm').onsubmit"));
function harness(popup:any=null){
 const elements=new Map<string,any>();const created:any[]=[];const timers:Array<()=>void>=[];const requests:any[]=[];
 const $=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,style:{},classList:{add(){},remove(){}},disabled:false,textContent:'',append(){},after(){},scrollIntoView(){},reportValidity:()=>true});return elements.get(id);};
 let reply:any={googleUrl:'https://auth.qoopia.ai/google?request=synthetic'};
 const context:any={$,QI:{msg:(x:string)=>x,resolve:(x:string)=>x,language:'en'},AbortController,AbortSignal,window:{open:()=>popup},document:{createElement:(type:string)=>{const e:any={type,clicks:0,click(){this.clicks++;}};created.push(e);return e;}},fetch:async(_url:string,options:any)=>{requests.push(options);return {ok:true,json:async()=>reply};},BASE:'',setTimeout:(fn:()=>void)=>timers.push(fn),consumeSafeNext:()=>false,showApp(){},boot(){}};
 runInNewContext(source+'\nglobalThis.start=startEmailLogin;',context);
 return {...context,created,timers,requests,reply:(v:any)=>reply=v};
}
test('native/blocked popup opens the real Google URL and keeps recovery link and cancellation',async()=>{
 const h=harness();const login=h.start('google');await new Promise(r=>setTimeout(r,0));
 const link=h.created.find((x:any)=>x.href);expect(link.href).toBe('https://auth.qoopia.ai/google?request=synthetic');expect(link.clicks).toBe(1);
 expect(h.$('#emailLoginStatus').textContent).toContain('Google');
 const cancel=h.created.find((x:any)=>x.textContent==='Cancel sign-in');cancel.onclick();
 expect(h.requests[0].signal.aborted).toBe(true);expect(h.$('#googleLoginBtn').disabled).toBe(false);
 h.timers.shift()!();await login;expect(h.requests.length).toBe(1);
});
test('normal browser navigates its popup once and retains recovery link',async()=>{
 const destinations:string[]=[];const popup={opener:{},location:{replace:(v:string)=>destinations.push(v)}};const h=harness(popup);const login=h.start('google');await new Promise(r=>setTimeout(r,0));
 expect(destinations).toEqual(['https://auth.qoopia.ai/google?request=synthetic']);expect(h.created.find((x:any)=>x.href).clicks).toBe(0);
 h.created.find((x:any)=>x.textContent==='Cancel sign-in').onclick();h.timers.shift()!();await login;
});
test('cancelled polling cannot re-enable buttons during a newer sign-in',async()=>{
 const h=harness();const first=h.start('google');await new Promise(r=>setTimeout(r,0));h.created.find((x:any)=>x.textContent==='Cancel sign-in').onclick();
 const second=h.start('google');await new Promise(r=>setTimeout(r,0));h.timers.shift()!();await first;expect(h.$('#googleLoginBtn').disabled).toBe(true);
 h.created.filter((x:any)=>x.textContent==='Cancel sign-in').at(-1).onclick();h.timers.shift()!();await second;
});
