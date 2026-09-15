import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {createAgent} from '../src/admin/agents.ts';
import {startHttpServer} from '../src/http.ts';
import {agentDirectory} from '../src/services/my-agent.ts';
import {durableWrite,privateDirectory} from '../src/delivery/files.ts';
function cookie(id:string){
  const row=db.query('SELECT session_version FROM agents WHERE id=?').get(id) as {session_version:number};
  const payload=Buffer.from(JSON.stringify({agent_id:id,sv:row.session_version,exp:Math.floor(Date.now()/1000)+600})).toString('base64url');
  return 'qoopia_dash='+payload+'.'+createHmac('sha256',process.env.QOOPIA_SESSION_SECRET!).update(payload).digest('base64url');
}
test('managed agent HTTP requires owner cookie, same-origin CSRF and an authorized file path',async()=>{
  runMigrations();const slug='my-agent-http';db.query('INSERT INTO workspaces(id,name,slug) VALUES(?,?,?)').run(slug,slug,slug);
  const owner=bootstrapOwner(db,'Agent HTTP owner',undefined,slug),agent=createAgent({name:'HTTP fixture',workspaceSlug:slug});
  db.query('INSERT INTO qoopia_agent_settings(owner_id,workspace_id,agent_id,enabled,created_at) VALUES(?,?,?,0,?)').run(owner.agent_id,slug,agent.id,'now');
  const folder=privateDirectory(path.join(agentDirectory(owner.agent_id),'workspace'));durableWrite(path.join(folder,'result.txt'),'Synthetic HTTP artifact');
  const server=startHttpServer();await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port,url=origin+'/api/dashboard/my-agent',headers={cookie:cookie(owner.agent_id)};
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url,{headers:{authorization:'Bearer '+agent.api_key}})).status).toBe(401);
    expect((await fetch(url,{headers:{cookie:cookie(agent.id)}})).status).toBe(403);
    expect((await fetch(url,{headers})).status).toBe(200);
    const post={method:'POST',body:JSON.stringify({action:'disconnect'})};
    expect((await fetch(url,{...post,headers:{...headers,origin}})).status).toBe(403);
    expect((await fetch(url,{...post,headers:{...headers,origin:'https://foreign.test','x-qoopia-csrf':'1'}})).status).toBe(403);
    expect((await fetch(url,{...post,headers:{...headers,origin,'x-qoopia-csrf':'1'}})).status).toBe(200);
    const accepted=await fetch(url,{method:'POST',headers:{...headers,origin,'x-qoopia-csrf':'1'},body:JSON.stringify({action:'setup',provider:'codex',acceptPermissions:true})});
    expect(accepted.status).toBe(202);expect(await accepted.json()).toEqual({accepted:true});
    const file=await fetch(url+'/file?path=result.txt',{headers});expect(file.status).toBe(200);expect(file.headers.get('content-disposition')).toContain('attachment');expect(file.headers.get('cache-control')).toBe('no-store');expect(await file.text()).toBe('Synthetic HTTP artifact');
    expect((await fetch(url+'/file?path=../credentials.json',{headers})).status).toBe(403);
    expect((await fetch(url+'/file?path=result.txt',{headers:{cookie:cookie(agent.id)}})).status).toBe(403);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
