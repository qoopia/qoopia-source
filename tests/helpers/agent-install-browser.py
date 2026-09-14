"""Bounded local checks for release-bound installation tasks; never installs Qoopia."""
from pathlib import Path
from functools import partial
from threading import Thread
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[2]
out=root.parent/'outputs/agent-install-site-20260913';out.mkdir(exist_ok=True)
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(root/'marketing-site')))
Thread(target=server.serve_forever,daemon=True).start();checks=[];errors=[]
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch()
  try:
   context=browser.new_context(permissions=['clipboard-read','clipboard-write'])
   page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   origin=f'http://127.0.0.1:{server.server_port}'
   for width in [1280,390]:
    page.set_viewport_size({'width':width,'height':900})
    for lang in ['en','ru']:
     page.goto(origin+'/docs.html?lang='+lang+'#agent-install')
     expect(page.locator('#install-copy')).to_be_enabled()
     assert page.locator('#install-channel').input_value()=='stable'
     for channel in ['stable','candidate']:
      page.locator('#install-channel').select_option(channel)
      for client in ['codex','claude_code']:
       page.locator('#install-client').select_option(client)
       expect(page.locator('#install-copy')).to_be_enabled()
       text=page.locator('#install-prompt').input_value()
       release=json.loads((root/'marketing-site'/('release.json' if channel=='stable' else 'candidate-release.json')).read_text())
       assert release['source'] in text
       for package in release['packages'].values():
        assert package['url'] in text and package['sha256'] in text
       assert ('codex mcp login' in text)==(client=='codex')
       assert ('Установи Qoopia' in text)==(lang=='ru')
       assert all(s not in text for s in ['CLIENT_NAME','\ue000','/Users/askhatsoltanov','mcp.qoopia.ai'])
       page.locator('#install-copy').click()
       assert page.evaluate('navigator.clipboard.readText()')==text
       checks.append(f'{width}/{lang}/{channel}/{client}: pinned prompt and clipboard')
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
     page.locator('#agent-install').screenshot(path=str(out/f'agent-{width}-{lang}.png'))
   # Language changes without reload refresh task bytes as well as UI labels.
   page.locator('[data-language="en"]').click();expect(page.locator('#install-prompt')).to_have_value(__import__('re').compile('^Install Qoopia'))
   checks.append('language switch refreshes task')
   # Denied clipboard exposes a selected, readable fallback.
   page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('denied'))}})")
   page.locator('#install-copy').click();expect(page.locator('#install-preview')).to_have_attribute('open','')
   assert page.locator('#install-prompt').evaluate('(e)=>e.selectionEnd-e.selectionStart')==len(page.locator('#install-prompt').input_value())
   checks.append('clipboard denial selects fallback')
   # A missing or unsafe release must never leave a copyable stale prompt.
   for fixture in ['unavailable','unsafe']:
    bad=context.new_page()
    if fixture=='unavailable':bad.route('**/candidate-release.json',lambda r:r.fulfill(status=503,body='unavailable'))
    else:
     manifest=json.loads((root/'marketing-site/candidate-release.json').read_text());manifest['packages']['darwin-arm64']['url']='https://evil.invalid/install'
     bad.route('**/candidate-release.json',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(manifest)))
    bad.goto(origin+'/docs.html?lang=en&install=candidate#agent-install')
    expect(bad.locator('#install-release-status')).to_contain_text('Could not load')
    expect(bad.locator('#install-copy')).to_be_disabled();assert bad.locator('#install-prompt').input_value()==''
    bad.close();checks.append(f'{fixture} release refuses task')
   page.goto(origin+'/');expect(page.locator('#download-action a')).to_have_attribute('href',json.loads((root/'marketing-site/release.json').read_text())['packages']['mac']['url'] if page.locator('#platform').input_value()=='mac' else json.loads((root/'marketing-site/release.json').read_text())['packages']['linux']['url'])
   assert page.locator('a[href="docs.html#agent-install"]').count()==2
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   checks.append('home entry links and unchanged stable download')
   assert not errors,errors
   (out/'browser-checks.json').write_text(json.dumps({'status':'PASS','checks':checks,'page_errors':errors},indent=2))
   print(f'PASS: {len(checks)} checks; no page errors')
  finally:browser.close()
finally:server.shutdown();server.server_close()
