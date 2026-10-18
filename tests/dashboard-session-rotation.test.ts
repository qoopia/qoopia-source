import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {db} from '../src/db/connection.ts';
import {b64uEncode,verifySession,signSession,sessionKey,buildSessionCookie,buildClearCookie,dashboardCookieValue,renewLocalOwnerSession,authFromSessionCookie} from '../src/dashboard-session.ts';

test('previous signing key and legacy cookie migrate without logout; new signatures use the current key',()=>{
  runMigrations();
  const workspace='rotation-session-synthetic';
  db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(workspace,workspace,workspace);
  const owner=bootstrapOwner(db,'Synthetic owner',undefined,workspace);
  const before={previous:process.env.QOOPIA_SESSION_SECRET_PREVIOUS,standalone:process.env.QOOPIA_STANDALONE};
  const previous='synthetic-previous-session-key-at-least-32-bytes';
  process.env.QOOPIA_SESSION_SECRET_PREVIOUS=previous;process.env.QOOPIA_STANDALONE='true';
  try{
    const payload=b64uEncode(JSON.stringify({agent_id:owner.agent_id,sv:0,exp:null,owner:true,issued:Math.floor(Date.now()/1000)-20}));
    const old=payload+'.'+createHmac('sha256',previous).update(payload).digest('base64url');
    const req={headers:{cookie:'qoopia_dash='+old},socket:{encrypted:true}} as unknown as IncomingMessage;
    expect(authFromSessionCookie(req)?.agent_id).toBe(owner.agent_id);
    let renewed='';renewLocalOwnerSession(req,{setHeader:(_k:string,v:string)=>{renewed=v;}} as ServerResponse);
    expect(renewed).toStartWith('__Host-qoopia_dash=');expect(renewed).toContain('Path=/;');expect(renewed).toContain('; Secure');
    expect(renewed).not.toContain('Domain=');
    const current=renewed.split(';')[0]!.split('=').slice(1).join('=');
    delete process.env.QOOPIA_SESSION_SECRET_PREVIOUS;
    expect(verifySession(old)).toBeNull();expect(verifySession(current)?.agent_id).toBe(owner.agent_id);
    const [body,tag]=current.split('.');
    expect(tag).toBe(createHmac('sha256',sessionKey()).update(body!).digest('base64url'));
    expect(buildClearCookie(req)).toHaveLength(2);
    expect(dashboardCookieValue({...req,headers:{cookie:'qoopia_dash='+old+'; __Host-qoopia_dash=invalid'}} as IncomingMessage)).toBe('invalid');
    db.query('UPDATE agents SET session_version=session_version+1 WHERE id=?').run(owner.agent_id);
    expect(authFromSessionCookie({...req,headers:{cookie:'__Host-qoopia_dash='+current}} as IncomingMessage)).toBeNull();
    expect(buildSessionCookie({headers:{},socket:{}} as IncomingMessage,signSession('synthetic',0))).toStartWith('qoopia_dash=');
  }finally{
    for(const [key,value] of [['QOOPIA_SESSION_SECRET_PREVIOUS',before.previous],['QOOPIA_STANDALONE',before.standalone]]){
      if(value===undefined)delete process.env[key!];else process.env[key!]=value;
    }
  }
});
