import {test,expect} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {db} from '../src/db/connection.ts';import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';import {bootstrapOwner} from '../src/auth/pairings.ts';
import {startHttpServer} from '../src/http.ts';import {env} from '../src/utils/env.ts';
import {authLimiter,dashboardLimiter} from '../src/utils/rate-limit.ts';
import {cancelDesktopAuth} from '../src/delivery/desktop-auth.ts';
import {lockStdioCredentials,stdioFolder} from '../src/delivery/stdio-oauth.ts';

test('Desktop wizard HTTP handoff awaits OAuth, resumes one pending URL, saves consent and cancels revoked access',async()=>{
  if(process.platform!=='darwin')return;
  runMigrations();authLimiter.resetForTests();dashboardLimiter.resetForTests();
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-desktop-http-'))),slug=randomUUID();
  const owner=bootstrapOwner(db,'Synthetic Desktop owner',undefined,createWorkspace({name:'Synthetic Desktop fixture',slug}).id);
  const server=startHttpServer();await new Promise<void>(r=>server.listening?r():server.once('listening',r));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const previous={url:env.PUBLIC_URL,issuer:env.OAUTH_ISSUER,origins:env.DASHBOARD_ALLOWED_ORIGINS,layout:process.env.QOOPIA_STANDALONE_LAYOUT};
  env.PUBLIC_URL=base;env.OAUTH_ISSUER=base;env.DASHBOARD_ALLOWED_ORIGINS=[base];
  process.env.QOOPIA_STANDALONE_LAYOUT=JSON.stringify({root,logs:path.join(root,'logs')});
  let connection:any;
  try{
    const login=await fetch(base+'/api/dashboard/login',{method:'POST',headers:{authorization:'Bearer '+owner.api_key,origin:base}});
    const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const action=async(input:any)=>{
      const response=await fetch(base+'/api/dashboard/connection-setup',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify(input)});
      expect(response.status).toBe(200);return await response.json() as any;
    };
    connection=(await action({action:'apply',surface:'claude_desktop',access_mode:'read',request_key:slug})).connection;
    expect((await action({action:'client-auth-start',id:connection.id})).code).toBe('CLIENT_CONFIG_REQUIRED');
    await action({action:'client-apply',id:connection.id,config_directory:path.join(root,'isolated Claude profile')});
    const started=await action({action:'client-auth-start',id:connection.id});
    expect(started.code).toBe('CLIENT_AUTHORIZATION_REQUIRED');expect(new URL(started.open_url).origin).toBe(base);
    expect((await action({action:'client-auth-start',id:connection.id})).open_url).toBe(started.open_url);
    const state=await action({action:'status',id:connection.id});
    expect(state.connections[0].client_auth.open_url).toBe(started.open_url);expect(state.connections[0].code).toBe('CLIENT_CALL_REQUIRED');
    const redirected=await fetch(started.open_url,{redirect:'manual'}),consentUrl=redirected.headers.get('location')!;
    const ticket=new URL(consentUrl).searchParams.get('ticket')!;
    const consent=await fetch(consentUrl,{headers:{cookie}}),nonce=(await consent.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
    const approved=await fetch(base+'/api/dashboard/oauth-consent/approve',{method:'POST',redirect:'manual',headers:{cookie,origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,nonce})});
    expect(approved.status).toBe(302);
    const finalized=await fetch(approved.headers.get('location')!,{redirect:'manual'});
    expect((await fetch(finalized.headers.get('location')!)).status).toBe(200);
    let saved:any;
    for(let i=0;i<100;i++){
      saved=await action({action:'client-auth-status',id:connection.id});
      if(saved.credentials_present)break;await Bun.sleep(10);
    }
    expect(saved.credentials_present).toBe(true);expect(saved.verified).toBe(false);expect(saved.code).toBe('CLIENT_CALL_REQUIRED');
    expect(JSON.stringify(saved)).not.toMatch(/access_token|refresh_token|client_secret/);
    expect((await action({action:'client-auth-start',id:connection.id})).credentials_present).toBe(true);
    // Another pending handoff can be interrupted by per-client revocation. The listener and lock must close.
    connection=(await action({action:'apply',surface:'claude_desktop',access_mode:'read',request_key:slug+'-cancel'})).connection;
    await action({action:'client-apply',id:connection.id,config_directory:path.join(root,'isolated Claude profile')});
    const second=await action({action:'client-auth-start',id:connection.id});
    const callback=new URL(second.open_url).searchParams.get('redirect_uri')!;
    await action({action:'disconnect',id:connection.id});
    const binding={format:'qoopia-client-connection/1',connection_id:connection.id,workspace_id:owner.workspace_id,surface:'claude_desktop' as const,access_mode:'read' as const,mcp_url:connection.mcp_url};
    let released=false;
    for(let i=0;i<100;i++){
      try{lockStdioCredentials(stdioFolder(root,binding))();released=true;break;}catch{await Bun.sleep(10);}
    }
    expect(released).toBe(true);await expect(fetch(callback)).rejects.toThrow();
    expect((await action({action:'status',id:connection.id})).connections[0].code).toBe('REVOKED');
  }finally{
    if(connection)cancelDesktopAuth(root,connection.id);
    env.PUBLIC_URL=previous.url;env.OAUTH_ISSUER=previous.issuer;env.DASHBOARD_ALLOWED_ORIGINS=previous.origins;
    if(previous.layout===undefined)delete process.env.QOOPIA_STANDALONE_LAYOUT;else process.env.QOOPIA_STANDALONE_LAYOUT=previous.layout;
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});
  }
},15_000);
