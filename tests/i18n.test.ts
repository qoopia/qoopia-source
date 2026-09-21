import {test,expect} from 'bun:test';
import {dashboardSource} from './helpers/dashboard-source.ts';
import {readFileSync} from 'node:fs';
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
