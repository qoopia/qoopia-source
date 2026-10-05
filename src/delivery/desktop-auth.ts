import {authorizeStdioClient,stdioAuthStatus,stdioBindingSchema,StdioAccessError} from './stdio-oauth.ts';
type Status=Record<string,unknown>;
type Flow={status:Status;cancel:AbortController;done?:boolean};
/** A refused or expired sign-in stays readable this long, so the wizard's next poll can show it. */
const RESULT_TTL_MS=60_000;
const flows=new Map<string,Flow>();
const key=(root:string,id:string)=>root+'\0'+id;

export function desktopAuthStatus(root:string,raw:unknown):Status {
  const binding=stdioBindingSchema.parse(raw);return flows.get(key(root,binding.connection_id))?.status??stdioAuthStatus(root,binding);
}
export function cancelDesktopAuth(root:string,id:string){flows.get(key(root,id))?.cancel.abort();}

/** Same bounded OAuth flow as the CLI. The local wizard keeps its browser handoff
 * in memory; restart requires a fresh handoff, never approval without consent.
 */
export async function startDesktopAuth(root:string,raw:unknown):Promise<Status> {
  const binding=stdioBindingSchema.parse(raw),id=key(root,binding.connection_id),existing=flows.get(id);
  if(existing&&!existing.done)return existing.status;
  if(flows.size>=100)return {format:'qoopia-connections/1',state:'temporarily_unavailable',code:'CLIENT_AUTH_BUSY',next_action:'Finish or cancel an active client sign-in.'};
  const flow:Flow={status:{format:'qoopia-connections/1',state:'temporarily_unavailable',code:'CLIENT_AUTH_STARTING',next_action:'Check connection status in a moment.'},
    cancel:new AbortController()};
  flows.set(id,flow);
  void authorizeStdioClient(root,binding,step=>{
    flow.status={format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_AUTHORIZATION_REQUIRED',...step,
      next_action:'Open this page and approve only this connection. Then restart Claude Desktop and send the request from the Qoopia connection card in a conversation; its first qoopia_protocol call confirms the connection.'};
  },{signal:flow.cancel.signal}).then(result=>{flow.status=result;},error=>{
    flow.status={format:'qoopia-connections/1',state:'requires_user_action',code:error instanceof StdioAccessError?error.code:'CLIENT_AUTH_REFUSED',
      next_action:'Start client sign-in again. Your memory and other connections are preserved.'};
  }).finally(()=>{
    flow.done=true;
    setTimeout(()=>{if(flows.get(id)===flow)flows.delete(id);},RESULT_TTL_MS).unref();
  });
  return flow.status;
}
