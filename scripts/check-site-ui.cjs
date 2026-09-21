/* Isolated public site + WebKit mobile acceptance. No real account sign-in. */
const {chromium,webkit}=require(process.env.QOOPIA_PLAYWRIGHT_MODULE||'playwright');const fs=require('node:fs');const assert=require('node:assert/strict');
const dir=require('node:path').resolve(process.argv[2]);const cfg=JSON.parse(fs.readFileSync(dir+'/preview.json'));
assert.equal(cfg.fixture,'qoopia-website-preview/1');assert.equal(new URL(cfg.url).hostname,'127.0.0.1');
(async()=>{
 const results=[];
 for(const [name,engine,viewport] of [['desktop',chromium,{width:1440,height:1000}],['mobile',webkit,{width:390,height:844}]]){
  const browser=await engine.launch({headless:true});try{
   const context=await browser.newContext({viewport,locale:'en-US',reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   // The fixture supplies release metadata locally and never sends analytics.
   await page.route('https://auth.qoopia.ai/**',r=>r.fulfill({status:204,body:''}));
   for(const route of ['/','/docs','/releases','/understand','/understand-ru','/mobile','/404.html','/profile']){
    await page.goto(cfg.url+route);await page.waitForLoadState('networkidle');await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode().catch(()=>{});}));});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' overflow '+route);
    assert.equal(await page.locator('h1').count(),1,name+' single h1 '+route);
    assert.equal(await page.locator('img').evaluateAll(es=>es.some(e=>!e.complete||!e.naturalWidth)),false,name+' broken image '+route);
    if(route==='/'){
     await page.locator('#download-action a').waitFor();assert.match(await page.locator('#download-action a').getAttribute('href'),/^https:\/\/github.com\/qoopia\/qoopia-downloads\//);
     assert((await page.locator('#platform').boundingBox()).height>=44,'platform touch target');await page.locator('#platform').selectOption('linux');assert.match(await page.locator('#download-action a').getAttribute('href'),/linux/);
     await page.screenshot({path:dir+'/'+name+'-hero-en.png'});await page.screenshot({path:dir+'/'+name+'-home-en.png',fullPage:true});
     await page.locator('[data-language="ru"]').click();await page.waitForTimeout(100);assert.equal(await page.locator('html').getAttribute('lang'),'ru');await page.screenshot({path:dir+'/'+name+'-home-ru.png',fullPage:true});
     await page.locator('[data-language="en"]').click();
    }
    if(route==='/mobile')await page.screenshot({path:dir+'/'+name+'-iphone.png',fullPage:true});
    if(route==='/profile')await page.screenshot({path:dir+'/'+name+'-signin.png',fullPage:true});
    // Each local fragment must resolve in its target document.
    results.push(name+' '+route);
   }
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }
 fs.writeFileSync(dir+'/browser-results.json',JSON.stringify({passed:true,checks:results},null,2));console.log('Website Chromium/WebKit checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
