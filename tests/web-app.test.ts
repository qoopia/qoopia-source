import {test,expect} from 'bun:test';
import {webAppAsset} from '../src/http/web-app.ts';
import {brandAsset} from '../src/brand.ts';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';

test('native iPhone client does not install a competing web app or service worker',()=>{
 const settings=[{hidden:true},{hidden:true}];
 const elements=Object.fromEntries(['installApp','installGuide','appConnection'].map(id=>['#'+id,{hidden:false}]));
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

// After qoopia-source PR #17 (niyazirsaliev): every icon the manifest and the page declare is served, at its declared type and size.
test('every declared app icon is served at its declared type and size, with a maskable icon inside the safe zone',()=>{
 // The order handleRequest uses for public reads: the app shell first, then /brand/*.
 const served=(path:string)=>{const shell=webAppAsset(path);return shell?{type:shell.type,body:Buffer.from(shell.body)}:brandAsset(path);};
 const png=(body:Buffer)=>{
  expect(body.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  const width=body.readUInt32BE(16),height=body.readUInt32BE(20),depth=body[24],color=body[25]!,channels=({2:3,6:4} as Record<number,number>)[color]!;
  expect([depth,body[28],channels>0]).toEqual([8,0,true]); // 8-bit, non-interlaced RGB(A): what this decoder reads.
  const chunks:Buffer[]=[];for(let at=8;at<body.length;){const size=body.readUInt32BE(at),kind=body.toString('ascii',at+4,at+8);if(kind==='IDAT')chunks.push(body.subarray(at+8,at+8+size));at+=12+size;}
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)]!,row=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)),out=pixels.subarray(y*stride,(y+1)*stride),up=y?pixels.subarray((y-1)*stride,y*stride):Buffer.alloc(stride);
   for(let x=0;x<stride;x++){const a=x>=channels?out[x-channels]!:0,b=up[x]!,c=x>=channels?up[x-channels]!:0,p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
    out[x]=(row[x]!+[0,a,b,(a+b)>>1,pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter]!)&255;}}
  return {width,height,pixel:(x:number,y:number)=>[...pixels.subarray(y*stride+x*channels,y*stride+x*channels+3)]};
 };
 const shell=served('/manifest.webmanifest')!;expect(shell.type).toBe('application/manifest+json');
 const manifest=JSON.parse(shell.body.toString()),purposes=new Set<string>();
 expect(manifest.icons.length).toBeGreaterThan(0);
 for(const icon of manifest.icons){
  const asset=served(icon.src);expect(asset?.type,icon.src).toBe(icon.type);expect(asset!.body.length,icon.src).toBeGreaterThan(0);
  const image=png(asset!.body as Buffer);expect(image.width+'x'+image.height,icon.src).toBe(icon.sizes);
  for(const purpose of String(icon.purpose??'any').split(/\s+/))purposes.add(purpose);
  // Maskable: the launcher may crop to a circle of 40% radius, so every mark pixel must lie inside it on a full-bleed background.
  if(String(icon.purpose).split(/\s+/).includes('maskable')){
   const background=image.pixel(0,0);let reach=0;
   for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)if(image.pixel(x,y).some((v,i)=>Math.abs(v-background[i]!)>8))reach=Math.max(reach,Math.hypot(x+.5-image.width/2,y+.5-image.height/2)/image.width);
   expect(reach,icon.src).toBeGreaterThan(0);expect(reach,icon.src).toBeLessThanOrEqual(.4);
   for(const [x,y] of [[0,0],[image.width-1,0],[0,image.height-1],[image.width-1,image.height-1]])expect(image.pixel(x!,y!),icon.src).toEqual(background);
  }
 }
 expect(purposes.has('maskable')).toBe(true);expect(purposes.has('any')).toBe(true);
 const page=readFileSync(new URL('../src/public/dashboard.html',import.meta.url),'utf8');
 expect(page.match(/<link rel="manifest" href="([^"]+)"/)?.[1]).toBe('/manifest.webmanifest');
 const touch=page.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];expect(touch).toBeString();
 const touchAsset=served(touch!);expect(touchAsset?.type).toBe('image/png');const touchImage=png(touchAsset!.body as Buffer);expect(touchImage.width+'x'+touchImage.height).toBe('180x180');
});

test('a dashboard change does not install a new worker or show a second update prompt',()=>{
 // The revision covers only the worker and what it caches; the page announces a new interface itself (#uiUpdate).
 const source=readFileSync(new URL('../src/http/web-app.ts',import.meta.url),'utf8');
 expect(source.match(/for\(const name of (\[[^\]]*\])/)?.[1]).toBe("['app-sw.js','offline.html','brand/Manrope.ttf']");
 const page=readFileSync(new URL('../src/public/dashboard.html',import.meta.url),'utf8'),app=readFileSync(new URL('../src/public/brand/app.js',import.meta.url),'utf8');
 expect(page).not.toContain('appUpdate');expect(app).not.toMatch(/waiting|ACTIVATE_UPDATE|controllerchange/);expect(page).toContain('id="uiUpdate"');
});

test('worker caches only public recovery assets and never handles private APIs or writes',async()=>{
 const handlers:Record<string,Function>={},cached:string[]=[],removed:string[]=[];let response:Promise<Response>|undefined,skipped=0;
 const context={URL,Response,fetch:async()=>{throw Error('offline');},caches:{open:async()=>({addAll:async(paths:string[])=>cached.push(...paths)}),keys:async()=>['qoopia-offline-old','unrelated-app-cache'],delete:async(key:string)=>removed.push(key),match:async()=>new Response('offline')},self:{location:{origin:'https://workspace.example'},skipWaiting:async()=>{skipped++;},clients:{claim:async()=>{}},addEventListener:(name:string,fn:Function)=>{handlers[name]=fn;}}};
 vm.runInNewContext(webAppAsset('/sw.js')!.body,context);
 let task:Promise<unknown>;handlers.install({waitUntil:(p:Promise<unknown>)=>task=p});await task!;expect(cached).toEqual(['/offline','/brand/Manrope.ttf']);
 // F-520-sw-update: the worker serves no dashboard file, so it takes over at once instead of a second "Update ready" prompt.
 expect(skipped).toBe(1);expect(handlers.message).toBeUndefined();
 handlers.activate({waitUntil:(p:Promise<unknown>)=>task=p});await task!;expect(removed).toEqual(['qoopia-offline-old']);
 const event=(path:string,mode='navigate',method='GET')=>({request:{url:'https://workspace.example'+path,mode,method},respondWith:(r:Promise<Response>)=>{response=r;}});
 for(const [path,mode,method] of [['/api/dashboard','cors','GET'],['/dashboard','navigate','POST'],['/oauth/authorize','navigate','GET'],['/api/dashboard/files/a','navigate','GET']]){response=undefined;handlers.fetch(event(path,mode,method));expect(response).toBeUndefined();}
 handlers.fetch(event('/dashboard'));expect(await(await response!).text()).toBe('offline');expect(cached).toEqual(['/offline','/brand/Manrope.ttf']);
});
