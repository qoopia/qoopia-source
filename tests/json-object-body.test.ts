import {afterAll,beforeAll,expect,test} from 'bun:test';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {runMigrations} from '../src/db/migrate.ts';
import {startHttpServer} from '../src/http.ts';
import {parseJsonObject} from '../src/utils/http-json.ts';

let server:Server,base='';
beforeAll(async()=>{
  runMigrations();server=startHttpServer();
  if(!server.listening)await new Promise<void>(r=>server.once('listening',()=>r()));
  base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
});
afterAll(async()=>{server.closeAllConnections?.();await new Promise<void>(r=>server.close(()=>r()));});

test('only a JSON object parses; any other body is null for the caller to refuse',()=>{
  expect(parseJsonObject(Buffer.from('{"grant_type":"x","n":1}'))).toEqual({grant_type:'x',n:1});
  for(const body of ['','{','null','[]','[{"a":1}]','"x"','5','true'])expect(parseJsonObject(Buffer.from(body))).toBeNull();
});

test('a JSON token request must be an object; an object reaches the grant dispatch',async()=>{
  const token=(body:string)=>fetch(base+'/oauth/token',{method:'POST',headers:{'content-type':'application/json'},body}).then(async r=>[r.status,await r.json()]);
  for(const body of ['[{"grant_type":"refresh_token"}]','null','{'])expect(await token(body)).toEqual([400,{error:'invalid_request'}]);
  expect((await token('{"grant_type":"password"}'))[1]).toEqual({error:'unsupported_grant_type'});
});
