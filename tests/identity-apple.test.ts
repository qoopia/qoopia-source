import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {SignJWT,exportJWK,generateKeyPair} from 'jose';
import {loginBroker,APPLE_KEYS_URL} from '../src/identity/broker.ts';

// Sign in with Apple (App Store guideline 4.8): the iPhone app proves the Apple account with Apple's
// identity token; the account page that started the request redeems it. Apple's keys are a local fixture.
const origin='https://auth.example.test',app='Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Qoopia-iOS/4';
const appleKey=await generateKeyPair('RS256'),otherKey=await generateKeyPair('RS256');
const jwk={...await exportJWK(appleKey.publicKey),kid:'apple-fixture',alg:'RS256',use:'sig'};

type Claims={iss?:string;aud?:string;sub?:string;email?:string|null;email_verified?:boolean|string;exp?:number;nonce?:string;key?:CryptoKey;kid?:string};
const appleToken=async(nonce:string,claims:Claims={})=>{
  const payload:Record<string,unknown>={nonce:claims.nonce??createHash('sha256').update(nonce).digest('hex'),email_verified:claims.email_verified??true};
  if(claims.email!==null)payload.email=claims.email??'abc123@privaterelay.apple.example.test';
  return new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:claims.kid??'apple-fixture'})
    .setIssuer(claims.iss??'https://appleid.apple.com').setAudience(claims.aud??'ai.qoopia.ios').setSubject(claims.sub??'001234.apple-subject.0001')
    .setIssuedAt().setExpirationTime(claims.exp??Math.floor(Date.now()/1000)+600).sign(claims.key??appleKey.privateKey);
};

