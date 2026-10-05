/* Run against scripts/dashboard-preview.ts synthetic workspace only. No live subscription calls.
   Usually through `bun run check:ui` (docs/qa/browser-checks.md); directly: node scripts/check-dashboard-ui.cjs PREVIEW_DIR */
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||process.env.QOOPIA_PLAYWRIGHT_MODULE||'playwright');const fs=require('fs');const assert=require('node:assert/strict');
if(!process.argv[2])throw Error('Pass the isolated directory created by scripts/dashboard-preview.ts');
const dir=require('node:path').resolve(process.argv[2]);const config=JSON.parse(fs.readFileSync(dir+'/preview.json'));config.dir=dir;
if(config.fixture!=='qoopia-dashboard-preview/1'||new URL(config.url).hostname!=='127.0.0.1')throw Error('Only an isolated localhost dashboard preview is allowed');
// Every visible control a finger uses must be at least 44px tall and wide (a switch may extend its hit area with ::before),
// every text field at least 16px (smaller makes iOS zoom the page), and no page may scroll sideways.
function phoneAudit(){
 const problems=[],W=innerWidth;if(document.documentElement.scrollWidth>W)problems.push('horizontal scroll '+document.documentElement.scrollWidth+'>'+W);
 const name=e=>(e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+[...e.classList].join('.'))+' "'+(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,30)+'"';
 for(const e of document.querySelectorAll('button,select,textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),summary,[role=button],a.nav-item,a.btn')){
  const r=e.getBoundingClientRect(),cs=getComputedStyle(e);if(r.width<=1||r.height<=1||cs.visibility==='hidden'||e.closest('[hidden],dialog:not([open])'))continue;
  if(e.closest('details:not([open])')&&e.tagName!=='SUMMARY'&&!e.closest('details:not([open]) > summary'))continue;
  let h=r.height,w=r.width;const b=getComputedStyle(e,'::before');if(b.content!=='none'&&b.position==='absolute'){h+=-(parseFloat(b.top)||0)-(parseFloat(b.bottom)||0);w+=-(parseFloat(b.left)||0)-(parseFloat(b.right)||0);}
  if(h<43.5||w<43.5)problems.push('target '+Math.round(w)+'x'+Math.round(h)+' '+name(e));
  if(/INPUT|SELECT|TEXTAREA/.test(e.tagName)&&parseFloat(cs.fontSize)<16)problems.push('font '+cs.fontSize+' '+name(e));
 }
 return problems;
}
// Scrolled to the end, the floating to-top and Chat buttons must not sit on any control of the page.
async function floatingCover(){
 scrollTo(0,document.documentElement.scrollHeight);await new Promise(r=>setTimeout(r,350));
 const floats=[...document.querySelectorAll('.to-top.show,#chatLauncher')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none').map(e=>[e.id||e.className,e.getBoundingClientRect()]);
 const out=[];for(const e of document.querySelectorAll('#main button,#main a[href],#main input:not([type=hidden]),#main select,#main textarea,#main summary')){const r=e.getBoundingClientRect();if(r.width<=1||r.height<=1||!e.checkVisibility({checkVisibilityCSS:true}))continue; // closed <details> content keeps its box
  for(const [name,f] of floats)if(r.left<f.right&&r.right>f.left&&r.top<f.bottom&&r.bottom>f.top)out.push(name+' covers '+e.tagName.toLowerCase()+' "'+(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,30)+'"');}
 scrollTo(0,0);return out;
}
// The sweep loads every page eight times; the dashboard's per-address limit (200 requests a minute) may answer 429,
// which the session check waits out, hence the long first wait.
async function phoneSweep(browser,config,state,routes){
 const seen=[],failures=[],hits=[];
 // Stay under the per-address dashboard limit so the sweep measures layout, not 429 error boxes.
 const pace=async()=>{for(;;){const now=Date.now();while(hits.length&&hits[0]<now-60_000)hits.shift();if(hits.length<120)return;await new Promise(r=>setTimeout(r,hits[0]+60_000-now+50));}};
 for(const width of [320,390,430,768]){const context=await browser.newContext({serviceWorkers:'block',storageState:state,viewport:{width,height:800},isMobile:true,hasTouch:true});const page=await context.newPage();const errors=[],refused=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/dashboard'))hits.push(Date.now());});page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))refused.push(r.status()+' '+r.request().method()+' '+new URL(r.url()).pathname);});
  for(const lang of ['ru','en']){await pace();await page.goto(config.url+'/dashboard?lang='+lang+'#overview');await page.locator('.ov-tile').first().waitFor({timeout:75000}).catch(async e=>{await page.screenshot({path:config.dir+'/phone-failed.png'});throw Error('overview at '+width+' '+lang+': '+e.message+' refused='+refused.join(', '));});
   for(const route of routes){await pace();await page.evaluate(h=>{location.hash=h;},'#'+route);await page.waitForTimeout(700);failures.push(...(await page.evaluate(phoneAudit)).map(x=>width+' '+lang+' #'+route+': '+x));failures.push(...(await page.evaluate(floatingCover)).map(x=>width+' '+lang+' #'+route+': '+x));}
   // An agent's own page with its tabs and saves waiting for confirmation.
   await pace();await page.evaluate(()=>{location.hash='#agents';});await page.locator('.agent-card').first().waitFor({timeout:75000});// The agents board repaints on its poll; a tap that lands on a replaced card is retried.
   for(let attempt=0;;attempt++){await page.locator('.agent-card[data-id="'+config.agents.asking+'"]').click();if(await page.locator('#memorySaves article').waitFor({timeout:4000}).then(()=>true,()=>false))break;if(attempt===2)throw Error('agent page did not open at '+width+' '+lang);}await page.waitForTimeout(700);
   failures.push(...(await page.evaluate(phoneAudit)).map(x=>width+' '+lang+' agent page: '+x));
   // Every tab of the agent's page is on screen (no tab hidden behind a sideways scroll).
   failures.push(...(await page.locator('.tabs .tab').evaluateAll(tabs=>tabs.filter(t=>t.getBoundingClientRect().right>innerWidth+1).map(t=>'tab off screen "'+t.textContent.trim()+'"'))).map(x=>width+' '+lang+' agent page: '+x));
   // Opening the chat moves focus to its title for screen readers without drawing a focus ring.
   await page.locator('#chatLauncher').tap();await page.locator('#chatPanel').waitFor();
   if(await page.locator('#chatTitle').evaluate(e=>document.activeElement===e&&getComputedStyle(e).outlineStyle!=='none'))failures.push(width+' '+lang+': focus ring on the chat title');
   await page.locator('#chatClose').tap();
   await page.evaluate(()=>{location.hash='#overview';});await page.locator('#navToggle').click();await page.waitForTimeout(200);failures.push(...(await page.evaluate(phoneAudit)).map(x=>width+' '+lang+' open menu: '+x));
   const logout=await page.locator('#logoutBtn').boundingBox();assert(logout&&logout.y+logout.height<=800,'Logout reachable in the open menu at '+width);await page.locator('#navToggle').click();
   await page.screenshot({path:config.dir+'/phone-'+width+'-'+lang+'.png'});}
  assert.deepEqual(errors,[]);seen.push(width);await context.close();}
 assert.deepEqual([...new Set(failures)],[],'phone sweep');return seen;
}
(async()=>{const browser=await (process.env.QOOPIA_BROWSER==='webkit'?webkit:chromium).launch({headless:true});const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const login=await context.request.post(config.url+'/api/dashboard/local-login',{data:{code:config.code},headers:{Origin:config.url}});assert.equal(login.status(),200,'Fresh one-use preview login required');await context.storageState({path:dir+'/browser-state.json'});
 await page.goto(config.url+'/dashboard');await page.locator('.ov-tile').first().waitFor();await page.screenshot({path:dir+'/desktop-overview-en.png'});
 assert.equal(await page.locator('#nav [data-page]').count(),10);assert.equal(await page.locator('.nav-more').count(),0);
 await page.locator('#chatLauncher').click();await page.locator('#agentFirstProvider').waitFor();await page.screenshot({path:dir+'/desktop-setup-en.png'});assert.equal(await page.locator('[name=firstChannel]').count(),0);await page.locator('#chatClose').click();
 const routes=['agents','connections','agentcomm','skills','bridges','external','files','search','memory'];
 for(const route of routes){await page.locator('#nav a[href="#'+route+'"]').click();await page.waitForTimeout(450);assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,'overflow '+route);
  if(route==='connections'){await page.locator('#setupSurface option[value="muse_code"]').waitFor({state:'attached'});await page.locator('#setupSurface option[value="grok_bot"]').waitFor({state:'attached'});await page.locator('#setupNew summary').click();await page.locator('#setupSurface').selectOption('muse_code');await page.screenshot({path:dir+'/desktop-connections-en.png'});}}
 // Connections: a setup in progress (created today, no request yet) shows in the wizard; an application that
 // called at least once shows in the connected list from /api/dashboard/connections.
 const museId='11111111-1111-4111-8111-111111111111',grokId='22222222-2222-4222-8222-222222222222',now=()=>new Date().toISOString();
 const connectionFixtures=[{id:museId,agent_name:'Legacy Muse',surface:'muse_code',mcp_url:'https://fixture.example/mcp/muse',access_mode:'read',state:'requires_user_action',code:'CLIENT_CALL_REQUIRED',created_at:now(),last_seen:null,client_config:null},{id:grokId,surface:'grok_bot',mcp_url:'https://fixture.example/mcp/grok',access_mode:'read',state:'requires_user_action',code:'CLIENT_CALL_REQUIRED',created_at:now(),last_seen:null,client_config:null}];
 await page.route('**/api/dashboard/connection-setup',async route=>{if(route.request().method()!=='GET'){const input=route.request().postDataJSON();if(input.action==='label'&&input.id===museId){connectionFixtures[0].agent_name=input.agent_name;connectionFixtures[0].surface=input.surface||connectionFixtures[0].surface;return route.fulfill({json:{connection:connectionFixtures[0],memory_preserved:true}});}return route.continue();}const response=await route.fetch(),body=await response.json();body.connections.push(...connectionFixtures);await route.fulfill({response,json:body});});
 const seen=now(),old=new Date(Date.now()-40*86400000).toISOString();let connectionOverviewPolls=0;
 await page.route('**/api/dashboard/connections',async route=>{const response=await route.fetch(),body=await response.json();connectionOverviewPolls++;
  body.apps=[{kind:'connection',id:'c-claude',surface:'claude_code',client:null,agent_id:'a1',name:'Qoopia Claude memory',last_seen:seen,authorized:1},{kind:'oauth',id:'gpt',surface:null,client:'ChatGPT',agent_id:'gpt',name:'GPT',last_seen:seen,authorized:1},
   {kind:'oauth',id:'old-claude',surface:null,client:'Claude',agent_id:'old-claude',name:'Claude',last_seen:old,authorized:1},{kind:'connection',id:'c-desk',surface:'claude_desktop',client:null,agent_id:'a2',name:'Desk',last_seen:seen,authorized:0},
   {kind:'connection',id:'c-never',surface:'codex',client:null,agent_id:'a3',name:'Never called',last_seen:null,authorized:1}];await route.fulfill({response,json:body});});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:config.url});
 await page.locator('#nav a[href="#connections"]').click();await page.locator('[data-copy-setup="'+museId+'"]').waitFor({state:'attached'});
 assert.equal(await page.locator('#connectedApplications .connection-line').count(),4,'only applications that called at least once are listed');
 assert.match(await page.locator('#connectedApplications').innerText(),/Not used for 40 days/);assert.match(await page.locator('#connectedApplications').innerText(),/Sign in again in the application/);
 assert.equal(await page.locator('[data-connection="'+museId+'"] .connection-state').innerText(),'Waiting for the agent’s first request');
 assert.equal(await page.locator('[data-connection-drafts]').count(),0,'pending connections remain visible');
 assert.equal(await page.locator('[data-connection="'+grokId+'"] > summary').isVisible(),true);
 await page.locator('[data-connection="'+museId+'"] > summary').click();await page.locator('[data-copy-setup="'+museId+'"]').click();
 const copiedMuse=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));assert.equal(copiedMuse.mcpServers['qoopia_'+museId.replaceAll('-','')].url,connectionFixtures[0].mcp_url);
 assert.equal(Object.keys(copiedMuse.mcpServers).length,1);assert.equal(await page.locator('[data-connection="'+museId+'"] code').textContent(),'muse mcp login qoopia_'+museId.replaceAll('-',''));
 await page.locator('[data-connection="'+grokId+'"] > summary').click();await page.locator('[data-copy-request="'+grokId+'"]').click();await page.locator('#setupFeedback').filter({hasText:'Request copied.'}).waitFor();assert((await page.evaluate(()=>navigator.clipboard.readText())).includes(connectionFixtures[1].mcp_url));
 // The agent's first protocol call moves the setup to Connected by background polling; no verification code.
 const beforePoll=connectionOverviewPolls;Object.assign(connectionFixtures[1],{state:'ready',code:null,last_seen:now(),verified_at:now()});
 await page.locator('#setupFeedback').filter({hasText:'Connected. Your agent can use Qoopia.'}).waitFor({timeout:15000});
 assert.equal(await page.locator('#setupConnections [data-connection="'+grokId+'"]').count(),0,'a connected setup leaves the in-progress list');
 assert(connectionOverviewPolls>beforePoll,'the connected list refreshes during background polling');assert.equal(await page.locator('[data-verify-connection]').count(),0);
 await page.locator('#setupNew summary').click();await page.locator('#setupSurface').selectOption('codex');const applied=page.waitForResponse(r=>r.url().includes('/connection-setup')&&r.request().method()==='POST'&&r.request().postDataJSON()?.action==='apply');await page.locator('#setupApply').click();const createdId=(await (await applied).json()).connection.id;
 const newDraft=page.locator('[data-connection="'+createdId+'"]');await newDraft.locator('[data-copy-request]').waitFor();
