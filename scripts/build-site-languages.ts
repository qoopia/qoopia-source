/**
 * qoopia.ai is written once, in English, with data-i18n keys. This renders the Russian copies
 * (marketing-site/ru/) from the same pages and the shared catalog, so crawlers get Russian HTML and
 * the two languages cannot drift. It also refreshes ?v= asset hashes, the static iPhone install state
 * (ios-release.json), the static current release (release.json: download links, checksums, JSON-LD),
 * sitemap.xml, llms.txt and llms-full.txt. The release notes source is scripts/site-releases.html: each
 * language page keeps only its own language blocks.
 *   bun scripts/build-site-languages.ts           write
 *   bun scripts/build-site-languages.ts --check   fail when a committed file is stale
 */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';

const site=new URL('../marketing-site/',import.meta.url);
const ru=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8')) as Record<string,string>;
const origin='https://qoopia.ai';
// English path → Russian path. understand and ru/understand are rendered by scripts/discovery-content.py.
export const routes:[file:string,en:string,ru:string][]=[['index','/','/ru/'],['docs','/docs','/ru/docs'],['mobile','/mobile','/ru/mobile'],['releases','/releases','/ru/releases']];
const pairs:[string,string][]=[...routes.map(([,en,r])=>[en,r] as [string,string]),['/understand','/ru/understand']];
const russianPath=new Map(pairs);
const json=(file:string|URL)=>JSON.parse(readFileSync(file,'utf8'));
type Package={label:string;format:string;file:string;bytes:number;sha256:string;url:string;requirements:string};
type Release={version:string;tag:string;date:string;source:string;availability:string;packages:{mac:Package;linux:Package}};
const release=json(new URL('release.json',site)) as Release;
const reviewed=(json(new URL('../docs/discovery/answers.json',import.meta.url)) as {reviewed_date:string}).reviewed_date;
const source=(file:string)=>readFileSync(file==='releases'?new URL('site-releases.html',import.meta.url):new URL(file+'.html',site),'utf8');

