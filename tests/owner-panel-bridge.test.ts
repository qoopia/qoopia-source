import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {accounts} from '../src/identity/account.ts';
import {loginBroker} from '../src/identity/broker.ts';

test('private owner bridge renders only the configured owner inside the dashboard',async()=>{
  const db=new Database(':memory:');
  try{
    const identify=accounts(db);
    const owner=identify({email:'owner@example.test'});
    identify({email:'another@example.test'});
    const secret='owner-bridge-test-secret-at-least-32-bytes';
    const broker=loginBroker(db,{
      origin:'https://auth.example.test',resendKey:'',from:'',googleClientId:'',googleClientSecret:'',
      owner:{accountId:owner},ownerBridgeSecret:secret,
    });
    const request=(email:string,authorization='Bearer '+secret,url='http://127.0.0.1:3740/internal/owner')=>
      broker(new Request(url,{method:'POST',headers:{authorization,'content-type':'application/json'},
        body:JSON.stringify({email,lang:'ru',page:0})}),'127.0.0.1');

    const allowed=await request('owner@example.test');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    const result=await allowed.json() as {html:string};
    expect(result.html).toContain('Закрытые данные аккаунтов');
    expect(result.html).toContain('another@example.test');
    expect(result.html).toContain('data-owner-section="accounts"');
    expect(result.html).not.toContain('href="/profile?lang=ru"');

    for(const denied of [
      request('another@example.test'),
      request('owner@example.test','Bearer wrong'),
      request('owner@example.test',''),
      request('owner@example.test','Bearer '+secret,'https://auth.example.test/internal/owner'),
    ]){
      const response=await denied;
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain('another@example.test');
    }
  }finally{db.close();}
});
