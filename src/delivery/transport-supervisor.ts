import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {durableWrite,privateDirectory,hash} from '../utils/fs.ts';
import {startMcpEdge} from './mcp-edge.ts';
import type {TransportConfig} from './transport-config.ts';

/** The installed service owns this child; the tunnel cannot keep serving after its owner exits. */
export function transportSupervisor(options:{root:string;upstreamPort:number;binary:string;config:()=>TransportConfig|null;
  lease:()=>Promise<'active'|'revoked'>;request?:typeof fetch}) {
  let child:ChildProcess|undefined,edge:ReturnType<typeof startMcpEdge>|undefined,metrics=0,expires=0,lastCheck:number|null=null;
  let phase:'disabled'|'connecting'|'online'|'temporarily_unavailable'|'revoked'='disabled',working=false,stopped=false;
  let failures=0,nextTry=0,generation=0;
  let socketPath:string|undefined;
  const request=options.request??fetch;
  const stopChild=()=>{
    expires=0;const process=child;child=undefined;
    if(process){process.kill('SIGTERM');const force=setTimeout(()=>process.kill('SIGKILL'),3000);force.unref();process.once('close',()=>clearTimeout(force));}
    edge?.closeAllConnections();edge?.close();edge=undefined;metrics=0;
    if(socketPath){try{fs.unlinkSync(socketPath);}catch{}socketPath=undefined;}
  };
  const startChild=async(c:TransportConfig,started:number)=>{
    if(!c.device||!c.tunnel)throw new Error('Device enrollment required');
    // A unique private socket cannot accidentally forward to another application after a parent crash/port reuse.
    const socketDir=privateDirectory('/var/tmp/qoopia-'+process.getuid!()+'/'+hash(options.root).slice(0,24));
    socketPath=path.join(socketDir,'edge-'+randomUUID()+'.sock');
    edge=startMcpEdge({publicOrigin:c.device.public_origin,upstreamPort:options.upstreamPort,socketPath,available:()=>expires>Date.now()});
    await once(edge,'listening');
    if(stopped||started!==generation)return;
    fs.chmodSync(socketPath,0o600);
    const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
    metrics=(reservation.address() as net.AddressInfo).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    if(stopped||started!==generation)return;
    const dir=privateDirectory(path.join(options.root,'config/tunnel'));
    const credentials=path.join(dir,'credentials.json'),config=path.join(dir,'config.json');
    durableWrite(credentials,JSON.stringify({AccountTag:c.tunnel.account,TunnelID:c.tunnel.id,TunnelSecret:c.tunnel_secret}));
    // JSON is valid YAML. Every scalar is encoded, not interpolated into YAML or shell text.
    durableWrite(config,JSON.stringify({tunnel:c.tunnel.id,'credentials-file':credentials,metrics:'127.0.0.1:'+metrics,
      'no-autoupdate':true,loglevel:'error','transport-loglevel':'error',ingress:[{hostname:new URL(c.device.public_origin).hostname,service:'unix:'+socketPath},{service:'http_status:404'}]}));
    const owned=spawn(options.binary,['--config',config,'tunnel','run',c.tunnel.id],{cwd:dir,env:{PATH:'/usr/bin:/bin',HOME:dir},stdio:'ignore'});
    child=owned;
    const failed=()=>{if(child===owned){stopChild();phase='temporarily_unavailable';nextTry=Date.now()+Math.min(60_000,1000*2**Math.min(++failures,6));}};
    owned.once('error',failed);owned.once('exit',failed);phase='connecting';
    await once(owned,'spawn');
  };
  const tick=async()=>{
    if(stopped||working)return;working=true;
    const started=generation;
    try{
      const config=options.config();
      if(!config?.enabled||!config.device||config.device.state==='revoked'){stopChild();phase=config?.device?.state==='revoked'?'revoked':'disabled';return;}
      if(Date.now()<nextTry)return;
      const lease=await options.lease();
      if(stopped||started!==generation||!options.config()?.enabled)return;
      if(lease==='revoked'){stopChild();phase='revoked';return;}
      expires=Date.now()+120_000;lastCheck=Date.now();
      if(!child)await startChild(config,started);
      if(stopped||started!==generation)return;
      const status=await request('http://127.0.0.1:'+metrics+'/ready',{redirect:'error',signal:AbortSignal.timeout(2000)});
      if(stopped||started!==generation)return;
      if(status.ok&&child&&!child.killed){
        const publicCheck=await request(config.device.public_origin+'/mcp',{headers:{'user-agent':'Qoopia-Connection-Health/1.0'},
          redirect:'error',signal:AbortSignal.timeout(5000)});
        const challenge=publicCheck.headers.get('www-authenticate')??'';
        const expected=config.device.public_origin+'/.well-known/oauth-protected-resource';
        const online=publicCheck.status===401&&challenge.includes('resource_metadata="'+expected+'"');
        await publicCheck.body?.cancel();if(stopped||started!==generation)return;
        phase=online?'online':'connecting';if(phase==='online')failures=0;
      }else phase='connecting';
    }catch{
      if(stopped||started!==generation)return;
      phase='temporarily_unavailable';
      if(expires<=Date.now())stopChild();
      if(!child)nextTry=Date.now()+Math.min(60_000,1000*2**Math.min(++failures,6));
    }finally{working=false;}
  };
  const timer=setInterval(()=>{void tick();},30_000);timer.unref();
  // Gate each request as well as the timer: a suspended process never revives with an expired lease.
  const expiryTimer=setInterval(()=>{if(child&&expires<=Date.now()){stopChild();phase='temporarily_unavailable';}},5000);expiryTimer.unref();
  return {refresh:tick,status:()=>({state:phase,reachability_basis:'public_mcp_auth_challenge',last_registry_check:lastCheck?new Date(lastCheck).toISOString():null,
    reachable:phase==='online'&&expires>Date.now(),memory_location:'this_installation'}),
    pause:()=>{generation++;stopChild();phase='disabled';},stop:()=>{generation++;stopped=true;clearInterval(timer);clearInterval(expiryTimer);stopChild();}};
}
