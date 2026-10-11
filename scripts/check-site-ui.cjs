/* Isolated public site + WebKit mobile acceptance. No real account sign-in.
   QOOPIA_AXE_CORE=/abs/axe-core/axe.min.js also runs axe-core on every page. */
const {chromium,webkit}=require(process.env.QOOPIA_PLAYWRIGHT_MODULE||'playwright');const fs=require('node:fs');const assert=require('node:assert/strict');
const dir=require('node:path').resolve(process.argv[2]);const cfg=JSON.parse(fs.readFileSync(dir+'/preview.json'));
assert.equal(cfg.fixture,'qoopia-website-preview/1');assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
const axe=process.env.QOOPIA_AXE_CORE&&fs.readFileSync(process.env.QOOPIA_AXE_CORE,'utf8');
(async()=>{
 const results=[];
 for(const [name,engine,viewport] of [['desktop',chromium,{width:1440,height:1000}],['mobile',webkit,{width:390,height:844}]]){
  const browser=await engine.launch({headless:true});try{
   const context=await browser.newContext({viewport,locale:'en-US',reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   // CSP violations and failed requests surface as console errors; a missing page's own 404 is expected.
   page.on('console',m=>{if(m.type()==='error'&&!(/\/(missing|404\.html)$/.test(m.location().url)&&/status of 404/.test(m.text())))errors.push(page.url()+' '+m.text());});
   // WebKit screenshots inject a <style> that the page CSP rightly refuses; that is the tool, not the page.
   const shot=async options=>{const own=errors.length;await page.screenshot(options);await page.waitForTimeout(50);errors.length=own;};
   // The fixture supplies release metadata locally and never sends analytics.
   await page.route('https://auth.qoopia.ai/**',r=>r.fulfill({status:204,body:''}));
   for(const [route,lang] of [['/','en'],['/docs','en'],['/releases','en'],['/understand','en'],['/understand-ru','ru'],['/mobile','en'],['/404.html','en'],['/missing','en'],
    ['/ru/','ru'],['/ru/docs','ru'],['/ru/releases','ru'],['/ru/mobile','ru'],['/ru/missing','en'],['/profile','']]){
    await page.goto(cfg.url+route);await page.waitForLoadState('networkidle');await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode().catch(()=>{/* A broken image fails the broken-image assertion below. */});}));});
    assert.equal(new URL(page.url()).pathname,route,name+' stays on '+route);
    if(lang)assert.equal(await page.locator('html').getAttribute('lang'),lang,name+' lang '+route);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' overflow '+route);
    assert.equal(await page.locator('h1').count(),1,name+' single h1 '+route);
    assert.equal(await page.locator('img').evaluateAll(es=>es.some(e=>!e.complete||!e.naturalWidth)),false,name+' broken image '+route);
    if(route==='/'||route==='/ru/'){
     await page.locator('#download-action a').waitFor();assert.match(await page.locator('#download-action a').getAttribute('href'),/^https:\/\/github.com\/qoopia\/qoopia-downloads\//);
     assert((await page.locator('#platform').boundingBox()).height>=44,'platform touch target');await page.locator('#platform').selectOption('linux');assert.match(await page.locator('#download-action a').getAttribute('href'),/linux/);
     await shot({path:dir+'/'+name+'-hero-'+lang+'.png'});await shot({path:dir+'/'+name+'-home-'+lang+'.png',fullPage:true});
    }
    if(route==='/mobile')await shot({path:dir+'/'+name+'-iphone.png',fullPage:true});
    if(route==='/profile')await shot({path:dir+'/'+name+'-signin.png',fullPage:true});
    if(axe&&route!=='/profile'){const own=errors.length;await page.evaluate(axe);const violations=await page.evaluate(async()=>(await window.axe.run(document,{resultTypes:['violations']})).violations.map(v=>v.id+': '+v.nodes.map(n=>n.target.join(' ')).join(', ')));assert.deepEqual(violations,[],name+' axe '+route);errors.length=own;/* axe's own probes trip the CSP; they are not the page's errors */}
    results.push(name+' '+route);
   }
   // The switcher links to the translation and remembers the choice; ?lang= from older links still lands on the right page.
   const landed=address=>page.waitForFunction(expected=>location.pathname+location.hash===expected,address,{timeout:5000}).catch(()=>{throw Error(name+' expected '+address+' at '+page.url());});
   await page.goto(cfg.url+'/docs#privacy');await page.locator('.header [data-language="ru"]').click();await landed('/ru/docs');
   assert.equal(await page.locator('html').getAttribute('lang'),'ru');assert.equal(await page.locator('.header [data-language="ru"]').getAttribute('aria-current'),'page');
   await page.goto(cfg.url+'/releases');await landed('/ru/releases');
   await page.locator('.header [data-language="en"]').click();await landed('/releases');await page.goto(cfg.url+'/mobile');await landed('/mobile');
   await page.goto(cfg.url+'/?lang=ru#download');await landed('/ru/#download');
   await page.goto(cfg.url+'/ru/docs?lang=en');await landed('/docs');
   results.push(name+' language links');
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }
 fs.writeFileSync(dir+'/browser-results.json',JSON.stringify({passed:true,checks:results},null,2));console.log('Website Chromium/WebKit checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
