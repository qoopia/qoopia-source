// Synthetic HTTP fixtures only: the real dashboard page and assets, a fake My agent API. No user memory,
// subscriptions or Telegram. Checks that the Telegram channel setup answers at once, keeps its buttons
// stable under polling and shows feedback for slow actions, on a desktop and a phone.
//   PLAYWRIGHT_MODULE=/path/to/playwright node scripts/check-dashboard-responsiveness.cjs
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||process.env.QOOPIA_PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const out=process.env.QOOPIA_PERF_OUTPUT||'work';fs.mkdirSync(out,{recursive:true});
let posts=[],pending=false,slow=false,operation=null;
// No bot yet: the Telegram choice focuses the token field. A pending pairing: the bot is connected and
// the owner confirms the Telegram account that pressed Start.
const state=()=>({configured:true,enabled:true,running:true,account:true,provider:'codex',selected_provider:null,conversations:[],runs:[],files:[],approvals:[],
  telegram:pending?{username:'fixture_bot',verified:false,linked:false}:{},
  telegram_setup:pending?{pending:{url:'https://t.me/fixture_bot?start=synthetic',user:{id:'123',chat:'123',name:'Synthetic user'}}}:{},operation});
const types={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');res.setHeader('cache-control','no-store');
 if(url.pathname==='/dashboard'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(fs.readFileSync('src/public/dashboard.html'));}
 if(url.pathname.startsWith('/brand/')){const f='src/public'+url.pathname;res.setHeader('content-type',types[f.slice(f.lastIndexOf('.'))]||'text/plain');return res.end(fs.existsSync(f)?fs.readFileSync(f):'');}
 res.setHeader('content-type','application/json');
 if(req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);posts.push(JSON.parse(Buffer.concat(chunks)));if(slow)await new Promise(r=>setTimeout(r,700));return res.end('{"ok":true}');}
 let body={};if(url.pathname.endsWith('/my-agent'))body=state();else if(url.pathname.endsWith('/identity'))body={linked:true};else if(url.pathname.endsWith('/agents'))body={items:[]};
 else if(url.pathname.endsWith('/memory'))body={model:{state:'not_connected'},embedding:{embedded:0,total_notes:0},sessions:{tracked:0,summarized:0}};
 res.end(JSON.stringify(body));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({headless:true});const results=[];
try{
 for(const width of [1440,390,320]){
  posts=[];pending=false;slow=false;operation=null;
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<800,hasTouch:width<800}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});console.log('viewport',width);
  await page.goto(origin+'/dashboard?lang=ru#my-agent');await page.locator('#agentUseTelegram').waitFor({state:'attached'});await page.locator('#agentChannel summary').click();
  const start=Date.now();await page.locator('#agentUseTelegram').click();await page.waitForFunction(()=>document.activeElement?.id==='telegramToken');const telegramFocusMs=Date.now()-start;assert(telegramFocusMs<500,'Telegram token focus '+telegramFocusMs+' ms');
  if(width<800)assert.equal(await page.locator('#telegramToken').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=16),true,'token field must not zoom on iOS');
  pending=true;await page.locator('#telegramConfirmOwner').waitFor();
  // Polling must not replace the button under the owner's finger.
  const stable=await page.evaluate(async()=>{const button=document.querySelector('#telegramConfirmOwner');await new Promise(r=>setTimeout(r,1400));return button===document.querySelector('#telegramConfirmOwner');});assert(stable);
  slow=true;await page.locator('#telegramConfirmOwner').scrollIntoViewIfNeeded();const box=await page.locator('#telegramConfirmOwner').boundingBox();
  if(width<800)assert(box.height>=44,'confirm button touch target '+box.height);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(1200);await page.mouse.up();await page.waitForTimeout(60);
  assert.match(await page.locator('#agentFeedback').innerText(),/Выполняем/);await page.waitForTimeout(850);assert(posts.some(p=>p.action==='telegram-confirm'));slow=false;
  operation={action:'setup',state:'running'};await page.waitForFunction(()=>document.querySelector('#agentFeedback').textContent.includes('Подготавливаем'),null,{timeout:5000});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal scroll at '+width);
  await page.screenshot({path:`${out}/dashboard-performance-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);
  results.push({width,telegramFocusMs,stableClickTarget:true,slowActionFeedback:true,backgroundPreparation:true,errors});operation=null;await page.close();
 }
 console.log(JSON.stringify(results,null,2));fs.writeFileSync(out+'/dashboard-browser-results.json',JSON.stringify(results,null,2));
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1});