const decode=(s:string)=>s.replace(/&(amp|quot|lt|gt|#39);/g,(_,e:string)=>({amp:'&',quot:'"',lt:'<',gt:'>','#39':"'"})[e]!);
const text=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const attr=(s:string)=>text(s).replaceAll('"','&quot;');
const localize=(href:string)=>{const [path,hash]=href.split(/(?=#)/);return (russianPath.get(path!)??path)+(hash??'');};

function refreshHashes(html:string){
 return html.replace(/(src|href)="\/([^"?#]+)\?v=[0-9a-f]+"/g,(_,name:string,file:string)=>
  `${name}="/${file}?v=${createHash('sha256').update(readFileSync(new URL(file,site))).digest('hex').slice(0,12)}"`);
}

// The iPhone install block as site.js renders it, so crawlers and visitors without JavaScript read the current state.
function iosInstall(html:string){
 const release=JSON.parse(readFileSync(new URL('ios-release.json',site),'utf8')) as {status:string;public_url:string};
 const span=(text:string)=>`<span data-i18n="${attr(text)}">${text}</span>`;
 const body=release.status==='available'&&/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(release.public_url)?`<a class="button" href="${release.public_url}">${span('Install on iPhone')}</a>`
  :`<p class="notice" role="status">${span(release.status==='review'?'Apple is reviewing the public beta. Installation will open here after approval.':'The public beta is being prepared. Installation will open here after Apple approval.')}</p>`;
 return html.replace(/(<div data-ios-install>)[\s\S]*?(<\/div>)/,`$1${body}$2`);
}

const say=(lang:'en'|'ru',text:string)=>{if(lang==='en')return text;const value=ru[text];if(typeof value!=='string')throw Error('No Russian for '+JSON.stringify(text));return value;};
const megabytes=(lang:'en'|'ru',bytes:number)=>new Intl.NumberFormat(lang==='ru'?'ru-RU':'en-GB',{maximumFractionDigits:1}).format(bytes/1e6)+' '+say(lang,'MB');
const day=(lang:'en'|'ru')=>new Intl.DateTimeFormat(lang==='ru'?'ru-RU':'en-GB',{dateStyle:'long',timeZone:'UTC'}).format(new Date(release.date+'T12:00:00Z'));
const platforms=['mac','linux'] as const;
// The current release as site.js and the old release-notes.js drew it, for readers and crawlers without
// JavaScript (A9-02, A6-10). Links go through /download/<platform>, which is counted on the server.
function releaseBlocks(html:string,lang:'en'|'ru'){
 if(release.availability!=='public')throw Error('release.json is not public: the site offers only public packages');
 const link=(p:typeof platforms[number],cls:string,label:string)=>`<a${cls?` class="${cls}"`:''} href="/download/${p}" data-platform="${p}" data-version="${attr(release.version)}">${text(label)}</a>`;
 const state=`Qoopia ${text(release.version)} · ${text(day(lang))}`;
 const action=platforms.map(p=>{const pkg=release.packages[p];
  return `<p class="release-meta">${text(pkg.label)} · ${text(pkg.format)} · ${text(megabytes(lang,pkg.bytes))}</p>${link(p,'button',say(lang,'Download {format} ↓').replace('{format}',pkg.format))}<p class="release-meta">SHA-256: ${text(pkg.sha256)}</p>`;}).join('');
 const packages=`<p>${text(release.tag)} · ${text(day(lang))} · ${text(say(lang,'runtime {source}').replace('{source}',release.source.slice(0,7)))}</p>`+platforms.map(p=>{const pkg=release.packages[p];
  return `<p class="release-meta">${link(p,'',pkg.label+' · '+pkg.format)} · ${text(megabytes(lang,pkg.bytes))} — ${text(pkg.file)} — SHA-256: ${text(pkg.sha256)}</p><p class="release-meta">${text(say(lang,pkg.requirements))}</p>`;}).join('');
 return html.replace(/(<div class="release-state" id="release-state"[^>]*>)[\s\S]*?(<\/div>)/,`$1${state}$2`)
  .replace(/(<div id="download-action">)[\s\S]*?(<\/div>)/,`$1${action}$2`)
  .replace(/(<div id="packages">)[\s\S]*?(<\/div>)/,`$1${packages}$2`);
}
// Release notes carry each version in both languages (lang="en"/lang="ru"); a page keeps its own (A9-07).
const ownLanguage=(html:string,lang:'en'|'ru')=>html.replace(/<(p|span)\b[^>]*\slang="(en|ru)"[^>]*>[\s\S]*?<\/\1>/g,(block,_tag:string,blockLang:string)=>blockLang===lang?block:'');
// Version, price and download addresses in the structured data come from release.json (A9-10).
function softwareData(html:string){
 return html.replace(/(<script type="application\/ld\+json">)(.*?)(<\/script>)/gs,(_,a:string,data:string,b:string)=>a+JSON.stringify(JSON.parse(data,(_key,value)=>value?.['@type']==='SoftwareApplication'?{...value,
  softwareVersion:release.version,downloadUrl:platforms.map(p=>`${origin}/download/${p}`),releaseNotes:`${origin}/releases`,offers:{'@type':'Offer',price:'0',priceCurrency:'USD'}}:value)).replaceAll('</','<\\/')+b);
}

export function russian(html:string,file:string){
 const t=(key:string)=>{const value=ru[decode(key)];if(typeof value!=='string')throw Error(`${file}: no Russian for ${JSON.stringify(decode(key))}`);return value;};
 const keys=html.match(/\sdata-i18n="/g)?.length??0;let done=0;
 // Same rule as the runtime: a data-i18n element holds one text node and gets the catalog text.
 html=html.replace(/<([a-z][a-z0-9]*)\b([^>]*\sdata-i18n="([^"]*)"[^>]*)>[^<]*<\/\1>/g,(_,tag:string,attrs:string,key:string)=>{done++;return `<${tag}${attrs}>${text(t(key))}</${tag}>`;});
 if(done!==keys)throw Error(`${file}: ${keys-done} data-i18n elements hold markup; keep one text node per key`);
 html=html.replace(/<[a-z][a-z0-9]*\b[^>]*>/g,tag=>{
  for(const [,name,key] of tag.matchAll(/\sdata-i18n-([a-z-]+)="([^"]*)"/g)){
   const own=new RegExp(`(\\s${name}=")[^"]*"`);if(!own.test(tag))throw Error(`${file}: ${tag} lacks ${name}`);
   tag=tag.replace(own,(_,start:string)=>start+attr(t(key!))+'"');
  }
  // Links into the site point at the Russian page; the language switcher (hreflang) already names its target.
  if(tag.startsWith('<a ')&&!/\shreflang=/.test(tag))tag=tag.replace(/\shref="(\/[^"]*)"/,(_,href:string)=>` href="${localize(href)}"`);
  if(/\sdata-language="/.test(tag))tag=tag.replace(' aria-current="page"','').replace(/(data-language="ru")/,'$1 aria-current="page"');
  return tag;
 });
 html=html.replace('<html lang="en" data-static-language>','<html lang="ru" data-static-language>')
  .replace(/(<link href=")([^"]+)(" rel="canonical"\/>)/,(_,a:string,url:string,b:string)=>a+origin+localize(url.slice(origin.length))+b)
  .replace(/(<meta content=")([^"]+)(" property="og:url"\/>)/,(_,a:string,url:string,b:string)=>a+origin+localize(url.slice(origin.length))+b)
  .replace('<meta content="en_US" property="og:locale"/><meta content="ru_RU" property="og:locale:alternate"/>','<meta content="ru_RU" property="og:locale"/><meta content="en_US" property="og:locale:alternate"/>')
  .replace(/(<script type="application\/ld\+json">)(.*?)(<\/script>)/gs,(_,a:string,json:string,b:string)=>a+JSON.stringify(JSON.parse(json,(key,value)=>
   // Nodes that state their language describe this page; the organization keeps its own address.
   key==='description'?t(value):value?.inLanguage==='en'?{...value,inLanguage:'ru',url:origin+localize(value.url.slice(origin.length)),
    ...(value['@id']?{'@id':value['@id'].replace(value.url,origin+localize(value.url.slice(origin.length)))}:{})}:value)).replaceAll('</','<\\/')+b);
 return html;
}

const head=(html:string,name:string)=>decode(new RegExp(`<meta content="([^"]*)"[^>]*name="${name}"|<meta name="${name}" content="([^"]*)"`).exec(html)!.slice(1).find(Boolean)!);
const title=(html:string)=>decode(/<title[^>]*>([^<]*)<\/title>/.exec(html)![1]!);

export function render(){
 const out=new Map<string,string>();
 // 404.html is served at any missing address and follows the visitor's language in place, so it has no copy.
 for(const file of [...routes.map(([file])=>file),'404']){
  const en=softwareData(iosInstall(refreshHashes(source(file))));
  out.set(file+'.html',releaseBlocks(ownLanguage(en,'en'),'en'));
  if(file!=='404')out.set('ru/'+file+'.html',releaseBlocks(ownLanguage(russian(en,file+'.html'),'ru'),'ru'));
 }
 out.set('sitemap.xml','<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'+pairs.flatMap(([en,r])=>{
  const alternates=([['en',en],['ru',r],['x-default',en]] as const).map(([lang,href])=>`<xhtml:link rel="alternate" hreflang="${lang}" href="${origin}${href}"/>`).join('');
  // Site pages are reviewed and redeployed with each release; the explanation pages carry their own review date.
  const lastmod=en==='/understand'?reviewed:release.date;
  return [en,r].map(loc=>`<url><loc>${origin}${loc}</loc><lastmod>${lastmod}</lastmod>${alternates}</url>\n`);
 }).join('')+'</urlset>\n');
 const page=(path:string)=>{const file=path==='/'?'index.html':path==='/ru/'?'ru/index.html':path.slice(1)+'.html';return out.get(file)??readFileSync(new URL(file,site),'utf8');};
 const list=(lang:0|1)=>pairs.map(pair=>{const html=page(pair[lang]);return `- [${title(html)}](${origin}${pair[lang]}): ${head(html,'description')}`;}).join('\n');
 const mac=release.packages.mac,linux=release.packages.linux;
 out.set('llms.txt',`# Qoopia

> ${head(page('/'),'description')}

Each page exists in English and Russian with the same content. Full text for AI assistants: ${origin}/llms-full.txt

## Current release

- Qoopia ${release.version}, released ${release.date} (source ${release.source.slice(0,7)}). Machine-readable manifest: ${origin}/release.json
- macOS Apple Silicon, ${mac.format}: ${origin}/download/mac (signed file: ${mac.url}), SHA-256 ${mac.sha256}
- Linux x64, ${linux.format}: ${origin}/download/linux (signed file: ${linux.url}), SHA-256 ${linux.sha256}

## Requirements

- Mac: ${mac.requirements}
- Linux: ${linux.requirements} The ps command (procps) must be installed. Run as a normal user, not root.
- No separate Bun, Docker or Ollama. Cloud model features need internet access and your own supported subscription.
- iPhone: a free TestFlight beta (iOS 17+) that opens the dashboard of a server installation reachable over HTTPS. A Mac or Linux installation keeps its dashboard on that computer.

## Install

1. Download the package for your computer and check its SHA-256.
2. Mac: open the DMG, move Qoopia to Applications and open it. Linux: extract the TAR.GZ and run ./qoopia open; to keep it running without a terminal, run ./qoopia service install --commit, and on a server also loginctl enable-linger $USER.
3. Sign in with Google or email, then connect your agents in Connections.

A local Codex or Claude Code session can do this for you: ${origin}/docs#agent-install

## Works with

- Claude Code and Codex: memory tools and native session capture.
- Claude Desktop on macOS.
- Claude in a browser and ChatGPT Web/Desktop through external HTTPS access prepared in Connections. ChatGPT last passed real-client acceptance on 15 September 2026; the current consent flow has not been re-verified since.
- Other MCP clients with a separate agent identity.

## Price and license

Qoopia is free; its source is MIT-licensed. Model subscriptions and server hosting are separate costs.

## English

${list(0)}

## Русский

${list(1)}

## Source

- [Qoopia source](https://github.com/qoopia/qoopia-source): MIT-licensed source code
- [Signed installers](https://github.com/qoopia/qoopia-downloads/releases): macOS (Apple Silicon) and Linux (x64)
- [Report a problem](https://github.com/qoopia/qoopia-source/issues)
`);
 // The same reviewed explanation and the setup guide as plain text, for assistants that read one file (A9-06).
 const plain=(html:string)=>decode(html.slice(html.indexOf('<main'),html.indexOf('</main>'))
  .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/g,'').replace(/<h([1-3])\b[^>]*>/g,(_,n:string)=>'\n\n'+'#'.repeat(Number(n)+1)+' ')
  .replace(/<(p|li|tr|summary|details|section|div|pre)\b[^>]*>/g,'\n').replace(/<[^>]+>/g,'')).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
 out.set('llms-full.txt',`# Qoopia — full text\n\nGenerated from ${origin}/understand and ${origin}/docs for Qoopia ${release.version}. The short index is ${origin}/llms.txt.\n\n`
  +readFileSync(new URL('../docs/discovery/UNDERSTAND-EN.md',import.meta.url),'utf8').replace(/^# /,'## ').replace(/\n## /g,'\n### ')+'\n## Setup guide\n\n'+plain(page('/docs'))+'\n');
 return out;
}

if(import.meta.main){
 const check=process.argv.includes('--check'),stale:string[]=[];
 for(const [file,content] of render()){
  const target=new URL(file,site),current=existsSync(target)?readFileSync(target,'utf8'):null;
  if(current===content)continue;
  if(check)stale.push(file);else{mkdirSync(new URL('.',target),{recursive:true});writeFileSync(target,content);}
 }
 if(stale.length)throw Error('Run bun scripts/build-site-languages.ts and commit: '+stale.join(', '));
}
