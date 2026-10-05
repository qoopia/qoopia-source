import {test,expect} from 'bun:test';
import {webAppAsset} from '../src/http/web-app.ts';
import {brandAsset} from '../src/brand.ts';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('native iPhone client does not install a competing web app or service worker',()=>{
 const settings=[{hidden:true},{hidden:true}];
 const elements=Object.fromEntries(['installApp','installGuide','appUpdate','appConnection'].map(id=>['#'+id,{hidden:false}]));
 vm.runInNewContext(readFileSync(new URL('../src/public/brand/app.js',import.meta.url),'utf8'),{
  navigator:{userAgent:'Mozilla/5.0 Qoopia-iOS/5.0.6'},document:{querySelector:(id:string)=>elements[id],querySelectorAll:()=>settings},
 });
 for(const element of Object.values(elements))expect(element.hidden).toBe(true);
 for(const link of settings)expect(link.hidden).toBe(false);
});

test('a loopback dashboard does not promise a Home Screen icon a phone could never open',()=>{
 const steps=[{hidden:false},{hidden:false}],loopback=[{hidden:true}];
 const guide:any={hidden:true,focus(){},querySelectorAll:(s:string)=>s==='[data-install-steps]'?steps:s==='[data-install-loopback]'?loopback:[]};
 const install:any={hidden:false,focus(){}},listeners:Record<string,Function>={};
 vm.runInNewContext(readFileSync(new URL('../src/public/brand/app.js',import.meta.url),'utf8'),{
  navigator:{userAgent:'Mozilla/5.0 Safari',onLine:true},location:{hostname:'127.0.0.1',search:''},matchMedia:()=>({matches:false}),isSecureContext:false,URLSearchParams,
  addEventListener:(name:string,fn:Function)=>listeners[name]=fn,
  document:{querySelector:(id:string)=>({'#installApp':install,'#installGuide':guide} as any)[id]??null,querySelectorAll:()=>[]},
 });
 for(const p of steps)expect(p.hidden).toBe(true);expect(loopback[0]!.hidden).toBe(false);
 let prompted=false;listeners.beforeinstallprompt!({preventDefault(){},prompt:async()=>{prompted=true;}});
 install.onclick();expect(prompted).toBe(false);expect(guide.hidden).toBe(false);
});

test('installable shell stays on its own workspace and exposes only explicit public assets',()=>{
 const manifest=JSON.parse(webAppAsset('/manifest.webmanifest')!.body);
 expect(manifest.start_url).toBe('/dashboard?app=1');expect(manifest.display).toBe('standalone');expect(manifest.id).toBe('/dashboard');
 for(const icon of manifest.icons)expect(brandAsset(icon.src)?.type).toBe('image/png');
 for(const path of ['/../.env','/api/dashboard/memory','/sw.js/../../.env'])expect(webAppAsset(path)).toBeUndefined();
 expect(webAppAsset('/sw.js')!.body).not.toContain('__QOOPIA_APP_REVISION__');
});

test('worker caches only public recovery assets and never handles private APIs or writes',async()=>{
 const handlers:Record<string,Function>={},cached:string[]=[],removed:string[]=[];let response:Promise<Response>|undefined;
 const context={URL,Response,fetch:async()=>{throw Error('offline');},caches:{open:async()=>({addAll:async(paths:string[])=>cached.push(...paths)}),keys:async()=>['qoopia-offline-old','unrelated-app-cache'],delete:async(key:string)=>removed.push(key),match:async()=>new Response('offline')},self:{location:{origin:'https://workspace.example'},clients:{claim:async()=>{}},addEventListener:(name:string,fn:Function)=>{handlers[name]=fn;}}};
 vm.runInNewContext(webAppAsset('/sw.js')!.body,context);
 let task:Promise<unknown>;handlers.install({waitUntil:(p:Promise<unknown>)=>task=p});await task!;expect(cached).toEqual(['/offline','/brand/Manrope.ttf']);
 handlers.activate({waitUntil:(p:Promise<unknown>)=>task=p});await task!;expect(removed).toEqual(['qoopia-offline-old']);
 const event=(path:string,mode='navigate',method='GET')=>({request:{url:'https://workspace.example'+path,mode,method},respondWith:(r:Promise<Response>)=>{response=r;}});
 for(const [path,mode,method] of [['/api/dashboard','cors','GET'],['/dashboard','navigate','POST'],['/oauth/authorize','navigate','GET'],['/api/dashboard/files/a','navigate','GET']]){response=undefined;handlers.fetch(event(path,mode,method));expect(response).toBeUndefined();}
 handlers.fetch(event('/dashboard'));expect(await(await response!).text()).toBe('offline');expect(cached).toEqual(['/offline','/brand/Manrope.ttf']);
});
