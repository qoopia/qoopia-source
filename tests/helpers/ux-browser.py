"""UX regressions against disposable dashboard + production-template previews only."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import json,os
out=Path(os.environ['QOOPIA_I18N_EVIDENCE']);info=json.loads(Path('/tmp/qoopia-bridges-preview.json').read_text());base=info['url'];fixture='http://127.0.0.1:18769'
checks=[];errors=[];unlabelled=[]
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True)
 c=b.new_context(viewport={'width':1440,'height':1000},locale='en-US',reduced_motion='reduce')
 assert c.request.post(base+'/api/dashboard/login',headers={'Authorization':'Bearer '+info['api_key'],'Origin':base}).ok
 page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 for route in ['memory','connections','bridges','overview','agents','files','knowledge','skills','search','activity','agentcomm']:
  page.goto(base+'/dashboard?lang=en#'+route);expect(page.locator('#appView')).to_be_visible();page.wait_for_timeout(200)
  expect(page.locator('#nav [aria-current=page]')).to_have_count(1)
  missing=page.locator('input:not([type=hidden]),select,textarea').evaluate_all("es=>es.filter(e=>e.getClientRects().length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')&&!e.labels?.length).map(e=>e.id)")
  unlabelled += [[route,x] for x in missing]
 page.goto(base+'/dashboard?lang=en#memory');expect(page.locator('#memoryConnections')).to_be_visible()
 assert page.locator('#memoryConnections').bounding_box()['y']<page.locator('#memoryProvider').bounding_box()['y'];checks.append('connect agents before optional subscription')
 page.get_by_role('link',name='Files',exact=True).click();expect(page.locator('#main')).to_be_focused();expect(page.locator('#nav [aria-current=page]')).to_have_attribute('href','#files');checks.append('navigation location and focus')
 page.set_viewport_size({'width':360,'height':900});page.locator('#navToggle').click();expect(page.locator('#navToggle')).to_have_attribute('aria-expanded','true');page.keyboard.press('Escape');expect(page.locator('#navToggle')).to_have_attribute('aria-expanded','false');expect(page.locator('#navToggle')).to_be_focused();checks.append('mobile menu keyboard recovery')
 page.goto(base+'/dashboard?lang=en#bridges');page.locator('#bridgeInvite').click();expect(page.locator('#bridgeCopyLink')).to_be_visible()
 page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('fixture denial')}}})")
 page.locator('#bridgeCopyLink').click();expect(page.locator('[data-copy-status]')).to_contain_text('Could not copy.');page.screenshot(path=str(out/'clipboard-recovery-360.png'),full_page=True)
 page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}})")
 page.locator('#bridgeCopyLink').click();expect(page.locator('[data-copy-status]')).to_have_text('Copied.');checks.append('clipboard failure and success announced in dialog')
 for width in [360,768,1440]:
  page.set_viewport_size({'width':width,'height':1000})
  for lang in ['en','ru']:
   for route in ['profile','profile-saved','confirm','mail','consent']:
    page.goto(fixture+'/'+route+'-'+lang+'.html');page.evaluate('document.fonts.ready');expect(page.locator('html')).to_have_attribute('lang',lang)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(route,width,lang)
    assert page.locator('img').evaluate_all('es=>es.every(e=>e.complete&&e.naturalWidth>0)'),(route,'missing image')
    if width in [360,1440]:page.screenshot(path=str(out/f'{route}-{lang}-{width}.png'),full_page=True)
   for guide in ['en','ru']:
    page.goto(base+'/connections-guide-'+guide+'.html');page.evaluate('document.fonts.ready');assert 'IBM Plex Sans' in page.locator('body').evaluate('e=>getComputedStyle(e).fontFamily')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');assert page.locator('.guide-clients a').count()==6
   checks.append(['templates and guides',width,lang])
 # No-token reload is explained. Valid token never sent before an explicit click.
 page.goto(fixture+'/confirm-ru.html');expect(page.locator('#confirm')).to_be_hidden();expect(page.locator('#status')).to_contain_text('полную ссылку')
 page.route('**/confirm',lambda r:r.fulfill(status=400,json={'error':'expired'}))
 page.goto(fixture+'/confirm-ru.html#'+'x'*43);expect(page.locator('#confirm')).to_be_enabled();page.locator('#confirm').click();expect(page.locator('#status')).to_contain_text('Ссылка истекла');expect(page.locator('#confirm')).to_be_hidden()
 page.unroute('**/confirm');page.route('**/confirm',lambda r:r.abort('internetdisconnected'))
 page.goto(fixture+'/confirm-ru.html#'+'x'*43);page.locator('#confirm').click();expect(page.locator('#status')).to_contain_text('Проверьте подключение');expect(page.locator('#confirm')).to_be_enabled();checks.append('missing expired offline confirmation recovery')
 # Google is an account-selection step before email delivery. No real provider call.
 started=[]
 def start(r):
  started.append(r.request.post_data_json);r.fulfill(json={'google_url':'https://fixture.example.test/google'})
 page.route('**/profile/start',start);page.route('**/profile/poll',lambda r:r.fulfill(status=202,json={'pending':True}))
 page.goto(fixture+'/profile-ru.html');page.locator('#google').click();expect(page.locator('#profile-status')).to_contain_text('Выберите аккаунт Google');expect(page.locator('#google-link')).to_be_focused();assert started[0]['language']=='ru'
 page.screenshot(path=str(out/'google-next-step-ru.png'),full_page=True);checks.append('Google stage and language forwarding')
 page.unroute('**/profile/start');page.route('**/profile/start',lambda r:r.abort('internetdisconnected'))
 page.goto(fixture+'/profile-ru.html');page.locator('#email').fill('fixture@example.test');page.locator('#signin-form button').click();expect(page.locator('#profile-status')).to_contain_text('Попробуйте ещё раз');expect(page.locator('#profile-status')).to_be_focused();expect(page.locator('#email')).to_have_value('fixture@example.test');checks.append('profile offline error preserves input and receives focus')
 page.goto('http://127.0.0.1:18768/404.html?lang=ru');assert page.locator('img').evaluate_all('es=>es.every(e=>e.complete&&e.naturalWidth>0)');checks.append('404 brand asset loads')
 assert not unlabelled,unlabelled
 assert not errors,errors
 b.close()
(out/'ux-verification.json').write_text(json.dumps({'status':'PASS','checks':checks,'unlabelled_controls':unlabelled,'javascript_errors':errors,'environment':'headless Chrome, synthetic data, emulated viewport; email templates rendered as web previews, no inbox delivery'},ensure_ascii=False,indent=2))
print('PASS UX regression flows and 30 template views')
