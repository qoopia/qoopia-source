import {test,expect} from 'bun:test';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {browserEvent} from '../src/analytics/events.ts';

// Static checks for the qoopia.ai pages. The understand pages are generated per language by scripts/discovery-content.py.
const site=new URL('../marketing-site/',import.meta.url);
const read=(name:string)=>readFileSync(new URL(name,site),'utf8');
const pages=readdirSync(site).filter(f=>f.endsWith('.html')&&!f.startsWith('understand'));
const scripts=readdirSync(site).filter(f=>f.endsWith('.js'));
const ru=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8')) as Record<string,string>;
const decode=(s:string)=>s.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
// Message literals passed to msg(...), including both branches of a ternary.
const msgLiterals=(js:string)=>[...js.matchAll(/\bmsg\(/g)].flatMap(m=>{
 let i=m.index!+4,depth=1,arg='';
 while(depth&&i<js.length){const c=js[i];if(c==="'"){const end=js.indexOf("'",i+1);arg+=js.slice(i,end+1);i=end+1;continue;}if(c==='(')depth++;else if(c===')')depth--;if(depth)arg+=c;i++;}
 return [...arg.matchAll(/(?:^|[?:])\s*'([^']*)'/g)].map(l=>l[1]);
});

test('every site message, accessible name and title has a Russian translation',()=>{
 const keys=new Map<string,string>();
 for(const page of pages){
  const html=read(page);
  for(const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]*)"/g))keys.set(decode(m[1]),page);
  for(const [tag] of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/g))for(const m of tag.matchAll(/\s(aria-label|alt|title)="([^"]+)"/g))
   if(!['qoopia','English','Русский'].includes(m[2]))expect(tag,page).toContain('data-i18n-'+m[1]+'=');
  expect(html.includes('<title>'),page+' has an untranslatable <title>').toBe(false);
 }
 for(const file of scripts)for(const key of msgLiterals(read(file)))keys.set(key,file);
 for(const pkg of Object.values(JSON.parse(read('release.json')).packages as Record<string,{requirements:string}>))keys.set(pkg.requirements,'release.json');
 expect(keys.size).toBeGreaterThan(200);
 expect([...keys].filter(([key])=>typeof ru[key]!=='string').map(([key,file])=>file+': '+key)).toEqual([]);
});

test('every page is served with HSTS covering the qoopia.ai subdomains (F-127)',()=>{
 expect(read('_headers')).toContain('\n  Strict-Transport-Security: max-age=31536000; includeSubDomains\n');
});