assert(await newDraft.evaluate(e=>e.open),'new connection details open');
 assert(await newDraft.locator(':scope > summary').evaluate(e=>document.activeElement===e),'new connection receives keyboard focus');
 await newDraft.locator('[data-copy-request]').click();assert((await page.evaluate(()=>navigator.clipboard.readText())).includes('qoopia_protocol'));
 await page.screenshot({path:dir+'/desktop-connection-instructions-en.png'});
 await page.locator('.topbar [data-language="ru"]').click();await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-connection="'+museId+'"] .connection-state').innerText(),'Ждём первый запрос агента');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,'mobile connections overflow');await page.screenshot({path:dir+'/mobile-connections-ru.png'});
 await page.setViewportSize({width:1440,height:1000});await page.locator('.topbar [data-language="en"]').click();
 const proposal=new URL(config.url+'/dashboard');proposal.hash='connections';
 const proposalFields={connect:'muse_app',agent:'FIBI',access:'read_write',workspace:config.workspace};
 for(const [key,value] of Object.entries(proposalFields))proposal.searchParams.set(key,value);
 let proposalWrites=0;const countWrite=request=>{if(request.method()==='POST'&&request.url().includes('/connection-setup'))proposalWrites++;};page.on('request',countWrite);
 await page.goto(proposal.href);await page.locator('#setupAgentName').waitFor();await page.waitForFunction(()=>document.querySelector('#setupAgentName')?.value==='FIBI');
 assert.equal(await page.locator('#setupSurface').inputValue(),'muse_app');assert.equal(await page.locator('#setupAccess').inputValue(),'read_write');assert.equal(proposalWrites,0,'review link never grants access');
 assert.equal(new URL(page.url()).searchParams.has('connect'),false,'proposal consumed once');
 await page.screenshot({path:dir+'/desktop-muse-review-en.png'});
 proposal.searchParams.set('connection',museId);await page.goto(proposal.href);await page.waitForFunction(()=>document.querySelector('[data-label-name="11111111-1111-4111-8111-111111111111"]')?.value==='FIBI');
 assert.equal(proposalWrites,0);await page.locator('[data-label-connection="'+museId+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-connection="11111111-1111-4111-8111-111111111111"] summary')?.textContent.includes('FIBI · Muse.app'));
 assert.equal(proposalWrites,1);await page.locator('[data-copy-request="'+museId+'"]').click();await page.locator('#setupFeedback').filter({hasText:'Request copied.'}).waitFor();const cloudRequest=await page.evaluate(()=>navigator.clipboard.readText());assert(cloudRequest.includes('FIBI'));assert(cloudRequest.includes(connectionFixtures[0].mcp_url));assert(!cloudRequest.includes('muse mcp login'));assert(!cloudRequest.includes('settings.json'));assert(cloudRequest.includes('qoopia_protocol'));assert(!cloudRequest.includes('challenge'));assert.equal(proposalWrites,1);
 assert.equal(await page.locator('[data-verify-connection]').count(),0);
 await page.locator('.topbar [data-language="ru"]').click();await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,'mobile Muse name and setup overflow');await page.screenshot({path:dir+'/mobile-muse-app-ru.png'});
 await page.setViewportSize({width:1440,height:1000});await page.locator('.topbar [data-language="en"]').click();
 proposal.searchParams.set('workspace','wrong-workspace');await page.goto(proposal.href);await page.locator('#setupFeedback').filter({hasText:'does not match your workspace'}).waitFor();assert.equal(await page.locator('#setupAgentName').inputValue(),'');
 proposal.searchParams.set('workspace',config.workspace);proposal.searchParams.set('connection','bad"selector');await page.goto(proposal.href);await page.locator('#setupFeedback').filter({hasText:'invalid settings'}).waitFor();
 page.off('request',countWrite);
 await page.unroute('**/api/dashboard/connections');await page.unroute('**/api/dashboard/connection-setup');

 // Mock only the managed-agent endpoint; all other routes above use the real isolated server.
 let agent={configured:true,provider:'codex',account:true,running:true,model:null,selected:'11111111-1111-4111-8111-111111111111',selected_provider:'codex',conversations:[{id:'11111111-1111-4111-8111-111111111111',title:'Dashboard redesign',provider:'codex'}],runs:[{id:'r1',prompt:'Как идёт обновление интерфейса?',answer:'Готовлю компактный дашборд. Чат остаётся рядом на любой странице, а контекст разговора сохраняется.',state:'completed',created_at:new Date().toISOString()}],approvals:[],files:[],telegram:{},active_conversation:null};let posts=[];
 await page.route('**/api/dashboard/my-agent*',async route=>{let r=route.request();if(r.method()==='POST'){let b=r.postDataJSON();posts.push(b);if(b.action==='model')agent.model=b.model;if(b.action==='send')agent.runs.push({id:'r2',prompt:b.text,answer:'Готово.',state:'completed',created_at:new Date().toISOString()});await route.fulfill({json:b.action==='models'?{models:[{id:'test-model',name:'Synthetic test model'}]}:{ok:true}});}else await route.fulfill({json:agent});});
 await page.locator('#chatLauncher').click();await page.locator('#agentModel').waitFor();await page.locator('#agentText').fill('Keep this draft');
 await page.locator('#nav a[href="#overview"]').click();await page.waitForTimeout(500);assert.equal(await page.locator('#agentText').inputValue(),'Keep this draft');
 await page.locator('#chatClose').click();await page.locator('#chatLauncher').click();assert.equal(await page.locator('#agentText').inputValue(),'Keep this draft');
 await page.locator('#agentModelsLoad').click();await page.locator('#agentModel option[value="test-model"]').waitFor({state:'attached'});await page.locator('#agentModel').selectOption('test-model');await page.waitForTimeout(400);assert(posts.some(b=>b.action==='model'&&b.model==='test-model'));
 await page.locator('#agentText').fill('Проверка чата');await page.locator('#agentSend').click();await page.waitForTimeout(500);assert.equal(await page.locator('#agentText').inputValue(),'');assert(posts.some(b=>b.action==='send'&&b.text==='Проверка чата'));
 await page.locator('.topbar [data-language="ru"]').click();await page.waitForTimeout(100);await page.screenshot({path:dir+'/desktop-chat-ru.png'});
 let bubs=await page.locator('.chat-bubble').evaluateAll(es=>es.slice(0,2).map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,fill:getComputedStyle(e).backgroundColor})));assert(bubs[0].right>bubs[1].right,'user right aligned');assert.notEqual(bubs[0].fill,bubs[1].fill);
 await page.locator('#chatExpand').click();assert.equal(await page.locator('#chatExpand').getAttribute('aria-pressed'),'true');await page.locator('#chatExpand').click();
 await page.locator('#agentText').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#chatPanel').isVisible(),false);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:dir+'/mobile-overview-ru.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert((await page.locator('.ov-tile').count())>0);assert.equal(await page.locator('.ov-tile').evaluateAll(es=>es.some(e=>e.getBoundingClientRect().right>innerWidth-8)),false,'mobile stats clipped');await page.locator('#chatLauncher').click();assert(await page.locator('#chatPanel select').evaluateAll(es=>es.filter(e=>e.offsetHeight).every(e=>e.getBoundingClientRect().height>=44)),'mobile select touch targets');await page.screenshot({path:dir+'/mobile-chat-ru.png'});assert.equal(await page.locator('#chatPanel').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
 agent={...agent,active_conversation:agent.selected,approvals:[{id:'approval',method:'item/commandExecution/requestApproval',params:{reason:'Synthetic approval fixture',command:'printf test'},expires:Date.now()+60000}]};await page.waitForTimeout(1700);await page.locator('[data-approval="approval"]').first().waitFor();assert.equal(await page.locator('#agentStop').isVisible(),true);
 await page.locator('#chatClose').click();
 for(const route of routes){await page.locator('#navToggle').click();await page.locator('#nav a[href="#'+route+'"]').click();await page.waitForTimeout(300);assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,'mobile overflow '+route);}
 await page.locator('#navToggle').click();await page.locator('#profileLink').click();
 assert.equal(await page.locator('#main h1').innerText(),'Профиль');
 assert.equal(new URL(page.url()).hash,'#profile');assert.equal(context.pages().length,1,'profile opened a second tab');
 assert.equal(await page.locator('#main').evaluate(e=>e.scrollWidth>e.clientWidth+1),false,'mobile overflow profile');
 // Phone and tablet sweep on every page, RU and EN: no horizontal scroll, 44px touch targets, 16px fields (no iOS zoom).
 await page.goto('about:blank'); // its polling would spend the shared rate limit
 const phone=await phoneSweep(browser,config,dir+'/browser-state.json',[...routes,'overview','profile']);
 await page.goto(config.url+'/dashboard?lang=ru#overview');await page.locator('.ov-tile').first().waitFor({timeout:75000});
 await page.setViewportSize({width:1440,height:1000});await page.locator('#logoutBtn').click();await page.locator('#loginView').waitFor({state:'visible'});assert.equal(await page.locator('#chatPanel').isVisible(),false);assert.equal(await page.locator('#chatBody').innerText(),'');
 const appBrowser=await chromium.launch({headless:true});const appContext=await appBrowser.newContext({viewport:{width:390,height:844}});const app=await appContext.newPage();await app.goto(config.url+'/dashboard');await app.evaluate(()=>navigator.serviceWorker.ready);await app.reload();const cached=await app.evaluate(async()=>{const keys=await caches.keys();return (await Promise.all(keys.filter(k=>k.startsWith('qoopia-offline-')).map(async k=>(await(await caches.open(k)).keys()).map(r=>new URL(r.url).pathname)))).flat();});assert.deepEqual([...new Set(cached)],['/offline','/brand/Manrope.ttf']);const manifest=await(await appContext.request.get(config.url+'/manifest.webmanifest')).json();assert.equal(manifest.start_url,'/dashboard?app=1');await appContext.setOffline(true);await app.reload();await app.getByRole('heading',{name:'Let’s reconnect.'}).waitFor();await app.evaluate(()=>document.fonts.ready);assert.equal(await app.evaluate(()=>document.fonts.check('16px Manrope')),true);await app.screenshot({path:dir+'/mobile-offline.png'});await appContext.setOffline(false);await app.reload();await app.locator('#loginView').waitFor({state:'visible'});await appContext.close();await appBrowser.close();assert.deepEqual(errors,[]);fs.writeFileSync(dir+'/browser-results.json',JSON.stringify({passed:true,dashboardEngine:process.env.QOOPIA_BROWSER||'chromium',offlineEngine:'chromium',routes,phone,checks:['phone sweep 320/390/430/768','overview default','flat menu','inline setup','draft persists across routes and minimize','model selection POST','send and bubble alignment','RU/EN','desktop/mobile overflow','profile stays in dashboard','expand and Escape','approval/Stop','logout cleanup','install manifest','private data absent from cache','offline and reconnect'],errors},null,2));console.log('Browser checks passed');await browser.close();})().catch(e=>{console.error(e);process.exit(1)});
