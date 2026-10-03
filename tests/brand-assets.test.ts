import {test,expect} from 'bun:test';
import {brandAsset,brandHead} from '../src/brand.ts';
import fs from 'node:fs';
import {Database} from 'bun:sqlite';
import {loginBroker} from '../src/identity/broker.ts';
import {fakeFetch} from './helpers/fake-fetch.ts';
test('brand assets are public but the allowlist never exposes other source or operator files',async()=>{
 for(const p of ['/brand/../identity/broker.ts','/brand/../../.env','/brand/toString','/brand/__proto__','/src/public/dashboard.html'])expect(brandAsset(p)).toBeUndefined();
 for(const name of ['graphite/qoopia-mark-ivory.svg','graphite/qoopia-wordmark-ivory.svg','graphite/favicon.svg'])expect(brandAsset('/brand/'+name)?.type).toBe('image/svg+xml');
 expect(brandAsset('/brand/agent-chat.js')?.type).toContain('javascript');
 expect(brandAsset('/brand/agent-chat.css')?.type).toContain('text/css');
 expect(brandAsset('/brand/Manrope.ttf')?.type).toBe('font/ttf');
 expect(brandAsset('/brand/IBMPlexSans.ttf')).toBeUndefined();
 const db=new Database(':memory:');
 const broker=loginBroker(db,{origin:'https://auth.example.test',resendKey:'fixture',from:'fixture',googleClientId:'fixture',googleClientSecret:'fixture'},fakeFetch(async()=>{throw Error('Network forbidden');}));
 const response=await broker(new Request('https://auth.example.test/brand/base.css'),'fixture');expect(response.status).toBe(200);expect(await response.text()).toContain('Manrope');db.close();
});

test('consent and account pages carry the dashboard touch icon and theme colour, served on every host',async()=>{
 const dashboard=fs.readFileSync(new URL('../src/public/dashboard.html',import.meta.url),'utf8');
 const attr=(html:string,re:RegExp)=>html.match(re)?.[1];
 const icon=attr(brandHead,/rel="apple-touch-icon" href="([^"]+)"/),theme=attr(brandHead,/name="theme-color" content="([^"]+)"/);
 expect(icon).toBe(attr(dashboard,/rel="apple-touch-icon" href="([^"]+)"/));
 expect(theme).toBe(attr(dashboard,/name="theme-color" content="([^"]+)"/));
 expect(brandAsset(icon!)?.type).toBe('image/png');
 // The broker serves /brand/* only, so brandHead must not point at the dashboard-only manifest.
 expect(brandHead).not.toContain('manifest');
 const db=new Database(':memory:');
 const broker=loginBroker(db,{origin:'https://auth.example.test',resendKey:'fixture',from:'fixture',googleClientId:'fixture',googleClientSecret:'fixture'},fakeFetch(async()=>{throw Error('Network forbidden');}));
 expect((await broker(new Request('https://auth.example.test'+icon),'fixture')).status).toBe(200);db.close();
});
