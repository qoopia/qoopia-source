// F-520-login-errors: a refused agent key read "HTTP 401. Check that this agent key is active.", a refused owner
// code showed the server's English sentence on a Russian page, and a network failure got a ". Run qoopia
// owner-login…" suffix after its own full stop. The sign-in forms now name what happened in the page language.
import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {dashboardScript} from './helpers/dashboard-source.ts';

const ru:Record<string,string>=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8'));
const cut=(from:string,to:string)=>dashboardScript.slice(dashboardScript.indexOf(from),dashboardScript.indexOf(to));
const code=cut('  // ---------- API ----------','  async function api(path) {')+cut("  $('#ownerLoginForm').onsubmit","  $('#tokenInput').addEventListener");

function page(fetch:()=>Promise<unknown>){
 const el=()=>({value:' secret ',textContent:'',style:{display:''},disabled:false,focus(){},reset(){}}),elements:Record<string,any>={};
 const $=(s:string)=>elements[s]??=el();
 // Russian catalog: QI.msg is a lookup and concatenation resolves as-is, like the real runtime's tokens.
 const QI={msg:(s:string)=>ru[s]??s,resolve:(s:string)=>s};
 runInNewContext(code,{$,QI,fetch,BASE:'',Number,Object,Error,errReason:()=>ru['The server could not complete the request.'],consumeSafeNext:()=>false,showApp(){},boot(){}});
 return {$,error:()=>$('#loginErr').textContent as string};
}
const answer=(status:number,body:unknown)=>async()=>({status,ok:status<300,headers:new Headers(),json:async()=>body});

test('refused owner codes and agent keys are explained in the page language, without status codes or server English',async()=>{
 const owner=page(answer(401,{error:'Login code expired or invalid'}));await owner.$('#ownerLoginForm').onsubmit({preventDefault(){},target:owner.$('#ownerLoginForm')});
 expect(owner.error()).toBe(ru['Code expired or invalid']!+ru['. Run qoopia owner-login locally for a new code.']!);
 const key=page(answer(401,{}));await key.$('#loginBtn').onclick();
 expect(key.error()).toBe(ru['This agent key was not accepted. Check that it is active.']!);
 for(const [status,run] of [[503,'owner'],[502,'key']] as const){
  const p=page(answer(status,{error:'Same-origin POST required'}));
  if(run==='owner')await p.$('#ownerLoginForm').onsubmit({preventDefault(){},target:p.$('#ownerLoginForm')});else await p.$('#loginBtn').onclick();
  expect(p.error()).toBe(ru['The server could not complete the request.']!);
 }
 const offline=page(async()=>{throw new TypeError('Failed to fetch');});await offline.$('#loginBtn').onclick();
 expect(offline.error()).toBe(ru['Could not reach the server. Check your connection.']!);
 for(const text of [owner.error(),key.error(),offline.error()])expect(text).not.toMatch(/HTTP|\.\.|Failed to fetch|expired|accepted/);
});
