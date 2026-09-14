import {readCurrent} from './operations.ts';
import {readServerWorkspace} from './remote.ts';
import {requestOwnerLogin} from './owner-control.ts';

/** Use the existing UID-authenticated owner socket, then keep the short-lived cookie in memory. */
export async function runConnectionCommand(root:string,input:unknown,ownerId?:string,ownerLibrary?:string) {
  if(readServerWorkspace(root))return {format:'qoopia-connections/1',state:'requires_user_action',code:'SERVER_WORKSPACE',
    next_action:'Run this command on the selected server, or open its Connections page.'};
  const current=readCurrent(root),origin=`http://127.0.0.1:${current.port}`;
  const login=await requestOwnerLogin(root,{operation:'login',ownerId},ownerLibrary);
  if('error' in login)return {format:'qoopia-connections/1',state:'requires_user_action',code:'OWNER_LOGIN_REQUIRED',next_action:login.error};
  const response=await fetch(origin+'/api/dashboard/local-login',{method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({code:login.code}),redirect:'error',signal:AbortSignal.timeout(10_000)});
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(!response.ok||!cookie)return {format:'qoopia-connections/1',state:'error',code:'OWNER_LOGIN_FAILED',next_action:'Check the local service and owner binding.'};
  const result=await fetch(origin+'/api/dashboard/connection-setup',{method:'POST',headers:{cookie,origin,'x-qoopia-csrf':'1','content-type':'application/json'},
    body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(85_000)});
  const text=await result.text();
  if(text.length>128_000)throw new Error('Connection response too large');
  return JSON.parse(text);
}
