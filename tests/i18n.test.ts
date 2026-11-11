import {test,expect} from 'bun:test';
import {dashboardSource} from './helpers/dashboard-source.ts';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {brandAsset} from '../src/brand.ts';
const ru=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8')) as Record<string,string>;
test('every explicit dashboard UI message has a Russian translation and matching placeholders',()=>{
 const html=dashboardSource;
 const keys=[...html.matchAll(/QI\.msg\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)].map(m=>m[1][0]==='"'?JSON.parse(m[1]):m[1].slice(1,-1));
 for(const key of keys)expect(ru[key],key).toBeString();
 for(const [key,value] of Object.entries(ru)){expect(value.trim().length,key).toBeGreaterThan(0);expect([...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),key).toEqual([...key.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort());}
});
test('the shared locale runtime is explicitly served, without exposing arbitrary files',()=>{
 expect(brandAsset('/brand/i18n.js')?.type).toBe('text/javascript; charset=utf-8');
 expect(brandAsset('/brand/../identity/broker.ts')).toBeUndefined();
 expect(brandAsset('/brand/i18n.ru.json')).toBeUndefined();
});
test('server sentences the dashboard shows verbatim for device-code sign-in and another-computer memory are translated',async()=>{
 // loginError and the memory settings status line show the server's error text through the catalog.
 const {DEVICE_CODE_UNSUPPORTED,DEVICE_CODE_LAUNCHER_ONLY}=await import('../src/identity/local.ts');
 const setup=readFileSync(new URL('../src/services/memory-setup.ts',import.meta.url),'utf8');
 const notReady=/QoopiaError\('NOT_READY','([^']+)'/.exec(setup)![1]!;
 for(const sentence of [DEVICE_CODE_UNSUPPORTED,DEVICE_CODE_LAUNCHER_ONLY,notReady])expect(ru[sentence],sentence).toBeString();
});
// A translation is data: «$&», «$'» or «$$» in it must reach the page as written, not as a replace() pattern.
test('the generated locale runtime carries the catalog exactly, whatever characters a translation holds',async()=>{
 const {renderRuntime}=await import('../scripts/build-ui-locales.ts');
 const tricky={'Price':"$& стоит $$5, а $' и $` остаются"};
 expect(renderRuntime('const catalog = __CATALOG__;',tricky)).toBe('const catalog = '+JSON.stringify(tricky)+';');
 const template=readFileSync(new URL('../scripts/ui/i18n-runtime.js',import.meta.url),'utf8'),[head,tail]=template.split('__CATALOG__') as [string,string];
 const generated=readFileSync(new URL('../src/public/brand/i18n.js',import.meta.url),'utf8');
 expect(generated.slice(head.length,generated.length-tail.length)).toBe(JSON.stringify(ru));
});
/** The built runtime in a page of its own; `observe` hands a change back to it, as the browser's observer does. */
function runtime(language:'en'|'ru'){
 let observe:(records:unknown[])=>void=()=>{};const listeners:Record<string,()=>void>={};
 const window:any={addEventListener(){},dispatchEvent(){}};
 const document={cookie:'',documentElement:{dataset:{},lang:'en'},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(name:string,fn:()=>void)=>{listeners[name]=fn;},body:{}};
 runInNewContext(readFileSync(new URL('../src/public/brand/i18n.js',import.meta.url),'utf8'),{window,document,location:{search:'?lang='+language,hostname:'localhost',href:'http://localhost/dashboard',hash:''},
  localStorage:{getItem:()=>null,setItem(){}},navigator:{language:'en-US'},crypto:globalThis.crypto,history:{replaceState(){}},URL,URLSearchParams,Intl,
  Node:{TEXT_NODE:3,ELEMENT_NODE:1,DOCUMENT_NODE:9},CustomEvent:class{},MutationObserver:class{constructor(fn:(records:unknown[])=>void){observe=fn;}observe(){}}});
 listeners.DOMContentLoaded!();
 // A text node as the browser gives it: every write is reported back to the runtime.
 const text=(value:string)=>{const node={nodeType:3,isConnected:true,value,changed:false,get nodeValue(){return this.value;},set nodeValue(v:string){this.value=v;this.changed=true;}};
  return {node,settle(){while(node.changed){node.changed=false;observe([{type:'characterData',target:node}]);}}};};
 return {QI:window.QI,text};
}
// A phrase whose parameter is itself a date or a number («Showing the latest {n} of {total} messages.») kept its
// English words after the switch to Russian: only the number inside was translated again.
test('a message with a date or number inside follows the language switch as a whole',()=>{
 const {QI,text}=runtime('en'),{node,settle}=text(QI.msg('Showing the latest {n} of {total} messages.',{n:QI.number(500),total:QI.number(1200)}));
 QI.scan(node);settle();
 expect(node.value).toBe('Showing the latest 500 of 1,200 messages.');
 QI.setLanguage('ru');settle();
 expect(node.value).toBe(ru['Showing the latest {n} of {total} messages.']!.replace('{n}','500').replace('{total}',new Intl.NumberFormat('ru').format(1200)));
 expect(QI.resolve(QI.msg('Agent {name}',{name:QI.msg('Memory')}))).toBe('Агент Память');
});
// A long-open page drops old tokens; one that lives only as a parameter of a phrase still on the page is not old.
test('a number inside a phrase that is still shown survives the token cleanup',()=>{
 const {QI,text}=runtime('ru'),{node,settle}=text(QI.msg('Showing the latest {n} of {total} messages.',{n:QI.number(7),total:QI.number(9)}));
 QI.scan(node);settle();
 for(let i=0;i<50_000;i++)QI.date(i*1000,{timeStyle:'short'});
 QI.setLanguage('en');settle();
 expect(node.value).toBe('Showing the latest 7 of 9 messages.');
});
