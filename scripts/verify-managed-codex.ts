// Deterministic local qualification of the real pinned Codex binary. No real model, account, MCP connector or memory is used.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {CodexAppServer} from '../src/services/codex-app-server.ts';
const args=process.argv.slice(2),binary=args[args.indexOf('--binary')+1],out=args[args.indexOf('--out')+1];
if(!args.includes('--binary')||!args.includes('--out')||!path.isAbsolute(binary??'')||!path.isAbsolute(out??''))throw Error('--binary and --out absolute paths required');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-native-flow-'))),profile=path.join(root,'profile');fs.mkdirSync(profile);
const marker='CEDAR_HARBOUR_593_LIGHTING_PLAN';let mode='context',seenContext=false,commandCalls=0;const toolsSeen:any[]=[];
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const body:any=await req.json();seenContext ||=JSON.stringify(body).includes(marker);toolsSeen.push((body.tools??[]).map((t:any)=>({type:t.type,name:t.name,tools:t.tools?.map((v:any)=>v.name)})));
 const item=mode==='command'?{type:'function_call',id:'fc_probe',call_id:'call_probe',name:'exec_command',arguments:JSON.stringify({cmd:'printf ready > ready; sleep 3; printf BAD > result',yield_time_ms:1000,max_output_tokens:100})}:{type:'message',id:'msg_probe',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic provider response',annotations:[]}]};
 if(mode==='command'){mode='after-command';commandCalls++;}
 const events=[{type:'response.created',response:{id:'resp_probe',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_probe',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
 return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
}});
fs.writeFileSync(path.join(profile,'config.toml'),`model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local regression fixture"\nbase_url="http://127.0.0.1:${server.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
const options={binary,cwd:root,env:{HOME:root,CODEX_HOME:profile,PATH:'/usr/bin:/bin',TMPDIR:root}};
let rpc=new CodexAppServer(options),completed=0;const notifications:any[]=[];function observe(){rpc.on('notification',m=>{if(m.method==='turn/completed')completed++;if(['error','turn/completed'].includes(m.method))notifications.push(m);});rpc.on('request',m=>{rpc.respond(m.id,{decision:'decline'});});}
const result:any={scope:'Actual pinned native Codex app-server with a deterministic loopback Responses fixture, no account/model subscription; verifies native inference payload and shell cancellation',account_used:false,model_called:false};
async function until(p:()=>boolean){const end=Date.now()+15000;while(!p()){if(Date.now()>end)throw Error('Native flow timeout');await Bun.sleep(25);}}
try{
 observe();await rpc.start();const thread=await rpc.call('thread/start',{cwd:root,approvalPolicy:'on-request',sandbox:'workspace-write',developerInstructions:'Qoopia saved reference context: '+marker});
 await rpc.call('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'What is our next step?',text_elements:[]}]});await until(()=>completed===1);
 if(!seenContext)throw Error('Context absent in native inference request');result.context_in_native_inference_request=true;
 mode='command';await rpc.call('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Run synthetic cancellation command',text_elements:[]}]});await until(()=>fs.existsSync(path.join(root,'ready')));
 await rpc.stop();await Bun.sleep(3200);if(fs.existsSync(path.join(root,'result')))throw Error('Command outlived Stop');result.delayed_side_effect_absent=true;
 rpc=new CodexAppServer(options);observe();await rpc.start();await rpc.call('thread/resume',{threadId:thread.thread.id,cwd:root,approvalPolicy:'on-request',sandbox:'workspace-write',developerInstructions:'Qoopia saved reference context: '+marker});
 const before=completed;await rpc.call('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'New independent turn; do not repeat the interrupted command',text_elements:[]}]});await until(()=>completed>before);
 result.next_turn_completed=true;result.command_calls=commandCalls;result.no_command_replay=commandCalls===1&&!fs.existsSync(path.join(root,'result'));result.status='PASS';
}catch(e){result.status='FAIL';result.error=String(e);result.notifications=notifications;result.tools=toolsSeen;process.exitCode=1;}finally{await rpc.stop();server.stop(true);fs.rmSync(root,{recursive:true,force:true});result.cleaned=true;fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
