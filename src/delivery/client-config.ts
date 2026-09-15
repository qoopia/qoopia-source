import {installAgentInstructions,planAgentInstructions} from '../agent-kit/install.ts';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {safePath,privateDirectory,readJsonBytes,durableWrite,hash} from '../utils/fs.ts';
import {resourceOrigin} from '../auth/resource-origin.ts';
import {nativeOwnerHome} from './native-keychain.ts';
import {selectedNativeDirectory} from './native-client-paths.ts';
import {prepareDesktopLauncher} from './desktop-launcher.ts';

export const clientBindingSchema=z.object({format:z.literal('qoopia-client-connection/1'),connection_id:z.string().uuid(),
  workspace_id:z.string().min(1).max(128),surface:z.enum(['codex','claude_code','claude_desktop']),access_mode:z.enum(['read','read_write']),mcp_url:z.string().url()}).strict()
  .superRefine((value,ctx)=>{try{
    const url=new URL(value.mcp_url);resourceOrigin(url.origin);
    if(value.mcp_url!==url.origin+'/mcp/c/'+value.connection_id)throw new Error();
  }catch{ctx.addIssue({code:'custom',message:'Use the exact prepared Qoopia connection URL'});}});
const receiptSchema=z.object({format:z.literal('qoopia-client-config/1'),binding:clientBindingSchema,file:z.string(),name:z.string(),entry_hash:z.string(),state:z.enum(['pending','applied','removed'])}).strict();

function current(file:string,codex:boolean) {
  const exists=fs.existsSync(file),bytes=exists?readJsonBytes(file):null;
  if(exists){const st=fs.lstatSync(file);if(st.uid!==process.getuid!()||st.nlink!==1||(st.mode&0o022))throw new Error('Native configuration must be owned and not writable by other users');}
  const text=bytes?.toString()??'',parsed=codex?Bun.TOML.parse(text):bytes?JSON.parse(text):{};
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid native configuration');
  const servers=parsed[codex?'mcp_servers':'mcpServers']??{};
  if(!servers||typeof servers!=='object'||Array.isArray(servers))throw new Error('Invalid MCP configuration');
  return {bytes,text,parsed,servers};
}
function directoryCheck(file:string) {
  let parent=path.dirname(file);
  while(!fs.existsSync(parent))parent=path.dirname(parent);
  const st=fs.lstatSync(safePath(parent));
  if(!st.isDirectory()||st.uid!==process.getuid!()||(st.mode&0o022))throw new Error('Native configuration directory must be owned and not writable by other users');
}
const same=isDeepStrictEqual;

