import {test,expect,spyOn} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {loginBroker} from '../src/identity/broker.ts';

// Headless installations cannot finish a network-bound sign-in: the owner's browser is elsewhere. A device code
// shown by the installation, confirmed on any device signed in to the same account, completes it instead.
const origin='https://auth.example.test';
function fixture(){
  const db=new Database(':memory:'),mails:string[]=[];
  const handler=loginBroker(db,{origin,resendKey:'test',from:'test@example.test',googleClientId:'test',googleClientSecret:'test'},
    (async(_url:unknown,init?:RequestInit)=>{mails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'test'});}) as typeof fetch);
  const browser=(ip:string)=>{
    const jar:Record<string,string>={};
    const call=async(path:string,body?:unknown,requestOrigin=origin)=>{
      const response=await handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),
        ...(body===undefined?{}:{origin:requestOrigin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),ip);
      for(const value of response.headers.getSetCookie()){const [key,...rest]=value.split(';')[0]!.split('=');jar[key!]=rest.join('=');}return response;
    };
    return {call,signIn:async(email:string)=>{
      await call('/profile/start',{method:'email',email});
      const token=new URL(mails.at(-1)!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
      expect((await call('/confirm',{token})).status).toBe(200);expect((await call('/profile/poll',{})).status).toBe(200);
    }};
  };
  // The installation calls the broker from its own (server) network.
  const installation=async(label='Qoopia Linux · build-server')=>{
    const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('hex');
    const r=await handler(new Request(origin+'/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'device',challenge,label,language:'en'})}),'198.51.100.20');
    expect(r.status).toBe(201);const data=await r.json() as {id:string;user_code:string;verification_uri:string;verification_uri_complete:string;expires_in:number;interval:number};
    const redeem=async()=>{const x=await handler(new Request(origin+'/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:data.id,verifier})}),'198.51.100.20');return {status:x.status,body:await x.json() as any};};
    return {...data,redeem};
  };
  return {db,handler,browser,installation,mails};
}

test('a device code confirmed on another network signs the installation in once, after an explicit approval',async()=>{
  const {db,handler,browser,installation,mails}=fixture();
  try{
    const flow=await installation('Qoopia Linux <script>');
    expect(flow.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(flow.verification_uri).toBe(origin+'/device');expect(flow.verification_uri_complete).toBe(origin+'/device?code='+flow.user_code);
    expect(flow.expires_in).toBe(600);expect(flow.interval).toBe(5);
    expect((await handler(new Request(origin+'/device?code='+flow.user_code),'203.0.113.5')).headers.get('location')).toBe('/profile/device?code='+flow.user_code);
    expect((await flow.redeem()).body).toEqual({pending:true});

    const phone=browser('203.0.113.5');
    // Signed out, the page offers the ordinary sign-in; nothing about the request is revealed.
    const signedOut=await(await phone.call('/profile/device?code='+flow.user_code)).text();
    expect(signedOut).toContain('signin-form');expect(signedOut).not.toContain('build-server');
    expect((await phone.call('/profile/device/lookup',{code:flow.user_code})).status).toBe(401);
    await phone.signIn('owner@example.test');
    const review=await(await phone.call('/profile/device?code='+flow.user_code)).text();
    expect(review).toContain('Continue only if you started this sign-in yourself');expect(review).toContain('owner@example.test');
    expect((await phone.call('/profile/device/lookup',{code:flow.user_code},'https://evil.test')).status).toBe(403);
    const lookup=await(await phone.call('/profile/device/lookup',{code:flow.user_code.toLowerCase().replace('-',' ')})).json() as any;
    expect(lookup.label).toBe('Qoopia Linux script');expect(lookup.network).toBe('198.51.100.20');
    // Looking up confirms nothing.
    expect((await flow.redeem()).body).toEqual({pending:true});
    expect((await phone.call('/profile/device/approve',{code:flow.user_code})).status).toBe(200);
    // The phone's network differs from the installation's: possession of the code is the binding.
    expect((await flow.redeem()).body).toEqual({email:'owner@example.test'});
    expect((await flow.redeem()).status).toBe(410);
    expect((await phone.call('/profile/device/approve',{code:flow.user_code})).status).toBe(410);
    expect(mails.filter(m=>m.includes('https://'))).toHaveLength(1);

    const denied=await installation();
    expect((await phone.call('/profile/device/deny',{code:denied.user_code})).status).toBe(200);
    expect((await denied.redeem()).status).toBe(410);
    const expired=await installation(),clock=spyOn(Date,'now').mockReturnValue(Date.now()+601_000);
    try{expect((await phone.call('/profile/device/lookup',{code:expired.user_code})).status).toBe(410);}finally{clock.mockRestore();}
  }finally{db.close();}
});

test('code guessing is limited per account and network; the email/Google paths keep their network binding',async()=>{
  const {db,browser,installation,mails}=fixture();
  try{
    const flow=await installation(),phone=browser('203.0.113.6');await phone.signIn('owner@example.test');
    const statuses:number[]=[];for(let i=0;i<11;i++)statuses.push((await phone.call('/profile/device/lookup',{code:'BBBB-BBBB'})).status);
    expect(statuses.slice(0,10).every(s=>s===410)).toBe(true);expect(statuses[10]).toBe(429);
    expect((await phone.call('/profile/device/approve',{code:flow.user_code})).status).toBe(429);
    expect((await flow.redeem()).body).toEqual({pending:true});
    // F-125 is unchanged: an emailed link opened from another network confirms nothing.
    const laptop=browser('203.0.113.7'),other=browser('192.0.2.44');
    await laptop.call('/profile/start',{method:'email',email:'owner@example.test'});
    const token=new URL(mails.at(-1)!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1);
    expect((await other.call('/confirm',{token})).status).toBe(400);
  }finally{db.close();}
});

test('the confirmation says when approving adds a device to the account, and a profile sign-in is never a device code',async()=>{
  const db=new Database(':memory:'),mails:string[]=[];
  const handler=loginBroker(db,{origin,resendKey:'test',from:'test@example.test',googleClientId:'test',googleClientSecret:'test',
    devices:{domain:'example.test',provider:{ensure:async()=>({id:'t',account:'a'.repeat(32)}),remove:async()=>{}}}},
    (async(_url:unknown,init?:RequestInit)=>{mails.push(JSON.parse(String(init?.body)).text);return Response.json({id:'test'});}) as typeof fetch);
  try{
    const start=(extra:Record<string,unknown>)=>handler(new Request(origin+'/requests',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({method:'device',challenge:createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex'),label:'Qoopia Linux · srv',...extra})}),'198.51.100.20')
      .then(r=>r.json() as Promise<{user_code:string}>);
    const enroll=await start({device_peer:randomBytes(32).toString('base64url')}),signIn=await start({});
    const jar:Record<string,string>={};
    const call=async(path:string,body?:unknown)=>{
      const r=await handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),
        ...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),'203.0.113.5');
      for(const v of r.headers.getSetCookie()){const [k,...rest]=v.split(';')[0]!.split('=');jar[k!]=rest.join('=');}return r;
    };
    // The broker's own profile sign-in is email or Google only: a device code nobody can see is never opened for it.
    expect((await call('/profile/start',{method:'device'})).status).toBe(400);
    expect(db.query('SELECT count(*) n FROM device_codes').get()).toEqual({n:2});
    await call('/profile/start',{method:'email',email:'owner@example.test'});
    expect((await call('/confirm',{token:new URL(mails.at(-1)!.match(/https:\/\/[^\s]+/)![0]).hash.slice(1)})).status).toBe(200);
    expect((await call('/profile/poll',{})).status).toBe(200);
    // Approving a request that carries a device key enrolls that installation in the account's external access,
    // where it can list and disconnect the account's other devices: the owner is told so before the click.
    expect(((await(await call('/profile/device/lookup',{code:enroll.user_code})).json()) as {adds_device:boolean}).adds_device).toBe(true);
    expect(((await(await call('/profile/device/lookup',{code:signIn.user_code})).json()) as {adds_device:boolean}).adds_device).toBe(false);
    expect(await(await call('/profile/device?code='+enroll.user_code)).text()).toContain('can list and disconnect');
  }finally{db.close();}
});
