/**
 * qoopia.ai is written once, in English, with data-i18n keys. This renders the Russian copies
 * (marketing-site/ru/) from the same pages and the shared catalog, so crawlers get Russian HTML and
 * the two languages cannot drift. It also refreshes ?v= asset hashes, the static iPhone install state
 * (ios-release.json), sitemap.xml and llms.txt.
 *   bun scripts/build-site-languages.ts           write
 *   bun scripts/build-site-languages.ts --check   fail when a committed file is stale
 */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';

const site=new URL('../marketing-site/',import.meta.url);
const ru=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8')) as Record<string,string>;
const origin='https://qoopia.ai';
// English path → Russian path. understand/understand-ru are rendered by scripts/discovery-content.py.
export const routes:[file:string,en:string,ru:string][]=[['index','/','/ru/'],['docs','/docs','/ru/docs'],['mobile','/mobile','/ru/mobile'],['releases','/releases','/ru/releases']];
const pairs:[string,string][]=[...routes.map(([,en,r])=>[en,r] as [string,string]),['/understand','/understand-ru']];
const russianPath=new Map(pairs);

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
   key==='description'?t(value):value?.inLanguage==='en'?{...value,inLanguage:'ru',url:origin+localize(value.url.slice(origin.length))}:value)).replaceAll('</','<\\/')+b);
 return html;
}

const head=(html:string,name:string)=>decode(new RegExp(`<meta content="([^"]*)"[^>]*name="${name}"|<meta name="${name}" content="([^"]*)"`).exec(html)!.slice(1).find(Boolean)!);
const title=(html:string)=>decode(/<title[^>]*>([^<]*)<\/title>/.exec(html)![1]!);

export function render(){
 const out=new Map<string,string>();
 // 404.html is served at any missing address and follows the visitor's language in place, so it has no copy.
 for(const file of [...routes.map(([file])=>file),'404']){
  const en=iosInstall(refreshHashes(readFileSync(new URL(file+'.html',site),'utf8')));
  out.set(file+'.html',en);if(file!=='404')out.set('ru/'+file+'.html',russian(en,file+'.html'));
 }
 out.set('sitemap.xml','<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'+pairs.flatMap(([en,r])=>{
  const alternates=([['en',en],['ru',r],['x-default',en]] as const).map(([lang,href])=>`<xhtml:link rel="alternate" hreflang="${lang}" href="${origin}${href}"/>`).join('');
  return [en,r].map(loc=>`<url><loc>${origin}${loc}</loc>${alternates}</url>\n`);
 }).join('')+'</urlset>\n');
 const page=(path:string)=>{const file=path==='/'?'index.html':path==='/ru/'?'ru/index.html':path.slice(1)+'.html';return out.get(file)??readFileSync(new URL(file,site),'utf8');};
 const list=(lang:0|1)=>pairs.map(pair=>{const html=page(pair[lang]);return `- [${title(html)}](${origin}${pair[lang]}): ${head(html,'description')}`;}).join('\n');
 out.set('llms.txt',`# Qoopia\n\n> ${head(page('/'),'description')}\n\nEach page exists in English and Russian with the same content.\n\n## English\n\n${list(0)}\n\n## Русский\n\n${list(1)}\n\n## Source\n\n- [Qoopia source](https://github.com/qoopia/qoopia-source): MIT-licensed source code\n- [Signed installers](https://github.com/qoopia/qoopia-downloads/releases): macOS (Apple Silicon) and Linux (x64)\n`);
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
