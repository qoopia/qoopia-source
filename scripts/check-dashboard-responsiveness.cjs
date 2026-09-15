const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict'),cp=require('node:child_process');
const source=fs.readFileSync('src/public/dashboard.html','utf8');
const prior=cp.execFileSync('git',['show',(process.env.QOOPIA_BASELINE_REF||'e250748e8f71383d89425ca6214cac6b21a2cfec')+':src/public/dashboard.html'],{encoding:'utf8'});
const out=process.env.QOOPIA_PERF_OUTPUT||'work';fs.mkdirSync(out,{recursive:true});
let posts=[],version='new',pending=false,slow=false,operation=null;
const state=()=>({configured:true,enabled:true,running:true,account:true,provider:'codex',selected_provider:null,conversations:[],runs:[],files:[],approvals:[],telegram:{verified:false,linked:false,username:'fixture_bot'},telegram_setup:{pending:pending?{user:{id:'123',chat:'123',name:'Synthetic user'}}:null},operation});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');res.setHeader('cache-control','no-store');
 if(url.pathname==='/dashboard'){res.setHeader('content-type','text/html');return res.end(version==='new'?source:prior);}
 if(url.pathname.startsWith('/brand/')){const f='src/public'+url.pathname;res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'image/svg+xml');return res.end(fs.existsSync(f)?fs.readFileSync(f):'');}
 res.setHeader('content-type','application/json');
 if(req.method==='POST'){let chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));posts.push(body);if(slow)await new Promise(r=>setTimeout(r,700));return res.end(JSON.stringify({ok:true}));}
 let body={};if(url.pathname.endsWith('/my-agent'))body=state();else if(url.pathname.endsWith('/identity'))body={linked:true};else if(url.pathname.endsWith('/agents'))body={agents:[]};
 res.end(JSON.stringify(body));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({headless:true});const results=[];
try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});console.log('viewport',width);
  version='old';pending=false;await page.goto(origin+'/dashboard?lang=ru#my-agent');await page.locator('#agentUseTelegram').waitFor({state:'attached'});await page.locator('#agentChannel summary').click();assert(await page.locator('#agentUseTelegram').isDisabled());
  version='new';await page.reload();await page.locator('#agentUseTelegram').waitFor({state:'attached'});await page.locator('#agentChannel summary').click();const start=Date.now();await page.locator('#agentUseTelegram').click();await page.waitForFunction(()=>document.activeElement.id==='telegramToken');const telegramFocusMs=Date.now()-start;assert(telegramFocusMs<500);
  pending=true;await page.locator('#telegramConfirmOwner').waitFor();
  const stable=await page.evaluate(async()=>{const button=document.querySelector('#telegramConfirmOwner');await new Promise(r=>setTimeout(r,1400));return button===document.querySelector('#telegramConfirmOwner');});assert(stable);
  slow=true;await page.locator('#telegramConfirmOwner').scrollIntoViewIfNeeded();const box=await page.locator('#telegramConfirmOwner').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(1200);await page.mouse.up();await page.waitForTimeout(60);assert.match(await page.locator('#agentFeedback').innerText(),/Выполняем/);await page.waitForTimeout(850);assert(posts.some(p=>p.action==='telegram-confirm'));slow=false;
  operation={action:'setup',state:'running'};await page.waitForFunction(()=>document.querySelector('#agentFeedback').textContent.includes('Подготавливаем'),{},{timeout:5000});assert.match(await page.locator('#agentFeedback').innerText(),/Подготавливаем/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${out}/dashboard-performance-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);results.push({width,telegramFocusMs,stableClickTarget:true,slowActionFeedback:true,backgroundPreparation:true,errors});operation=null;await page.close();
 }
 console.log(JSON.stringify(results,null,2));fs.writeFileSync(out+'/dashboard-browser-results.json',JSON.stringify(results,null,2));
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1});
