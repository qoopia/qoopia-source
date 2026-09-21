"""Real email proof and workspace session over an isolated fixture. No external email."""
import json,sys
from urllib.parse import urlparse
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
 browser=p.webkit.launch(headless=True)
 context=browser.new_context(viewport={'width':393,'height':852},is_mobile=True,has_touch=True,user_agent='Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1 Qoopia-iOS/2')
 def proxy(route):
  req=route.request;headers=req.all_headers();headers['x-fixture-url']=req.url
  # WebKit's intercepted requests omit Cookie here; forward only this page context's scoped cookies.
  headers['cookie']='; '.join(c['name']+'='+c['value'] for c in req.frame.page.context.cookies(req.url))
  response=transport.fetch('http://127.0.0.1:18973/proxy',method=req.method,headers=headers,data=req.post_data_buffer,fail_on_status_code=False)
  output={}
  for h in response.headers_array:
   if h['name'].lower() in ('content-length','transfer-encoding','content-encoding'):continue
   name=h['name'].lower();output[name]=output.get(name,'')+('\n' if name in output else '')+h['value']
  print(req.method,urlparse(req.url).hostname,urlparse(req.url).path,response.status,'cookie_names', [v.split('=')[0].strip() for v in headers.get('cookie','').split(';')], 'set_cookie_names', [h['value'].split('=')[0] for h in response.headers_array if h['name'].lower()=='set-cookie'],flush=True)
  route.fulfill(status=response.status,headers=output,body=response.body())
 transport=p.request.new_context()
 context.route('https://**/*',proxy)
 page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://auth.qoopia.ai/profile?app=ios');page.wait_for_load_state('networkidle')
 expect(page.get_by_role('heading',name='Sign in to Qoopia')).to_be_visible()
 page.screenshot(path=str(out/'email-entry.png'))
 page.locator('#email').fill('phone@example.test');page.locator('#app-signin button').click()
 expect(page.locator('#app-status')).to_contain_text('Open the latest email')
 expect(page.locator('#app-signin')).to_be_hidden()
 page.locator('#app-check').click()
 expect(page.locator('#app-status')).to_contain_text('not confirmed yet')
 # A rejected/stale email must never be presented as successful or silently ignored.
 rejected=browser.new_context();rejected.route('https://**/*',proxy)
 oldlink=rejected.new_page();oldlink.goto('https://auth.qoopia.ai/confirm#'+'x'*43)
 oldlink.locator('#confirm').click();expect(oldlink.locator('#status')).to_contain_text('expired or was already used')
 rejected.close()
 page.locator('#app-check').click()
 expect(page.locator('#app-status')).to_contain_text('not confirmed yet')
 mail=context.request.get('http://127.0.0.1:18973/fixture-mail').json();assert mail['count']==1
 # A separate browser context represents Mail/Safari; no cookie is shared with the app.
 safari=browser.new_context();safari.route('https://**/*',proxy);confirmation=safari.new_page();confirmation.goto(mail['url']);confirmation.locator('#confirm').click()
 page.evaluate("window.dispatchEvent(new Event('pageshow'))")
 
 try:page.wait_for_url('https://workspace.example.test/dashboard',timeout=20000)
 except Exception:
  print('FINAL',urlparse(page.url).path,page.locator('body').inner_text(),errors,flush=True);raise
 expect(page.locator('#appView')).to_be_visible();expect(page.locator('#crumb')).to_have_text('Overview')
 page.wait_for_load_state('networkidle');assert page.locator('.overview-stat').count()==4
 assert context.request.get('http://127.0.0.1:18973/fixture-mail').json()['count']==1
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
 page.screenshot(path=str(out/'dashboard.png'))
 page.locator('#navToggle').click();expect(page.locator('#appView [data-native-app-settings]')).to_be_visible()
 page.screenshot(path=str(out/'dashboard-menu.png'))
 page.reload();expect(page.locator('#appView')).to_be_visible();expect(page.locator('.overview-stat')).to_have_count(4);page.wait_for_load_state('networkidle')
 # Expire only the workspace session; the confirmed account still opens it without another email.
 cookies=context.cookies();context.clear_cookies();context.add_cookies([c for c in cookies if c['name']!='qoopia_dash'])
 page.goto('https://workspace.example.test/dashboard?signin=complete');page.wait_for_url('https://workspace.example.test/dashboard',timeout=20000)
 expect(page.locator('#appView')).to_be_visible()
 assert context.request.get('http://127.0.0.1:18973/fixture-mail').json()['count']==1
 expect(page.locator('.overview-stat')).to_have_count(4);page.wait_for_load_state('networkidle')
 assert not errors,errors
 (out/'browser-results.json').write_text(json.dumps({'result':'PASS','engine':'WebKit','environment':'isolated synthetic fixture','checks':['one email only','pending button feedback','rejected confirmation remains unconfirmed','confirmation in separate browser','automatic owner dashboard','mobile layout','native settings link','persisted login','lost callback recovery'],'javascript_errors':errors},indent=2))
 safari.close();browser.close()
print('PASS WebKit app entry → email in separate browser → existing owner dashboard; one email; reload and lost callback recovery')
