// Disposable UI fixture; it cannot contact the production relay or databases.
import '../setup.ts';
import {Database} from 'bun:sqlite';
import {writeFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {db} from '../../src/db/connection.ts';
import {runMigrations} from '../../src/db/migrate.ts';
import {bootstrapOwner} from '../../src/auth/pairings.ts';
import {localOwner} from '../../src/delivery/owner-onboarding.ts';
import {ownerFixture} from './p1-fixtures.ts';
import {bridgeService} from '../../src/bridges/service.ts';
import {bridgeRelay} from '../../src/bridges/relay.ts';
import {BRIDGE_RELAY} from '../../src/bridges/protocol.ts';
import {createAgent} from '../../src/admin/agents.ts';
import {env} from '../../src/utils/env.ts';

runMigrations();
const owner=bootstrapOwner(db,'Preview owner','Private preview'),auth=localOwner(db,owner.agent_id);
const relayDb=new Database(':memory:'),relay=bridgeRelay(relayDb),nativeFetch=globalThis.fetch;
const transport=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=input instanceof Request?input.url:String(input);
  if(url.startsWith(BRIDGE_RELAY+'/'))return relay(new Request(input,init),'ui-fixture');
  return nativeFetch(input,init);
}) as typeof fetch;
globalThis.fetch=transport;
const {bridges}=await import('../../src/bridges/api.ts');
const workspace=db.query('SELECT slug FROM workspaces WHERE id=?').get(owner.workspace_id) as {slug:string};
const steward=createAgent({name:'Preview steward',workspaceSlug:workspace.slug,type:'steward'});
await bridges.selectAgent(auth,steward.id);
const other=ownerFixture(39),peer=bridgeService(other.database,BRIDGE_RELAY,transport),group=randomUUID();
await bridges.create(auth,{id:group,name:'Research circle'});
const invitation=await bridges.invite(auth,{id:randomUUID(),group});
await peer.join(other.auth,{code:invitation.code,name:'Alex · research partner'});
db.query('UPDATE bridges SET checked_at_ms=0').run();await bridges.tick();
await bridges.membership(auth,{group,action:'admit',peer:peer.view(other.auth).peer_id!});await peer.tick();
const one=bridges.stage(auth,{id:randomUUID(),title:'A practical memory handbook',description:'A short guide to keeping useful context across agent sessions.',kind:'note',filename:'memory-handbook.md',mime:'text/markdown',content_base64:Buffer.from('# Memory handbook\n\nKeep decisions, constraints and the next useful step.\n\nThis is synthetic preview content.').toString('base64')});
bridges.publish(auth,{group,material_id:one.id,version:one.version,visible:true,auto_send:false});
const two=peer.stage(other.auth,{id:randomUUID(),title:'Ship a small, useful release',description:'A checklist for a focused pilot with real users.',kind:'note',filename:'pilot-checklist.md',mime:'text/markdown',content_base64:Buffer.from('# Pilot checklist\n\nInvite a few people. Collect specific feedback. Fix the most useful problems.\n\nSynthetic preview content.').toString('base64')});
peer.publish(other.auth,{group,material_id:two.id,version:two.version,visible:true,auto_send:true});
bridges.refresh(auth,{group});peer.refresh(other.auth,{group});
for(let i=0;i<3;i++){await bridges.tick();await peer.tick();}
peer.requestMaterial(other.auth,{id:randomUUID(),group,peer:bridges.view(auth).peer_id!,material_id:one.id,version:one.version});
for(let i=0;i<2;i++){await peer.tick();await bridges.tick();}
const timer=setInterval(()=>peer.tick(),1000);timer.unref();
const {startHttpServer}=await import('../../src/http.ts');
const server=startHttpServer();await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address();if(!address||typeof address==='string')throw new Error('Preview listener missing');
const url='http://127.0.0.1:'+address.port;env.PUBLIC_URL=url;env.DASHBOARD_ALLOWED_ORIGINS=[url];
const info='/tmp/qoopia-bridges-preview.json';writeFileSync(info,JSON.stringify({url,api_key:owner.api_key,agent_key:steward.api_key,group,root:process.env.QOOPIA_ROOT}),{mode:0o600});
console.log('Synthetic bridge preview ready at '+url);
process.once('SIGTERM',()=>{clearInterval(timer);server.closeAllConnections();server.close(()=>{other.database.close();relayDb.close();rmSync(info,{force:true});process.exit(0);});});
