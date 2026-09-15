import {randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {db} from '../db/connection.ts';
import {createAgent} from '../admin/agents.ts';
import {localOwner} from '../delivery/owner-onboarding.ts';
import {authorize, currentToolAuth} from '../auth/policy.ts';
import type {AuthContext} from '../auth/middleware.ts';
import {sha256Hex} from '../auth/api-keys.ts';
import {env} from '../utils/env.ts';
import {nowIso, QoopiaError} from '../utils/errors.ts';
import {resourceOrigin} from '../auth/resource-origin.ts';
import {surfaces, connectionId, type ConnectionRow as Row, connectionOrigin, connectionResource, connectionIssuer, resourceConnection, publicConnection} from './connection-identity.ts';
export {surfaces, connectionId, connectionOrigin, connectionResource, connectionIssuer, resourceConnection, publicConnection};
import {configureNativeClient} from '../delivery/client-config.ts';
import {desktopAuthStatus,startDesktopAuth,cancelDesktopAuth} from '../delivery/desktop-auth.ts';

const clientDirectory=z.string().startsWith('/').max(4096).optional();
const selection = {surface:z.enum(surfaces), access_mode:z.enum(['read','read_write']), request_key:z.string().min(1).max(100),transport:z.enum(['auto','local','remote']).default('auto')};
export const connectionActionSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('plan'),...selection}).strict(),
  z.object({action:z.literal('apply'),...selection}).strict(),
  z.object({action:z.literal('status'),id:connectionId.optional()}).strict(),
  z.object({action:z.literal('resume'),id:connectionId}).strict(),
  z.object({action:z.literal('verify'),id:connectionId}).strict(),
  z.object({action:z.literal('disconnect'),id:connectionId}).strict(),
  z.object({action:z.literal('client-plan'),id:connectionId,config_directory:clientDirectory}).strict(),
  z.object({action:z.literal('client-apply'),id:connectionId,config_directory:clientDirectory}).strict(),
  z.object({action:z.literal('client-status'),id:connectionId,config_directory:clientDirectory}).strict(),
  z.object({action:z.literal('client-remove'),id:connectionId,config_directory:clientDirectory}).strict(),
  z.object({action:z.literal('client-export'),id:connectionId}).strict(),
  z.object({action:z.literal('client-auth-start'),id:connectionId}).strict(),
  z.object({action:z.literal('client-auth-status'),id:connectionId}).strict(),
]);
export function connectionRegistrationAuth(id:string):AuthContext {
  const row=publicConnection(id);
  if((db.query('SELECT count(*) AS n FROM oauth_clients WHERE agent_id=?').get(row.agent_id) as {n:number}).n>=20)
    throw new QoopiaError('RATE_LIMITED','Connection registration limit reached');
  return {agent_id:row.agent_id,workspace_id:row.workspace_id,agent_name:row.surface,source:'api-key',type:'standard'};
}
function owned(ownerId:string,id:string):Row {
  const owner=localOwner(db,ownerId);authorize(db,owner,'owner');
  const row=db.query('SELECT * FROM client_connections WHERE id=? AND owner_id=? AND workspace_id=?').get(id,ownerId,owner.workspace_id) as Row|null;
  if(!row)throw new QoopiaError('NOT_FOUND','Connection unavailable');return row;
}
function status(row:Row) {
  const active=!!db.query('SELECT 1 FROM agents WHERE id=? AND workspace_id=? AND active=1').get(row.agent_id,row.workspace_id);
  const revoked=row.state==='revoked'||!active;
  const layout=process.env.QOOPIA_STANDALONE_LAYOUT;
  return {id:row.id,surface:row.surface,workspace_id:row.workspace_id,access_mode:row.access_mode,
    state:revoked?'error':row.state==='verified'?'ready':'requires_user_action',code:revoked?'REVOKED':row.state==='verified'?'CLIENT_CALL_VERIFIED':'CLIENT_CALL_REQUIRED',
    mcp_url:connectionResource(row.id),verified_at:row.verified_at,
    evidence:row.verified_at?'authenticated_mcp_call':null,live_availability:'not_checked',
    client_config:row.surface==='codex'||row.surface==='claude_code'||row.surface==='claude_desktop'?(process.env.QOOPIA_STANDALONE_LAYOUT&&(row.surface!=='claude_desktop'||process.platform==='darwin')?'on_this_computer':'download_file'):null,
    ...(row.surface==='claude_desktop'&&layout&&process.platform==='darwin'&&!revoked?{client_auth:desktopAuthStatus(JSON.parse(layout).root,{
      format:'qoopia-client-connection/1',connection_id:row.id,workspace_id:row.workspace_id,surface:row.surface,access_mode:row.access_mode,mcp_url:connectionResource(row.id)})}:{}),
    next_action:revoked?null:row.state==='verified'?'Use this connection in the selected client.':'Add the MCP URL in the selected client, consent, then run the verification prompt.'};
}
export function connectionAction(ownerId:string,raw:unknown) {
  const input=connectionActionSchema.parse(raw),owner=localOwner(db,ownerId);authorize(db,owner,'owner');
  if(input.action==='plan')return {format:'qoopia-connections/1',state:'requires_user_action',code:'APPLY_REQUIRED',selection:input,
    workspace_id:owner.workspace_id,read:true,write:input.access_mode==='read_write',transcript_capture:false,model_authorization:'separate',
    next_action:'Apply this selection to create one independently revocable connection. No memory is copied.'};
  if(input.action==='apply')return db.transaction(()=>{
    const previous=db.query('SELECT * FROM client_connections WHERE owner_id=? AND request_key=?').get(ownerId,input.request_key) as Row|null;
    if(previous){
      if(previous.surface!==input.surface||previous.access_mode!==input.access_mode||
        input.transport==='local'&&!previous.origin.startsWith('http:')||input.transport==='remote'&&!previous.origin.startsWith('https:'))throw new QoopiaError('IDEMPOTENCY_MISMATCH','Request key was used for another selection');
      return {format:'qoopia-connections/1',connection:status(previous),created:false};
    }
    const native=input.surface==='codex'||input.surface==='claude_code'||input.surface==='claude_desktop'&&process.platform==='darwin';
    const local=input.transport==='local'||input.transport==='auto'&&native&&process.env.QOOPIA_STANDALONE==='true';
    if(local&&!native)throw new QoopiaError('UNSUPPORTED','This client requires the managed external connection');
    const origin=resourceOrigin(local&&process.env.QOOPIA_STANDALONE==='true'?`http://127.0.0.1:${env.PORT}`:env.PUBLIC_URL);
    if((input.transport==='remote'||!native)&&!origin.startsWith('https:'))throw new QoopiaError('NOT_READY','Enable external access before preparing this client');
    if(local&&!origin.startsWith('http:'))throw new QoopiaError('UNSUPPORTED','A local client must run on the installation machine; use the server connection here');
    const workspace=db.query('SELECT slug FROM workspaces WHERE id=?').get(owner.workspace_id) as {slug:string};
    const id=randomUUID(),agent=createAgent({name:input.surface+' '+id.slice(0,8),workspaceSlug:workspace.slug,type:'standard'});
    // Discard the initial API key. The selected client obtains its own OAuth grant after consent.
    db.query("UPDATE agents SET tool_profile=?,authority_profile='memory-worker',legacy_skill_access=0 WHERE id=?")
      .run(input.access_mode==='read'?'read-only':'no-destructive',agent.id);
    db.query(`INSERT INTO client_connections(id,workspace_id,owner_id,agent_id,surface,access_mode,request_key,origin,challenge_hash,challenge_expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,'',?,?)`).run(id,owner.workspace_id,ownerId,agent.id,input.surface,input.access_mode,input.request_key,origin,nowIso(),nowIso());
    return {format:'qoopia-connections/1',connection:status(owned(ownerId,id)),created:true};
  })();
  if(input.action==='status')return {format:'qoopia-connections/1',connections:input.id?[status(owned(ownerId,input.id))]:
    (db.query('SELECT * FROM client_connections WHERE owner_id=? AND workspace_id=? ORDER BY created_at,id').all(ownerId,owner.workspace_id) as Row[]).map(status)};
  const row=owned(ownerId,input.id);
  if(input.action.startsWith('client-')){
    if(row.state==='revoked'&&input.action!=='client-remove')throw new QoopiaError('REVOKED','Create a new connection to reconnect');
    if(row.surface!=='codex'&&row.surface!=='claude_code'&&row.surface!=='claude_desktop')return {format:'qoopia-connections/1',state:'unsupported',code:'CLIENT_CONFIG_UNSUPPORTED',next_action:'Use this client’s supported connection settings.'};
    const binding={format:'qoopia-client-connection/1',connection_id:row.id,workspace_id:row.workspace_id,surface:row.surface,access_mode:row.access_mode,mcp_url:connectionResource(row.id)};
    if(input.action==='client-export')return {format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_FILE_READY',binding,next_action:'Open this connection file with Qoopia on the computer running your client, then approve OAuth in the client.'};
    if(row.surface==='claude_desktop'&&process.platform!=='darwin')return {format:'qoopia-connections/1',state:'unsupported',code:'CLIENT_OS_UNSUPPORTED',binding,
      next_action:'Download this connection file for Claude Desktop on a Mac, or use Claude Web / Claude Code on Linux.'};
    const layout=process.env.QOOPIA_STANDALONE_LAYOUT;
    if(!layout)return {format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_COMPUTER_REQUIRED',binding,next_action:'Download the connection file and open it with Qoopia on the computer running your client.'};
    if(input.action==='client-auth-start'||input.action==='client-auth-status'){
      if(row.surface!=='claude_desktop')return {format:'qoopia-connections/1',state:'unsupported',code:'CLIENT_NATIVE_AUTH_REQUIRED',next_action:'Use this client’s own OAuth sign-in.'};
      const root=JSON.parse(layout).root;
      if(input.action==='client-auth-status')return desktopAuthStatus(root,binding);
      const nativeStatus=configureNativeClient(root,binding,'status');
      if(!('configuration_present' in nativeStatus)||nativeStatus.configuration_present!==true)return {format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_CONFIG_REQUIRED',next_action:'Add this connection to Claude Desktop first.'};
      return startDesktopAuth(root,binding);
    }
    return configureNativeClient(JSON.parse(layout).root,binding,input.action.slice(7) as 'plan'|'apply'|'status'|'remove',undefined,'config_directory' in input?input.config_directory:undefined);
  }
  if(input.action==='disconnect')return db.transaction(()=>{
    if(process.env.QOOPIA_STANDALONE_LAYOUT)cancelDesktopAuth(JSON.parse(process.env.QOOPIA_STANDALONE_LAYOUT).root,row.id);
    db.query("UPDATE client_connections SET state='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(nowIso(),row.id);
    db.query('UPDATE agents SET active=0,session_version=session_version+CASE WHEN active=1 THEN 1 ELSE 0 END WHERE id=?').run(row.agent_id);
    db.query('UPDATE oauth_tokens SET revoked=1 WHERE agent_id=?').run(row.agent_id);
    return {format:'qoopia-connections/1',state:'ready',code:'DISCONNECTED',id:row.id,memory_preserved:true};
  })();
  if(row.state==='revoked')throw new QoopiaError('REVOKED','Create a new connection to reconnect');
  if(input.action==='resume')return {format:'qoopia-connections/1',connection:status(row)};
  const challenge=randomBytes(24).toString('base64url');
  db.query('UPDATE client_connections SET challenge_hash=?,challenge_expires_at=? WHERE id=?')
    .run(sha256Hex(challenge),new Date(Date.now()+600_000).toISOString(),row.id);
  return {format:'qoopia-connections/1',state:'requires_user_action',code:'CLIENT_CALL_REQUIRED',id:row.id,
    prompt:`First call qoopia_protocol on this exact Qoopia connection and read its protocol. Then call Qoopia connection_verify with connection_id "${row.id}" and challenge "${challenge}".`,expires_in_seconds:600,
    next_action:'Run this prompt inside the selected client. Configuration or OAuth login alone does not complete verification.'};
}
/** Invoked only by the authenticated MCP tool. It never accepts an owner-generated success claim. */
export function verifyClientConnection(auth:AuthContext,id:string,challenge:string) {
  currentToolAuth(db,auth,'read');
  const row=publicConnection(id);
  if(row.agent_id!==auth.agent_id||row.workspace_id!==auth.workspace_id)throw new QoopiaError('FORBIDDEN','Connection belongs to another principal');
  if(!auth.oauth_client_id)throw new QoopiaError('FORBIDDEN','Use the client OAuth connection');
  if(!db.query('SELECT 1 FROM oauth_clients WHERE id=? AND agent_id=? AND workspace_id=?').get(auth.oauth_client_id,row.agent_id,row.workspace_id))
    throw new QoopiaError('FORBIDDEN','OAuth client does not belong to this connection');
  if(row.state==='verified'&&!row.challenge_hash&&row.oauth_client_id===auth.oauth_client_id)
    throw new QoopiaError('VERIFICATION_ALREADY_COMPLETED',`A previous authenticated call verified this connection at ${row.verified_at}. The one-use challenge was consumed. This repeated call creates no new verification and does not undo the earlier result.`);
  if(row.challenge_expires_at<=new Date().toISOString()||!row.challenge_hash||sha256Hex(challenge)!==row.challenge_hash)
    throw new QoopiaError('EXPIRED','Request a fresh verification prompt in Qoopia');
  db.query("UPDATE client_connections SET state='verified',verified_at=?,oauth_client_id=?,challenge_hash='' WHERE id=?")
    .run(nowIso(),auth.oauth_client_id,row.id);
  return {connection_id:row.id,workspace_id:row.workspace_id,surface:row.surface,access_mode:row.access_mode,
    verified:true,evidence:'authenticated_mcp_call',memory_content_logged:false};
}
