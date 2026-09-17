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
actions=[];errors=[];held=[]
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
     else:r.fulfill(json=state)
    elif '/agents' in url:r.fulfill(json=[])
    elif '/memory' in url:r.fulfill(json={})
    elif '/profile' in url:r.fulfill(json={})
    else:r.fulfill(json={})
   elif url.startswith(base+'/dashboard'):
    r.fulfill(content_type='text/html',body=(root/'src/public/dashboard.html').read_text())
   else:r.continue_()
  page.route('**/*',route)
  page.goto(base+'/dashboard?lang=en#my-agent');page.wait_for_load_state('networkidle')
  page.locator('#agentUseTelegram').evaluate('e=>e.closest("details").open=true')
  expect(page.locator('#telegramRetry')).to_be_visible();page.locator('#telegramRetry').click()
  expect(page.locator('#telegramLink a')).to_have_attribute('href','https://t.me/qoopia_bot?start='+'a'*32)
  page.reload();page.wait_for_load_state('networkidle');page.locator('#agentUseTelegram').evaluate('e=>e.closest("details").open=true')
  expect(page.locator('#telegramLink a')).to_have_attribute('href','https://t.me/qoopia_bot?start='+'a'*32)
  page.locator('#agentUseTelegram').click();expect(page.locator('#telegramLink a')).to_be_focused()
  page.locator('#agentText').fill('Synthetic browser test');page.locator('#agentSend').click()
  expect(page.locator('#myAgent')).to_have_attribute('aria-busy','true')
  page.locator('#agentStop').click();expect(page.locator('#agentFeedback')).to_contain_text('Saved.')
  assert any(a['action']=='stop' for a in actions),actions
  assert held,'Send did not stay in flight'
  held.pop().fulfill(status=409,json={'error_description':'Task cancelled'})
  page.screenshot(path=str(out/'telegram-recovery-ui.png'),full_page=True)
  assert not errors,errors
  result={'status':'PASS','checks':['Expired pairing offers retry','Pairing URL survives page reload','Use Telegram focuses saved link','Stop is sent while another action is in flight'],'javascript_errors':errors,'environment':'Headless Chrome; real dashboard HTML with synthetic API responses, no real Telegram send'}
  (out/'browser-check.json').write_text(json.dumps(result,indent=2))
  print(json.dumps(result))
 finally:browser.close()
