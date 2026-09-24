import type {Database} from 'bun:sqlite';
import type {AuthContext} from '../auth/middleware.ts';
import {authorize,bootstrapToolAllowed,currentToolAuth,type AuthorityAction} from '../auth/policy.ts';
import {grantedScopeAllowsRisk} from '../auth/oauth.ts';
import {isToolAllowedForProfile,normalizeAgentProfile,toolCatalog,toolNames,type RiskClass} from '../mcp/tools.ts';
import {assertInstanceWriteAllowed} from '../utils/instance-role.ts';
import {BRIDGE_READ_TOOLS,BRIDGE_TOOL_NAMES,bridgeRefusal} from '../bridges/api.ts';
import {agentMemoryStatus} from '../services/memory-policy.ts';
import {AGENT_KIT_REVISION} from '../agent-kit/index.ts';

export type MechanismStatus='available'|'forbidden'|'client_unsupported'|'needs_setup'|'faulty';
export interface Mechanism {id:string;title:string;status:MechanismStatus;tools:string[];withheld:string[];reason:string|null;action:string|null}
interface ContractOperation {name:string;action:AuthorityAction;humanOnly?:boolean}

/** Titles, reasons and actions are fixed sentences so the dashboard can translate them.
 * One row per product mechanism. A registered tool that matches none of them lands in
 * `other`, and the contract test refuses that — a new tool must be placed deliberately. */
const MECHANISMS:{id:string;title:string;match:RegExp;flag?:string}[]=[
  {id:'memory.notes',title:'Notes, recall and brief',match:/^(recall|brief|note_|activity_list|extraction_)/},
  {id:'memory.sessions',title:'Session log, search and expansion',match:/^session_/},
  {id:'agentcomm',title:'Messages between agents, inbox, reply and wake',match:/^agent_(send|inbox|reply|status|session_)/},
  {id:'skills',title:'Skills',match:/^(skill_|runtime_|operation_get$)/},
  {id:'knowledge',title:'Knowledge pages',match:/^entity_/,flag:'QOOPIA_ENTITY_PAGES'},
  {id:'bridges',title:'Bridges and external material',match:/^bridge_/},
  {id:'files',title:'Files',match:/^file_/},
  {id:'transfer',title:'Export and import',match:/^(export_|import_)/},
  {id:'management',title:'Agents, access and memory policy',match:/^(agent_(onboard|list|deactivate|set_profile)$|memory_(policy|save)_)/},
];
const MCP_ONLY_SURFACES=['chatgpt_web','chatgpt_desktop','claude_web','claude_desktop','muse_code','grok_bot'];

/** What this agent really gets, by the same predicates the MCP registration applies. */
export function grantedTools(database:Database,auth:AuthContext,operations:readonly ContractOperation[]) {
  const profile=normalizeAgentProfile(auth.tool_profile,auth.agent_name);
  // What this connection really got, when the transport recorded it; otherwise the default rule.
  const bootstrap=auth.bootstrap_profile!==undefined?(auth.bootstrap_profile??undefined)
    :auth.legacy_skill_access===1?undefined:auth.authority_profile;
  const steward=auth.type==='steward'||auth.type==='owner';
  // The same four predicates MCP registration applies, plus the instance gate the handler
  // enforces: on a follower or with storage exhausted a write tool exists but always refuses,
  // and reporting it as available would be a promise the server cannot keep.
  const writable=(risk:RiskClass)=>{try{assertInstanceWriteAllowed(risk,'contract');return true;}catch{return false;}};
  const registry=toolCatalog().filter(t=>(!t.admin||steward)&&bootstrapToolAllowed(t.name,bootstrap)&&isToolAllowedForProfile(t.risk,profile)&&grantedScopeAllowsRisk(auth.granted_scope,t.risk)&&writable(t.risk)).map(t=>t.name);
  const taken=new Set(toolNames('full').filter(name=>bootstrapToolAllowed(name,bootstrap)));
  const authority=operations.filter(op=>!op.humanOnly&&!taken.has(op.name)).filter(op=>{try{authorize(database,auth,op.action);return true;}catch{return false;}}).map(op=>op.name);
  const bridges=bridgeRefusal(auth)?[]:BRIDGE_TOOL_NAMES.filter(name=>{try{currentToolAuth(database,auth,BRIDGE_READ_TOOLS.includes(name)?'read':'write-low');return true;}catch{return false;}});
  return [...new Set([...registry,...authority,...bridges])];
}

/** The connection this agent actually uses: the most recently verified one that still stands.
 * An agent may hold several rows, so an unordered pick would report a random or revoked client. */
function currentConnection(database:Database,workspace:string,agent:string) {
  return database.query(`SELECT surface,state,verified_at FROM client_connections
    WHERE agent_id=? AND workspace_id=? AND state!='revoked'
    ORDER BY (state='verified') DESC,COALESCE(verified_at,created_at) DESC LIMIT 1`)
    .get(agent,workspace) as {surface:string;state:string;verified_at:string|null}|null;
}

