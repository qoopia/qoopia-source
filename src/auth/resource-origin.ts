/** OAuth may use HTTP only for the local loopback connection. */
export function resourceOrigin(value:string):string {
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw new Error('MCP requires an HTTPS or local loopback origin');
  return url.origin;
}
