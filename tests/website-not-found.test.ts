import {test,expect} from 'bun:test';
import worker from '../marketing-site/_worker.js';

test('direct not-found routes return a real 404 with the custom page, without affecting normal assets',async()=>{
  const calls:Request[]=[];
  const env={ASSETS:{fetch:async(req:Request)=>{calls.push(req);return new Response('<h1>Page not found</h1>',{status:404,headers:{'content-type':'text/html'}});}}};
  for(const path of ['/404','/404.html']){
    const response=await worker.fetch(new Request('https://example.test'+path,{headers:{'if-none-match':'stale'}}),env);
    expect(response.status).toBe(404);expect(await response.text()).toContain('Page not found');
    expect(calls.at(-1)!.headers.has('if-none-match')).toBe(false);
  }
  const req=new Request('https://example.test/brand/Manrope.woff2');await worker.fetch(req,env);expect(calls.at(-1)).toBe(req);
});
