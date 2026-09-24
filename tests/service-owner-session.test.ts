import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {db} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {signSession} from '../src/dashboard-session.ts';
import {handleServiceOwner,serviceOwnerEmail} from '../src/http/service-owner.ts';

test('service owner panel uses only the signed human owner session and never forwards a browser token',async()=>{
  runMigrations();
  const workspace='service-owner-session-test';
  db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'Owner panel test',workspace);
  const owner=bootstrapOwner(db,'Owner panel test',undefined,workspace);
  const root=mkdtempSync(join(tmpdir(),'qoopia-service-owner-'));
  mkdirSync(join(root,'config'));
  writeFileSync(join(root,'config/owner-identity.json'),JSON.stringify({ownerId:owner.agent_id,email:'owner@example.test'}),{mode:0o600});
  const keys=['QOOPIA_STANDALONE','QOOPIA_STANDALONE_LAYOUT','QOOPIA_SERVICE_OWNER_AGENT_ID','QOOPIA_OWNER_BRIDGE_SECRET','QOOPIA_OWNER_BRIDGE_PORT'] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const secret='owner-bridge-test-secret-at-least-32-bytes';
  Object.assign(process.env,{QOOPIA_STANDALONE:'true',QOOPIA_STANDALONE_LAYOUT:JSON.stringify({root}),
    QOOPIA_SERVICE_OWNER_AGENT_ID:owner.agent_id,QOOPIA_OWNER_BRIDGE_SECRET:secret,QOOPIA_OWNER_BRIDGE_PORT:'3740'});
  const req={method:'GET',url:'/api/dashboard/service-owner?lang=ru&page=0',headers:{cookie:'qoopia_dash='+signSession(owner.agent_id,0,null)}} as IncomingMessage;
  let status=0,body='',noStore='',calls=0;
  const res={setHeader:(key:string,value:string)=>{if(key==='cache-control')noStore=value;},
    writeHead:(code:number)=>{status=code;},end:(value:string)=>{body=value;}} as unknown as ServerResponse;
  const request=(async(url:string,init:RequestInit)=>{
    calls++;
    expect(url).toBe('http://127.0.0.1:3740/internal/owner');
    expect(init.headers).toEqual({authorization:'Bearer '+secret,'content-type':'application/json'});
    expect(JSON.parse(String(init.body))).toEqual({email:'owner@example.test',lang:'ru',page:0});
    return Response.json({html:'<section>private owner data</section>'});
  }) as typeof fetch;
  try{
    expect(serviceOwnerEmail(req)).toBe('owner@example.test');
    await handleServiceOwner(req,res,request);
    expect(status).toBe(200);
    expect(noStore).toBe('no-store');
    expect(JSON.parse(body).html).toContain('private owner data');
    expect(calls).toBe(1);

    const denied=[
      {...req,headers:{}},
      {...req,headers:{...req.headers,authorization:'Bearer invalid'}},
      {...req,headers:{cookie:'qoopia_dash=invalid'}},
      {...req,headers:{cookie:'qoopia_dash='+signSession(owner.agent_id,0)}},
    ] as IncomingMessage[];
    for(const attempt of denied){
      expect(serviceOwnerEmail(attempt)).toBeNull();
      await handleServiceOwner(attempt,res,request);
      expect(status).toBe(403);
    }
    process.env.QOOPIA_SERVICE_OWNER_AGENT_ID='a-different-owner';
    expect(serviceOwnerEmail(req)).toBeNull();
    process.env.QOOPIA_SERVICE_OWNER_AGENT_ID=owner.agent_id;
    db.query('UPDATE agents SET session_version=session_version+1 WHERE id=?').run(owner.agent_id);
    expect(serviceOwnerEmail(req)).toBeNull();
    expect(calls).toBe(1);
  }finally{
    for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(root,{recursive:true,force:true});
  }
});
