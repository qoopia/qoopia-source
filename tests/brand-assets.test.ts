import {test,expect} from 'bun:test';
import {brandAsset} from '../src/brand.ts';
import {Database} from 'bun:sqlite';
import {loginBroker} from '../src/identity/broker.ts';
test('brand assets are public but the allowlist never exposes other source or operator files',async()=>{
 for(const p of ['/brand/../identity/broker.ts','/brand/../../.env','/brand/toString','/brand/__proto__','/src/public/dashboard.html'])expect(brandAsset(p)).toBeUndefined();
 expect(brandAsset('/brand/IBMPlexSans.ttf')?.type).toBe('font/ttf');
 const db=new Database(':memory:');
 const broker=loginBroker(db,{origin:'https://auth.example.test',resendKey:'fixture',from:'fixture',googleClientId:'fixture',googleClientSecret:'fixture'},(async()=>{throw Error('Network forbidden');}) as typeof fetch);
 const response=await broker(new Request('https://auth.example.test/brand/base.css'),'fixture');expect(response.status).toBe(200);expect(await response.text()).toContain('IBM Plex Sans');db.close();
});
