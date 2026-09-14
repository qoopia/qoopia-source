"""Render the real dashboard with synthetic API responses; no service or user data."""
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
import json,os,subprocess,mimetypes
root=Path(__file__).resolve().parents[2]
out=Path(os.environ['QOOPIA_LAYOUT_EVIDENCE']);out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True)
 try:
  context=browser.new_context(reduced_motion='reduce')
  def route(r):
   path=urlparse(r.request.url).path
   if path.startswith('/api/'):
    fixtures={'/api/dashboard/identity':{'linked':True},'/api/dashboard/agents':{'items':[]},'/api/dashboard/profile':{},'/api/dashboard/memory':{'model':{'state':'ready','runtime':'codex','model':'fixture'},'embedding':{'embedded':0,'total_notes':0},'sessions':{'summarized':0,'tracked':0},'busy':False}}
    r.fulfill(status=200 if path in fixtures else 404,json=fixtures.get(path,{}));return
   file=root/'src/public'/('dashboard.html' if path=='/dashboard' else path.lstrip('/'))
   if not file.is_file():r.fulfill(status=404);return
   body=file.read_bytes()
   if path=='/dashboard' and os.environ.get('QOOPIA_LAYOUT_BASELINE'):
    body=subprocess.check_output(['git','show',os.environ['QOOPIA_LAYOUT_BASELINE']+':src/public/dashboard.html'],cwd=root)
   r.fulfill(content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=body)
  context.route('**/*',route)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  for lang in ['en','ru']:
   for width in [390,760,860,861,894,900,901,1024,1100,1101,1280,1440]:
    page.set_viewport_size({'width':width,'height':1000})
    page.goto(f'https://fixture.test/dashboard?lang={lang}#memory')
    expect(page.locator('#memoryProvider')).to_be_visible();page.evaluate('document.fonts.ready')
    measured=page.locator('#memoryProvider,#memorySelect,#memoryLogin,#memoryCheck').evaluate_all('(es)=>es.map(e=>({id:e.id,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right,y:e.getBoundingClientRect().y,bottom:e.getBoundingClientRect().bottom,width:e.getBoundingClientRect().width}))')
    for e in measured:assert e['x']>=0 and e['right']<=width+1 and e['width']>=44,(lang,width,e)
    a,b=measured[:2];assert min(a['right'],b['right'])<=max(a['x'],b['x']) or min(a['bottom'],b['bottom'])<=max(a['y'],b['y']),(lang,width,'overlap')
    if width<=900:
     expect(page.locator('#navToggle')).to_be_visible();page.locator('#navToggle').click();expect(page.locator('#navToggle')).to_have_attribute('aria-expanded','true');page.keyboard.press('Escape');expect(page.locator('#navToggle')).to_have_attribute('aria-expanded','false')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    checks.append({'language':lang,'width':width,'controls':measured})
    if width in [390,894,901,1440]:page.locator('#main').screenshot(path=str(out/f'memory-{lang}-{width}.png'))
  assert not errors,errors
  (out/'browser-checks.json').write_text(json.dumps({'checks':checks,'page_errors':errors},indent=2));print(f'PASS: {len(checks)} viewport/language cases')
 finally:browser.close()