function continuity(database:Database,auth:AuthContext):Mechanism {
  const base={id:'memory.continuity',title:'Automatic session capture and restore',tools:[] as string[],withheld:[] as string[]};
  const memory=agentMemoryStatus(auth.workspace_id,auth.agent_id,database);
  const surface=currentConnection(database,auth.workspace_id,auth.agent_id)?.surface;
  if(memory.state==='manual')return {...base,status:'forbidden',reason:'The owner set this agent to save only on request.',
    action:'Reading and search keep working. note_create prepares the note for the owner to confirm; the owner can turn automatic saving back on.'};
  if(memory.state==='working')return {...base,status:'available',reason:null,action:null};
  if(memory.state==='waiting')return surface&&MCP_ONLY_SURFACES.includes(surface)
    ?{...base,status:'client_unsupported',reason:'This client has no session lifecycle hooks, so nothing is captured automatically.',action:'Save what matters with note_create. Full coverage needs a client with the Qoopia memory adapter (Claude Code, Codex).'}
    :{...base,status:'needs_setup',reason:'No lifecycle adapter has delivered a session for this agent yet.',action:'Connect the Qoopia memory client in the runtime this agent already uses; its identity and provider stay as they are.'};
  return {...base,status:'faulty',reason:memory.state==='behind'?'Conversations wait for a summary.':'The memory model reported an error.',
    action:memory.state==='sign_in'?'The owner signs in to the memory subscription in Qoopia, or checks its quota.':'Accepted messages are kept. The owner checks the memory model in Qoopia; summaries resume by themselves.'};
}

/** The same contract for every agent, new or existing: what exists on this server, what this
 * agent may use, what its client cannot do, and what to do about it. Live status, so it is
 * reported next to the config digest rather than inside it. */
export function agentContract(database:Database,auth:AuthContext,operations:readonly ContractOperation[]) {
  const universe=[...new Set([...toolCatalog().map(t=>t.name),...operations.filter(op=>!op.humanOnly).map(op=>op.name),...BRIDGE_TOOL_NAMES])];
  const granted=grantedTools(database,auth,operations),placed=new Set<string>();
  const mechanisms:Mechanism[]=[];
  for(const m of MECHANISMS) {
    const known=universe.filter(name=>m.match.test(name)),tools=granted.filter(name=>m.match.test(name));known.forEach(name=>placed.add(name));
    const row={id:m.id,title:m.title,tools,withheld:known.filter(name=>!tools.includes(name))};
    if(!known.length){if(m.flag)mechanisms.push({...row,status:'needs_setup',reason:'Switched off on this server.',action:'The owner enables it in the server configuration.'});continue;}
    if(tools.length){mechanisms.push({...row,status:'available',reason:null,action:null});continue;}
    const refusal=m.id==='bridges'?bridgeRefusal(auth):null;
    mechanisms.push(refusal?.includes('external agent')?{...row,status:'needs_setup',reason:refusal,action:'The owner selects this agent in Bridges.'}
      :{...row,status:'forbidden',reason:m.id==='management'?'Reserved for the steward and the owner.':'Not included in this agent\'s access profile.',
        action:'The owner can change this agent\'s access on its card or with agent_set_profile.'});
  }
  const other=universe.filter(name=>!placed.has(name));
  if(other.length) {
    const tools=granted.filter(name=>other.includes(name));
    mechanisms.push({id:'other',title:'Other operations',status:tools.length?'available':'forbidden',tools,
      withheld:other.filter(name=>!tools.includes(name)),reason:tools.length?null:'Not included in this agent\'s access profile.',
      action:tools.length?null:'The owner can change this agent\'s access on its card or with agent_set_profile.'});
  }
  mechanisms.splice(2,0,continuity(database,auth));
  const connection=currentConnection(database,auth.workspace_id,auth.agent_id);
  return {contract:'qoopia-agent-contract/1',
    protocol:{kit:'qoopia-agent-kit/1',revision:AGENT_KIT_REVISION,read_with:'qoopia_protocol',evidence:'A protocol file on disk does not prove that a session loaded it.'},
    connection,mechanisms};
}

/** Any agent of the workspace seen through the same contract — for the owner's overview. */
export function agentContractFor(database:Database,workspace:string,agent:string,operations:readonly ContractOperation[]) {
  const row=database.query('SELECT id,name,type,tool_profile,authority_profile,legacy_skill_access FROM agents WHERE id=? AND workspace_id=? AND active=1').get(agent,workspace) as
    {id:string;name:string;type:string;tool_profile:string|null;authority_profile:string;legacy_skill_access:number}|null;
  if(!row)return null;
  return agentContract(database,{agent_id:row.id,agent_name:row.name,workspace_id:workspace,type:row.type,source:'api-key',tool_profile:row.tool_profile,
    authority_profile:row.authority_profile,legacy_skill_access:row.legacy_skill_access},operations);
}
