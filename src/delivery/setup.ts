import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {dataFile,readCurrent} from './operations.ts';
import {readJson,safePath} from '../utils/fs.ts';
import {nativePackageSchema} from './native-provision.ts';
import { tableExists } from '../db/introspect.ts';
import { selectedNativeDirectory } from './native-client-paths.ts';

type SetupRuntime='codex'|'claude_code';
type SetupStatus={
 format:'qoopia-setup-status/1';stage:string;runtime:SetupRuntime|null;next_action:string|null;
 detail:string;read_only:true;
};
const quote=(value:string)=>JSON.stringify(value);
const commandRoot=(root:string)=>` --root ${quote(root)}`;

/** Read-only first-run dispatcher. It reports one existing command at a time and stores no parallel setup state. */
export function inspectSetup(root:string,requested?:string):SetupStatus{
 const base={format:'qoopia-setup-status/1' as const,read_only:true as const};
 const pointer=path.join(root,'current.json');
 if(!fs.existsSync(pointer))return {...base,stage:'INSTALL_REQUIRED',runtime:null,next_action:`qoopia install${commandRoot(root)}`,detail:'No installation pointer exists.'};
 const current=readCurrent(root),database=new Database(dataFile(root,current),{readonly:true});
 let owners=0,clients:string[]=[];
 try{
  owners=(database.query('SELECT count(*) AS n FROM workspace_owners').get() as {n:number}).n;
  // OAuth client connections of the owner whose agent is still active (what connections status reports).
  if(owners===1&&tableExists(database,'client_connections'))
   clients=(database.query(`SELECT c.state FROM client_connections c JOIN workspace_owners o ON o.actor_id=c.owner_id AND o.workspace_id=c.workspace_id
    JOIN agents a ON a.id=c.agent_id AND a.workspace_id=c.workspace_id AND a.active=1 WHERE c.state IN ('verified','awaiting_client')`).all() as {state:string}[]).map(row=>row.state);
 }finally{database.close();}
 if(owners===0)return {...base,stage:'OWNER_BOOTSTRAP_REQUIRED',runtime:null,next_action:`qoopia start${commandRoot(root)}`,
  detail:'Start the server; its local output gives the single owner-login action. Setup cannot bootstrap owner authority.'};
 if(owners>1)return {...base,stage:'OWNER_SELECTION_REQUIRED',runtime:null,next_action:null,
  detail:'More than one owner is bound. Re-run the eventual connect command with an explicit --owner-id; setup does not disclose identifiers.'};
 if(requested===undefined){
  if(clients.includes('verified'))return {...base,stage:'CLIENT_CONNECTED',runtime:null,next_action:null,
   detail:`A client connection is verified. Review connections with qoopia connections status${commandRoot(root)}.`};
  if(clients.length)return {...base,stage:'CLIENT_CALL_REQUIRED',runtime:null,next_action:`qoopia connections status${commandRoot(root)}`,
   detail:'A client connection waits for its first call. Status shows its MCP URL and the step to finish in that client.'};
  return {...base,stage:'CONNECTION_REQUIRED',runtime:null,next_action:`qoopia connections plan --input ABSOLUTE_SELECTION_JSON${commandRoot(root)}`,
   detail:'Connect a client with its own OAuth connection: run qoopia open and choose Connections, or, while Qoopia runs, plan a selection naming surface, access_mode and request_key, then apply it with --commit. No API key is written into client files. The legacy native runtime path is setup --runtime codex|claude_code.'};
 }
 const selected=(['codex','claude_code'] as const).filter(runtime=>{
  const file=path.join(root,'native-runtimes',runtime+'.json');
  if(!fs.existsSync(file))return false;
  try{return nativePackageSchema.parse(readJson(safePath(file))).runtime===runtime;}catch{return false;}
 });
 if(requested!=='codex'&&requested!=='claude_code')throw new Error('Setup runtime must be codex or claude_code');
 const runtime:SetupRuntime=requested;
 if(!selected.includes(runtime))return {...base,stage:'RUNTIME_PROVISION_REQUIRED',runtime,next_action:`qoopia runtime provision --runtime ${runtime}${commandRoot(root)}`,
  detail:'Review the existing provision preview, then apply its saved plan explicitly. Setup performs no network, login, or installation.'};
 const connections=safePath(path.join(root,'connections'));
 const connected=fs.existsSync(connections)&&fs.readdirSync(connections).some(name=>{
  const file=safePath(path.join(connections,name));
  try{
   const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return false;
   const receipt=readJson<Record<string,any>>(file);
   const installation=receipt.installation,config=receipt.config;
   const text=(value:unknown)=>typeof value==='string'&&value.length>0;
   const integer=(value:unknown)=>Number.isInteger(value);
   return name===receipt.agent_id+'.json'&&receipt.format==='qoopia-native-connection/1'&&receipt.runtime_kind===runtime&&
    [receipt.runtime_id,receipt.workspace_id,receipt.agent_id,receipt.owner_id].every(text)&&
    [receipt.agent_epoch,receipt.agent_session,receipt.owner_epoch,receipt.owner_session].every(integer)&&
    config&&text(config.path)&&integer(config.dev)&&integer(config.ino)&&typeof config.sha256==='string'&&/^[a-f0-9]{64}$/.test(config.sha256)&&
    installation?.root===root&&installation?.instance===current.instance&&installation?.bundle===current.bundle&&
    installation?.generation===current.generation&&installation?.port===current.port;
  }catch{return false;}
 });
 if(connected)return {...base,stage:'LIVE_QUALIFICATION_REQUIRED',runtime,next_action:`qoopia start${commandRoot(root)}`,
  detail:'A current-generation connect receipt exists, but setup has not validated live auth, runtime login, model access, service health, or a useful task.'};
 // The same file client-config writes: CODEX_HOME / CLAUDE_CONFIG_DIR first, then the home default.
 // setup is read-only diagnosis: a malformed override is refused by connect itself, not here.
 let custom:string|undefined;try{custom=selectedNativeDirectory(runtime);}catch{custom=undefined;}
 const config=runtime==='codex'?path.join(custom??path.join(os.homedir(),'.codex'),'config.toml'):path.join(custom??os.homedir(),'.claude.json');
 const name=runtime==='codex'?'Codex memory worker':'Claude Code memory worker';
 return {...base,stage:'CONNECT_REQUIRED',runtime,next_action:`qoopia connect --runtime ${runtime} --name ${quote(name)} --config ${quote(config)}${commandRoot(root)}`,
  detail:'Run the existing connect preview while Qoopia is stopped; apply only with its exact preview digest. No owner ID is needed for the sole owner.'};
}