/** Add one scoped OAuth entry or the private Desktop adapter; preserve unrelated settings. */
export function configureNativeClient(root:string,raw:unknown,action:'plan'|'apply'|'status'|'remove',home?:string,directory?:string) {
  const binding=clientBindingSchema.parse(raw),codex=binding.surface==='codex',desktop=binding.surface==='claude_desktop';
  if(desktop&&process.platform!=='darwin')throw new Error('The local Claude Desktop adapter requires macOS; this Linux installation supports Claude Web and Claude Code');
  const folder=safePath(path.join(root,'client-configs',binding.connection_id)),receiptFile=path.join(folder,'receipt.json');
  const receipt=fs.existsSync(receiptFile)?receiptSchema.parse(JSON.parse(readJsonBytes(receiptFile).toString())):null;
  const custom=directory??(home===undefined&&!desktop?selectedNativeDirectory(binding.surface as 'codex'|'claude_code'):undefined);
  if(custom!==undefined&&(!path.isAbsolute(custom)||/[\0\r\n]/.test(custom)))throw new Error('Native client directory must be an absolute path');
  // Resume the exact previously selected file when a background service has no shell overrides.
  const file=safePath(custom?path.join(safePath(custom),codex?'config.toml':desktop?'claude_desktop_config.json':'.claude.json'):
    receipt?.file??path.join(home??nativeOwnerHome(),codex?'.codex/config.toml':desktop?'Library/Application Support/Claude/claude_desktop_config.json':'.claude.json'));
  directoryCheck(file);
  const name='qoopia_'+binding.connection_id.replaceAll('-','');
  const adapter=desktop?prepareDesktopLauncher(root,binding,process.execPath,false,process.argv.includes('--allow-test-fixture')):undefined;
  const entry=adapter?.entry??(codex?{url:binding.mcp_url}:{type:'http',url:binding.mcp_url});
  const profile=codex?path.dirname(file):file===safePath(path.join(home??nativeOwnerHome(),'.claude.json'))?path.join(home??nativeOwnerHome(),'.claude'):path.dirname(file);
  const instructions=!desktop&&action!=='remove'?planAgentInstructions(profile,codex?'codex':'claude_code'):null;
  const state=current(file,codex),existing=state.servers[name];
  if(receipt&&(receipt.file!==file||receipt.name!==name||!same(receipt.binding,binding)||receipt.entry_hash!==hash(JSON.stringify(entry))))
    throw new Error('Native connection receipt belongs to another selection');
  const matches=existing&&same(existing,entry),owned=!!(receipt&&receipt.state!=='removed');
  const result=(code:string,extra:Record<string,unknown>={})=>({format:'qoopia-connections/1',state:'requires_user_action',code,
    client:binding.surface,connection_id:binding.connection_id,mcp_url:binding.mcp_url,configuration_file:file,configuration_name:name,
    protocol:instructions?{protocol_file:instructions.protocol_file,instruction_file:instructions.instruction_file,revision:instructions.manifest.revision,changes:instructions.changes.length,loaded:'NOT_VERIFIED'}:{delivery:'mcp',tool:'qoopia_protocol',loaded:'NOT_VERIFIED'},
    credentials_in_configuration:false,verified:false,plan_digest:hash(JSON.stringify({binding,configuration_file:file,entry,...(instructions?{instruction_digest:instructions.digest}:{}),...(adapter?{launcher_digest:adapter.launcher_digest}:{})})),
    ...(adapter?{binding_file:adapter.binding_file,authentication_argv:[process.execPath,'client-auth','--root',root,'--file',adapter.binding_file,'--commit','--open',...(process.argv.includes('--allow-test-fixture')?['--allow-test-fixture']:[])]}:{}),
    next_action:desktop?'Approve this connection using Qoopia client-auth, then restart Claude Desktop and run the verification prompt.':codex?'Sign in to this MCP connection in Codex, then run the verification prompt.':'Open Claude Code, run /mcp, authenticate this Qoopia connection, then run the verification prompt.',...extra});
  if(action==='plan')return result(existing&&!matches?'CLIENT_CONFIG_CONFLICT':matches?'CLIENT_CONFIG_PRESENT':'CLIENT_CONFIG_APPLY_REQUIRED',{
    change:matches?(instructions?.changes.length?'Install or update the managed Qoopia protocol; preserve personal instructions.':'none'):desktop?'Add one local MCP adapter; preserve other settings and create a private backup.':'Add a single independently named MCP URL and managed Qoopia protocol; preserve personal settings and instructions with private backups.',can_apply:!existing||!!matches});
  if(action==='status')return result(existing&&!matches?'CLIENT_CONFIG_CHANGED':matches?'CLIENT_AUTH_REQUIRED':'CLIENT_CONFIG_MISSING',{configuration_present:!!matches,managed_entry:owned});
  if(existing&&!matches)throw new Error('This MCP entry changed outside Qoopia; it was preserved');
  if(action==='remove'&&receipt?.state==='removed'&&!existing)return result('CLIENT_CONFIG_REMOVED',{next_action:'The local entry is removed. Revoke its memory access in Qoopia if it is still active.'});
  if(action==='remove'&&!owned)throw new Error('Qoopia has no ownership receipt for this native entry');
  if(action==='apply'&&instructions)installAgentInstructions(profile,codex?'codex':'claude_code');
  privateDirectory(folder);
  if(action==='apply'&&matches){
    if(desktop)prepareDesktopLauncher(root,binding,process.execPath,true,process.argv.includes('--allow-test-fixture'));
    // A pending receipt resumes a crash after config publication. An unrelated matching entry is never claimed.
    if(owned)durableWrite(receiptFile,JSON.stringify({...receipt,state:'applied'}));
    return result('CLIENT_AUTH_REQUIRED',{configuration_present:true,managed_entry:owned});
  }
  if(action==='remove'&&!existing){durableWrite(receiptFile,JSON.stringify({...receipt,state:'removed'}));return result('CLIENT_CONFIG_REMOVED',{next_action:'The local entry is removed. Revoke its memory access in Qoopia if it is still active.'});}
  let next:string;
  if(codex){
    if(action==='apply')next=state.text+'\n[mcp_servers.'+name+']\nurl = '+JSON.stringify(binding.mcp_url)+'\n';
    else {
      // The owned entry is exactly one table with one URL. Refuse unusual user formatting instead of rewriting unrelated TOML.
      const marker='\n[mcp_servers.'+name+']\nurl = '+JSON.stringify(binding.mcp_url)+'\n',start=state.text.indexOf(marker);
      if(start<0)throw new Error('Native entry formatting changed; remove it in Codex settings');
      next=state.text.slice(0,start)+state.text.slice(start+marker.length);
    }
    const parsed=Bun.TOML.parse(next) as any,expected={...state.servers};if(action==='apply')expected[name]=entry;else delete expected[name];
    if(!same({...parsed,mcp_servers:expected},{...state.parsed,mcp_servers:expected})||!same(parsed.mcp_servers??{},expected))throw new Error('Native TOML edit would change unrelated settings');
  }else{
    const servers={...state.servers};if(action==='apply')servers[name]=entry;else delete servers[name];
    next=JSON.stringify({...state.parsed,mcpServers:servers},null,2)+'\n';
  }
  if(state.bytes)durableWrite(path.join(folder,'settings-before-'+randomUUID()+'.bak'),state.bytes);
  if(action==='apply')durableWrite(receiptFile,JSON.stringify({format:'qoopia-client-config/1',binding,file,name,entry_hash:hash(JSON.stringify(entry)),state:'pending'}));
  // Refuse a concurrently edited file before publication. Backups and receipts remain private and recoverable.
  if(!same(current(file,codex).bytes?.toString()??null,state.bytes?.toString()??null))throw new Error('Native settings changed while applying; retry from the current configuration');
  if(action==='apply'&&desktop){
    prepareDesktopLauncher(root,binding,process.execPath,true,process.argv.includes('--allow-test-fixture'));
    if(!same(current(file,codex).bytes?.toString()??null,state.bytes?.toString()??null))throw new Error('Native settings changed while applying; retry from the current configuration');
  }
  if(!fs.existsSync(path.dirname(file)))privateDirectory(path.dirname(file));durableWrite(file,next);
  durableWrite(receiptFile,JSON.stringify({format:'qoopia-client-config/1',binding,file,name,entry_hash:hash(JSON.stringify(entry)),state:action==='apply'?'applied':'removed'}));
  return result(action==='apply'?'CLIENT_AUTH_REQUIRED':'CLIENT_CONFIG_REMOVED',action==='apply'?{configuration_present:true,managed_entry:true}:{next_action:'The local entry is removed. Revoke its memory access in Qoopia if it is still active.'});
}
