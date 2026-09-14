from pathlib import Path
import json,threading,http.server,functools
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2];out=root.parent/'outputs/analytics-launch-20260913';requests=[]
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(root/'marketing-site')));threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='chrome',headless=True)
  try:
   page=browser.new_page(viewport={'width':390,'height':844})
   page.route('https://auth.qoopia.ai/analytics/events',lambda route:(requests.append(json.loads(route.request.post_data)),route.fulfill(status=204,headers={'access-control-allow-origin':'*'})))
   page.goto('http://127.0.0.1:'+str(server.server_port)+'/');page.wait_for_load_state('networkidle')
   assert requests==[],'No events may leave before opt-in'
   page.locator('.site-analytics summary').click();page.locator('.site-analytics input').check();page.wait_for_timeout(100)
   assert len([x for x in requests if x['kind']=='site_view'])==1
   page.locator('#download-action a').evaluate('(link)=>link.addEventListener("click",event=>event.preventDefault())')
   page.locator('#download-action a').click(no_wait_after=True);page.wait_for_timeout(100)
   assert any(x['kind']=='download_click' for x in requests)
   for e in requests:assert not (set(e)&{'email','url','query','token','user_id','session_id'})
   page.locator('.site-analytics input').uncheck();before=len(requests);page.reload();page.wait_for_load_state('networkidle');assert len(requests)==before
   page.locator('.site-analytics summary').click();page.screenshot(path=str(out/'website-analytics-mobile.png'),full_page=False)
   protected=browser.new_context();protected.add_init_script("Object.defineProperty(navigator,'globalPrivacyControl',{get:()=>true}); localStorage.setItem('qoopia.site-analytics.v1','allow');")
   tab=protected.new_page();denied=[];tab.route('https://auth.qoopia.ai/**',lambda route:(denied.append(route.request.url),route.abort()));tab.goto('http://127.0.0.1:'+str(server.server_port)+'/');tab.wait_for_load_state('networkidle')
   expect(tab.locator('.site-analytics input')).to_be_disabled();assert denied==[]
   (out/'browser-checks.json').write_text(json.dumps({'status':'PASS','checks':['no request before opt-in','one page event after opt-in','download click collected','no content/identity/token fields','opt-out persists','GPC overrides stored opt-in'],'events_inspected':requests},indent=2))
  finally:browser.close()
finally:server.shutdown();server.server_close()
