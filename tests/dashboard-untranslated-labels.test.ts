// F-520-skill-labels: the skill pages printed "Blocked:", "Desired: active", "Permissions: none" and "Renderer:"
// in English on Russian pages, outside the catalog. No visible "Label:" literal may bypass QI any more.
import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {dashboardScript} from './helpers/dashboard-source.ts';

const chat=readFileSync(new URL('../src/public/brand/agent-chat.js',import.meta.url),'utf8');
const literal=/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// Remove explicit translations: QI.msg/QI.plain(<literal>…) and t(<en>,<ru>).
const outsideCatalog=(code:string)=>code.replace(new RegExp('QI\\.(?:msg|plain)\\(\\s*(?:'+literal.source+')','g'),'QI(').replace(new RegExp('\\bt\\(\\s*(?:'+literal.source+')\\s*,\\s*(?:'+literal.source+')','g'),'t(');

test('no English "Label:" text reaches the page outside the catalog',()=>{
 const found:string[]=[];
 for(const code of [dashboardScript,chat])for(const [lit] of outsideCatalog(code).matchAll(literal)){
  for(const text of lit.slice(1,-1).split(/<[^>]*>/))if(/^\s*[A-Z][a-z]+(?: [a-z]+)*: ?$/.test(text))found.push(text);
 }
 expect(found).toEqual([]);
});

// F-520-attributes: the agent page's search field said "Search this agent's messages…", a note's id "copy id" and
// a Telegram topic's tooltip "Topic: …" in English on Russian pages. A visible attribute is a catalog message or
// has data-i18n-*. The note and session id copy targets are buttons, so a keyboard reaches them.
test('placeholders and tooltips are never fixed English text; id copy targets are buttons',()=>{
 expect(dashboardScript).toContain('<button type="button" class="copyable mono" data-copy="');
 expect(dashboardScript).toContain('<button type=\\"button\\" class=\\"copyable\\" id=\\"sidCopy\\"');
 expect(dashboardScript).not.toContain("'<div class=\"note-meta\">tags: '");
 const found:string[]=[];
 for(const code of [dashboardScript,chat])for(const m of code.matchAll(/(placeholder|title|aria-label|alt)=\\?["']([^"'\\]*(?:\\'[^"'\\]*)*)\\?["']( data-i18n-([a-z-]+)=\\?")?/g)){
  const [whole,attr,text,,translated]=m;if(translated===attr||!/[A-Za-z]{2,}[^A-Za-z]+[a-z]{2,}/.test(text!))continue;found.push(whole);
 }
 expect(found).toEqual([]);
 // The full-width search hint fits a phone's field instead of being cut mid-word.
 const ru:Record<string,string>=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8'));
 expect(ru['Search messages and notes…']!.length).toBeLessThanOrEqual(32);
});
