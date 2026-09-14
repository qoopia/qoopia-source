import { expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, DB_PATH } from '../src/db/connection.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapOwner } from '../src/auth/pairings.ts';
import { connectInstalled } from '../src/delivery/connect.ts';
import { functionalDiagnostic } from '../src/delivery/functional-diagnostic.ts';
import { PRODUCT_VERSION } from '../src/utils/product-version.ts';

const build='a'.repeat(40),bundle='b'.repeat(64);

async function fixture() {
  runMigrations();fs.chmodSync(DB_PATH,0o600);
  const outer=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-t27-'))),root=path.join(outer,'installation');fs.mkdirSync(root,{mode:0o700});
  const workspace=randomUUID();db.query('INSERT INTO workspaces(id,name,slug) VALUES (?,?,?)').run(workspace,'T27 fixture',workspace);
  const owner=bootstrapOwner(db,'T27 owner',undefined,workspace),instance=(db.query("SELECT instance_id FROM authority_instance WHERE id='local'").get() as {instance_id:string}).instance_id;
  let identityInstance=instance,authAllowed=true,writes=0,noteId='',text='';
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/health') {res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',version:PRODUCT_VERSION,release_sha:build,build_commit:build,schema_version:37,server_role:'canonical',instance_id:identityInstance,writes_enabled:true}));return;}
    if(req.url!=='/mcp'){res.statusCode=404;res.end();return;}
    if(!authAllowed){res.statusCode=401;res.end('{"error":"unauthorized"}');return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const rpc=JSON.parse(Buffer.concat(chunks).toString());
    const name=rpc.params?.name,args=rpc.params?.arguments??{};let value:unknown;
    if(name==='qoopia_capabilities')value={profile:'memory-worker',config_digest:'c'.repeat(64)};
    else if(name==='note_create'){writes++;noteId=randomUUID();text=args.text;value={id:noteId};}
    else if(name==='note_get')value={id:noteId,text};
    else if(name==='recall')value={results:[{id:noteId,text}]};
    else value={};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(value)}]}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
  const home=path.join(outer,'config');fs.mkdirSync(home,{mode:0o700});const config=path.join(home,'mcp.json');
  const context={root,instance,bundle,generation:'generation-'+randomUUID(),port};
  const input={runtime:'claude_code' as const,config,name:'T27 diagnostic principal',ownerId:owner.agent_id};
  const preview=await connectInstalled(input,context) as {preview_digest:string};
  const connected=await connectInstalled(input,context,preview.preview_digest) as {connection:unknown};
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({format:'qoopia-installation/1',...context,bundle_digest:bundle,root:undefined}),{mode:0o600});
  return {outer,root,instance,port,connection:connected.connection,server,setInstance:(v:string)=>{identityInstance=v;},setAuth:(v:boolean)=>{authAllowed=v;},writeCount:()=>writes,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(outer,{recursive:true,force:true});}};
}

test('T27 opt-in diagnostic validates identity and live auth before write, then writes, reads and recalls',async()=>{
  const f=await fixture();try{
    const input={runtime_kind:'claude_code' as const,connection:f.connection};
    const pointer=JSON.parse(fs.readFileSync(path.join(f.root,'current.json'),'utf8'));
    const expected={root:f.root,instance:f.instance,bundle,generation:pointer.generation,port:f.port,build,version:PRODUCT_VERSION,schema:37};
    f.setInstance('foreign');await expect(functionalDiagnostic(db,input,expected)).rejects.toThrow('LISTENER_IDENTITY');expect(f.writeCount()).toBe(0);
    f.setInstance(f.instance);f.setAuth(false);await expect(functionalDiagnostic(db,input,expected)).rejects.toThrow('LIVE_AUTH');expect(f.writeCount()).toBe(0);
    f.setAuth(true);const result=await functionalDiagnostic(db,input,expected);expect(result).toMatchObject({status:'PASS_FUNCTIONAL_DIAGNOSTIC',write:true,read_exact:true,recall_found:true,instance:f.instance,build});expect(f.writeCount()).toBe(1);expect(JSON.stringify(result)).not.toMatch(/Bearer|q_[A-Za-z0-9_-]{43}/);
  }finally{await f.close();}
});