test('the site CSP refuses form posts, lists only live style hashes, and a Permissions-Policy is sent (F-187)',()=>{
 const headers=read('_headers'),csp=headers.split('Content-Security-Policy: ')[1]!.split('\n')[0]!;
 expect(csp).toContain("form-action 'none'");
 expect(headers).toContain('\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n');
 const inline=new Set<string>(),walk=(dir:URL)=>{for(const entry of readdirSync(dir)){const file=new URL(entry,dir);
  if(statSync(file).isDirectory())walk(new URL(entry+'/',dir));
  else if(/\.(html|svg)$/.test(entry))for(const m of readFileSync(file,'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))inline.add(createHash('sha256').update(m[1]!).digest('base64'));}};
 walk(site);
 const listed=[...csp.matchAll(/'sha256-([^']+)'/g)].map(m=>m[1]!);
 expect(listed.length).toBeGreaterThan(0);
 for(const hash of listed)expect(inline.has(hash),'stale style hash '+hash).toBe(true);
});

test('the site serves the same generated locale runtime as the dashboard',()=>{
 expect(read('brand/i18n.js')).toBe(readFileSync(new URL('../src/public/brand/i18n.js',import.meta.url),'utf8'));
});

test('cache-busting hashes match the referenced files',()=>{
 for(const page of pages)for(const m of read(page).matchAll(/(?:src|href)="\/?([^"?#]+)\?v=([0-9a-f]+)"/g))
  expect(createHash('sha256').update(readFileSync(new URL(m[1],site))).digest('hex').slice(0,12),page+' '+m[1]).toBe(m[2]);
});

test('each sitemap page shares its own card: og:url is the canonical and descriptions are not copied',()=>{
 const seen=new Map<string,string>();
 for(const [,url,path] of read('sitemap.xml').matchAll(/<loc>(https:\/\/qoopia\.ai\/([a-z-]*))<\/loc>/g)){
  const html=read((path||'index')+'.html'),meta=(re:RegExp)=>re.exec(html)?.slice(1).find(Boolean);
  expect(meta(/<meta content="([^"]+)" property="og:url"|<meta property="og:url" content="([^"]+)"/),url).toBe(url);
  expect(meta(/<link href="([^"]+)" rel="canonical"|<link rel="canonical" href="([^"]+)"/),url).toBe(url);
  for(const [name,re] of [['description',/<meta content="([^"]+)"[^>]*name="description"|<meta name="description" content="([^"]+)"/],['og:title',/<meta content="([^"]+)"[^>]*property="og:title"|<meta property="og:title" content="([^"]+)"/],['og:description',/<meta content="([^"]+)"[^>]*property="og:description"|<meta property="og:description" content="([^"]+)"/]] as const){
   const value=meta(re)!;expect(value,url+' '+name).toBeString();
   expect(seen.get(name+value),url+' copies '+name).toBeUndefined();seen.set(name+value,url);
  }
 }
 expect(seen.size).toBe(18);
});

// Runs site.js's download card against browser stubs for one visitor device.
async function downloadCard(platform:string,userAgent:string,maxTouchPoints=0){
 type Node={className?:string;textContent?:string;href?:string;dataset:Record<string,string>};
 const children:Node[]=[],select={value:'mac',addEventListener(){}},meta={textContent:''},state={textContent:''};
 const action={replaceChildren(){children.length=0;},append(child:Node){children.push(child);}};
 const nodes:Record<string,unknown>={'#platform':select,'#release-meta':meta,'#release-state':state,'#download-action':action};
 const release=JSON.parse(read('release.json'));
 new Function('document','navigator','window','fetch','QI',read('site.js'))(
  {querySelector:(selector:string)=>nodes[selector]??null,createElement:()=>({dataset:{}})},
  {platform,userAgent,maxTouchPoints},{addEventListener(){}},
  ()=>Promise.resolve({ok:true,json:()=>Promise.resolve(release)}),
  {language:'en',msg:(text:string,values:Record<string,string>={})=>text.replace(/\{(\w+)\}/g,(_,key)=>values[key]!),number:String,date:String});
 for(let i=0;i<5;i++)await Promise.resolve();
 return {platform:select.value,notice:children.find(child=>child.className==='notice')?.textContent,download:children.find(child=>child.href)?.href};
}

test('visitors on Windows, phones, tablets and ARM Linux are told no package runs on their device',async()=>{
 const notice='This device does not look like an Apple Silicon Mac or a Linux x64 computer. Choose the package for the computer where Qoopia will run.';
 const chrome='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
 for(const [name,platform,agent,selected] of [['Mac','MacIntel','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)','mac'],['Linux x64','Linux x86_64',chrome,'linux']] as const){
  const card=await downloadCard(platform,agent);
  expect(card.notice,name).toBeUndefined();expect(card.platform,name).toBe(selected);expect(card.download,name).toStartWith('https://github.com/');
 }
 for(const [name,platform,agent,touch] of [['Windows','Win32','Mozilla/5.0 (Windows NT 10.0; Win64; x64)',0],['Linux arm64','Linux aarch64',chrome.replace('x86_64','aarch64'),0],
  ['Android','Linux armv81','Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile',5],['iPhone','iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',5],['iPad','MacIntel','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',5]] as const){
  const card=await downloadCard(platform,agent,touch);
  expect(card.notice,name).toBe(notice);expect(card.download,name).toStartWith('https://github.com/');
 }
});

// Runs analytics.js against minimal browser stubs; every request is captured, nothing leaves.
function runAnalytics(pathname:string,stored:string|null=null){
 type StubNode={append():void;addEventListener(type:string,fn:()=>void):void;checked?:boolean};
 const sent:Record<string,unknown>[]=[],on:Record<string,(event?:unknown)=>void>={},inputs:StubNode[]=[];
 class Element{dataset={platform:'mac',version:'5.0.14'};closest(){return this;}}
 const node=(tag:string)=>{const n:StubNode={append(){},addEventListener(type:string,fn:()=>void){on[type]=fn;}};if(tag==='input')inputs.push(n);return n;};
 new Function('localStorage','navigator','location','document','window','innerWidth','fetch','performance','PerformanceObserver','Element',read('analytics.js'))(
  {getItem:()=>stored,setItem(){}},{},{pathname,hostname:'qoopia.ai'},
  {referrer:'',readyState:'loading',createElement:node,querySelector:()=>null,addEventListener:(type:string,fn:()=>void)=>{on[type]=fn;}},
  {addEventListener(){}},1440,(_url:string,init:{body:string})=>{sent.push(JSON.parse(init.body));return Promise.resolve();},
  {getEntriesByType:()=>[]},class{observe(){}},Element);
 return {sent,click:()=>on.click({type:'click',target:new Element()}),optIn:()=>{inputs[0].checked=true;on.change();}};
}

// Owner decision 2026-10-02 (as in PR #94): every download click is counted anonymously without
// opt-in; page views wait for the opt-in; docs#privacy says exactly this.
test('download clicks are counted without opt-in; page views wait for it',()=>{
 const page=runAnalytics('/');
 page.click();expect(page.sent.map(event=>event.kind)).toEqual(['download_click']);
 expect(Object.keys(page.sent[0]!).sort()).toEqual(['id','kind','page','platform','referrer','version']);
 page.optIn();page.click();
 expect(page.sent.map(event=>event.kind)).toEqual(['download_click','site_view','download_click']);
 expect(read('docs.html')).toContain('Download button clicks are counted anonymously for everyone');
});

test('opted-in page views carry a page label the event service accepts',async()=>{
 for(const [file,label] of [['index.html','home'],['docs.html','docs'],['releases.html','releases'],['mobile.html','mobile']]){
  expect(read(file)).toContain('analytics.js');
  for(const path of ['/'+file,'/'+file.replace(/(index)?\.html$/,'')]){
   const [view]=runAnalytics(path,'allow').sent;
   expect(view?.page,path).toBe(label);
   const request=new Request('https://auth.qoopia.ai/analytics/events',{method:'POST',headers:{origin:'https://qoopia.ai','content-type':'application/json'},body:JSON.stringify(view)});
   expect((await browserEvent(request,()=>true)).status,path).toBe(204);
  }
 }
});

test('one working skip link per page, unique ids and no duplicate attributes',()=>{
 for(const page of readdirSync(site).filter(f=>f.endsWith('.html'))){
  const html=read(page),ids=new Set<string>();
  for(const [tag] of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/g)){
   const names=[...tag.matchAll(/\s([a-z-]+)(?==)/g)].map(m=>m[1]);
   expect(names.length,page+' '+tag).toBe(new Set(names).size);
   const id=/\sid="([^"]+)"/.exec(tag)?.[1];
   if(id){expect(ids.has(id),page+' #'+id).toBe(false);ids.add(id);}
  }
  for(const m of html.matchAll(/\shref="#([^"]+)"/g))expect(ids.has(m[1]),page+' href=#'+m[1]).toBe(true);
  expect(html.match(/class="(?:q-)?skip"/g)?.length,page).toBe(1);
 }
});

test('release notes show one language: each block is translated, or marked lang and hidden in the other language',()=>{
 const sections=[...read('releases.html').matchAll(/<section data-release-version="[^"]+">([\s\S]*?)<\/section>/g)].map(m=>m[1]);
 expect(sections.length).toBeGreaterThan(5);
 for(const section of sections)for(const [block] of section.matchAll(/<(h2|h3|p|li)\b[^>]*>[\s\S]*?<\/\1>/g))
  // Exactly one mechanism: a translated block marked lang would vanish in the other language.
  expect(/\slang="(en|ru)"/.test(block),block.slice(0,90)).toBe(!/data-i18n=/.test(block));
 expect(read('style.css')).toContain('html[lang=en] [data-release-version] [lang=ru],html[lang=ru] [data-release-version] [lang=en]{display:none}');
});

test('internal links use the canonical extensionless URLs, not .html redirects',()=>{
 const sources=[...pages.map(read),...scripts.map(read),readFileSync(new URL('../src/identity/profile-view.ts',import.meta.url),'utf8')];
 const redirects=sources.flatMap(text=>[...text.matchAll(/href="(?!https?:)[^"]*\.html[^"]*"|qoopia\.ai\/[a-z-]+\.html/g)].map(m=>m[0]));
 expect(redirects).toEqual([]);
});

test('every published site file is referenced by the site or is an intentional public file',()=>{
 const files=(readdirSync(site,{recursive:true}) as string[]).filter(f=>!f.split('/').some(part=>part.startsWith('.'))&&statSync(new URL(f,site)).isFile());
 const texts=files.filter(f=>/\.(html|js|css|json|xml)$/.test(f)).map(f=>[f,read(f)]);
 const intentional=['_headers','_redirects','robots.txt','sitemap.xml','release.json','candidate-release.json','ios-release.json','updates/macos/appcast.xml','brand/Manrope-OFL.txt'];
 const orphans=files.filter(f=>!f.endsWith('.html')&&!intentional.includes(f)&&!texts.some(([other,text])=>other!==f&&text.includes(f.split('/').pop()!)));
 expect(orphans).toEqual([]);
});

test('the 404 page works at any depth: every reference is root-absolute or external',()=>{
 // Pages serves 404.html at the missing URL, so a relative path resolves under /a/b/.
 const refs=[...read('404.html').matchAll(/\s(?:src|href)="([^"]*)"/g)].map(m=>m[1]);
 expect(refs.length).toBeGreaterThan(5);
 expect(refs.filter(ref=>!/^(\/|https:\/\/|#)/.test(ref))).toEqual([]);
});

test('every shipped surface gives the same dated ChatGPT status and no stale qualification claim [F-246]',()=>{
 const repo=(name:string)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
 const docs=read('docs.html'),russian=[...docs.matchAll(/data-i18n="([^"]*)"/g)].map(m=>ru[decode(m[1])]??'').join('\n');
 const surfaces:Record<string,string>={'docs.html':docs,'docs.html (ru)':russian,'scripts/build-bundle.ts':repo('scripts/build-bundle.ts'),
  'src/public/brand/dashboard.js':repo('src/public/brand/dashboard.js'),'src/public/connections-agent.md':repo('src/public/connections-agent.md'),
  'src/public/connections-guide-en.html':repo('src/public/connections-guide-en.html'),'src/public/connections-guide-ru.html':repo('src/public/connections-guide-ru.html'),
  'src/agent-kit/MCP-CONNECTIONS.md':repo('src/agent-kit/MCP-CONNECTIONS.md'),'docs/operations/connections.md':repo('docs/operations/connections.md')};
 const stale=/ChatGPT[^.<\n]*(?:experimental|экспериментал)|not qualified for this release|не принят для текущего выпуска|remain unqualified|fully qualified setup path|repeated one-use verification|Повтор одноразовой проверки/gi;
 expect(Object.entries(surfaces).flatMap(([name,text])=>(text.match(stale)??[]).map(hit=>name+': '+hit))).toEqual([]);
 // The status is dated and says the current consent flow was not re-run with a real ChatGPT account.
 expect(Object.entries(surfaces).filter(([,text])=>!/(15 September 2026|2026-09-15|15 сентября 2026|15\.09\.2026)/.test(text)||!/not been re-verified|повторно не проверял/.test(text)).map(([name])=>name)).toEqual([]);
 expect(Object.keys(ru).filter(key=>/ChatGPT.*experimental|Full setup qualification/.test(key))).toEqual([]);
});

test('onboarding text describes the shipped connection flow, not the retired verification prompt [F-245]',()=>{
 const docs=read('docs.html'),task=read('install-agent.js'),runbook=readFileSync(new URL('../docs/operations/connections.md',import.meta.url),'utf8');
 const russian=[...docs.matchAll(/data-i18n="([^"]*)"/g)].map(m=>ru[decode(m[1])]??'');
 expect([docs,task,runbook,...russian].flatMap(text=>text.match(/verification\s+prompt|application menu|проверочн\S* запрос|меню приложений/gi)??[])).toEqual([]);
 expect(docs).toContain('its first Qoopia protocol call confirms the connection');
 expect(task.match(/qoopia_protocol/g)?.length).toBe(2);
});

test('the agent task and the package say how to check manifest.sig and where the Mac CLI is [F-302]',()=>{
 const task=read('install-agent.js'),bundle=readFileSync(new URL('../scripts/build-bundle.ts',import.meta.url),'utf8');
 const agent=readFileSync(new URL('../src/public/connections-agent.md',import.meta.url),'utf8');
 const command=/openssl pkeyutl -verify [^`'"\n(]*-sigfile manifest\.sig/.exec(task)?.[0];
 expect(command).toBeString();expect(task.split(command!).length).toBe(3);expect(bundle).toContain(command!);
 for(const text of [task,agent])expect(text).toContain('/Applications/Qoopia.app/Contents/Resources/bundle/qoopia');
 expect(task).not.toContain('using the package instructions');
 // The documented command verifies a manifest signed the way build-bundle signs it (Ed25519 over the raw bytes).
 const openssl=spawnSync('openssl',['version'],{encoding:'utf8'});
 if(openssl.status!==0||!/^OpenSSL [3-9]/.test(openssl.stdout))return; // LibreSSL lacks -rawin Ed25519
 const dir=mkdtempSync(join(tmpdir(),'qoopia-manifest-sig-'));
 try{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),manifest=Buffer.from('{"format":"qoopia-bundle/1"}');
  writeFileSync(join(dir,'publisher-public-key.pem'),publicKey.export({type:'spki',format:'pem'}));
  writeFileSync(join(dir,'manifest.json'),manifest);writeFileSync(join(dir,'manifest.sig'),sign(null,manifest,privateKey));
  const run=(args:string[])=>spawnSync('openssl',args,{cwd:dir,encoding:'utf8'});
  const ok=run(command!.split(' ').slice(1));expect(ok.status).toBe(0);expect(ok.stdout).toContain('Signature Verified Successfully');
  writeFileSync(join(dir,'manifest.json'),'{"format":"tampered"}');expect(run(command!.split(' ').slice(1)).status).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
