import {z} from 'zod';
import type {TunnelProvider} from './device-registry.ts';
const id=z.string().uuid(),accountId=z.string().regex(/^[a-f0-9]{32}$/);
/** Operator-only provider access. A device receives its own tunnel id; it never receives this token. */
export function cloudflareTunnels(config:{account:string;zone:string;token:string},request:typeof fetch=fetch):TunnelProvider {
  accountId.parse(config.account);accountId.parse(config.zone);if(!config.token)throw new Error('Cloudflare operator token required');
  const call=async(route:string,method='GET',body?:unknown)=>{
    const response=await request('https://api.cloudflare.com/client/v4'+route,{method,headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20_000),redirect:'error'});
    const data=await response.json() as {success?:boolean;result?:unknown};
    // Provider errors can contain request values. Never propagate their response or URL into operational logs.
    if(!response.ok||data.success!==true)throw new Error('TUNNEL_PROVIDER_UNAVAILABLE');return data.result;
  };
  const tunnels='/accounts/'+config.account+'/cfd_tunnel',dns='/zones/'+config.zone+'/dns_records';
  const findTunnel=async(deviceId:string)=>{
    const rows=z.array(z.object({id,name:z.string(),config_src:z.string()})).parse(await call(tunnels+'?is_deleted=false&name='+encodeURIComponent('qoopia-device-'+id.parse(deviceId))));
    const matches=rows.filter(r=>r.name==='qoopia-device-'+deviceId);
    if(matches.length>1||matches[0]&&matches[0].config_src!=='local')throw new Error('TUNNEL_NAME_CONFLICT');return matches[0];
  };
  const findDNS=async(hostname:string)=>z.array(z.object({id:accountId,type:z.string(),name:z.string(),content:z.string(),proxied:z.boolean().optional()}))
    .parse(await call(dns+'?name='+encodeURIComponent(hostname)));
  const published=async(hostname:string)=>{
    // Do not prompt installation/client resolvers to cache NXDOMAIN immediately after DNS creation.
    // This independent request must never receive the operator Authorization header.
    for(let attempt=0;attempt<15;attempt++){
      const response=await request('https://cloudflare-dns.com/dns-query?'+new URLSearchParams({name:hostname,type:'A'}),
        {headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(5000)});
      if(response.ok){
        const data=await response.json() as {Status?:number;Answer?:{name?:string;type?:number;data?:string}[]};
        if(data.Status===0&&data.Answer?.some(a=>a.name?.replace(/\.$/,'')===hostname&&a.type===1&&typeof a.data==='string'))return;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('TUNNEL_DNS_PROPAGATING');
  };
  return {
    async ensure(deviceId,hostname,tunnelSecret){
      let tunnel=await findTunnel(deviceId);
      if(!tunnel)tunnel=z.object({id,name:z.string(),config_src:z.string()}).parse(await call(tunnels,'POST',{name:'qoopia-device-'+deviceId,config_src:'local',tunnel_secret:tunnelSecret}));
      const target=tunnel.id+'.cfargotunnel.com',records=await findDNS(hostname);
      if(records.length){if(records.length!==1||records[0]!.type!=='CNAME'||records[0]!.content!==target||!records[0]!.proxied)throw new Error('TUNNEL_DNS_CONFLICT');}
      else await call(dns,'POST',{type:'CNAME',name:hostname,content:target,proxied:true,ttl:1,comment:'Qoopia managed device '+deviceId});
      await published(hostname);
      return {id:tunnel.id,account:config.account};
    },
    async remove(deviceId,hostname,tunnelId){
      const tunnel=await findTunnel(deviceId);
      if(tunnelId&&tunnel&&tunnel.id!==tunnelId)throw new Error('TUNNEL_ID_CONFLICT');
      const target=(tunnel?.id??tunnelId)+'.cfargotunnel.com';
      for(const record of await findDNS(hostname)){
        if(record.type!=='CNAME'||record.content!==target)throw new Error('TUNNEL_DNS_CONFLICT');await call(dns+'/'+record.id,'DELETE');
      }
      if(tunnel){await call(tunnels+'/'+tunnel.id+'/connections','DELETE');await call(tunnels+'/'+tunnel.id,'DELETE');}
    }
  };
}
