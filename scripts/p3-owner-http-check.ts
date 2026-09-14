// Disposable local HTTP + native IPC qualification; no browser, model, credentials or services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { buildOwnerPeer } from './build-owner-peer.ts';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-owner-http-')));
let server: import('node:http').Server | undefined, closeControl: (()=>void) | undefined, closeDb: (()=>void) | undefined;
try {
  const reservation = net.createServer();
  await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  process.env = { PATH:process.env.PATH, HOME:root, TMPDIR:root, NODE_ENV:'test', QOOPIA_DATA_DIR:root+'/data', QOOPIA_LOG_DIR:root+'/logs', QOOPIA_BACKUP_DIR:root+'/backups',
    QOOPIA_PORT:String(port), QOOPIA_HOST:'127.0.0.1', QOOPIA_PUBLIC_URL:`http://127.0.0.1:${port}`, QOOPIA_STANDALONE:'true', QOOPIA_SERVER_ROLE:'canonical', QOOPIA_LOG_LEVEL:'error',
    QOOPIA_ADMIN_SECRET:'disposable-owner-http-admin', QOOPIA_SESSION_SECRET:'disposable-owner-http-session' };
  const connection = await import('../src/db/connection.ts'); closeDb=connection.closeDb;
  const {runMigrations}=await import('../src/db/migrate.ts'); runMigrations();
  const {startHttpServer}=await import('../src/http.ts');
  const {startOwnerControl,requestOwnerLogin}=await import('../src/delivery/owner-control.ts');
  const {ownerControlRequest}=await import('../src/delivery/owner-onboarding.ts');
  const {issueLocalLogin}=await import('../src/delivery/local-login.ts');
  const library=buildOwnerPeer(root);
  closeControl=startOwnerControl(root,input=>ownerControlRequest(connection.db,input),library);
  server=startHttpServer();
  await new Promise<void>((resolve,reject)=>{if(server!.listening)return resolve();server!.once('error',reject);server!.once('listening',resolve);});
  const base=`http://127.0.0.1:${port}`, route=base+'/api/dashboard/local-login';
  const send=(code:string,headers:Record<string,string>={},method='POST',suffix='')=>fetch(route+suffix,{method,headers:{origin:base,'content-type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify({code})}:{}),redirect:'manual'});
  assert.equal((await send('0'.repeat(32))).status,401);
  assert.equal((connection.db.query('SELECT count(*) n FROM workspace_owners').get() as {n:number}).n,0);
  const claim=await requestOwnerLogin(root,{operation:'bootstrap',name:'HTTP fixture human'},library);
  assert.ok('code' in claim);
  const code=claim.code;
  for(const headers of ([{origin:'http://evil.invalid'},{origin:'null'},{origin:''},{host:'evil.invalid'},{host:`127.0.0.1:${port+1}`},{origin:`http://localhost:${port}`}] as Record<string,string>[]))assert.equal((await send(code,headers)).status,403);
  assert.equal((await send(code,{},'GET','?code='+code)).status,403);
  const query=await fetch(route+'?code='+code,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'});
  assert.equal(query.status,400);
  const good=await send(code);assert.equal(good.status,200);
  const cookie=good.headers.get('set-cookie')!;
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/; Secure/);
  assert.equal(good.headers.get('cache-control'),'no-store');assert.equal(await good.text(),'{"ok":true}');
  assert.equal((await send(code)).status,401);
  const owner=connection.db.query('SELECT actor_id FROM workspace_owners').get() as {actor_id:string};
  assert.equal((await send(issueLocalLogin(owner.actor_id,Date.now()-300000))).status,401);
  const formCode=await requestOwnerLogin(root,{operation:'login'},library);assert.ok('code' in formCode);
  const form=await fetch(route,{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:formCode.code})});
  assert.equal(form.status,200);
  const authority=base+'/api/dashboard/authority/agent-pairings';
  assert.equal((await fetch(authority,{method:'POST',headers:{cookie:cookie.split(';')[0]!,origin:base,'content-type':'application/json'},body:'{}'})).status,403);
  const revoked=await requestOwnerLogin(root,{operation:'login'},library);assert.ok('code' in revoked);
  connection.db.query('UPDATE agents SET active=0 WHERE id=?').run(owner.actor_id);
  assert.equal((await send(revoked.code)).status,401);
  console.log('PASS actual IPC→owner→HTTP session; first HTTP claim refusal; Host/Origin/GET/query/CSRF controls; form POST; expiry/replay; revoked human owner. Codes/cookies omitted.');
} finally {
  closeControl?.();
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  closeDb?.();
  fs.rmSync(root,{recursive:true,force:true});
}
