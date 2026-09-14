import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {terminateAgentProcess} from './agent-process.ts';

/** Private stdio transport. No browser can choose RPC methods or thread ids. */
export class CodexAppServer extends EventEmitter {
  private child?:ChildProcessWithoutNullStreams;
  private nextId=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private buffer='';
  private stopping?:Promise<void>;
  constructor(private options:{binary:string;cwd:string;env:NodeJS.ProcessEnv}) {super();}
  async start() {
    if(this.child)throw new Error('Agent process is already running');
    this.stopping=undefined;this.buffer='';
    this.child=spawn(this.options.binary,['app-server','--stdio'],{cwd:this.options.cwd,env:this.options.env,stdio:'pipe'});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>this.consume(chunk));
    // Stderr may contain credentials or tool output. It is never sent to telemetry.
    this.child.stderr.on('data',()=>{});
    this.child.stdin.on('error',()=>this.abort());
    this.child.once('error',()=>this.fail());
    this.child.once('close',()=>{if(!this.stopping)this.fail();});
    await this.call('initialize',{clientInfo:{name:'qoopia',title:'My Qoopia agent',version:'1.0.0'},capabilities:{experimentalApi:false}});
    this.write({method:'initialized'});
  }
  private consume(chunk:string) {
    if(this.stopping)return;
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>8*1024*1024){this.abort();return;}
    let end:number;
    while((end=this.buffer.indexOf('\n'))>=0) {
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      if(!line.trim())continue;
      let message:any;try{message=JSON.parse(line);}catch{this.abort();return;}
      if(message.method){this.emit(message.id===undefined?'notification':'request',message);continue;}
      const entry=this.pending.get(message.id);if(!entry)continue;
      this.pending.delete(message.id);clearTimeout(entry.timer);
      if(message.error)entry.reject(new Error('Codex request failed. Check sign-in and model availability.'));
      else entry.resolve(message.result);
    }
  }
  private write(message:unknown) {
    if(this.stopping||!this.child||!this.child.stdin.writable)throw new Error('Agent process is unavailable');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  call(method:string,params:unknown):Promise<any> {
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Agent request timed out'));this.abort();},45_000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  respond(id:string|number,result:unknown){this.write({id,result});}
  refuse(id:string|number){this.write({id,error:{code:-32601,message:'This request is not supported by Qoopia'}});}
  private fail() {
    if(!this.child)return;
    this.child=undefined;
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Agent process stopped'));}
    this.pending.clear();this.emit('closed');
  }
  private abort(){void this.stop().catch(()=>{});}
  stop():Promise<void> {
    if(this.stopping)return this.stopping;
    const child=this.child;if(!child)return Promise.resolve();
    this.stopping=terminateAgentProcess(child).then(()=>this.fail()).catch(error=>{this.stopping=undefined;this.emit('stopFailed');throw error;});
    // Callers that stop on shutdown/revocation need no unhandled rejection.
    // An explicit dashboard Stop still awaits the original rejecting promise.
    void this.stopping.catch(()=>{});return this.stopping;
  }
}
