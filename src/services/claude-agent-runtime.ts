import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {stripVTControlCharacters} from 'node:util';
import {randomUUID} from 'node:crypto';
import {terminateAgentProcess} from './agent-process.ts';

export function claudeLoginUrl(raw:string){const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||!((u.hostname==='claude.ai'&&u.pathname==='/oauth/authorize')||(u.hostname==='claude.com'&&u.pathname==='/cai/oauth/authorize')))throw new Error('Unexpected Claude sign-in URL');return u.href;}
type Options={binary:string;cwd:string;env:NodeJS.ProcessEnv;mcpConfig:string};
type Thread={id:string;resume:boolean;instructions:string};
/** Adapts Claude Code's native stream/control protocol to the dashboard runner contract. */
export class ClaudeAgentRuntime extends EventEmitter {
  private active?:{child:ChildProcessWithoutNullStreams;thread:Thread;turn:string;ended:boolean;completion?:Promise<void>};
  private login?:ChildProcessWithoutNullStreams;
  private probes=new Set<ChildProcessWithoutNullStreams>();
  private stopped=false;
  private stopping?:Promise<void>;
  private threads=new Map<string,Thread>();
  private permissions=new Map<string,{input:any;tool:string}>();
  constructor(private options:Options){super();}
  async start(){if(this.stopping)await this.stopping;this.stopping=undefined;this.stopped=false;}
  private spawn(args:string[]){return spawn(this.options.binary,args,{cwd:this.options.cwd,env:this.options.env,stdio:'pipe'});}
  private kill(child:ChildProcessWithoutNullStreams){const result=terminateAgentProcess(child);void result.catch(()=>this.emit('stopFailed'));return result;}
  private finish(child:ChildProcessWithoutNullStreams):Promise<void>{
    if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
    // A result precedes the native transcript flush. EOF lets Claude persist the
    // assistant response before exit; forced termination loses resume context.
    return new Promise((resolve,reject)=>{
      const closed=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{child.removeListener('close',closed);this.kill(child).then(resolve,reject);},3000);
      child.once('close',closed);child.stdin.end();
    });
  }
  private async account():Promise<any>{
    return new Promise((resolve,reject)=>{
      const child=this.spawn(['auth','status','--json']);this.probes.add(child);let output='';
      const timer=setTimeout(()=>{this.kill(child);reject(new Error('Claude sign-in check timed out'));},15_000);
      child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{output+=s;if(output.length>65536){this.kill(child);output='';}});child.stderr.on('data',()=>{});
      child.once('error',()=>{this.probes.delete(child);clearTimeout(timer);reject(new Error('Claude Code could not start'));});
      child.once('close',(code)=>{this.probes.delete(child);clearTimeout(timer);let a:any;try{a=JSON.parse(output);}catch{return resolve({account:null});}
        resolve({account:!this.stopped&&code===0&&a.loggedIn===true&&a.authMethod==='claude.ai'&&a.apiProvider==='firstParty'&&(!a.apiKeySource||a.apiKeySource==='none')&&['pro','max','team','enterprise'].includes(a.subscriptionType)?{type:'claude'}:null});});
    });
  }
  private async startLogin():Promise<any>{
    if(this.login)throw new Error('Claude sign-in is already running');
    const child=this.spawn(['auth','login','--claudeai']);this.login=child;
    return new Promise((resolve,reject)=>{
      let output='',resolved=false;
      const timer=setTimeout(()=>{this.kill(child);},600_000);
      const urlTimer=setTimeout(()=>{if(!resolved){this.kill(child);reject(new Error('Claude sign-in link timed out. Try again.'));}},30_000);
      const receive=(chunk:string)=>{output=stripVTControlCharacters((output+chunk).slice(-65536));const urls=output.match(/https:\/\/[^\s<>"]+/g)??[];
        for(const raw of urls){let url:URL;try{url=new URL(claudeLoginUrl(raw));}catch{continue;}
          if(!resolved){resolved=true;clearTimeout(urlTimer);resolve({authUrl:url.href});}return;}
      };
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',receive);child.stderr.on('data',receive);child.stdin.on('error',()=>this.kill(child));
      child.once('error',()=>{clearTimeout(timer);clearTimeout(urlTimer);if(this.login===child)this.login=undefined;if(!resolved)reject(new Error('Claude sign-in could not start'));});
      child.once('close',async()=>{clearTimeout(timer);clearTimeout(urlTimer);if(this.login===child)this.login=undefined;
        if(this.stopped)return;let success=false;try{success=!!(await this.account()).account;}catch{}
        if(!this.stopped)this.emit('notification',{method:'account/login/completed',params:{success}});
        if(!resolved)reject(new Error('Claude sign-in did not provide an authorization link. Try again.'));
      });
    });
  }
  async call(method:string,params:any):Promise<any>{
    if(this.stopped)throw new Error('Claude agent stopped');
    if(method==='account/read')return this.account();
    if(method==='account/login/start')return this.startLogin();
    if(method==='account/login/code'){if(!this.login?.stdin.writable)throw new Error('Claude sign-in expired');this.login.stdin.write(params.code+'\n');return {};}
    if(method==='thread/start'||method==='thread/resume'){
      const id=method==='thread/resume'?params.threadId:randomUUID();
      if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Invalid Claude session ID');
      this.threads.set(id,{id,resume:method==='thread/resume',instructions:params.developerInstructions});return {thread:{id}};
    }
    if(method==='turn/interrupt'){if(this.active)await this.complete(this.active,'interrupted');return {};}
    if(method!=='turn/start')throw new Error('Unsupported Claude operation');
    if(this.active)throw new Error('Claude is already working');
    const thread=this.threads.get(params.threadId);if(!thread)throw new Error('Claude session was not prepared');
    const turn=randomUUID();
    if(params.model!==undefined&&!['opus','sonnet'].includes(params.model))throw new Error('Unsupported Claude model');
    const args=[...(params.model?['--model',params.model]:[]),'--print','--verbose','--input-format','stream-json','--output-format','stream-json','--include-partial-messages',
      '--permission-mode','default','--permission-prompt-tool','stdio','--setting-sources','user','--strict-mcp-config','--mcp-config',this.options.mcpConfig,
      '--append-system-prompt',thread.instructions,thread.resume?'--resume='+thread.id:'--session-id='+thread.id];
    const child=this.spawn(args),active={child,thread,turn,ended:false};this.active=active;let buffer='',initialized=false,sawText=false;
    const timer=setTimeout(()=>this.complete(active,'failed'),45_000);
    child.stdout.setEncoding('utf8');child.stderr.on('data',()=>{});child.stdin.on('error',()=>this.complete(active,'failed'));
    child.stdout.on('data',(chunk:string)=>{
      if(active.ended)return;buffer+=chunk;if(Buffer.byteLength(buffer)>8*1024*1024){this.complete(active,'failed');return;}
      let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
        let m:any;try{m=JSON.parse(line);}catch{this.complete(active,'failed');return;}
        if(m.type==='control_response'&&m.response?.request_id==='initialize'){
          clearTimeout(timer);if(m.response.subtype!=='success'){this.complete(active,'failed');return;}
          if(initialized)continue;initialized=true;
          child.stdin.write(JSON.stringify({type:'user',session_id:thread.id,message:{role:'user',content:params.input.map((v:any)=>v.text).join('\n')},parent_tool_use_id:null})+'\n');
          this.emit('notification',{method:'turn/started',params:{threadId:thread.id,turn:{id:turn}}});continue;
        }
        if(m.session_id&&m.session_id!==thread.id){this.complete(active,'failed');return;}
        if(m.type==='control_request'){
          if(m.request?.subtype==='hook_callback'&&m.request.callback_id==='qoopia-read-boundary'){
            const input=m.request.input?.tool_input??{},requested=input.file_path??input.path??this.options.cwd;
            let inside=false;try{const absolute=path.resolve(this.options.cwd,requested),real=fs.existsSync(absolute)?fs.realpathSync(absolute):absolute,root=fs.realpathSync(this.options.cwd);inside=real===root||real.startsWith(root+path.sep);}catch{}
            child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:inside?{}:{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'This read is outside your Qoopia agent folder.'}}}})+'\n');continue;
          }
          if(m.request?.subtype!=='can_use_tool'||typeof m.request_id!=='string'||!m.request?.input||typeof m.request.input!=='object'||this.permissions.has(m.request_id)){this.refuse(m.request_id);continue;}
          const r=m.request;this.permissions.set(m.request_id,{input:r.input,tool:r.tool_name});
          const questions=r.tool_name==='AskUserQuestion'&&Array.isArray(r.input.questions)?r.input.questions.map((q:any)=>({id:q.question,question:q.question})):undefined;
          this.emit('request',{id:m.request_id,method:questions?'item/tool/requestUserInput':'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn,reason:r.tool_name,command:r.input.command,tool:r.tool_name,input:r.input,...(questions?{questions}:{})}});continue;
        }
        if(m.type==='control_cancel_request'){this.permissions.delete(m.request_id);this.emit('notification',{method:'qoopia/approval/cancelled',params:{rpcId:m.request_id}});continue;}
        if(m.type==='stream_event'&&!m.parent_tool_use_id){const delta=m.event?.delta;if(delta?.type==='text_delta'&&typeof delta.text==='string'){sawText=true;this.emit('notification',{method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn,delta:delta.text}});}if(m.event?.type==='content_block_start'&&m.event.content_block?.type==='tool_use')this.emit('notification',{method:'item/started',params:{threadId:thread.id,item:{type:m.event.content_block.name}}});}
        if(m.type==='result'){
          if(!sawText&&typeof m.result==='string')this.emit('notification',{method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn,delta:m.result}});
          thread.resume=true;this.complete(active,m.is_error||m.subtype!=='success'?'failed':'completed');return;
        }
      }
    });
    child.once('error',()=>{clearTimeout(timer);this.complete(active,'failed');});child.once('close',()=>{clearTimeout(timer);this.complete(active,'failed');});
    child.stdin.write(JSON.stringify({type:'control_request',request_id:'initialize',request:{subtype:'initialize',hooks:{PreToolUse:[{matcher:'Read|Glob|Grep',hookCallbackIds:['qoopia-read-boundary']}]}}})+'\n');
    return {turn:{id:turn}};
  }
  private complete(active:NonNullable<ClaudeAgentRuntime['active']>,status:string){
    if(active.completion)return active.completion;
    active.ended=true;this.permissions.clear();
    active.completion=(status==='completed'?this.finish(active.child):this.kill(active.child)).then(()=>{
      if(this.active===active)this.active=undefined;
      this.emit('notification',{method:'turn/completed',params:{threadId:active.thread.id,turnId:active.turn,turn:{id:active.turn,status,...(status==='failed'?{error:true}:{})}}});
    }).catch(error=>{active.completion=undefined;throw error;});
    void active.completion.catch(()=>{});return active.completion;
  }
  respond(id:string|number,result:any){
    const p=this.permissions.get(String(id)),active=this.active;if(!p||!active)throw new Error('Claude approval expired');this.permissions.delete(String(id));
    let input=p.input;if(p.tool==='AskUserQuestion'&&result.answers)input={...input,answers:Object.fromEntries(Object.entries(result.answers).map(([key,value]:[string,any])=>[key,value.answers?.join(', ')??'']))};
    const allow=result.decision==='accept'||p.tool==='AskUserQuestion'&&!!result.answers;
    active.child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:String(id),response:allow?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'The user declined this action.'}}})+'\n');
  }
  refuse(id:string|number){this.permissions.delete(String(id));this.active?.child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:String(id),error:'This request is not supported or no longer active.'}})+'\n');}
  stop():Promise<void>{
    if(this.stopping)return this.stopping;
    this.stopped=true;
    this.stopping=Promise.all([this.active?this.complete(this.active,'interrupted'):Promise.resolve(),this.login?this.kill(this.login):Promise.resolve(),...[...this.probes].map(child=>this.kill(child))]).then(()=>{this.login=undefined;this.emit('closed');}).catch(error=>{this.stopping=undefined;throw error;});
    void this.stopping.catch(()=>{});return this.stopping;
  }
}
