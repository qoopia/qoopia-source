"""Optional local UI qualification, against synthetic accounts and a fake mail provider."""
from pathlib import Path
import json,os,subprocess,sys
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2]
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
server=subprocess.Popen([os.environ.get('BUN','bun'),'tests/helpers/news-browser.ts'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 port=int(server.stdout.readline());base=f'http://127.0.0.1:{port}'
 with sync_playwright() as pw:
  browser=pw.chromium.launch(channel='chrome',headless=True)
  errors=[];checks=[]
  try:
   for name,width in [('desktop',1440),('mobile',390)]:
    context=browser.new_context(viewport={'width':width,'height':1000});page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(base+'/profile?lang=ru');page.wait_for_load_state('networkidle')
    expect(page.locator('#signup-news')).not_to_be_checked();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out/f'signup-{name}.png'),full_page=True)
    page.goto(base+'/owner');expect(page.get_by_role('heading',name='Сначала войдите')).to_be_visible()
    context.add_cookies([{'name':'__Host-qoopia_profile','value':'synthetic-owner','domain':'127.0.0.1','path':'/','secure':True,'httpOnly':True}])
    page.goto(base+'/profile?lang=ru');expect(page.locator('#news-form')).to_be_visible();page.locator('#news-optin').check();page.get_by_role('button',name='Сохранить выбор').click();expect(page.locator('#news-status')).to_have_text('Ваш выбор сохранён.')
    page.reload();expect(page.locator('#news-optin')).to_be_checked();page.wait_for_load_state('networkidle');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out/f'profile-{name}.png'),full_page=True)
    page.get_by_role('link',name='Панель владельца').click();page.wait_for_load_state('networkidle');expect(page.get_by_role('heading',name='Панель владельца')).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out/f'owner-{name}.png'),full_page=True)
    path=context.request.get(base+'/__fixture/unsubscribe').json()['path'];context.clear_cookies();page.goto(base+path);page.wait_for_load_state('networkidle');page.screenshot(path=str(out/f'unsubscribe-{name}.png'),full_page=True)
    page.get_by_role('button',name='Отписаться',exact=True).click();expect(page.get_by_text('Новости Qoopia больше не будут приходить.',exact=False)).to_be_visible()
    context.add_cookies([{'name':'__Host-qoopia_profile','value':'synthetic-owner','domain':'127.0.0.1','path':'/','secure':True,'httpOnly':True}])
    page.goto(base+'/profile?lang=ru');expect(page.locator('#news-optin')).not_to_be_checked()
    page.goto(base+'/owner?lang=en');expect(page.get_by_role('heading',name='Owner dashboard')).to_be_visible()
    checks.append({'viewport':width,'checks':['unchecked signup','anonymous owner denied','persisted opt-in','owner navigation','no viewport overflow','unsubscribe without login','English owner view']})
    context.close()
   assert not errors,errors
   (out/'browser-checks.json').write_text(json.dumps({'status':'PASS','synthetic':True,'checks':checks,'page_errors':errors},indent=2))
  finally:browser.close()
finally:
 server.terminate();server.wait(timeout=10)
