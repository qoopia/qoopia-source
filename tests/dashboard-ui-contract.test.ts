import {expect,test} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {dashboardPage,dashboardScript,dashboardStyles} from './helpers/dashboard-source.ts';

/** Declarations of every rule whose selector list names `selector` exactly (media blocks included). */
const decls=(css:string,selector:string)=>[...css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(m=>m[1]!.split(',').map(s=>s.trim()).includes(selector)).map(m=>m[2]).join(';');

test('dashboard buttons and fields never fall back to browser-default chrome [F-310]',()=>{
  // A <button class="tg-chat"> row must reset the UA ButtonFace fill and outset border.
  expect(decls(dashboardStyles,'.tg-chat')).toMatch(/background:\s*(none|transparent)/);
  expect(decls(dashboardStyles,'.tg-chat')).toMatch(/(^|;)\s*border:\s*0/);
  // AgentComm toolbar fields use the shared compact field style.
  expect(dashboardScript).toMatch(/<input type="search" id="acSearch" class="sel"/);
  expect(dashboardScript).toMatch(/<select id="acRecent" class="sel"/);
  // Save-request actions use the shared button roles.
  expect(dashboardScript).toContain('<button type="button" class="btn primary" data-accept="1">');
  expect(dashboardScript).toContain('<button type="button" class="btn" data-accept="">');
  // Retry inside an error box is styled by the shared button rule.
  expect(decls(dashboardStyles,'.err button')).toContain('min-height:32px');
});

test('long unbreakable names wrap inside chips, connection rows and folder pickers [F-314]',()=>{
  for(const selector of ['.chip','.connection-line>strong'])expect(decls(dashboardStyles,selector),selector).toContain('overflow-wrap:anywhere');
  expect(decls(dashboardStyles,'.chip')).toContain('max-width:100%');
  expect(decls(dashboardStyles,'.sel')).toContain('max-width:100%');
  expect(decls(dashboardStyles,'.msg-head')).toContain('flex-wrap:wrap');
  expect(decls(dashboardStyles,'.f-row')).toContain('flex-wrap:wrap');
  expect(decls(dashboardStyles,'.f-name')).toContain('overflow-wrap:anywhere');
});

test('skip link is the first keyboard stop of the signed-in app [F-315]',()=>{
  const app=dashboardPage.slice(dashboardPage.indexOf('id="appView"'));
  const firstFocusable=app.match(/<(a|button|input|select|textarea)\b[^>]*>/)![0];
  expect(firstFocusable).toContain('class="q-skip"');
  expect(firstFocusable).toContain('href="#main"');
});

/** The generated locale runtime, evaluated with only the globals it reads at load time. */
function localeRuntime(lang:'en'|'ru') {
  const source=readFileSync(new URL('../src/public/brand/i18n.js',import.meta.url),'utf8');
  const window:{QI?:{resolve:(t:string)=>string;count:(n:number,unit:string)=>string;msg:(s:string)=>string}}&{addEventListener:()=>void}={addEventListener(){}};
  const document={cookie:'',documentElement:{lang:''},addEventListener(){}};
  new Function('window','document','location','localStorage','navigator',source)(window,document,{search:'?lang='+lang},{getItem:()=>null},{language:'en-US'});
  return window.QI!;
}

test('dashboard counts, titles and data labels read correctly in the selected language [F-317]',()=>{
  const ru=localeRuntime('ru'),en=localeRuntime('en');
  const n=(qi:ReturnType<typeof localeRuntime>,value:number,unit:string)=>qi.resolve(qi.count(value,unit));
  expect([n(ru,1,'session'),n(ru,2,'session'),n(ru,5,'session')]).toEqual(['1 сессия','2 сессии','5 сессий']);
  expect([n(ru,21,'message'),n(ru,3,'note'),n(ru,120,'note')]).toEqual(['21 сообщение','3 заметки','120 заметок']);
  expect([n(en,1,'session'),n(en,60,'message'),n(en,1,'note')]).toEqual(['1 session','60 messages','1 note']);
  expect(dashboardScript).toContain("QI.count(a.sessions_count,'session')");
  // Static tooltip is English source text, translated like every other label.
  expect(dashboardPage).toMatch(/data-i18n-title="Scroll to top" id="toTopBtn" title="Scroll to top"/);
  // The tab title follows a language switch.
  expect(dashboardScript).toMatch(/addEventListener\('qoopia:language',\(\)=>\{?document\.title=/);
  // Transcript roles and note types are labels, not raw codes.
  expect(dashboardScript).not.toContain("'\">' + esc(m.role) + '</span>");
  const catalog=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8')) as Record<string,string>;
  const types=JSON.parse(dashboardScript.match(/const NOTE_TYPES = (\[[^\]]*\])/)![1]!.replaceAll("'",'"')) as string[];
  for(const type of types)expect(catalog[type],type).toBeString();
  expect(ru.resolve(ru.msg('(untitled session)'))).not.toBe('(untitled session)');
});

const brand=(name:string)=>readFileSync(new URL('../src/public/brand/'+name,import.meta.url),'utf8');
/** `key: "value"` pairs of one DESIGN.md frontmatter section (nested keys flattened by name). */
function designSection(name:string) {
  const front=readFileSync(new URL('../DESIGN.md',import.meta.url),'utf8').split('\n---')[0]!;
  const block=front.split(new RegExp('^'+name+':$','m'))[1]!.split(/^\S/m)[0]!;
  const out=new Map<string,string>();let current='';
  for(const line of block.split('\n')){
    const top=/^  ([\w-]+):\s*"?([^"]*)"?$/.exec(line),nested=/^    fontSize:\s*"([^"]+)"/.exec(line);
    if(top){current=top[1]!;if(top[2])out.set(current,top[2]);}
    else if(nested)out.set(current,nested[1]!);
  }
  return out;
}

test('tokens.css carries the DESIGN.md palette, type roles, radii and spacing, and the CSS uses only it [F-320]',()=>{
  const tokens=brand('tokens.css');
  const defined=new Map([...tokens.matchAll(/(--qoopia-[a-z0-9-]+):\s*([^;]+);/g)].map(m=>[m[1]!,m[2]!.trim()]));
  const website=(key:string)=>key.startsWith('website-')||key==='product-example';
  for(const [key,value] of designSection('colors'))if(!website(key))expect(defined.get('--qoopia-'+key),key).toBe(value);
  for(const [key,value] of designSection('rounded'))if(!website(key))expect(defined.get('--qoopia-radius-'+key),key).toBe(value);
  for(const [key,value] of designSection('spacing'))if(!website(key))expect(defined.get('--qoopia-space-'+key),key).toBe(value);
  for(const [key,value] of designSection('typography'))if(!website(key))expect(defined.get('--qoopia-type-'+key),key).toBe(value);
  // Colour literals live only in tokens.css; no stylesheet re-declares a token.
  for(const name of ['dashboard.css','base.css','agent-chat.css']){
    const bodies=[...brand(name).matchAll(/\{([^{}]*)\}/g)].map(m=>m[1]).join(';');
    expect(bodies.match(/#[0-9a-fA-F]{3,8}\b/g),name).toBeNull();
    expect(brand(name).match(/--qoopia-[a-z0-9-]+\s*:/g),name).toBeNull();
  }
  // Every token is used somewhere in the served UI.
  const files=(dir:string):string[]=>readdirSync(new URL('../'+dir,import.meta.url),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(dir+'/'+e.name):/\.(css|js|ts|html)$/.test(e.name)&&e.name!=='tokens.css'?[readFileSync(new URL('../'+dir+'/'+e.name,import.meta.url),'utf8')]:[]);
  const used=files('src').join('\n');
  for(const token of defined.keys())expect(used.includes('var('+token+')'),token).toBe(true);
  // Colour-coded legacy aliases all resolved to ivory/surface; neutral names replace them.
  expect(dashboardStyles).not.toMatch(/--(green|amber|red|purple|blue|pink|cyan)(-dim)?\b/);
});

test('dashboard text sizes below 14px are DESIGN type roles, never under the 11px metadata floor [F-319]',()=>{
  const css=dashboardStyles.replace(/\/\*[\s\S]*?\*\//g,'');
  const literal=[...css.matchAll(/font(?:-size)?\s*:\s*(?:\d{3}\s+)?([0-9.]+)(px|rem)\b/g)].map(m=>({text:m[0],px:Number(m[1])*(m[2]==='rem'?14:1)}));
  expect(literal.filter(x=>x.px<14).map(x=>x.text)).toEqual([]);
  const roles=new Set([...css.matchAll(/var\(--qoopia-type-([a-z-]+)\)/g)].map(m=>m[1]));
  for(const role of ['body','navigation','label','metadata'])expect(roles.has(role),role).toBe(true);
});

test('actionable controls are outlined by the control colour, and filter counts keep AA contrast [F-321]',()=>{
  for(const selector of ['.icon-btn','.note-filter','.btn-more','.nav-toggle'])expect(decls(dashboardStyles,selector),selector).toMatch(/border(-color)?:[^;]*var\(--control\)/);
  expect(dashboardScript).not.toContain('<span style="opacity:.6">·');
  // Copyable ids stay readable (opacity .55 dropped them to 3.7:1 at 11px).
  expect(dashboardScript).not.toMatch(/class=\\?"copyable mono\\?" style=\\?"opacity/);
});

test('disclosures and lone action links keep 44px touch targets on phones [F-327]',()=>{
  const coarse=(css:string)=>[...css.matchAll(/@media\s*\(pointer:coarse\),\s*\(max-width:600px\)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].map(m=>m[1]).join('\n');
  expect(decls(coarse(dashboardStyles),'summary')).toContain('min-height:44px');
  expect(decls(coarse(dashboardStyles),'.login-sub>a')).toContain('min-height:44px');
  expect(decls(coarse(brand('base.css')),'.q-profile .profile-footer a')).toContain('min-height:44px');
  const offline=readFileSync(new URL('../src/public/offline.html',import.meta.url),'utf8');
  expect(offline).toMatch(/<a [^>]*style="[^"]*min-height:44px[^"]*" href="\/dashboard">/);
});

test('every dashboard view has one h1 and the shell sits in landmarks [F-328]',()=>{
  expect(dashboardPage).toContain('<header class="topbar">');
  const crumb=dashboardPage.match(/<[a-z]+ [^>]*id="crumb"[^>]*>/)![0];
  expect(crumb).toStartWith('<nav ');
  expect(crumb).toContain('aria-label="Breadcrumb"');
  expect(dashboardPage).toMatch(/<main class="login-wrap" id="loginView">[\s\S]*<h1 class="q-brand login-brand">/);
  // The app (and its skip link) precedes the login's external links, so the skip link is a skip link to axe.
  expect(dashboardPage.indexOf('id="appView"')).toBeLessThan(dashboardPage.indexOf('id="loginView"'));
  // Sections under a view's h1 start at h2.
  expect(dashboardScript).toContain('<h2 id="memorySavesTitle">');
  for(const fn of ['renderAgentsPage','renderAgentCommPage','renderFilesPage','renderAgentDetail','renderSession','renderAcThread','renderSearchPage']){
    const body=dashboardScript.slice(dashboardScript.indexOf('function '+fn+'('));
    expect(body.slice(0,body.indexOf('\n  }\n')),fn).toContain('<h1');
  }
});

test('edge-aligned shell controls respect the left/right safe-area insets [F-329]',()=>{
  for(const selector of ['.topbar','.content'])expect(decls(dashboardStyles,selector),selector).toMatch(/padding-left:max\([^)]*env\(safe-area-inset-left\)\)[\s\S]*padding-right:max\([^)]*env\(safe-area-inset-right\)\)/);
  for(const selector of ['#chatLauncher','.to-top'])expect(decls(dashboardStyles,selector),selector).toContain('env(safe-area-inset-right)');
});

test('the login wordmark keeps its 144px width and natural aspect [F-330]',()=>{
  // base.css sizes every .q-brand img 28px tall; the login wordmark must override the height too.
  expect(decls(dashboardStyles,'.login-brand .brand-wordmark')).toMatch(/width:144px;\s*height:auto/);
});
