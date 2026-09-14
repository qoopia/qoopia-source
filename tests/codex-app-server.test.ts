import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexAppServer} from '../src/services/codex-app-server.ts';

test('private stdio preserves Unicode, routes approvals and rejects pending calls on exit',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-rpc-test-')),binary=path.join(root,'fixture');
  fs.writeFileSync(binary,'#!'+process.execPath+'\n'+`
    import {createInterface} from 'node:readline';
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const x=JSON.parse(line);
      if(x.method==='initialize')send({id:x.id,result:{userAgent:'fixture'}});
      if(x.method==='test/events'){
        const bytes=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'Привет'}})+'\\n');
        const offset=bytes.indexOf(Buffer.from('П'))+1;
        process.stdout.write(bytes.subarray(0,offset));setTimeout(()=>{process.stdout.write(bytes.subarray(offset));send({id:99,method:'item/commandExecution/requestApproval',params:{command:'fixture only'}});send({id:x.id,result:{ok:true}});},5);
      }
      if(x.method==='test/exit')process.exit(1);
    });
  `,{mode:0o700});
  const rpc=new CodexAppServer({binary,cwd:root,env:{PATH:path.dirname(process.execPath),HOME:root}});
  try{
    const notes:any[]=[],requests:any[]=[];rpc.on('notification',x=>notes.push(x));rpc.on('request',x=>requests.push(x));
    await rpc.start();expect(await rpc.call('test/events',{})).toEqual({ok:true});
    expect(notes[0].params.delta).toBe('Привет');expect(requests[0].id).toBe(99);
    rpc.respond(99,{decision:'decline'});
    await expect(rpc.call('test/exit',{})).rejects.toThrow('stopped');
  }finally{await rpc.stop();fs.rmSync(root,{recursive:true,force:true});}
});