function harness(){
  const db=new Database(':memory:'),mails:string[]=[];let keyFetches=0;
  const config={origin,resendKey:'fixture',from:'test@example.test',googleClientId:'fixture',googleClientSecret:'fixture'};
  const provider=(async(input,init)=>{
    if(String(input)===APPLE_KEYS_URL){keyFetches++;return Response.json({keys:[jwk]});}
    mails.push(String(init?.body));return Response.json({id:'fixture'});
  }) as typeof fetch;
  const handler=loginBroker(db,config,provider);
  const call=async(path:string,body?:unknown,cookies:Record<string,string>={},headers:Record<string,string>={})=>{
    const result=await handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{'user-agent':app,cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),...(body===undefined?{}:{origin,'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),'test');
    for(const value of result.headers.getSetCookie()){const [key,...rest]=value.split(';')[0]!.split('=');cookies[key!]=rest.join('=');}
    return result;
  };
  // The native app posts without an Origin header, as URLSession does.
  const native=(body:unknown)=>handler(new Request(origin+'/apple/native',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),'test');
  const start=async(cookies:Record<string,string>)=>{
    const started=await call('/profile/start',{method:'apple',language:'en'},cookies);expect(started.status).toBe(200);
    const apple=(await started.json() as {apple:{request:string;nonce:string}}).apple;
    expect(apple.request).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(apple.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return apple;
  };
  const signIn=async(claims:Claims={})=>{
    const cookies:Record<string,string>={},apple=await start(cookies);
    expect((await call('/profile/poll',{},cookies)).status).toBe(202);
    const sent=await native({request:apple.request,nonce:apple.nonce,identity_token:await appleToken(apple.nonce,claims)});
    expect(sent.status).toBe(200);
    expect((await call('/profile/poll',{},cookies)).status).toBe(200);
    return cookies;
  };
  return {db,mails,call,native,start,signIn,keyFetches:()=>keyFetches};
}

test('the iPhone account page offers Sign in with Apple next to Google only to app builds that handle it',async()=>{
  const {db,call}=harness();
  try{
    const html=await(await call('/profile?app=ios')).text();
    expect(html).toContain('id="app-apple"');expect(html).toContain('Sign in with Apple');expect(html).toContain('id="app-google"');
    expect(html.indexOf('id="app-apple"')).toBeLessThan(html.indexOf('id="app-google"'));
    expect(await(await call('/profile?app=ios&lang=ru')).text()).toContain('Вход с Apple');
    expect(await(await call('/profile?app=ios',undefined,{},{'user-agent':'Mozilla/5.0 Qoopia-iOS/3'})).text()).not.toContain('id="app-apple"');
    expect(await(await call('/profile')).text()).not.toContain('id="app-apple"');
    const privacy=await(await call('/privacy')).text();
    expect(privacy).toContain('Sign in with Apple');expect(privacy).toContain('stores no Apple tokens');
  }finally{db.close();}
});

test('Apple identity token signs in, links by Apple account identifier with a relay email and is removed by account deletion',async()=>{
  const {db,call,signIn,keyFetches}=harness();
  try{
    const cookies=await signIn();
    expect(await(await call('/profile',undefined,cookies)).text()).toContain('abc123@privaterelay.apple.example.test');
    const row=db.query('SELECT id,email,apple_sub,google_sub FROM connection_accounts').all() as {id:string;email:string;apple_sub:string;google_sub:string|null}[];
    expect(row).toHaveLength(1);expect(row[0]).toMatchObject({email:'abc123@privaterelay.apple.example.test',apple_sub:'001234.apple-subject.0001',google_sub:null});
    // Apple shares the email only on the first authorization; the known Apple account continues without it.
    const again=await signIn({email:null});
    expect(await(await call('/profile',undefined,again)).text()).toContain('abc123@privaterelay.apple.example.test');
    expect((db.query('SELECT COUNT(*) n FROM connection_accounts').get() as {n:number}).n).toBe(1);
    expect(keyFetches()).toBe(1); // Apple's keys are cached.
    expect((await call('/profile/delete',{confirm:true},again)).status).toBe(200);
    expect((db.query('SELECT COUNT(*) n FROM connection_accounts WHERE apple_sub IS NOT NULL').get() as {n:number}).n).toBe(0);
    expect(db.query("SELECT 1 FROM login_requests WHERE apple_sub IS NOT NULL").get()).toBeNull();
  }finally{db.close();}
});

test('a verified Apple email links to the existing account with that email',async()=>{
  const {db,call,signIn}=harness();
  try{
    db.query("INSERT INTO connection_accounts(id,email,google_sub) VALUES ('existing','owner@example.test','google-1')").run();
    const cookies=await signIn({email:'Owner@Example.test',sub:'apple-owner'});
    expect(await(await call('/profile',undefined,cookies)).text()).toContain('owner@example.test');
    expect(db.query('SELECT id,google_sub,apple_sub FROM connection_accounts').all()).toEqual([{id:'existing',google_sub:'google-1',apple_sub:'apple-owner'}]);
  }finally{db.close();}
});

test('Apple tokens with the wrong issuer, audience, expiry, nonce, signature or unverified email are refused, once per request',async()=>{
  const {db,start,native}=harness();
  try{
    const refused:[Claims,number,string][]=[
      [{iss:'https://evil.test'},400,'Apple did not confirm this sign-in'],
      [{aud:'com.example.other'},400,'Apple did not confirm this sign-in'],
      [{exp:Math.floor(Date.now()/1000)-120},400,'Apple did not confirm this sign-in'],
      [{nonce:createHash('sha256').update('another nonce').digest('hex')},400,'Apple did not confirm this sign-in'],
      [{key:otherKey.privateKey},400,'Apple did not confirm this sign-in'],
      [{kid:'unknown-key'},400,'Apple did not confirm this sign-in'],
      [{email_verified:false,sub:'apple-new'},400,'Apple did not share an email address. Sign in with email instead.'],
      [{email:null,sub:'apple-unknown'},400,'Apple did not share an email address. Sign in with email instead.'],
    ];
    for(const [claims,status,error] of refused){
      const apple=await start({});
      const token=await appleToken(apple.nonce,claims);
      const response=await native({request:apple.request,nonce:apple.nonce,identity_token:token});
      expect([response.status,(await response.json() as {error:string}).error]).toEqual([status,error]);
    }
    // The request accepted one token: a retry, even a valid one, must start again.
    const retried=await start({});
    expect((await native({request:retried.request,nonce:retried.nonce,identity_token:await appleToken(retried.nonce,{aud:'com.example.other'})})).status).toBe(400);
    expect((await native({request:retried.request,nonce:retried.nonce,identity_token:await appleToken(retried.nonce)})).status).toBe(410);
    expect((db.query('SELECT COUNT(*) n FROM connection_accounts').get() as {n:number}).n).toBe(0);
    expect((db.query('SELECT COUNT(*) n FROM login_requests WHERE confirmed=1').get() as {n:number}).n).toBe(0);
    // Shape, nonce ownership and replay.
    const apple=await start({});
    const valid=await appleToken(apple.nonce);
    expect((await native({request:apple.request,nonce:apple.nonce})).status).toBe(400);
    expect((await native({request:'short',nonce:apple.nonce,identity_token:valid})).status).toBe(400);
    expect((await native({request:apple.request,nonce:apple.nonce,identity_token:'x'.repeat(7000)})).status).toBe(400);
    expect((await native({request:apple.request,nonce:'A'.repeat(43),identity_token:valid})).status).toBe(410);
    expect((await native({request:apple.request,nonce:apple.nonce,identity_token:valid})).status).toBe(200);
    expect((await native({request:apple.request,nonce:apple.nonce,identity_token:valid})).status).toBe(410);
  }finally{db.close();}
});
