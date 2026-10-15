// F-520-net-errors: a request that got no answer used to show the browser's own English words
// ("Failed to fetch" in Chromium, "Load failed" in Safari, "signal timed out") on Russian pages, and an
// answer without a sentence showed "HTTP 502". Every dashboard and chat request now goes through send().
import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {dashboardScript} from './helpers/dashboard-source.ts';

const start=dashboardScript.indexOf('  // ---------- API ----------'),end=dashboardScript.indexOf('  // ---------- Auth / boot ----------');
const section=dashboardScript.slice(start,end);
const ru:Record<string,string>=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8'));

function load(fetch:(url:string,init?:any)=>Promise<any>){
 const QI={msg:(s:string,p?:any)=>JSON.stringify([s,p]),resolve:(t:string)=>{const [s,p]=JSON.parse(t);return (ru[s]??s).replace(/\{(\w+)\}/g,(_:string,k:string)=>String(p[k]));}};
 const errReason=(e:any)=>e.status===429?QI.msg('Too many requests. Try again in {s} s.',{s:e.retryAfter||60}):QI.msg('The server could not complete the request.');
 return runInNewContext(section+';({send,api,apiWrite})',{fetch,QI,errReason,BASE:'',AbortSignal,showLogin(){},Number,Object,Error,JSON});
}
const reject=(name:string,message:string)=>async()=>{throw Object.assign(new Error(message),{name});};
const answer=(status:number,body:unknown,headers:Record<string,string>={})=>async()=>({status,ok:status<300,headers:new Headers(headers),json:async()=>body});

test('no browser error text or HTTP status reaches the page; the reason is a sentence in the page language',async()=>{
 for(const [name,message] of [['TypeError','Failed to fetch'],['TypeError','Load failed'],['TimeoutError','signal timed out']]){
  const {api,apiWrite}=load(reject(name,message));
  const read=await api('/api/dashboard/agents').catch((e:any)=>e);
  expect(read.message).toBe(ru['Could not reach the server. Check your connection.']!);expect(read.offline).toBe(true);expect(read.status).toBeUndefined();
  // A write that timed out may still have been applied: say so instead of inviting a blind retry.
  const write=await apiWrite('/api/dashboard/x',{}).catch((e:any)=>e);
  expect(write.message).toBe(name==='TimeoutError'?ru['The server has not confirmed this action yet. Check its status before trying again.']!:ru['Could not reach the server. Check your connection.']!);
 }
 const cancelled=await load(reject('AbortError','The operation was aborted.')).send('/x',{}).catch((e:any)=>e);expect(cancelled.name).toBe('AbortError');
 expect((await load(answer(502,{})).apiWrite('/x',{}).catch((e:any)=>e)).message).toBe(ru['The server could not complete the request.']!);
 expect((await load(answer(500,{error:'query_failed'})).api('/x').catch((e:any)=>e)).message).toBe(ru['The server could not complete the request.']!);
 const limited=await load(answer(429,{error:'too_many_requests'},{'retry-after':'7'})).api('/x').catch((e:any)=>e);expect(limited.message).toBe(ru['Too many requests. Try again in {s} s.']!.replace('{s}','7'));expect(limited.status).toBe(429);
 expect((await load(answer(409,{error_description:'Stale revision'})).apiWrite('/x',{}).catch((e:any)=>e)).message).toBe('Stale revision');
});

test('the dashboard and the owner chat send every request through send()',()=>{
 const chat=readFileSync(new URL('../src/public/brand/agent-chat.js',import.meta.url),'utf8');
 expect(dashboardScript.match(/\bfetch\(/g)).toHaveLength(1);expect(section).toContain('return await fetch(url, init);');
 expect(chat).not.toMatch(/\bfetch\(/);expect(dashboardScript).toContain('window.QoopiaChat({api,send,');
});
