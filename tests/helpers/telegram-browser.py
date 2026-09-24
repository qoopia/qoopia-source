from pathlib import Path
from playwright.sync_api import sync_playwright,expect
import json,argparse
parser=argparse.ArgumentParser(description='Synthetic Telegram dashboard regression; no real API actions')
parser.add_argument('--base',required=True,help='Loopback fixture origin')
parser.add_argument('--out',required=True,help='Evidence directory')
args=parser.parse_args()
from urllib.parse import urlparse
origin=urlparse(args.base)
assert origin.scheme=='http' and origin.hostname=='127.0.0.1' and origin.port
base=args.base.rstrip('/')
root=Path(__file__).resolve().parents[2]
out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
state={'configured':True,'enabled':True,'running':True,'account':True,'provider':'codex','conversations':[],'runs':[],'approvals':[],'files':[],'telegram':{'username':'qoopia_bot','linked':False,'verified':False},'telegram_setup':{'pending':None,'expired':True,'queued':0},'selected':None,'active_conversation':None}
actions=[];errors=[];held=[];reads=[]
with sync_playwright() as p:
 browser=p.chromium.launch(channel='chrome',headless=True)
 try:
  page=browser.new_page(viewport={'width':1280,'height':950})
  page.on('pageerror',lambda e:errors.append(str(e)))
  def route(r):
   url=r.request.url
   if '/api/dashboard/' in url:
    if '/identity' in url:r.fulfill(status=404,json={})
    elif '/my-agent' in url:
     if r.request.method=='POST':
      body=r.request.post_data_json;actions.append(body)
      if body['action']=='telegram-retry':
       state['telegram_setup']={'pending':{'url':'https://t.me/qoopia_bot?start='+'a'*32,'user':None},'expired':False,'queued':0};r.fulfill(json={})
      elif body['action']=='new':r.fulfill(json={'id':'fixture-conversation'})
      elif body['action']=='send':held.append(r)
      else:r.fulfill(json={})
     else:reads.append(url);r.fulfill(json=state)
    elif '/agents' in url:r.fulfill(json=[])
    elif '/memory' in url:r.fulfill(json={})
    elif '/profile' in url:r.fulfill(json={'email':'owner@example.test'})
    else:r.fulfill(json={})
   elif url.startswith(base+'/dashboard'):
    r.fulfill(content_type='text/html',body=(root/'src/public/dashboard.html').read_text())
   else:r.continue_()
  page.route('**/*',route)
  page.goto(base+'/dashboard?lang=en#my-agent');page.wait_for_load_state('networkidle')
  assert reads and all('files=0' in url for url in reads),reads
  page.locator('#agentFileDetails summary').click()
  expect(page.locator('#agentFileDetails')).to_have_attribute('open','')
  expect(page.locator('#agentFileStatus')).to_contain_text('No files in this folder yet.')
  assert any('files=1' in url for url in reads),reads
  page.locator('#agentUseTelegram').evaluate('e=>e.closest("details").open=true')
  expect(page.locator('#telegramRetry')).to_be_visible();page.locator('#telegramRetry').click()
  expect(page.locator('#telegramLink a')).to_have_attribute('href','https://t.me/qoopia_bot?start='+'a'*32)
  page.reload();page.wait_for_load_state('networkidle');page.locator('#agentUseTelegram').evaluate('e=>e.closest("details").open=true')
  expect(page.locator('#telegramLink a')).to_have_attribute('href','https://t.me/qoopia_bot?start='+'a'*32)
  page.locator('#agentUseTelegram').click();expect(page.locator('#telegramLink a')).to_be_focused()
  page.locator('#agentText').fill('Synthetic browser test');page.locator('#agentSend').click()
  expect(page.locator('#myAgent')).to_have_attribute('aria-busy','true')
  state['selected']='fixture-conversation';state['selected_title']='Synthetic browser test';state['active_conversation']='fixture-conversation';state['progress']='commandExecution'
  state['conversations']=[{'id':'fixture-conversation','title':'Synthetic browser test','provider':'codex'}]
  state['runs']=[{'id':'fixture-run','prompt':'Synthetic browser test','answer':'','state':'running','created_at':'2026-09-22T00:00:00Z'}]
  expect(page.locator('#agentProgress')).to_contain_text('Running a command',timeout=5000)
  page.locator('#agentStop').click();expect(page.locator('#agentFeedback')).to_contain_text('Saved.')
  assert any(a['action']=='stop' for a in actions),actions
  assert held,'Send did not stay in flight'
  held.pop().fulfill(status=409,json={'error_description':'Task cancelled'})
  page.screenshot(path=str(out/'telegram-recovery-ui.png'),full_page=True)
  mobile=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
  mobile.on('pageerror',lambda e:errors.append(str(e)))
  mobile.route('**/*',route)
  mobile.goto(base+'/dashboard?lang=en#overview');mobile.wait_for_load_state('networkidle')
  mobile.locator('#chatLauncher').click()
  expect(mobile.locator('#chatPanel')).to_be_visible()
  assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile page overflows horizontally'
  mobile.screenshot(path=str(out/'telegram-mobile-ui.png'),full_page=True)
  mobile.locator('#chatClose').click()
  mobile.locator('#navToggle').click()
  mobile.locator('#profileLink').click()
  expect(mobile.locator('#main h1')).to_have_text('Profile')
  expect(mobile.locator('.profile-details')).to_contain_text('owner@example.test')
  assert mobile.url.startswith(base+'/dashboard?lang=en#profile'),mobile.url
  assert len(mobile.context.pages)==1,'Profile opened a separate account tab'
  assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile profile overflows horizontally'
  mobile.screenshot(path=str(out/'profile-mobile-ui.png'),full_page=True)
  assert not errors,errors
  result={'status':'PASS','checks':['Agent files load only when opened','Expired pairing offers retry','Pairing URL survives page reload','Use Telegram focuses saved link','In-flight Send still refreshes agent progress','Stop is sent while another action is in flight','Mobile chat has no horizontal page overflow','Mobile Profile stays in the signed-in dashboard without a second account tab'],'javascript_errors':errors,'environment':'Headless Chrome; real dashboard HTML with synthetic API responses, no real Telegram send'}
  (out/'browser-check.json').write_text(json.dumps(result,indent=2))
  print(json.dumps(result))
 finally:browser.close()
