"""Run against the disposable bridges-ui-server fixture and the local marketing preview."""
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
import json,os
info=json.loads(Path('/tmp/qoopia-bridges-preview.json').read_text());base=info['url'];out=Path(os.environ.get('QOOPIA_I18N_EVIDENCE','../work/i18n'));out.mkdir(parents=True,exist_ok=True)
errors=[];checks=[];routes=['memory','connections','bridges','overview','agents','files','knowledge','skills','search','activity','agentcomm']
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True)
 c=b.new_context(viewport={'width':1440,'height':1000},locale='en-US');assert c.request.post(base+'/api/dashboard/login',headers={'Authorization':'Bearer '+info['api_key'],'Origin':base}).ok
 page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 def language(lang):
  page.get_by_role('button',name='Русский' if lang=='ru' else 'English',exact=True).filter(visible=True).click();expect(page.locator('html')).to_have_attribute('lang',lang)
 for width in [360,768,1440]:
  page.set_viewport_size({'width':width,'height':1000})
  for lang in ['en','ru']:
   page.goto(base+'/dashboard#memory');language(lang)
   for route in routes:
    page.goto(base+'/dashboard#'+route);page.wait_for_timeout(200);page.evaluate('document.fonts.ready')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(route,width,lang)
    assert '\ue000' not in page.locator('body').inner_text(),(route,'unresolved message')
    if width==1440 and route in ['memory','connections','bridges']:page.screenshot(path=str(out/f'dashboard-{route}-{lang}.png'),full_page=True)
    checks.append([route,width,lang])
 # Switching never rebuilds the form, changes its values, uploads a file or writes data.
 page.goto(base+'/dashboard#bridges');language('en');page.locator('#bridgeAdd summary').click();page.locator('#bridgeTitle').fill('Memory');page.locator('#bridgeDescription').fill('Connections — русский текст');page.locator('#bridgeText').fill('Keep the thread. Это МОИ данные.');page.locator('#bridgeSource').select_option('upload');page.locator('#bridgeFile').set_input_files({'name':'Memory.txt','mimeType':'text/plain','buffer':b'Memory'})
 group=page.locator('#bridgeGroup').input_value();writes=[];page.on('request',lambda request:writes.append(request.url) if request.method not in ['GET','HEAD'] else None)
 language('ru');expect(page.locator('#bridgeTitle')).to_have_value('Memory');expect(page.locator('#bridgeDescription')).to_have_value('Connections — русский текст');expect(page.locator('#bridgeText')).to_have_value('Keep the thread. Это МОИ данные.');expect(page.locator('#bridgeSource')).to_have_value('upload');assert page.locator('#bridgeFile').evaluate('(e)=>e.files[0].name')=='Memory.txt';assert page.locator('#bridgeGroup').input_value()==group;assert not writes
 expect(page.locator('#bridgeConnection')).to_contain_text('2 участника')
 language('en');expect(page.locator('#bridgeTitle')).to_have_value('Memory');page.reload();expect(page.locator('html')).to_have_attribute('lang','en');language('ru');page.reload();expect(page.locator('html')).to_have_attribute('lang','ru')
 # User data equal to dictionary keys stays untouched in actual rendered catalogue rows.
 expect(page.locator('#bridgeList')).to_contain_text('A practical memory handbook')
 page.goto(base+'/dashboard#skills');page.get_by_role('button',name='Создать навык',exact=True).click();page.locator('#skTitle').fill('Memory');page.locator('#skSteps').fill('Do not translate this draft.');language('en');expect(page.locator('#skTitle')).to_have_value('Memory');expect(page.locator('#skSteps')).to_have_value('Do not translate this draft.')
 # Language preference, semantic labels and browser-locale fallback on the login surface.
 ru=b.new_context(locale='ru-RU');login=ru.new_page();login.goto(base+'/dashboard');expect(login.locator('html')).to_have_attribute('lang','ru');expect(login.locator('#ownerLoginBtn')).to_contain_text('Войти как владелец');login.get_by_role('button',name='English',exact=True).filter(visible=True).click();login.reload();expect(login.locator('html')).to_have_attribute('lang','en')
 # Storage denial must not prevent language selection.
 denied=b.new_context(locale='en-US');denied.add_init_script("Storage.prototype.getItem=()=>{throw Error('blocked')};Storage.prototype.setItem=()=>{throw Error('blocked')}");q=denied.new_page();q.goto(base+'/dashboard');q.get_by_role('button',name='Русский',exact=True).filter(visible=True).click();expect(q.locator('html')).to_have_attribute('lang','ru')
 for width in [360,768,1440]:
  page.set_viewport_size({'width':width,'height':1000})
  for lang in ['en','ru']:
   for path in ['','docs.html','releases.html','404.html']:
    page.goto('http://127.0.0.1:18768/'+path+'?lang='+lang);page.evaluate('document.fonts.ready');expect(page.locator('html')).to_have_attribute('lang',lang);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),('site',path,width,lang);assert '\ue000' not in page.locator('body').inner_text();checks.append(['site/'+path,width,lang])
   page.goto('http://127.0.0.1:18768/?lang='+lang)
   for platform in ['mac','linux']:
    page.locator('#platform').select_option(platform);expect(page.locator('#download-action a')).to_have_attribute('href',__import__('re').compile('https://github.com/qoopia/qoopia-downloads/'))
   if width==1440:page.screenshot(path=str(out/f'site-{lang}.png'),full_page=True)
 assert not errors,errors
 b.close()
(out/'browser-verification.json').write_text(json.dumps({'status':'PASS','views':checks,'drafts_files_and_user_content_preserved':True,'no_writes_on_switch':True,'preference_reload':True,'browser_locale_fallback':True,'storage_denial':True,'javascript_errors':errors},indent=2));print('PASS',len(checks),'views; drafts, file inputs, data, preference, storage failure and public downloads')
