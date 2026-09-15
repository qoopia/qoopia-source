// Synthetic HTTP fixtures only. Does not access user memory, OAuth or subscriptions.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const out=process.env.QOOPIA_PERF_OUTPUT||'work';fs.mkdirSync(out,{recursive:true});
let posts=[],operation=null,connections=[],tick=0,login=null;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');res.setHeader('cache-control','no-store');
 if(url.pathname==='/dashboard'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(fs.readFileSync('src/public/dashboard.html'));}
 if(url.pathname.startsWith('/brand/')){const f='src/public'+url.pathname;res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'image/svg+xml');return res.end(fs.existsSync(f)?fs.readFileSync(f):'');}
 res.setHeader('content-type','application/json');
 if(req.method==='POST'){
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));posts.push(body);
  if(url.pathname.endsWith('/memory')){if(body.action==='cancel-login'){login=null;return res.end('{}');}operation={state:'running',action:body.action};res.statusCode=202;return res.end('{"accepted":true}');}
  await new Promise(r=>setTimeout(r,600));
  if(body.action==='apply'){const c={id:'fixture-'+connections.length,surface:body.surface,access_mode:body.access_mode,mcp_url:'https://fixture.example/mcp',state:'requires_user_action',code:'CLIENT_CALL_REQUIRED',client_config:'on_this_computer'};connections.push(c);return res.end(JSON.stringify({connection:c}));}
  if(body.action==='client-auth-start'){connections[0].client_auth={code:'CLIENT_AUTH_STARTING'};setTimeout(()=>{connections[0].client_auth={code:'CLIENT_AUTHORIZATION_REQUIRED',open_url:'https://fixture.example/authorize'};},300);return res.end('{"code":"CLIENT_AUTH_STARTING"}');}
  if(body.action==='verify')return res.end('{"prompt":"Synthetic verification prompt"}');
  return res.end('{}');
 }
 let body={};if(url.pathname.endsWith('/memory'))body={model:{state:'selected',runtime:'claude_code'},embedding:{embedded:2,total_notes:3},sessions:{tracked:1,summarized:1},busy:operation?.state==='running'||!!login,operation,login};
 else if(url.pathname.endsWith('/connections'))body={workspace:'Synthetic workspace',stewards:[],clients:[],agents:[],memory_model:{state:'not_connected'}};
 else if(url.pathname.endsWith('/connection-setup'))body={connections,network:{code:'NETWORK_CONNECTING',enabled:true,device:{state:'active'},transport:{reachable:false,checked:++tick}}};
 else if(url.pathname.endsWith('/identity'))body={linked:true};
 res.end(JSON.stringify(body));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({headless:true});const results=[];
try{for(const width of [1440,390]){
 posts=[];operation=null;connections=[];login=null;
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/dashboard?lang=ru#work');await page.locator('#memorySelect').click();
 await page.waitForFunction(()=>document.querySelector('#memoryActionStatus').textContent.includes('Подготавливаем'));
 assert(await page.locator('#memoryCheck').isDisabled());assert(await page.locator('#memoryConnections').isEnabled());
 await page.locator('#memoryConnections').click();await page.locator('#setupApply').waitFor({state:'attached'});
 await page.locator('#setupNew summary').click();await page.locator('#setupSurface').selectOption('claude_desktop');await page.locator('#setupApply').click();
 assert.match(await page.locator('#setupFeedback').innerText(),/Выполняем/);assert(await page.locator('#setupApply').isDisabled());
 await page.locator('[data-client-auth]').waitFor();
 const stability=await page.evaluate(async()=>{const button=document.querySelector('[data-client-auth]');await new Promise(r=>setTimeout(r,5500));return button===document.querySelector('[data-client-auth]');});assert(stability);
 await page.locator('[data-client-auth]').click();await page.locator('a[href="https://fixture.example/authorize"]').waitFor({timeout:10000});
 assert.equal(posts.filter(p=>p.action==='apply').length,1);assert.equal(posts.filter(p=>p.action==='client-auth-start').length,1);
 assert(await page.locator('[data-connection]').innerText().then(t=>!t.includes('Вызов подтверждён')));
 await page.locator('[data-verify-connection]').click();await page.waitForFunction(()=>document.querySelector('[data-proof]').textContent.includes('Synthetic'));
 await page.screenshot({path:out+'/workflow-'+width+'.png',fullPage:true});
 operation=null;login={state:'waiting',url:'https://fixture.example/login'};await page.goto(origin+'/dashboard?lang=ru#work');await page.locator('#memoryLoginCode').fill('synthetic-code');
 await page.waitForTimeout(5500);assert.equal(await page.locator('#memoryLoginCode').inputValue(),'synthetic-code');
 assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 results.push({width,immediateFeedback:true,navigationWhilePreparing:true,stableMcpButtonsDuringNetworkPolling:stability,oauthLinkFromPolling:true,noFalseVerification:true,loginInputPreserved:true,errors});await page.close();
}fs.writeFileSync(out+'/workflow-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}
finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1});
