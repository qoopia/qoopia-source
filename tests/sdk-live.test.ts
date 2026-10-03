import {expect,test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import {runMigrations} from '../src/db/migrate.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {startHttpServer} from '../src/http.ts';
import {QoopiaClient,QoopiaClientError} from '../sdk/typescript/src/index.ts';

// The SDK against the real /mcp route, not a JSON stub: Streamable HTTP answers with SSE.
test('the TypeScript SDK reads the live server reply and sends each call once [F-227, F-247]',async()=>{
  runMigrations();
  const workspace=createWorkspace({name:'SDK live',slug:'sdk-live-check'}),agent=createAgent({name:'sdk-live',workspaceSlug:workspace.slug});
  const server=startHttpServer();
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',()=>resolve()));
  const endpoint='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/mcp';
  let requests=0;
  const counting=(async(input:string|URL|Request,init?:RequestInit)=>{requests++;return fetch(input,init);}) as typeof fetch;
  try{
    const client=new QoopiaClient({endpoint,tokenProvider:()=>agent.api_key,fetch:counting});
    // The README example.
    expect(await client.recall({query:'release decision'})).toBeDefined();
    expect(requests).toBe(1);
    await client.brief();
    expect(requests).toBe(2);
    // A deterministic refusal surfaces its code once instead of being retried.
    const disabled=await client.recall({query:'release decision',latest_only:true}).catch(error=>error);
    expect(disabled).toBeInstanceOf(QoopiaClientError);expect((disabled as QoopiaClientError).code).toBe('FEATURE_DISABLED');
    expect(requests).toBe(3);
    const denied=await new QoopiaClient({endpoint,tokenProvider:()=>'q_not_a_key',fetch:counting}).brief().catch(error=>error);
    expect(denied).toBeInstanceOf(QoopiaClientError);expect((denied as QoopiaClientError).code).toBe(401);expect(String((denied as QoopiaClientError).message)).not.toContain('q_not_a_key');
    expect(requests).toBe(4);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
