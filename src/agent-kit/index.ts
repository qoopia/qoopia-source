import fs from 'node:fs';
import path from 'node:path';
import protocol from './qoopia-protocol.md' with {type:'text'};
import connections from './MCP-CONNECTIONS.md' with {type:'text'};
import soul from './SOUL.md' with {type:'text'};
import operations from './OPERATIONS.md' with {type:'text'};
import {PRODUCT_VERSION} from '../utils/product-version.ts';
import {hash} from '../utils/fs.ts';
declare const QOOPIA_BUILD_SHA:string;
export const AGENT_KIT_REVISION=4;
export const agentKitFiles={'qoopia-protocol.md':protocol,'MCP-CONNECTIONS.md':connections,'SOUL.md':soul,'OPERATIONS.md':operations};
/** The commit this kit was built from.
 *
 * Only a bundled build carries QOOPIA_BUILD_SHA. The server runs from source in
 * its image, so it used to stamp every installed kit "development" and no
 * installation could be traced back to a release. The image already knows its
 * commit through the release stamp it starts with; read that before giving up. */
function buildSource(){
  if(typeof QOOPIA_BUILD_SHA!=='undefined')return QOOPIA_BUILD_SHA;
  const declared=process.env.QOOPIA_EXPECTED_RELEASE_SHA?.trim();
  if(declared&&/^[0-9a-f]{40}$/.test(declared))return declared;
  const stamp=process.env.QOOPIA_RELEASE_STAMP_PATH?.trim();
  if(stamp)try{
    const sha=JSON.parse(fs.readFileSync(stamp,'utf8')).commit_sha;
    if(typeof sha==='string'&&/^[0-9a-f]{40}$/.test(sha))return sha;
  }catch{}
  return 'development';
}
export function agentKitManifest(){return {format:'qoopia-agent-kit/1',revision:AGENT_KIT_REVISION,product_version:PRODUCT_VERSION,source:buildSource(),files:Object.fromEntries(Object.entries(agentKitFiles).map(([name,text])=>[name,hash(text)]))};}
export function agentProtocol(section:'protocol'|'connections'|'operations'|'soul'='protocol'){
  return {manifest:agentKitManifest(),section,text:({protocol,connections,operations,soul})[section],authority:'Documentation only. Discover actual tools and permissions on the selected MCP connection. Does not grant steward or owner authority.'};
}
export function managedAgentInstructions(directory:string){return soul+'\n\n'+protocol+'\n\nYour installed knowledge directory is '+JSON.stringify(directory)+'. Read '+JSON.stringify(path.join(directory,'qoopia','INSTALLATION.json'))+' for this installation and its CLI location. For connection work read '+JSON.stringify(path.join(directory,'qoopia','MCP-CONNECTIONS.md'))+'; for health, agents, bridges and recovery read '+JSON.stringify(path.join(directory,'qoopia','OPERATIONS.md'))+'. This documentation does not grant permission to bypass current user instructions.';}
