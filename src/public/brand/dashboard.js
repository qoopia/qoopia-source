(function () {
  const BASE = window.location.origin;
  const alert = message => window.alert(QI.resolve(message));
  const setupCode = new URLSearchParams(location.hash.slice(1)).get('setup');
  const accountCode = new URLSearchParams(location.hash.slice(1)).get('account_code');
  const accountSignIn = new URLSearchParams(location.search).get('signin');
  if(setupCode||accountCode)history.replaceState(null,'',location.pathname+location.search);
  // QDASH-COOKIE: token is never stored in JS. Auth lives in an HttpOnly
  // cookie set by POST /api/dashboard/login. All fetches use credentials.
  let agentsCache = null;
  let serviceOwner = false;
  let ownerPage = 0;

  let localWorkspace = null;
  let pollFn = null;          // function called every 5s while tab visible
  let chat=null;
  let state = { page: 'overview', drill: null }; // drill: {kind:'agent'|'session', ...}

  const $ = (s) => document.querySelector(s);
  const main = $('#main');
  const crumb = $('#crumb');
  $('.q-skip').onclick=e=>{e.preventDefault();main.focus();};
  // Until the session check answers, show a neutral status instead of the sign-in card (F-324).
  $('#loginView').style.display = 'none';
  document.body.insertAdjacentHTML('afterbegin', '<p class="loading" id="sessionCheck" role="status">' + QI.msg('Checking your session…') + '</p>');

  // ---------- API ----------
  // fetch rejects in the browser's own English ("Failed to fetch", "Load failed", "signal timed out"). Every request
  // goes through send(), so a request that got no answer reads as one sentence in the owner's language.
  async function send(url, init = {}) {
    try { return await fetch(url, init); }
    catch (e) {
      if (e?.name === 'AbortError') throw e; // Cancelled on purpose; the caller ignores it.
      const write = !!init.method && !['GET', 'HEAD'].includes(init.method);
      throw Object.assign(new Error(QI.resolve(QI.msg(e?.name === 'TimeoutError' && write ? 'The server has not confirmed this action yet. Check its status before trying again.' : 'Could not reach the server. Check your connection.'))), { offline: true });
    }
  }
  // An answer without a human sentence names the failure in words, never as "HTTP 502" or a snake_case code.
  // A4-03: the server's sentence goes through the catalog (tests/server-messages-translated.test.ts).
  function failure(r, data) {
    const error = Object.assign(new Error(''), { status: r.status, code: data.code, details: data.details, retryAfter: Number(r.headers.get('retry-after')) || 0 });
    const said = data.error_description || data.error?.message || (typeof data.error === 'string' && data.error.includes(' ') ? data.error : '');
    error.message = QI.resolve(said ? QI.msg(said) : errReason(error));
    return error;
  }
  async function api(path) {
    const r = await send(BASE + path, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (r.status === 401) { showLogin(true); throw new Error('unauthorized'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw failure(r, data);
    return data;
  }
  async function apiWrite(path, body) {
    const r = await send(BASE + path, {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', 'X-Qoopia-CSRF': '1' },
      body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(true); throw new Error('unauthorized'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw failure(r, data);
    return data;
  }

  // ---------- Auth / boot ----------
  let loginPoll=0;
  let loginAbort;
  const loginError=e=>{
    $('#loginView').classList.remove('account-connecting');
    const error=$('#loginErr');
    if(!$('#emailLogin').hidden){$('#emailLoginStatus').textContent='';$('#emailLoginStatus').after(error);}
    error.textContent=QI.resolve(e.message)===e.message?QI.msg(e.message):e.message;error.style.display='block';
    error.scrollIntoView({block:'nearest'});
  };
  async function identityPost(route,body={}){
    const r=await send(BASE+'/api/dashboard/identity/'+route,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(25000),...(loginAbort?[loginAbort.signal]:[])])});
    // A page that is not JSON (a proxy while the server restarts) counts as no answer: the sign-in poll keeps waiting.
    const data=await r.json().catch(()=>null);if(!data)throw Object.assign(new Error(QI.resolve(QI.msg("Sign-in is temporarily unavailable"))),{offline:true});
    if(!r.ok)throw new Error(data.error||(QI.msg("Sign-in is temporarily unavailable")));return data;
  }
  function finishAccountSignIn(){const url=new URL(location.href);url.searchParams.delete('signin');history.replaceState(null,'',url.pathname+url.search+url.hash);$('#loginView').classList.remove('account-connecting');}
  async function startAccountLogin(){
    ++loginPoll;loginAbort?.abort();loginAbort=new AbortController();
    $('#loginErr').style.display='none';$('#loginView').classList.add('account-connecting');$('#emailLoginStatus').textContent=QI.msg('Opening your dashboard…');
    try{const data=await identityPost('start',{method:'account',language:QI.language});const url=new URL(data.accountUrl);if(url.origin!=='https://auth.qoopia.ai'||url.pathname!=='/profile')throw new Error(QI.msg('Sign-in is temporarily unavailable'));location.assign(url.href);}catch(e){loginError(e);}
  }
  $('#accountLoginBtn').onclick=startAccountLogin;
  // The sign-in finishes by itself once Google or the email link completes it on this device.
  async function awaitEmailConfirmation(googleUrl,openGoogle=false,code=null,device=null){
    const poll=++loginPoll;
    $('#emailLoginStatus').textContent=QI.msg(code?'Opening your dashboard…':googleUrl?"Choose your Google account — Qoopia opens here by itself.":device?"On your phone or another computer, open the page below, sign in to your Qoopia account and enter this code. This page continues by itself.":"Open the email on this device and tap Sign in to Qoopia — this page opens your workspace by itself.");
    // A headless installation: the code is confirmed on another device. Only the sign-in service's own page is linked.
    if(device){const strong=document.createElement('strong');strong.textContent=device.userCode;const a=document.createElement('a');a.href=device.verificationUriComplete;a.target='_blank';a.rel='noopener noreferrer';a.textContent=device.verificationUri;$('#emailLoginStatus').append(' ',a,' · ',strong);}
    if(googleUrl){const a=document.createElement('a');a.href=googleUrl;a.target='_blank';a.rel='noopener';a.textContent=QI.msg("Choose your Google account");$('#emailLoginStatus').append(' ',a);if(openGoogle)a.click();}
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent=QI.msg("Cancel sign-in");cancel.onclick=()=>{++loginPoll;loginAbort?.abort();$('#loginView').classList.remove('account-connecting');$('#emailLoginStatus').textContent=QI.msg("Sign-in canceled. You can try again.");$('#googleLoginBtn').disabled=false;$('#emailLoginBtn').disabled=false;};$('#emailLoginStatus').append(' ',cancel);
    for(let i=0;i<240&&poll===loginPoll;i++){
      if(!code||i>0)await new Promise(resolve=>setTimeout(resolve,2500));
      if(poll!==loginPoll)return;
      // A phone drops the request while the Google tab or Mail is in front, or on a flaky network:
      // keep waiting instead of failing a sign-in the owner may already have confirmed.
      let data;try{data=await identityPost('poll',code?{accountCode:code}:{});}
      catch(e){if(poll!==loginPoll)return;if(e?.offline)continue;throw e;}
      if(poll!==loginPoll)return;
      if(data.ok){finishAccountSignIn();$('#emailLoginStatus').textContent='';if(consumeSafeNext())return;showApp();boot();return;}
    }
    if(poll===loginPoll)throw new Error((QI.msg("Sign-in link expired. Request a new email.")));
  }
  async function startEmailLogin(method){
    const email=$('#emailInput').value.trim();
    if(method==='email'&&!$('#emailLoginForm').reportValidity())return;
    loginAbort?.abort();const controller=loginAbort=new AbortController();
    const popup=method==='google'?window.open('about:blank','qoopia-google'):null;
    let popupNavigated=false;
    if(popup)popup.opener=null;
    $('#googleLoginBtn').disabled=true;$('#emailLoginBtn').disabled=true;$('#loginErr').style.display='none';
    try{
      const data=await identityPost('start',{method,language:QI.language,...(method==='email'?{email}:{})});
      if(data.googleUrl&&popup){popup.location.replace(data.googleUrl);popupNavigated=true;}
      await awaitEmailConfirmation(data.googleUrl,!!data.googleUrl&&!popup);
    }catch(e){if(popup&&!popupNavigated&&!popup.closed)popup.close();if(!controller.signal.aborted)loginError(e);}
    finally{if(loginAbort===controller){$('#googleLoginBtn').disabled=false;$('#emailLoginBtn').disabled=false;}}
  }
  async function startDeviceLogin(){
    loginAbort?.abort();const controller=loginAbort=new AbortController();
    $('#deviceLoginBtn').disabled=true;$('#loginErr').style.display='none';
    try{
      const data=await identityPost('start',{method:'device',language:QI.language});
      const url=new URL(data.verificationUriComplete);if(url.origin!=='https://auth.qoopia.ai'||url.pathname!=='/device')throw new Error(QI.msg('Sign-in is temporarily unavailable'));
      await awaitEmailConfirmation(null,false,null,data);
    }catch(e){if(!controller.signal.aborted)loginError(e);}
    finally{if(loginAbort===controller)$('#deviceLoginBtn').disabled=false;}
  }
  $('#deviceLoginBtn').onclick=startDeviceLogin;
  $('#emailLoginForm').onsubmit=e=>{e.preventDefault();startEmailLogin('email');};
  $('#googleLoginBtn').onclick=()=>startEmailLogin('google');
  // A4-11: a session that ends while the dashboard is open says so on the sign-in card.
  function showLogin(expired) { if (expired === true && $('#appView').style.display === 'block') { $('#loginErr').textContent = QI.msg('Your session has ended. Sign in again.'); $('#loginErr').style.display = 'block'; } chat?.dispose();chat=null;localWorkspace=null; $('#sessionCheck')?.remove(); $('#loginView').style.display = 'flex'; $('#appView').style.display = 'none'; pollFn = null; }
  function showApp() { $('#sessionCheck')?.remove(); $('#loginView').style.display = 'none'; $('#appView').style.display = 'block'; }
  function consumeSafeNext() {
    const next = new URLSearchParams(window.location.search).get('next') || '';
    if (!next.startsWith('/api/dashboard/oauth-consent')) return false;
    window.location.assign(next); return true;
  }
  $('#ownerLoginForm').onsubmit = async (e) => {
    e.preventDefault();
    const form=e.target, btn=$('#ownerLoginBtn'), inp=$('#ownerCodeInput'), code=inp.value.trim();
    if (!code) return;
    btn.disabled=true; btn.textContent=(QI.msg("Checking…")); $('#loginErr').style.display='none';
    try {
      const r=await send(BASE+'/api/dashboard/local-login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
      // The server's own words are English; only a 401 means the code itself was refused.
      if (r.status === 401) throw new Error(QI.resolve(QI.msg("Code expired or invalid")+QI.msg(". Run qoopia owner-login locally for a new code.")));
      if (!r.ok) throw failure(r, {});
      form.reset(); if (consumeSafeNext()) return; showApp(); boot();
    } catch (e) { $('#loginErr').textContent=e.message; $('#loginErr').style.display='block'; inp.focus(); }
    finally { btn.disabled=false; btn.textContent=(QI.msg("Sign in as owner")); }
  };
  $('#loginBtn').onclick = async () => {
    const btn = $('#loginBtn'); const inp = $('#tokenInput'); const t = inp.value.trim();
    if (!t) return;
    btn.disabled = true; btn.textContent = (QI.msg("Checking…"));
    try {
      const r = await send(BASE + '/api/dashboard/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Authorization': 'Bearer ' + t },
      });
      if (r.status === 401 || r.status === 403) throw new Error(QI.resolve(QI.msg("This agent key was not accepted. Check that it is active.")));
      if (!r.ok) throw failure(r, {});
      inp.value = '';
      if (consumeSafeNext()) return;
      showApp(); boot();
    } catch (e) { $('#loginErr').textContent=e.message; $('#loginErr').style.display='block'; inp.focus(); }
    finally { btn.disabled = false; btn.textContent = (QI.msg("Sign in with API key")); }
  };
  $('#tokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#loginBtn').click();
    $('#loginErr').style.display = 'none';
  });
  $('#logoutBtn').onclick = async () => {
    loginPoll++;
    try {
      const r=await send(BASE + '/api/dashboard/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Qoopia-CSRF': '1' } });
      if(!r.ok)throw new Error((QI.msg("Could not sign out. Please try again.")));
      showLogin();
    }catch(e){alert(e.message||(QI.msg("Could not sign out. Please try again.")));}
  };
  $('#refreshBtn').onclick = () => route(true);
  function setMenu(open){document.querySelector('.sidebar').classList.toggle('open',open);$('#navToggle').setAttribute('aria-expanded',String(open));}
  $('#navToggle').onclick=()=>setMenu($('#navToggle').getAttribute('aria-expanded')!=='true');
  $('#profileLink').onclick=e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;e.preventDefault();setMenu(false);go('profile');};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#navToggle').getAttribute('aria-expanded')==='true'){setMenu(false);$('#navToggle').focus();}});

  // ---------- Conn / clock ----------
  function setConn(ok) {
    $('#connDot').classList.toggle('off', !ok);
    $('#connText').textContent = ok ? (QI.msg("Live")) : (QI.msg("Offline"));
  }
  function tickClock() {
    const d = new Date();
    $('#clock').textContent = d.toLocaleTimeString(QI.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  setInterval(tickClock, 1000);window.addEventListener('qoopia:language',tickClock);

  // ---------- Utils ----------
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const diff=Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/1000));
    if(diff<60)return QI.relative(-diff,'second');
    if(diff<3600)return QI.relative(-Math.floor(diff/60),'minute');
    if(diff<86400)return QI.relative(-Math.floor(diff/3600),'hour');
    if(diff<2592000)return QI.relative(-Math.floor(diff/86400),'day');
    return QI.date(iso,{dateStyle:'medium'});
  }
  function fmtTimeFull(iso){return iso?QI.date(iso):'—';}
  function fmtNum(n){return n==null?'—':QI.number(n);}
  function humanDur(sec){
    if(sec==null)return '—';
    const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);
    return d?QI.msg('{d}d {h}h',{d,h}):h?QI.msg('{h}h {m}m',{h,m}):m?QI.msg('{m}m',{m}):QI.msg('{s}s',{s:Math.floor(sec)});
  }
  // A4-19: an avatar tone from the name itself; the product names no particular agents.
  function avatarClass(name) {
    let h = 0; for (const c of String(name || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return 'tone-' + (h % 3);
  }
  // A4-15: smooth scrolling only when the reader has not asked for reduced motion.
  const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  // A4-16: a search field takes focus on open only with a mouse or trackpad; on a phone that would pop the keyboard.
  const focusField = el => { if (matchMedia('(pointer: fine)').matches) el.focus(); };
  function initial(name) { return esc((name || '?').charAt(0).toUpperCase()); }
  // Activity in words, appended to a meta line; the old dots were identical and hover-only (F-322).
  function liveStatus(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 90) return ' · ' + QI.msg("active now");
    if (diff < 600) return ' · ' + QI.msg("active recently");
    return '';
  }
  async function copyText(el, text) {
    let status=$('#uiFeedback');const dialog=el.closest('dialog');
    if(dialog){status=dialog.querySelector('[data-copy-status]');if(!status){status=document.createElement('p');status.dataset.copyStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');dialog.append(status);}}
    try{if(!navigator.clipboard)throw Error();await navigator.clipboard.writeText(text);status.textContent=QI.msg('Copied.');el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),600);}
    catch{status.textContent=QI.msg('Could not copy. Select the text and copy it manually.');}
  }
  window.copyText = copyText;
  function lineIcon(paths) { return '<svg aria-hidden="true" class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>'; }
  function roleIcon(role) {
    return lineIcon(role==='user'?'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>':role==='tool'?'<path d="m8 5-6 7 6 7M16 5l6 7-6 7"/>':'<path d="M4 4h16v13H9l-5 4zM8 9h8M8 13h5"/>');
  }
  function actionStyle(action) {
    const paths=action==='created'?'<path d="M12 5v14M5 12h14"/>':action==='deleted'?'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>':action.startsWith('agent_')?'<path d="M3 5h18v14H3zM3 5l9 8 9-8"/>':'<path d="m5 12 4 4L19 6"/>';
    return {icon:lineIcon(paths),color:'var(--text2)'};
  }

  // Polled lists are rewritten only when their markup changed, and the row a keyboard user
  // was on (its data-id, else its position) keeps focus across the rewrite (F-313).
  function patch(el, html) {
    if (!el || el.html === html && el.firstChild === el.htmlStart) return; // Same markup, not overwritten since.
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const rows = () => [...el.querySelectorAll('button,a[href]')], id = focused?.dataset.id, nth = focused ? rows().indexOf(focused) : -1;
    el.innerHTML = el.html = html; el.htmlStart = el.firstChild;
    if (focused) (id && el.querySelector('[data-id="' + CSS.escape(id) + '"]') || rows()[nth])?.focus({ preventScroll: true });
  }

  // ---------- Errors ----------
  // A failed load says what failed and why in words and offers Retry; codes stay off the page (F-323).
  function errReason(e) {
    if (e?.status === 403) return QI.msg('This is available only to the workspace owner.');
    if (e?.status === 429) return QI.msg('Too many requests. Try again in {s} s.', { s: e.retryAfter || 60 });
    if (e?.status) return QI.msg('The server could not complete the request.');
    return QI.msg('Could not reach the server. Check your connection.');
  }
  function errBox(el, what, retry, e) {
    if (!el || e?.message === 'unauthorized') return;
    if (!e?.status) setConn(false); // Only an unreachable server is Offline; a 429 or 5xx answered (F-311).
    el.classList.remove('loading', 'empty');
    el.innerHTML = '<div class="err layout-full-row">' + what + ' ' + errReason(e) + ' <button type="button" class="btn">' + QI.msg('Retry') + '</button></div>';
    el.querySelector('button').onclick = retry;
  }

  // ---------- Navigation ----------
  const NAV = [
    { id: 'work', label: (QI.msg("Memory")), icon: '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>' },
    { id: 'connections', label: (QI.msg("Connections")), icon: '<path d="m8 12 8 0M8 6H4v12h4M16 6h4v12h-4"/>' },
    { id: 'overview', label: (QI.msg("Overview")), icon: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z"/>' },
    { id: 'agents', label: (QI.msg("Agents")), icon: '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.87"/>' },
    { id: 'agentcomm', label: (QI.msg("Agent conversations")), icon: '<path d="M8 10h8M8 14h5"/><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>' },
    { id: 'bridges', label: (QI.msg("Bridges")), icon: '<circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><path d="m8 10 8-4M8 14l8 4"/>' },
    { id:'external',label:QI.msg('External folder'),icon:'<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>' },
    { id: 'canon', label: (QI.msg("Canon")), icon: '<path d="M6 3h12v18l-6-4-6 4z"/><path d="M9 8h6M9 12h4"/>' },
    { id: 'skills', label: (QI.msg("Skills")), icon: '<path d="M12 3l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/>' },
    { id: 'files', label: (QI.msg("Files")), icon: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>' },
    { id: 'search', label: (QI.msg("Search")), icon: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>' },
  ];
  const navOrder=['overview','work','canon','agents','connections','agentcomm','skills','bridges','external','files','search'];
  NAV.sort((a,b)=>navOrder.indexOf(a.id)-navOrder.indexOf(b.id));
  let navBadges = {};
  // A4-04: pages only the workspace owner can open; an agent's own view does not list them.
  const OWNER_PAGES=['work','connections','bridges','external'];
  function renderNav() {
    $('#nav').innerHTML = NAV.filter(n => !OWNER_PAGES.includes(n.id) || localWorkspace).map(n => {
      const b = navBadges[n.id];
      const attn = '';
      const pill = (b != null && b !== '') ? '<span class="pill">' + b + '</span>' : '';
      return '<a href="#'+(n.id==='work'?'memory':n.id)+'"'+(state.page===n.id&&!state.drill?' aria-current="page"':'')+' class="nav-item' + (state.page === n.id && !state.drill ? ' active' : '') + attn + '" data-page="' + n.id + '">' +
        '<svg aria-hidden="true" class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + n.icon + '</svg>' +
        '<span>' + n.label + '</span>' + pill + '</a>';
    }).join('');
    $('#nav').querySelectorAll('.nav-item').forEach(el => {
      el.onclick=e=>{if(!el.getAttribute('data-page'))return;if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;e.preventDefault();setMenu(false);go(el.getAttribute('data-page'));};
    });
    const profile=$('#profileLink');
    profile.classList.toggle('active',state.page==='profile'&&!state.drill);
    if(state.page==='profile'&&!state.drill)profile.setAttribute('aria-current','page');
    else profile.removeAttribute('aria-current');
  }
  function pageFromHash() {
    const hash=location.hash.slice(1),page=hash==='memory'?'work':hash;
    if(hash==='my-agent'){chat?.open();return 'overview';}
    if(page==='profile'||page==='owner'&&serviceOwner)return page;
    return NAV.some(n=>n.id===page)&&(!OWNER_PAGES.includes(page)||localWorkspace)?page:'overview';
  }
  function go(page) {
    if(page==='my-agent'){chat?.open();return;}
    if(page!=='profile'&&!(page==='owner'&&serviceOwner)&&!NAV.some(n=>n.id===page))return;
    try{localStorage.setItem('qoopia.dashboard.page',page);}catch{/* Storage unavailable (private mode or blocked); continue without persistence. */}
    history.pushState(null,'',location.pathname+location.search+'#'+(page==='work'?'memory':page));
    state={page:pageFromHash(),drill:null};Promise.resolve(route()).then(()=>{if(document.contains(main))main.focus({preventScroll:true});});
  }
  // A4-05: an agent (and its tab), a session and an agent conversation have their own address, so Back,
  // reload and a shared link return to them: #agents/<id>[/<tab>], #agents/<id>/sessions/<sid>, #agentcomm/<first>/<second>.
  function drillHash(page, d) {
    if (!d) return page === 'work' ? 'memory' : page;
    const id = encodeURIComponent;
    if (d.kind === 'agent') return 'agents/' + id(d.agent.id) + (d.tab && d.tab !== 'sessions' ? '/' + id(d.tab) : '');
    if (d.kind === 'session') return 'agents/' + id(d.agent.id) + '/sessions/' + id(d.session.id);
    return 'agentcomm/' + id(d.pair.agent_a.id) + '/' + id(d.pair.agent_b.id);
  }
  function parseDrillHash(hash) {
    let p; try { p = hash.split('/').map(decodeURIComponent); } catch { return null; }
    if (p[0] === 'agents' && p[1]) return p[2] === 'sessions' && p[3] ? { kind: 'session', agent: p[1], session: p[3] } : { kind: 'agent', agent: p[1], tab: p[2] || 'sessions' };
    if (p[0] === 'agentcomm' && p[1] && p[2]) return { kind: 'acthread', a: p[1], b: p[2] };
    return null;
  }
  function openDrill(page, drill, replace) {
    state = { page, drill };
    history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + '#' + drillHash(page, drill));
    return route();
  }
  async function stateFromHash() {
    const want = parseDrillHash(location.hash.slice(1));
    if (!want) return { page: pageFromHash(), drill: null };
    if (!agentsCache) try { agentsCache = (await api('/api/dashboard/agents')).items; } catch { /* The list page below reports the failure. */ }
    const find = id => (agentsCache || []).find(a => a.id === id);
    if (want.kind === 'acthread') return { page: 'agentcomm', drill: { kind: 'acthread', pair: { agent_a: find(want.a) || { id: want.a }, agent_b: find(want.b) || { id: want.b } } } };
    const agent = find(want.agent);
    if (!agent) return { page: 'agents', drill: null };
    return { page: 'agents', drill: want.kind === 'session' ? { kind: 'session', agent, session: { id: want.session, title: null } } : { kind: 'agent', agent, tab: want.tab, noteType: null } };
  }
  window.addEventListener('hashchange',()=>{if($('#appView').style.display!=='none'){stateFromHash().then(next=>{state=next;return route();}).then(()=>{if(document.contains(main))main.focus({preventScroll:true});});}});

  function setCrumb(html) { crumb.innerHTML = html;document.title=QI.resolve(crumb.textContent)+' · Qoopia'; }
  window.addEventListener('qoopia:language',()=>{document.title=crumb.textContent+' · Qoopia';});

  // ---------- Router ----------
  async function route(force) {
    // Refresh drops cached agent data; the open agent card is a snapshot of that list.
    if (force) {
      agentsCache = null;
      const drill = state.drill;
      if (drill?.kind === 'agent') {
        try { const fresh = ((await api('/api/dashboard/agents')).items || []).find(x => x.id === drill.agent.id); if (fresh) drill.agent = fresh; }
        catch (e) { if (e.message === 'unauthorized') return; /* Otherwise keep the snapshot; the tab body reports the failure. */ }
        if (state.drill !== drill) return; // The user moved on while this loaded.
      }
    }
    pollFn = null;
    renderNav();
    if (state.drill) {
      if (state.drill.kind === 'agent') return renderAgentDetail();
      if (state.drill.kind === 'session') return renderSession();
      if (state.drill.kind === 'acthread') return renderAcThread();
    }
    if (state.page === 'external') return renderBridgesPage(true);
    if (state.page === 'work') return renderWorkspace();
    if (state.page === 'connections') return renderConnections();
    if (state.page === 'overview') return renderOverview();
    if (state.page === 'profile') return renderProfile();
    if (state.page === 'owner') return renderOwner();
    if (state.page === 'agents') return renderAgentsPage();
    if (state.page === 'agentcomm') return renderAgentCommPage();
    if (state.page === 'bridges') return renderBridgesPage();
    if (state.page === 'canon') return renderCanonPage();
    if (state.page === 'skills') return renderSkillsPage();
    if (state.page === 'files') return renderFilesPage();
    if (state.page === 'search') return renderSearchPage();
  }
  // Links in generated markup name their target in data attributes; the page's CSP allows no inline handlers.
  document.addEventListener('click', e => {
    const link = e.target.closest && e.target.closest('[data-go],[data-route]'); if (!link) return;
    e.preventDefault(); if (link.hasAttribute('data-route')) route(); else go(link.dataset.go);
  });

  // single global poll loop, paused when tab hidden
  let lastPoll=0,pollRunning=false;async function pollPage(){if(pollRunning||!pollFn)return;pollRunning=true;try{await pollFn();}catch{/* Each page's poll shows its own failure; this only keeps the loop alive. */}finally{pollRunning=false;}}setInterval(() => { if (!document.hidden && pollFn && Date.now()-lastPoll>=5000){lastPoll=Date.now();void pollPage();} }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollFn) void pollPage(); });

  // ================= FILES =================
  function humanSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + (" " + QI.msg("B"));
    if (n < 1048576) return (n / 1024).toFixed(1) + (" " + QI.msg("KB"));
    return (n / 1048576).toFixed(1) + (" " + QI.msg("MB"));
  }
  // Folders are paths ('inbox', 'research/reports'); one exists while it holds a file. Agents save into
  // their own folder with file_put; the owner uploads anywhere and opens a new folder in place.
  // The top level shows every folder and the latest files; an upload there goes to inbox.
  let filesPath = '', filesFolders = [], filesNew = [];
  async function renderFilesPage() {
    setCrumb(("<span class=\"text-primary\">" + QI.msg("Files") + "</span>")); filesPath = '';
    main.innerHTML =
      '<div class="panel files" id="fPanel">' +
        ("<div class=\"panel-h\"><h1>" + QI.msg("Files") + "</h1><span class=\"meta\">" + QI.msg("Yours and your agents’ files · any agent can read them") + "</span></div>") +
        '<div class="files-bar"><nav class="files-path" id="fPath" aria-label="Folder" data-i18n-aria-label="Folder"></nav>' +
          '<button type="button" class="btn" id="fNew">' + QI.msg("New folder") + '</button>' +
          '<label class="btn primary" id="fDrop"><input type="file" id="fInput" multiple class="file-picker-hidden">' + QI.msg("Upload") + '</label></div>' +
        '<form class="files-new" id="fNewForm" hidden><input class="input-text" id="fNewName" maxlength="120" aria-label="Folder name" data-i18n-aria-label="Folder name" placeholder="' + esc(QI.msg("Folder name")) + '">' +
          '<button class="btn primary">' + QI.msg("Create") + '</button><button type="button" class="btn" id="fNewCancel">' + QI.msg("Cancel") + '</button></form>' +
        '<p id="fProg" class="meta" role="status" aria-live="polite"></p>' +
        ("<div id=\"fList\" class=\"loading\">" + QI.msg("Loading…") + "</div>") +
      '</div>';
    const inp = $('#fInput'), panel = $('#fPanel'), form = $('#fNewForm');
    inp.onchange = () => { filesUpload(inp.files); inp.value = ''; };
    panel.ondragover = (e) => { e.preventDefault(); panel.classList.add('drop'); };
    panel.ondragleave = () => panel.classList.remove('drop');
    panel.ondrop = (e) => { e.preventDefault(); panel.classList.remove('drop'); if (e.dataTransfer.files.length) filesUpload(e.dataTransfer.files); };
    $('#fNew').onclick = () => { form.hidden = false; $('#fNewName').focus(); };
    $('#fNewCancel').onclick = () => { form.hidden = true; };
    form.onsubmit = (e) => {
      e.preventDefault(); const name = $('#fNewName').value.trim();
      if (!name || /[/\\]|^\.\.?$/.test(name)) { $('#fProg').textContent = QI.msg("Use a folder name without slashes."); return; }
      const path = (filesPath ? filesPath + '/' : '') + name;
      filesNew.push(path); form.hidden = true; $('#fNewName').value = ''; $('#fProg').textContent = '';
      filesPath = path; void filesLoadList();
    };
    $('#fPath').onclick = (e) => { const b = e.target.closest('[data-path]'); if (b) { filesPath = b.dataset.path; void filesLoadList(); } };
    await filesLoadFolders();
  }
  async function filesLoadFolders() {
    try {
      filesFolders = (await api('/api/dashboard/files/folders')).folders || [];
      setConn(true);
    } catch (e) { if (e.message === 'unauthorized') return; }
    await filesLoadList();
  }
  async function filesLoadList() {
    const list = $('#fList'); if (!list) return;
    const here = filesPath, prefix = here ? here + '/' : '', kids = new Map();
    // The next path part of every deeper folder, with the files under it.
    for (const f of filesFolders.concat(filesNew.map(folder => ({ folder, count: 0 }))))
      if (f.folder.startsWith(prefix) && f.folder !== here) { const name = f.folder.slice(prefix.length).split('/')[0]; kids.set(name, (kids.get(name) || 0) + f.count); }
    const path = $('#fPath'), parts = here ? here.split('/') : [];
    if (path) path.innerHTML = '<button type="button" data-path="">' + QI.msg("All files") + '</button>' + parts.map((part, i) =>
      '<span aria-hidden="true">/</span>' + (i === parts.length - 1 ? '<strong aria-current="page">' + esc(part) + '</strong>' : '<button type="button" data-path="' + esc(parts.slice(0, i + 1).join('/')) + '">' + esc(part) + '</button>')).join('');
    let files;
    try { files = (await api('/api/dashboard/files' + (here ? '?folder=' + encodeURIComponent(here) : ''))).files || []; }
    catch (e) { errBox(list, QI.msg("Failed to load files."), filesLoadList, e); return; }
    if (filesPath !== here || !list.isConnected) return;
    const folderIcon = lineIcon('<path d="M3 6h6l2 2h10v11H3z"/>');
    const rows = [...kids].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) =>
      '<button type="button" class="f-row f-folder" data-path="' + esc(prefix + name) + '">' + folderIcon + '<span class="f-name">' + esc(name) + '</span><span class="meta">' + QI.count(n, 'file') + '</span></button>')
      .concat(files.map(f => '<div class="f-row"><span class="f-name">' + esc(f.filename) + '</span><span class="meta">' + (here ? '' : esc(f.folder) + ' · ') + humanSize(f.size) + ' · ' + fmtTime(f.created_at) +
        (f.uploaded_by ? ' · ' + esc(f.uploaded_by) : '') + '</span><a class="btn-more" href="' + BASE + '/api/dashboard/files/' + encodeURIComponent(f.id) + '/download">' + QI.msg("Download") + '</a>' +
        '<button type="button" class="btn-more" data-del="' + esc(f.id) + '">' + QI.msg("Delete") + '</button></div>'));
    list.className = rows.length ? 'files-list' : 'empty';
    list.innerHTML = rows.length ? rows.join('') : here ? QI.msg("This folder is empty. It is kept once a file is added.") : QI.msg("No files yet. Upload one, or ask an agent to save one here.");
    list.querySelectorAll('[data-path]').forEach(b => b.onclick = () => { filesPath = b.dataset.path; void filesLoadList(); });
    list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => filesDelete(b.getAttribute('data-del')));
    setConn(true);
  }
  // A refused batch stores nothing: the server names the reason, the dashboard words it.
  function uploadRefusal(j) {
    if (j && j.reason === 'empty_file') return QI.msg('Nothing was uploaded: {file} is empty.', { file: j.file });
    if (j && j.reason === 'invalid_filename') return QI.msg('Nothing was uploaded: rename {file} to at most 180 characters, without control or text-direction characters.', { file: j.file });
    if (j && j.reason === 'invalid_folder') return QI.msg('Nothing was uploaded: use a folder name of at most 200 characters, without control or text-direction characters, backslashes, or empty, “.” or “..” parts.');
    return '';
  }
  function filesUpload(fileList) {
    if (!fileList || !fileList.length) return;
    const folder = filesPath || 'inbox';
    const prog = $('#fProg'); if (prog) prog.textContent = QI.msg("Uploading") + " " + QI.count(fileList.length, 'file') + "…";
    // Bun's multipart parser drops an empty file's name, so name it here before sending.
    const empty = [].find.call(fileList, f => !f.size);
    if (empty) { if (prog) prog.textContent = uploadRefusal({ reason: 'empty_file', file: empty.name }); return; }
    const fd = new FormData();
    fd.append('folder', folder);
    for (const f of fileList) fd.append('file', f);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/api/dashboard/files');
    xhr.setRequestHeader('X-Qoopia-CSRF', '1');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && prog) prog.textContent = (QI.msg("Uploading…") + " ") + Math.round(e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      if (xhr.status === 401) { showLogin(); return; }
      if (xhr.status === 403) { if (prog) prog.textContent = (QI.msg("Only the owner can upload.")); return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (prog) prog.textContent = (QI.msg("Uploaded ✓"));
        filesNew = filesNew.filter(f => f !== folder); filesPath = folder; void filesLoadFolders();
      } else if (xhr.status === 413) { if (prog) prog.textContent = QI.msg('File too large (maximum 100 MB).'); }
      else if (xhr.status === 429) { if (prog) prog.textContent = QI.msg('Qoopia is reading other files right now. Nothing was saved; try again in a minute.'); }
      else { var d = ''; try { var j = JSON.parse(xhr.responseText); d = ' — ' + (j.detail || j.error || ''); } catch { /* Non-JSON error body; the status code is shown alone. */ } if (prog) prog.textContent = uploadRefusal(j) || QI.msg('Could not load (') + xhr.status + ')' + d; }
    };
    xhr.onerror = () => { if (prog) prog.textContent = (QI.msg("Upload error.")); };
    xhr.send(fd);
  }
  async function filesDelete(id) {
    if(!window.confirm(QI.resolve(QI.msg('Delete this file? This cannot be undone.'))))return;
    try {
      const r = await send(BASE + '/api/dashboard/files/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Qoopia-CSRF': '1' } });
      if (r.status === 401) { showLogin(); return; }
      if (r.status === 403) { alert((QI.msg("Only the owner can delete."))); return; }
      if (!r.ok) throw failure(r, await r.json().catch(() => ({})));
      await filesLoadFolders();
    } catch (e) { alert((QI.msg("Delete failed:") + " ") + e.message + (QI.msg(". The file list was not changed."))); }
  }

  // ================= OVERVIEW =================
  function renderProfile() {
    setCrumb(QI.msg('Profile'));
    const email=$('#ownerEmail').textContent;
    const address=location.origin+'/dashboard';
    const ownerPanel=serviceOwner?'<button class="btn" id="profileOwnerPanel" type="button">'+esc(QI.msg('Owner dashboard'))+'</button>':'';
    main.innerHTML='<section class="dashboard-profile"><header class="page-heading"><div><h1>'+esc(QI.msg('Profile'))+'</h1><p>'+esc(QI.msg('You are signed in to this workspace.'))+'</p></div></header>'+
      '<dl class="profile-details"><div><dt>'+esc(QI.msg('Email address'))+'</dt><dd>'+esc(email||QI.msg('No email linked to this dashboard session.'))+'</dd></div>'+
      '<div><dt>'+esc(QI.msg('Workspace address'))+'</dt><dd>'+esc(address)+'</dd></div></dl>'+
      '<div class="profile-actions">'+ownerPanel+'<button class="btn" id="profileCopy" type="button">'+esc(QI.msg('Copy address'))+'</button><button class="btn" id="profileLogout" type="button">'+esc(QI.msg('Logout'))+'</button></div></section>';
    $('#profileCopy').onclick=e=>copyText(e.currentTarget,address);
    $('#profileLogout').onclick=()=>$('#logoutBtn').click();
    if(serviceOwner)$('#profileOwnerPanel').onclick=()=>go('owner');
  }

  async function renderOwner(page=ownerPage) {
    setCrumb(QI.msg('Owner dashboard'));
    main.innerHTML='<section class="dashboard-owner"><header class="page-heading"><div><h1>'+esc(QI.msg('Owner dashboard'))+'</h1></div><button class="btn" id="ownerBack" type="button">'+esc(QI.msg('Profile'))+'</button></header><div id="ownerContent" role="region" aria-live="polite"><p class="loading">'+esc(QI.msg('Loading…'))+'</p></div></section>';
    $('#ownerBack').onclick=()=>go('profile');
    const view=$('#ownerContent');
    try {
      const data=await api('/api/dashboard/service-owner?lang='+encodeURIComponent(QI.language)+'&page='+page);
      if(state.page!=='owner'||!view.isConnected)return;
      ownerPage=page;view.innerHTML=data.html;
      view.onclick=e=>{
        const link=e.target.closest?.('a[data-owner-page],a[data-owner-refresh],a[data-owner-section]');
        if(!link)return;
        e.preventDefault();
        if(link.dataset.ownerPage!==undefined)return void renderOwner(Number(link.dataset.ownerPage));
        if(link.dataset.ownerRefresh!==undefined)return void renderOwner(ownerPage);
        view.querySelector('#'+link.dataset.ownerSection)?.scrollIntoView({behavior:motion(),block:'start'});
      };
    } catch(e) {
      if(state.page==='owner'&&view.isConnected)errBox(view,QI.msg('Could not load the owner dashboard.'),()=>renderOwner(page),e);
    }
  }

  window.addEventListener('qoopia:language',()=>{
    if(state?.page==='owner')void renderOwner(ownerPage);
  });

  // Four tiles that open their pages, then what the agents do, newest first, refreshed every 5 s.
  async function renderOverview() {
    setCrumb(QI.msg('Overview'));
    main.innerHTML='<section class="overview"><header class="page-heading"><h1>'+esc(QI.msg('Overview'))+'</h1>'+(localWorkspace?'<button class="btn primary" id="overviewChat">'+esc(QI.msg('Open chat'))+'</button>':'')+'</header>'+
      '<div class="ov-tiles" id="ccCards"><p class="loading">'+esc(QI.msg('Loading…'))+'</p></div>'+
      '<section id="canonProposals" aria-live="polite" hidden></section>'+
      '<section aria-labelledby="feedTitle"><h2 class="section-title" id="feedTitle">'+esc(QI.msg('Live activity'))+'</h2><div class="feed" id="ccFeed"></div></section>'+
      '<details class="system-status"><summary>'+esc(QI.msg('System status'))+'</summary><div class="health" id="ccHealth"></div></details></section>';
    if($('#overviewChat'))$('#overviewChat').onclick=()=>chat?.open();
    const view=$('#ccCards');await fillOverview();if(view.isConnected)pollFn=fillOverview;
  }

  async function fillOverview() {
    const view=$('#ccCards');if(!view)return;
    try {
      const [ov, act, agts, proposals] = await Promise.all([
        api('/api/dashboard/overview'),
        api('/api/dashboard/activity?limit=100'),
        api('/api/dashboard/agents'),
        localWorkspace?api('/api/dashboard/canon-proposals'):Promise.resolve({items:[]}),
      ]);
      if(!view.isConnected)return;
      setConn(true);
      agentsCache = agts.items;
      paintCards(ov, agentsCache || []);
      paintHealth(ov.health);
      paintFeed(act.items, $('#ccFeed'));
      paintCanonProposals(proposals.items);
    } catch (e) { errBox($('#ccCards'), QI.msg("Could not load the overview."), fillOverview, e); }
  }

  function paintCanonProposals(items) {
    const view=$('#canonProposals');if(!view)return;
    view.hidden=!items.length;
    const version=JSON.stringify(items);if(view.dataset.version===version)return;view.dataset.version=version;
    view.innerHTML='<h2 class="section-title">'+QI.msg('Rules from the nightly review')+'</h2><p class="meta">'+QI.msg('These are drafts. Only an accepted rule is loaded into context.')+'</p>'+items.map(p=>
      '<article class="canon-item"><p class="canon-text">'+esc(p.text)+'</p><p class="meta">'+esc(canonScope(p))+' · '+esc(canonMode(p))+'</p><p>'+esc(p.reason)+'</p><details><summary>'+QI.msg('Sources')+'</summary><ul>'+p.source_refs.map(ref=>'<li class="mono">'+esc(ref)+'</li>').join('')+'</ul></details><div class="work-actions"><button type="button" data-proposal-id="'+esc(p.id)+'" data-accept="true">'+QI.msg('Accept rule')+'</button><button type="button" data-proposal-id="'+esc(p.id)+'" data-accept="false">'+QI.msg('Reject rule')+'</button></div><p role="status" class="meta"></p></article>').join('');
    view.querySelectorAll('[data-proposal-id]').forEach(button=>button.onclick=async()=>{
      const row=button.closest('article'),buttons=[...row.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
      try{await apiWrite('/api/dashboard/canon-proposals/'+encodeURIComponent(button.dataset.proposalId)+'/decision',{accept:button.dataset.accept==='true'});await fillOverview();}
      catch(e){row.querySelector('[role=status]').textContent=e.message;buttons.forEach(b=>b.disabled=false);}
    });
  }

  function paintCards(ov, agents) {
    const tile = (page, label, value, more = '') => '<a class="ov-tile' + (more ? ' ov-wide' : '') + '" href="#' + page + '" data-id="' + page + '"><span class="ov-label">' + esc(QI.msg(label)) + '</span>' +
      '<strong>' + fmtNum(value) + '</strong>' + more + '</a>';
    // The owner sees which MCP clients reach this workspace; an agent's own view has no Connections page.
    const conns = ov.connections, chips = conns && '<span class="ov-chips">' + (conns.length ? conns.map(c => '<span class="chip" title="' + esc(c.name) + '">' + esc(c.client || SURFACE_NAMES[c.surface] || c.name) + '</span>').join('')
      : '<span class="ov-none">' + esc(QI.msg("None connected")) + '</span>') + '</span>';
    patch($('#ccCards'), tile('agents', 'Active agents', agents.filter(a => !isInfra(a) && a.type !== 'owner').length) +
      (conns ? tile('connections', 'Connections', conns.length, chips) : '') + (localWorkspace ? tile('bridges', 'Bridges', ov.bridges?.total) : '') + tile('files', 'Files', ov.files?.total));
  }
  function paintHealth(h) {
    if (!h) { $('#ccHealth').innerHTML = ("<div class=\"hi\">" + QI.msg("Health unavailable") + "</div>"); return; }
    const embedOk = !!h.embed_endpoint;
    const bk = h.verified_backup;
    const bkDot = bk && bk.status === 'pass' ? '' : 'amber';
    const bkTxt = bk && bk.status === 'pass' ? 'verified' : esc(bk&&bk.reason?QI.code(bk.reason):QI.msg('not verified'));
    const ops = h.operations;
    const pending = ops && Number.isInteger(ops.pending) ? ops.pending : null;
    const opsText = pending === null ? (QI.msg("status unknown")) : pending + (" " + QI.msg("unsent")) + (ops.delivery_hold ? (" " + QI.msg("· recovery replay held; owner authorization required")) : ops.status === 'degraded' ? (" " + QI.msg("· maintenance degraded")) : '');
    $('#ccHealth').innerHTML =
      hItem('', (QI.msg("Schema")), 'v' + (h.schema_version != null ? h.schema_version : '?')) +
      hItem('', (QI.msg("Recall")), esc(QI.code(h.recall_mode || '—'))) +
      hItem('', (QI.msg("Uptime")), humanDur(h.uptime_seconds)) +
      hItem(bkDot, (QI.msg("Backup")), bkTxt) +
      hItem(pending === 0 && ops.status === 'ok' ? '' : 'amber', (QI.msg("Alerts")), esc(opsText)) +
      hItem(embedOk ? '' : 'red', (QI.msg("Embeddings")), QI.msg(embedOk?'On':'Off')) +
      ("<div class=\"hi align-end\"><span class=\"k\">" + QI.msg("Server") + "</span><span class=\"v\">") + esc((h.now || '').replace('T', ' ').slice(0, 19)) + 'Z</span></div>';
  }
  function hItem(dot, k, v) {
    return '<div class="hi">' + (dot !== undefined ? '<span class="hdot ' + dot + '"></span>' : '') +
      '<span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  }

  // Server summaries are English and carry raw ids ("Created note 01M4…"). Events Qoopia itself records read as
  // a sentence in the page language, with names and topics kept verbatim; anything else (a summary an agent
  // wrote itself) is shown as written. The original summary stays in the row's tooltip.
  const NOTE_EVENTS = { created: 'Note saved', updated: 'Note updated', deleted: 'Note deleted', note_superseded: 'Note replaced by a newer version' };
  // A4-02: the server sends an event code and its parameters (src/services/activity.ts ACTIVITY_EVENTS).
  const ACTIVITY_EVENTS = {
    'note.created': 'Note saved', 'note.updated': 'Note updated', 'note.deleted': 'Note deleted', 'note.superseded': 'Note replaced by a newer version', 'note.relation.created': 'Notes linked',
    'file.uploaded': 'File {name} uploaded to {folder}', 'file.deleted': 'File {name} deleted from {folder}',
    'agentcomm.session.created': 'Agent conversation started: {topic}', 'agentcomm.session.closed': 'Agent conversation closed', 'agentcomm.message.sent': 'Message to {name}',
    'agentcomm.wake.woken': 'Woke {name} for a new message', 'agentcomm.wake.failed': 'Could not wake {name}; the message waits in the inbox', 'agentcomm.wake.ignored': '{name} was not woken; the message waits in the inbox',
    'agent.onboarded': 'Agent {name} added', 'agent.onboarded_with_role': 'Agent {name} added with role {role}', 'agent.deactivated': 'Agent {name} deactivated; application sign-ins revoked: {tokens}',
    'agent.profile_changed': 'Access profile of {name} changed: {from} → {to}', 'agent.autosave.on': '{name}: automatic saving turned on', 'agent.autosave.off': '{name}: saves only on request',
    'agent.shared_context.on': '{name}: shared context turned on', 'agent.shared_context.off': '{name}: reads only its own context',
    'agent.dreamer.on': '{name} is now the dreamer', 'agent.dreamer.off': '{name} is no longer the dreamer',
    'canon.created': 'Canon added', 'canon.superseded': 'Canon replaced by a new wording', 'canon.retired': 'Canon retired', 'canon.imported': 'Rule notes imported as canons: {count}',
    'extraction.candidate.accepted': 'Suggested note accepted', 'extraction.candidate.edited': 'Suggested note accepted with edits', 'extraction.candidate.rejected': 'Suggested note declined',
  };
  function activityText(it) {
    if (ACTIVITY_EVENTS[it.event]) return QI.msg(ACTIVITY_EVENTS[it.event], it.params || {});
    const s = it.summary || '', x = re => s.match(re);let m;
    if (it.entity_type === 'note' && NOTE_EVENTS[it.action]) return QI.msg(NOTE_EVENTS[it.action]);
    if (it.action === 'relation_created') return QI.msg('Notes linked');
    if (it.action === 'file_upload' && (m = x(/^Uploaded (.+) to (.+)$/))) return QI.msg('File {name} uploaded to {folder}', { name: m[1], folder: m[2] });
    if (it.action === 'file_delete' && (m = x(/^Deleted (.+) from (.+)$/))) return QI.msg('File {name} deleted from {folder}', { name: m[1], folder: m[2] });
    if (it.action === 'agent_session_create' && (m = x(/^Created agent session: (.*)$/))) return QI.msg('Agent conversation started: {topic}', { topic: m[1] });
    if (it.action === 'agent_session_close') return QI.msg('Agent conversation closed');
    if (it.action === 'agent_send' && (m = x(/^Agent message \S+ to (.+)$/))) return QI.msg('Message to {name}', { name: m[1] });
    return s || it.action + (it.entity_type ? ' · ' + it.entity_type : '');
  }
  // One line per event: when, who, what. The agent's name opens the agent. The same event repeated
  // in a row (a summary rewritten again and again) is one line with a count, at its latest time.
  function paintFeed(items, el) {
    if (!el) return;
    if (!items || !items.length) { patch(el, "<div class=\"empty\">" + QI.msg("No activity yet.") + "</div>"); return; }
    const today = new Date().toDateString(), rows = [];
    for (const it of items) { const last = rows[rows.length - 1]; if (last && last.agent_id === it.agent_id && last.action === it.action && last.summary === it.summary) last.n++; else rows.push({ ...it, n: 1 }); }
    patch(el, rows.map(it => {
      const st = actionStyle(it.action), who = it.agent_name || (it.agent_id ? it.agent_id.slice(0, 8) : QI.msg('System'));
      return '<div class="frow" title="' + esc(fmtTimeFull(it.created_at) + ' · ' + (it.summary || it.action) + (it.origin_host ? ' @' + it.origin_host : '')) + '">' +
        '<span class="ftime">' + QI.date(it.created_at, { ...(new Date(it.created_at).toDateString() === today ? {} : { day: 'numeric', month: 'short' }), hour: '2-digit', minute: '2-digit' }) + '</span><span class="fic">' + st.icon + '</span>' +
        (it.agent_id ? '<button type="button" class="chip click" data-aid="' + esc(it.agent_id) + '" data-id="' + esc(it.id || '') + '">' + esc(who) + '</button>' : '<span class="chip">' + esc(who) + '</span>') +
        '<span class="fline">' + esc(activityText(it)) + (it.n > 1 ? ' <span class="fcount">×' + it.n + '</span>' : '') + '</span></div>';
    }).join(''));
    el.querySelectorAll('[data-aid]').forEach(c => {
      c.onclick = () => drillAgentById(c.getAttribute('data-aid'));
    });
  }

  // ================= AGENTS PAGE =================
  // Real working agents go to the main board; only genuine infra / ephemeral
  // agents (ingest daemon, smoke/test, dashboard-*, tailer, agentcomm helpers)
  // are bucketed into the dimmed "System" section. No hardcoded persona list.
  function isInfra(a) {
    if (!a) return false;
    if (a.type === 'ingest-daemon') return true;
    const n = (a.name || '').toLowerCase();
    return /(^system$|^tailer$|^v3-admin$|smoke|^test|dashboard-|agentcomm)/.test(n);
  }
  function lastActiveTs(a) {
    return new Date(a.last_session_active || a.last_seen || 0).getTime() || 0;
  }
  function byRecent(a, b) { return lastActiveTs(b) - lastActiveTs(a); }
  // The owner first, the steward second, then the agents of each runtime in this order, then the rest.
  const RUNTIMES = { claude: 'Claude', claude_code: 'Claude Code', chatgpt: 'ChatGPT', codex: 'Codex', grok: 'Grok', muse: 'Muse', hermes: 'Hermes' };
  function agentRank(a) { const i = Object.keys(RUNTIMES).indexOf(a.runtime); return a.type === 'owner' ? 0 : a.type === 'steward' ? 1 : i < 0 ? 9 : 2 + i; }
  function byRank(a, b) { return agentRank(a) - agentRank(b) || byRecent(a, b); }
  function agentRole(a) { return a.type === 'owner' ? QI.msg("Owner") : a.type === 'steward' ? QI.msg("Steward") : RUNTIMES[a.runtime] || ''; }
  // One flat row per agent: identity, memory state, the owner's two switches and the counts.
  // A switch changes its setting in place; only the name opens the agent. The owner reads the whole
  // workspace and needs no autosave, so its row has no switch; the steward has only autosave.
  function agentSwitch(kind, a, on, enabled, label) {
    return '<div class="ar-switch ar-' + kind + '"><span class="ar-label" aria-hidden="true">' + esc(label) + '</span>' +
      '<button type="button" class="qswitch" role="switch" data-id="' + kind + ':' + esc(a.id) + '" data-switch="' + kind + '" data-agent="' + esc(a.id) + '"' +
      ' aria-checked="' + on + '" aria-label="' + esc(label + ': ' + a.name) + '"' +
      (enabled ? '' : ' aria-disabled="true" aria-describedby="switchLockReason"') + '><span class="qswitch-thumb"></span></button></div>';
  }
  function agentCount(n, unit) {
    return '<span class="ar-num"><b aria-hidden="true">' + fmtNum(n) + '</b><span class="ar-unit">' + QI.count(n || 0, unit) + '</span></span>';
  }
  function agentCard(a) {
    const lastIso = a.last_session_active || a.last_seen, owner = a.type === 'owner', mem = !owner && a.memory, saves = mem?.pending_saves || 0, role = agentRole(a);
    const shared = typeof a.shared_context === 'boolean' ? agentSwitch('shared', a, a.shared_context, a.can_switch_shared_context === true, QI.msg("Shared context"))
      : a.shared_context === null ? '<div class="ar-switch ar-shared"><span class="ar-label" aria-hidden="true">' + esc(QI.msg("Shared context")) + '</span><span class="ar-always">' + esc(QI.msg("Whole workspace")) + '</span></div>' : '<div></div>';
    // ADR-022: the dreamer reads every conversation of the workspace; only the owner switches it.
    const dreamer = typeof a.dreamer === 'boolean' ? agentSwitch('dreamer', a, a.dreamer, a.can_switch_dreamer === true, QI.msg("Dreamer")) : '<div></div>';
    return '<div class="agent-row' + (owner ? ' agent-row-owner' : '') + '">' +
      '<button type="button" class="agent-card" data-id="' + esc(a.id) + '">' +
        '<span class="agent-avatar ' + avatarClass(a.name) + '" aria-hidden="true">' + initial(a.name) + '</span>' +
        '<span class="ar-id"><span class="agent-name">' + esc(a.name) + '</span>' +
        '<span class="agent-meta">' + (role ? esc(role) + ' · ' : '') + fmtTime(lastIso) + liveStatus(lastIso) + '</span></span></button>' +
      '<div class="ar-status">' + (mem ? coverageLine(a) : '') +
        (saves ? '<button type="button" class="ar-saves" data-id="saves:' + esc(a.id) + '" data-open="' + esc(a.id) + '">' + esc(QI.msg("{n} to confirm", { n: saves })) + '</button>' : '') + '</div>' +
      (mem ? agentSwitch('autosave', a, mem.mode === 'auto', a.can_manage_memory === true, QI.msg("Autosave")) : '<div></div>') + shared + dreamer +
      agentCount(a.sessions_count, 'session') + agentCount(a.messages_count, 'message') + agentCount(a.notes_count, 'note') + '</div>';
  }
  function agentTable(items) {
    return '<div class="agent-table"><div class="agent-row agent-row-head" aria-hidden="true"><span>' + esc(QI.msg("Agent")) + '</span><span>' + esc(QI.msg("Memory")) +
      '</span><span>' + esc(QI.msg("Autosave")) + '</span><span>' + esc(QI.msg("Shared context")) + '</span><span>' + esc(QI.msg("Dreamer")) + '</span><span>' + esc(QI.msg("Sessions")) + '</span><span>' +
      esc(QI.msg("Messages")) + '</span><span>' + esc(QI.msg("Notes")) + '</span></div>' + items.map(agentCard).join('') + '</div>';
  }
  function paintAgentsBoard(el, items) {
    if (!el) return;
    if (!items || !items.length) { patch(el, "<div class=\"empty\">" + QI.msg("No agents.") + "</div>"); return; }
    const live = items.filter(a => !isInfra(a)).sort(byRank);
    const sys = items.filter(a => isInfra(a)).sort(byRecent);
    let html = agentTable(live);
    // A4-13: a locked switch stays focusable (aria-disabled) and its reason is on the page, not only in a tooltip.
    if (html.includes('aria-disabled="true"')) html = '<p class="meta" id="switchLockReason">' + QI.msg("Only the workspace owner can change autosave and shared context.") + '</p>' + html;
    if (sys.length) html += '<h2 class="section-title system-title">' + QI.msg("System & integration agents") + '</h2><div class="system-grid">' + agentTable(sys) + '</div>';
    patch(el, html);
    el.querySelectorAll('.agent-card,[data-open]').forEach(c => { c.onclick = () => drillAgentById(c.getAttribute('data-open') || c.getAttribute('data-id')); });
    el.querySelectorAll('[data-switch]').forEach(s => { s.onclick = () => switchAgentSetting(s); });
  }
  // Optimistic: the switch moves at once, returns on failure, and the row is re-read either way.
  async function switchAgentSetting(button) {
    const a = (agentsCache || []).find(x => x.id === button.dataset.agent), status = $('#uiFeedback');
    if (button.getAttribute('aria-disabled') === 'true') { if (status) status.textContent = QI.msg("Only the workspace owner can change this."); return; }
    if (!a || button.getAttribute('aria-busy') === 'true') return;
    const on = button.getAttribute('aria-checked') === 'true', autosave = button.dataset.switch === 'autosave', dreamer = button.dataset.switch === 'dreamer';
    // aria-busy, not disabled: a disabled button drops keyboard focus, and the repaint restores it by data-id.
    button.setAttribute('aria-busy', 'true'); button.setAttribute('aria-checked', String(!on));
    try {
      if (autosave) await apiWrite('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/memory-policy', { mode: on ? 'manual' : 'auto', expected_revision: a.memory.revision });
      else await apiWrite('/api/dashboard/agents/' + encodeURIComponent(a.id) + (dreamer ? '/dreamer' : '/shared-context'), { enabled: !on });
      if (status) status.textContent = autosave ? (on ? QI.msg("{name} saves only on request.", { name: a.name }) : QI.msg("Automatic saving is on for {name}.", { name: a.name }))
        : dreamer ? (on ? QI.msg("{name} is no longer the dreamer.", { name: a.name }) : QI.msg("{name} is now the dreamer and reads every conversation of the workspace.", { name: a.name }))
        : (on ? QI.msg("{name} now reads only its own context.", { name: a.name }) : QI.msg("{name} now reads the shared context.", { name: a.name }));
    } catch (e) {
      button.setAttribute('aria-checked', String(on));
      if (status && e.message !== 'unauthorized') status.textContent = e.status === 403 ? QI.msg("Only the workspace owner can change this.") : QI.msg("Could not complete this.") + ' ' + e.message;
    }
    button.removeAttribute('aria-busy');
    try { agentsCache = (await api('/api/dashboard/agents')).items; } catch { return; }
    paintAgentsBoard($('#agentsWrap'), agentsCache);
  }
  async function renderAgentsPage() {
    setCrumb(("<span class=\"text-primary\">" + QI.msg("Agents") + "</span>"));
    main.innerHTML = ("<h1 class=\"section-title\">" + QI.msg("Your agents · open their notes and sessions") + "</h1><div id=\"agentsWrap\"><div class=\"loading\">" + QI.msg("Loading agents…") + "</div></div>");
    try {
      const d = await api('/api/dashboard/agents');
      setConn(true); agentsCache = d.items;
      paintAgentsBoard($('#agentsWrap'), d.items || []);
    } catch (e) { errBox($('#agentsWrap'), QI.msg("Failed to load agents."), renderAgentsPage, e); }
  }

  function drillAgentById(id) {
    const a = (agentsCache || []).find(x => x.id === id);
    if (a) openDrill('agents', { kind: 'agent', agent: a, tab: 'sessions', noteType: null });
  }

  // ================= AGENT DETAIL (drill-down, preserved) =================
  // Wanted mode and the factual channel state are shown together; the glyph and the text
  // carry the meaning, colour only reinforces it.
  const memoryState = state => ({
    working: ['●', QI.msg("Saving automatically")], manual: ['○', QI.msg("Only on request")],
    waiting: ['◌', QI.msg("Waiting for this agent to connect")], behind: ['◐', QI.msg("Saving; the summary is catching up")],
    sign_in: ['!', QI.msg("The memory model needs sign-in or quota")], error: ['!', QI.msg("Saving needs attention")]
  })[state];
  // "waiting" only says no conversation has arrived. An agent that has signed in is connected: it
  // writes notes, but its client (Grok, ChatGPT, Claude web…) sends no conversations by itself.
  const agentMemoryState = a => a.memory.state === 'waiting' && a.last_seen
    ? ['○', QI.msg("Connected · conversations are not saved automatically")] : memoryState(a.memory.state);
  // One contract for every agent: the same rows the agent reads in qoopia_capabilities.
  const mechanismState = status => ({
    available: ['●', QI.msg("Available")], forbidden: ['○', QI.msg("Not permitted")], client_unsupported: ['◌', QI.msg("The client cannot do this")],
    needs_setup: ['◐', QI.msg("Needs setup")], faulty: ['!', QI.msg("Needs attention")]
  })[status] || ['!', QI.msg("Needs attention")];
  function coverageLine(a) {
    const st = a.memory && agentMemoryState(a); if (!st) return '';
    return '<div class="agent-meta coverage-line" title="' + esc(st[1]) + '"><span aria-hidden="true">' + st[0] + '</span> ' + esc(st[1]) + '</div>';
  }
  // The agent's page opens straight on its workspace; autosave and shared context are switched in its row.
  // Saves an agent prepared while it saves only on request wait here for the owner.
  function savesPanel(a) {
    const n = a.type !== 'owner' && a.memory?.pending_saves; if (!n) return '';
    return '<section class="memory-saves" id="memorySaves" aria-labelledby="memorySavesTitle"><h2 id="memorySavesTitle">' + esc(QI.msg("Waiting for your confirmation:")) + ' ' + fmtNum(n) + '</h2>' +
      '<p id="memoryResult" role="status" aria-live="polite"></p></section>';
  }
  // The agent prepared these notes while it saves only on request; nothing is memory until the owner confirms.
  async function bindMemorySaves(a) {
    const host = $('#memorySaves'); if (!host) return;
    let items; try { items = ((await api('/api/dashboard/memory-saves')).items || []).filter(x => x.agent_id === a.id); }
    catch (e) { host.insertAdjacentHTML('beforeend', '<div></div>'); const box = host.lastElementChild; errBox(box, QI.msg("Could not load the saves waiting for confirmation."), () => { box.remove(); void bindMemorySaves(a); }, e); return; }
    host.insertAdjacentHTML('beforeend', items.map(x => '<article data-save="' + esc(x.id) + '"><p class="meta">' + esc(x.operation === 'note_update' ? QI.msg("Change to an existing note") : noteTypeLabel(x.type || 'note')) +
      ' · ' + esc(QI.msg("Expires:")) + ' ' + fmtTimeFull(new Date(x.expires_at_ms).toISOString()) + '</p><pre>' + esc(x.text || '') + '</pre>' +
      '<button type="button" class="btn primary" data-accept="1">' + esc(QI.msg("Save to memory")) + '</button> <button type="button" class="btn" data-accept="">' + esc(QI.msg("Decline")) + '</button></article>').join(''));
    host.querySelectorAll('button').forEach(button => button.onclick = async () => {
      const card = button.closest('article'), result = $('#memoryResult'), accept = !!button.dataset.accept;
      card.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        await apiWrite('/api/dashboard/memory-saves/' + encodeURIComponent(card.dataset.save), { accept });
        card.remove(); result.textContent = accept ? QI.msg("Saved to memory.") : QI.msg("Declined. The prepared text was removed.");
        const left = host.querySelectorAll('article').length;
        if (a.memory) a.memory.pending_saves = left;
        if (left) host.querySelector('h2').textContent = QI.resolve(QI.msg("Waiting for your confirmation:")) + ' ' + fmtNum(left);
        else host.remove();
      } catch (e) { card.querySelectorAll('button').forEach(b => b.disabled = false); await memoryWriteFailed(e, QI.msg("Could not complete this. Only the workspace owner can confirm a save.")); }
    });
  }
  // Only 403 means "not the owner". Stale, decided or expired state re-reads the card; anything else shows the server's reason.
  async function memoryWriteFailed(e, ownerOnly) {
    if (e.message === 'unauthorized' || !$('#memoryResult')) return;
    if ([404, 409, 410].includes(e.status)) await route(true);
    const result = $('#memoryResult'); if (result) result.textContent = e.status === 403 ? ownerOnly : QI.msg("Could not complete this.") + ' ' + e.message;
  }
  // ---------- Canon (ADR-021) ----------
  // Agents and dreaming create rules. The owner views and retires them here.
  const canonScope = c => c.scope === 'workspace' ? QI.msg("Whole workspace") : c.scope === 'project' ? QI.msg("Project") : QI.msg("This agent");
  const canonMode = c => c.mode === 'always' ? QI.msg("Always loaded") : QI.msg("Loaded when relevant");
  async function renderCanonList(el, agentId) {
    const d = state.drill, page = state.page;
    try {
      const data = await api('/api/dashboard/canons?status=active&limit=200' + (agentId ? '&agent=' + encodeURIComponent(agentId) : ''));
      if (state.drill !== d || state.page !== page || !el.isConnected) return;
      setConn(true);
      el.innerHTML = '<p class="meta" id="canonResult" role="status"></p>' + (data.items.length ? '<ul class="canon-list">' + data.items.map(c =>
        '<li class="canon-item"><p class="canon-text">' + esc(c.text) + '</p><p class="meta">' + esc(canonScope(c)) + ' · ' + esc(canonMode(c)) + '</p><p class="meta">' +
          QI.msg("Loaded into turns:") + ' ' + fmtNum(c.applied_count || 0) + (c.last_applied_at ? ' · ' + QI.msg("last") + ' ' + fmtTime(c.last_applied_at) : '') +
          '</p>' + (localWorkspace ? '<button type="button" class="btn" data-retire="' + esc(c.id) + '">' + QI.msg("Retire") + '</button>' : '') + '</li>').join('') + '</ul>'
        : '<div class="empty">' + QI.msg("No canons yet. A canon is a short rule Qoopia gives the agent by itself: at every session start, or on the turns it matters for.") + '</div>');
      el.querySelectorAll('[data-retire]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await apiWrite('/api/dashboard/canons/' + encodeURIComponent(b.dataset.retire) + '/retire', {}); void renderCanonList(el, agentId); }
        catch (e) { b.disabled = false; const r = $('#canonResult'); if (r) r.textContent = e.message; }
      });
    } catch (e) { if (el.isConnected) errBox(el, QI.msg("Could not load canons."), () => renderCanonList(el, agentId), e); }
  }
  function renderCanonPage() {
    setCrumb('<span aria-current="page">' + QI.msg("Canon") + '</span>');
    main.innerHTML = '<h1 class="page-title">' + QI.msg("Canon") + '</h1><p class="ent-sum">' +
      QI.msg("Your agent creates canons when you ask; the nightly review also finds rules. View them here or retire a rule you no longer need.") +
      '</p><div id="canonBody"><div class="loading">' + QI.msg("Loading…") + '</div></div>';
    void renderCanonList($('#canonBody'), null);
  }
  function renderAgentDetail() {
    const a = state.drill.agent, role = agentRole(a), st = a.memory && a.type !== 'owner' && agentMemoryState(a);
    setCrumb('<a href="#agents" data-go="agents">' + QI.msg("Agents") + '</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">' + esc(a.name) + '</span>');
    const tabs = [['sessions', QI.msg("Sessions"), a.sessions_count], ['memory', QI.msg("Notes"), a.notes_count], ['canon', QI.msg("Canon")], ['search', QI.msg("Search")], ['access', QI.msg("Access")]];
    // A4-05: an unknown tab in the address opens Sessions.
    if (!tabs.some(([id]) => id === state.drill.tab)) state.drill.tab = 'sessions';
    const tab = state.drill.tab;
    main.innerHTML =
      '<div class="detail-head">' +
        '<div class="agent-avatar ' + avatarClass(a.name) + '">' + initial(a.name) + '</div>' +
        '<div><h1 class="detail-title">' + esc(a.name) + '</h1>' +
        '<div class="detail-sub">' + (role ? esc(role) + ' · ' : '') + QI.count(a.sessions_count,'session') + ' · ' + QI.count(a.messages_count,'message') + ' · ' + QI.count(a.notes_count,'note') +
          (st ? ' · <span aria-hidden="true">' + st[0] + '</span> ' + esc(st[1]) : '') + '</div></div>' +
      '</div>' + savesPanel(a) +
      // A4-14: a real tab list, as in Bridges: one tab in the Tab order, arrows move between tabs.
      '<div class="tabs" role="tablist" aria-label="' + esc(QI.msg("Agent sections")) + '">' + tabs.map(([id, label, n]) => '<button type="button" role="tab" id="agentTab-' + id + '" aria-controls="tabBody" aria-selected="' + (tab === id) + '" tabindex="' + (tab === id ? 0 : -1) + '" class="tab' + (tab === id ? ' active' : '') + '" data-tab="' + id + '">' + label +
        (n == null ? '' : ' <span class="tab-badge">' + fmtNum(n) + '</span>') + '</button>').join('') +
      ("</div><div id=\"tabBody\" role=\"tabpanel\" aria-labelledby=\"agentTab-" + tab + "\"><div class=\"loading\">" + QI.msg("Loading…") + "</div></div>");
    const tabEls = [...main.querySelectorAll('[role=tab]')];
    tabEls.forEach((el, i) => {
      el.onclick = () => { state.drill.tab = el.dataset.tab; history.replaceState(null, '', location.pathname + location.search + '#' + drillHash(state.page, state.drill)); renderAgentDetail(); $('#agentTab-' + el.dataset.tab)?.focus(); };
      el.onkeydown = e => { const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabEls.length - 1 }[e.key]; if (next === undefined) return; e.preventDefault(); tabEls[(next + tabEls.length) % tabEls.length].click(); };
    });
    void bindMemorySaves(a);

    if (tab === 'sessions') return renderSessions();
    if (tab === 'memory') return renderMemory();
    if (tab === 'canon') return renderCanonList($('#tabBody'), a.id);
    if (tab === 'search') return renderAgentSearch();
    if (tab === 'access') return renderAgentAccess();
  }
  // One contract for every agent: the same rows the agent reads in qoopia_capabilities.
  async function renderAgentAccess() {
    const a = state.drill.agent, d = state.drill, body = $('#tabBody');
    try { if (!(a.mechanisms || []).length) a.mechanisms = (await api('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/contract')).mechanisms || []; }
    catch (e) { if (state.drill === d) errBox(body, QI.msg("Could not complete this."), renderAgentAccess, e); return; }
    if (state.drill !== d || d.tab !== 'access' || !body.isConnected) return;
    body.innerHTML = '<p class="meta">'+(a.api_key_issued_at?QI.msg('API key issued: {date}',{date:fmtTimeFull(a.api_key_issued_at)}):QI.msg('API key issue date is unknown for this older key.'))+'</p><ul class="mechanisms">' + a.mechanisms.map(m => { const st = mechanismState(m.status);
      return '<li><span aria-hidden="true">' + st[0] + '</span> <strong>' + esc(QI.msg(m.title)) + '</strong> — ' + esc(st[1]) +
        (m.reason ? '<br><span class="meta">' + esc(QI.msg(m.reason)) + ' ' + esc(QI.msg(m.action || '')) + '</span>' : '') + '</li>'; }).join('') + '</ul>';
  }
  async function renderSessions(more) {
    const a = state.drill.agent; const body = $('#tabBody'), d = state.drill;
    // A4-06: 200 sessions at a time; Load more follows the server cursor.
    if (!more) d.sessionsList = { items: [], next: null };
    const list = d.sessionsList;
    try {
      const page = await api('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/sessions?limit=200' + (more ? '&before=' + encodeURIComponent(list.next) : ''));
      if (state.drill !== d || d.sessionsList !== list) return;
      setConn(true);
      list.items = list.items.concat(page.items); list.next = page.next_before || null;
      const data = list;
      if (!data.items.length) { body.innerHTML = ("<div class=\"empty\">" + QI.msg("No sessions yet.") + "</div>"); return; }
      body.innerHTML = '<div class="sess-list">' + data.items.map(s => {
        return '<button type="button" class="sess-item" data-id="' + esc(s.id) + '"><div class="sess-info">' +
          '<div class="sess-title">' + esc(s.title || QI.msg('(untitled)')) + '</div>' +
          '<div class="sess-id">' + esc(s.id) + '</div></div>' +
          '<div class="sess-badges"><span class="sess-badge">' + QI.count(s.message_count, 'message') + "</span>" +
          '<span class="sess-badge">' + fmtTime(s.last_active) + liveStatus(s.last_active) + '</span></div><div class="sess-chev">›</div></button>';
      }).join('') + '</div>' + (list.next ? '<button type="button" class="btn-more" id="sessionsMore">' + QI.msg("Load more") + '</button>' : '');
      body.querySelectorAll('.sess-item').forEach(el => el.onclick = () => {
        const s = data.items.find(x => x.id === el.getAttribute('data-id'));
        if (s) openDrill('agents', { kind: 'session', agent: a, session: s });
      });
      const next = $('#sessionsMore'); if (next) next.onclick = () => { next.disabled = true; void renderSessions(true); };
      if (more) body.querySelectorAll('.sess-item')[list.items.length - page.items.length]?.focus();
    } catch (e) { errBox(body, QI.msg("Failed to load sessions."), () => renderSessions(), e); }
  }
  const NOTE_TYPES = ['memory','rule','decision','knowledge','task','deal','project','context','contact','finance','note'];
  const noteTypeLabel = t => NOTE_TYPES.includes(t) ? QI.msg(t) : QI.code(t);
  // F-312: notes arrive 200 at a time; Load more follows the server cursor to the oldest one.
  async function renderMemory(more) {
    const a = state.drill.agent; const body = $('#tabBody'); const d = state.drill;
    if (!more) d.notesList = { items: [], next: null, types: [] };
    const list = d.notesList;
    const url = '/api/dashboard/agents/' + encodeURIComponent(a.id) + '/notes?limit=200' + (d.noteType ? '&type=' + encodeURIComponent(d.noteType) : '') + (more ? '&before=' + encodeURIComponent(list.next) : '');
    try {
      const data = await api(url); if (state.drill !== d || d.tab !== 'memory' || d.notesList !== list) return; setConn(true);
      list.items = list.items.concat(data.items || []); list.next = data.next_before || null; list.types = data.type_breakdown || [];
      paintNotes();
      if (more) ($('#notesMore') || body.querySelector('.note-list')).focus({ preventScroll: true });
    } catch (e) { errBox(body, QI.msg("Failed to load memory."), () => renderMemory(), e); }
  }
  function paintNotes() {
    const d = state.drill, list = d.notesList, body = $('#tabBody'); if (!body) return;
    const sortBy = d.notesSort || 'created_desc';
    const bd = Object.fromEntries(list.types.map(x => [x.type, x.c]));
    const filters = ['<button class="note-filter ' + (d.noteType === null ? 'active' : '') + ("\" data-t=\"\">" + QI.msg("All") + "</button>")]
      .concat(NOTE_TYPES.filter(t => bd[t]).map(t => '<button class="note-filter ' + (d.noteType === t ? 'active' : '') + '" data-t="' + t + '">' + esc(noteTypeLabel(t)) + ' <span>· ' + bd[t] + '</span></button>')).join('');
    const sorted = list.items.slice().sort((x, y) => { const k = sortBy === 'updated_desc' ? 'updated_at' : 'created_at'; return (y[k] || '').localeCompare(x[k] || ''); });
    const sortToggle = '<div class="session-sort-controls">' +
      '<button class="note-filter ' + (sortBy === 'created_desc' ? 'active' : '') + ("\" data-sort=\"created_desc\">" + QI.msg("Newest created") + "</button>") +
      '<button class="note-filter ' + (sortBy === 'updated_desc' ? 'active' : '') + ("\" data-sort=\"updated_desc\">" + QI.msg("Recently updated") + "</button></div>");
    const items = sorted.length ? sorted.map(n => '<div class="note t-' + esc(QI.code(n.type)) + '"><div class="note-head">' +
      '<span class="note-type">' + esc(noteTypeLabel(n.type)) + '</span><span>' + fmtTimeFull(n.created_at) + '</span>' +
      (n.updated_at && n.updated_at !== n.created_at ? ("<span>" + QI.msg("· upd") + " ") + fmtTime(n.updated_at) + '</span>' : '') +
      '<span class="flex-spacer"></span><button type="button" class="copyable mono" data-copy="' + esc(n.id) + '" aria-label="' + esc(QI.msg('Copy note ID')) + '" title="' + esc(QI.msg('Copy note ID')) + '">' + esc(String(n.id).slice(0, 12)) + '</button></div>' +
      '<div class="note-text">' + esc(n.text) + '</div>' +
      (n.tags && n.tags.length ? '<div class="note-meta">' + QI.msg('Tags:') + ' ' + n.tags.map(esc).join(', ') + '</div>' : '') + '</div>').join('') : ("<div class=\"empty\">" + QI.msg("No notes matching filter.") + "</div>");
    body.innerHTML = '<div class="note-filters">' + filters + '</div>' + sortToggle + '<div class="note-list" tabindex="-1">' + items + '</div>' +
      (list.next ? '<button type="button" class="btn-more" id="notesMore">' + QI.msg("Load more") + '</button>' : '');
    body.querySelectorAll('[data-t]').forEach(el => el.onclick = () => { d.noteType = el.getAttribute('data-t') || null; renderMemory(); });
    body.querySelectorAll('[data-sort]').forEach(el => el.onclick = () => { d.notesSort = el.getAttribute('data-sort'); paintNotes(); });
    body.querySelectorAll('.copyable[data-copy]').forEach(el => el.onclick = (ev) => { ev.stopPropagation(); copyText(el, el.getAttribute('data-copy')); });
    const more = $('#notesMore'); if (more) more.onclick = () => { more.disabled = true; void renderMemory(true); };
  }
  async function renderAgentSearch() {
    const a = state.drill.agent; const body = $('#tabBody'); const q = state.drill.searchQuery || '';
    body.innerHTML = '<div class="space-after-panel"><input type="text" id="searchInp" aria-label="Search this agent’s messages" data-i18n-aria-label="Search this agent’s messages" class="input-text" placeholder="' + esc(QI.msg("Search this agent's messages…")) + '" value="' + esc(q) + '"></div><div id="searchResults"></div>';
    const inp = $('#searchInp'); focusField(inp); let dbnc;
    inp.addEventListener('input', () => { clearTimeout(dbnc); state.drill.searchQuery = inp.value; dbnc = setTimeout(doSearch, 300); });
    if (q) await doSearch();
    async function doSearch() {
      const results = $('#searchResults'); const qq = (state.drill.searchQuery || '').trim();
      if (!qq) { results.innerHTML = ("<div class=\"empty\">" + QI.msg("Type to search…") + "</div>"); return; }
      results.innerHTML = ("<div class=\"loading\">" + QI.msg("Searching…") + "</div>");
      try {
        const data = await api('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/search?q=' + encodeURIComponent(qq) + '&limit=80');
        setConn(true);
        if (!data.items.length) { results.innerHTML = ("<div class=\"empty\">" + QI.msg("Nothing found.") + "</div>"); return; }
        results.innerHTML = '<div class="transcript">' + data.items.map(m => '<button type="button" class="msg search-result" data-role="' + esc(m.role) + '" data-session="' + esc(m.session_id) + '"><div class="msg-head">' + roleIcon(m.role) +
          '<span class="msg-role ' + esc(m.role) + '">' + esc(QI.code(m.role)) + '</span><span>' + fmtTimeFull(m.created_at) + '</span><span class="flex-spacer"></span>' +
          // Inside the result's own button a nested button is invalid; the session page has the keyboard copy button.
          ("<span class=\"copyable mono\" title=\"" + QI.msg("Copy session ID") + "\">") + esc(String(m.session_id).slice(0, 16)) + '…</span></div>' +
          '<div class="msg-content">' + esc(m.content) + '</div></button>').join('') + '</div>';
        results.querySelectorAll('.copyable').forEach((el, i) => { const sid = data.items[i].session_id; el.onclick = (ev) => { ev.stopPropagation(); copyText(el, sid); }; });
        results.querySelectorAll('.msg').forEach(el => { el.onclick = () => openDrill('agents', { kind: 'session', agent: a, session: { id: el.getAttribute('data-session'), title: null } }); });
      } catch (e) { errBox(results, QI.msg("Search failed."), doSearch, e); }
    }
  }
  async function renderSession() {
    const a = state.drill.agent; const s = state.drill.session;
    const agentHash = '#' + drillHash('agents', { kind: 'agent', agent: a, tab: 'sessions' });
    setCrumb('<a href="#agents" data-go="agents">' + QI.msg("Agents") + '</a><span class="crumb-sep" aria-hidden="true">›</span><a href="' + esc(agentHash) + '">' + esc(a.name) + '</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">' + esc(String(s.id).slice(0, 12)) + '</span>');
    main.innerHTML = '<div class="detail-head"><div class="agent-avatar ' + avatarClass(a.name) + '">' + initial(a.name) + '</div>' +
      '<div class="detail-main"><h1 class="detail-title" id="sessTitle">' + esc(s.title || QI.msg('(untitled session)')) + '</h1>' +
      ("<div class=\"detail-sub mono\"><button type=\"button\" class=\"copyable\" id=\"sidCopy\" aria-label=\"" + QI.msg("Copy session ID") + "\" title=\"" + QI.msg("Copy session ID") + "\">") + esc(s.id) + '</button></div></div></div>' +
      ("<div id=\"tabBody\"><div class=\"loading\">" + QI.msg("Loading transcript…") + "</div></div>");
    const sidEl = $('#sidCopy'); if (sidEl) sidEl.onclick = () => copyText(sidEl, s.id);
    const body = $('#tabBody'), d = state.drill;
    // A4-06: a long session opens on its latest messages; "Load older messages" pages back in time.
    const t = d.transcript = { messages: [], next: null, count: 0 };
    async function load(older) {
      const anchor=older?[...body.querySelectorAll('[data-mid]')].find(el=>el.getBoundingClientRect().bottom>0):null;
      const anchorId=anchor?.dataset.mid,anchorTop=anchor?.getBoundingClientRect().top;
      try {
        const data = await api('/api/dashboard/sessions/' + encodeURIComponent(s.id) + '/messages?limit=500' + (older ? '&before=' + t.next : ''));
        if (state.drill !== d || d.transcript !== t) return;
        setConn(true);
        if (data.session?.title && !s.title) $('#sessTitle').textContent = s.title = data.session.title;
        t.messages = data.messages.concat(t.messages); t.next = data.next_before ?? null; t.count = data.count ?? t.messages.length;
        if (!t.messages.length) { body.innerHTML = ("<div class=\"empty\">" + QI.msg("No messages.") + "</div>"); return; }
        body.innerHTML = (t.next ? '<p class="meta">' + QI.msg("Showing the latest {n} of {total} messages.", { n: fmtNum(t.messages.length), total: fmtNum(t.count) }) +
          ' <button type="button" class="btn-more" id="sessMore">' + QI.msg("Load older messages") + '</button></p>' : '') +
          '<div class="transcript">' + t.messages.map(m => '<div class="msg ' + esc(m.role) + '" data-mid="' + esc(m.id) + '"><div class="msg-head">' + roleIcon(m.role) +
          '<span class="msg-role ' + esc(m.role) + '">' + esc(QI.code(m.role)) + '</span><span>' + fmtTimeFull(m.created_at) + '</span>' +
          (m.token_count != null ? '<span>· ' + QI.count(m.token_count, 'token') + "</span>" : '') + '</div><div class="msg-content">' + esc(m.content) + '</div></div>').join('') + '</div>';
        const more = $('#sessMore'); if (more) more.onclick = () => { more.disabled = true; void load(true); };
        if(older&&anchorId){
          const restored=[...body.querySelectorAll('[data-mid]')].find(el=>el.dataset.mid===anchorId);
          if(restored){document.documentElement.scrollTop+=restored.getBoundingClientRect().top-anchorTop;restored.tabIndex=-1;restored.focus({preventScroll:true});}
        }
      } catch (e) { errBox(body, QI.msg("Failed to load transcript."), () => load(older), e); }
    }
    await load(false);
  }

  // ================= COMMS =================
  let acThreads=[];
  let acState = { messages: [], nextBefore: null, hasMore: false, busy: false };

  function acName(a) { return (a && (a.name || (a.id || '').slice(0, 8))) || '?'; }
  function acDayKey(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toDateString(); }
  function acDayLabel(iso) {
    const d = new Date(iso); if (isNaN(d)) return '—';
    const today = new Date(); const y = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return (QI.msg("Today"));
    if (d.toDateString() === y.toDateString()) return (QI.msg("Yesterday"));
    return QI.date(d, { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  function acClock(iso) {
    const d = new Date(iso); if (isNaN(d)) return '—';
    return QI.date(d, { hour: '2-digit', minute: '2-digit' });
  }

  async function renderAgentCommPage() {
    setCrumb(("<span class=\"text-primary\">" + QI.msg("Agent conversations") + "</span>"));
    main.innerHTML = ("<div class=\"panel\"><div class=\"panel-h\"><h1>" + QI.msg("Conversations") + ("</h1><span class=\"meta\">" + QI.msg("read-only") + "</span></div>")) +
      ("<div id=\"acChats\"><div class=\"loading\">" + QI.msg("Loading conversations…") + "</div></div></div>");
    $('#acChats').insertAdjacentHTML('beforebegin','<div class="agent-toolbar"><label for="acSearch">'+esc(QI.msg('Find a conversation'))+'</label><input type="search" id="acSearch" class="sel"><label for="acRecent">'+esc(QI.msg('Period'))+'</label><select id="acRecent" class="sel"><option value="all">'+esc(QI.msg('All conversations'))+'</option><option value="day">'+esc(QI.msg('Last 24 hours'))+'</option></select></div>');$('#acSearch').oninput=()=>fillAcThreads(true);$('#acRecent').onchange=()=>fillAcThreads(true);
    await fillAcThreads();
    pollFn = ()=>fillAcThreads();
  }

  async function fillAcThreads(cached=false) {
    const box = $('#acChats'); if (!box) return;
    try {
      if(!cached){const d=await api('/api/dashboard/agentcomm/threads?limit=100');if(!box.isConnected)return;acThreads=d.items||[];setConn(true);}
      const query=($('#acSearch')?.value||'').toLocaleLowerCase(),recent=$('#acRecent')?.value==='day';const items=acThreads.filter(t=>(!recent||Date.now()-new Date(t.last_message_at).getTime()<86400000)&&(!query||[acName(t.agent_a),acName(t.agent_b),t.last_message?.preview||''].join(' ').toLocaleLowerCase().includes(query)));
      if (!items.length) { patch(box, "<div class=\"empty\">" + QI.msg("No agent conversations yet.") + "</div>"); return; }
      patch(box, '<div class="tg-chats">' + items.map((t, i) => {
        const an = acName(t.agent_a), bn = acName(t.agent_b);
        const last = t.last_message;
        const prev = last
          ? '<b>' + esc(acName({ name: last.sender_name, id: last.sender_agent_id })) + ':</b> ' + esc(String(last.preview || '').replace(/\s+/g, ' '))
          : (QI.msg("No messages"));
        return '<button type="button" class="tg-chat" data-i="' + i + '" data-id="' + esc(t.agent_a.id + '|' + t.agent_b.id) + '">' +
          '<div class="tg-duo">' +
            '<div class="agent-avatar ' + avatarClass(t.agent_a.name) + '">' + initial(an) + '</div>' +
            '<div class="agent-avatar ' + avatarClass(t.agent_b.name) + '">' + initial(bn) + '</div>' +
          '</div>' +
          '<div class="tg-chat-main">' +
            '<div class="tg-chat-title">' + esc(an) + ' <span class="text-muted-normal">↔</span> ' + esc(bn) + '</div>' +
            '<div class="tg-chat-prev">' + prev + '</div>' +
          '</div>' +
          '<div class="tg-chat-side">' +
            '<span class="tg-chat-time">' + fmtTime(t.last_message_at) + '</span>' +
            '<span class="tg-count">' + fmtNum(t.message_count) + '</span>' +
          '</div></button>';
      }).join('') + '</div>');
      box.querySelectorAll('.tg-chat').forEach(el => {
        el.onclick = () => {
          const t = items[parseInt(el.getAttribute('data-i'), 10)];
          openDrill('agentcomm', { kind: 'acthread', pair: t });
        };
      });
    } catch (e) { errBox(box, QI.msg("Failed to load conversations."), () => fillAcThreads(), e); }
  }

  async function renderAcThread() {
    const p = state.drill.pair;
    const an = acName(p.agent_a), bn = acName(p.agent_b);
    setCrumb('<a href="#agentcomm" data-go="agentcomm">' + QI.msg("Agent conversations") + '</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">' + esc(an) + ' ↔ ' + esc(bn) + '</span>');
    main.innerHTML = '<div class="detail-head">' +
      '<div class="tg-duo"><div class="agent-avatar ' + avatarClass(p.agent_a.name) + '">' + initial(an) + '</div>' +
      '<div class="agent-avatar ' + avatarClass(p.agent_b.name) + '">' + initial(bn) + '</div></div>' +
      '<div class="detail-main"><h1 class="detail-title">' + esc(an) + ' ↔ ' + esc(bn) + '</h1>' +
      ("<div class=\"detail-sub\" id=\"acSub\">" + QI.msg("loading…") + "</div></div></div>") +
      ("<div class=\"panel tg-panel\"><div id=\"acBody\"><div class=\"loading\">" + QI.msg("Loading conversation…") + "</div></div></div>");
    acState = { messages: [], nextBefore: null, hasMore: false, busy: false };
    await loadAcPage(true);pollFn=refreshAcThread;
  }

  async function loadAcPage(first) {
    const p = state.drill.pair,current=acState,body=$('#acBody');
    if (current.busy) return;
    current.busy = true;
    try {
      const q = '/api/dashboard/agentcomm/thread?a=' + encodeURIComponent(p.agent_a.id) +
        '&b=' + encodeURIComponent(p.agent_b.id) + '&limit=200' +
        (acState.nextBefore ? '&before=' + encodeURIComponent(acState.nextBefore) : '');
      const d = await api(q);if(acState!==current||!body?.isConnected)return;setConn(true);
      acState.messages = [...new Map([...(d.messages||[]),...acState.messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||String(a.id).localeCompare(String(b.id)));
      acState.hasMore = !!d.has_more;
      acState.nextBefore = d.next_before;
      const sub = $('#acSub');
      if (sub) sub.textContent = QI.count(d.total, 'message') + " · " + QI.msg("shown: {n}", { n: fmtNum(acState.messages.length) });
      renderAcMessages(first);
    } catch (e) {
      if (first) errBox($('#acBody'), QI.msg("Failed to load conversation."), () => loadAcPage(true), e);
      else { if (!e?.status) setConn(false); const more = $('#acMore'); if (more) more.textContent = QI.msg("Load older messages"); }
    } finally { current.busy = false; }
  }

  async function refreshAcThread() {
    const body=$('#acBody'),pair=state.drill?.pair,current=acState;if(!body||!pair||current.busy)return;
    current.busy=true;
    try {const d=await api('/api/dashboard/agentcomm/thread?a='+encodeURIComponent(pair.agent_a.id)+'&b='+encodeURIComponent(pair.agent_b.id)+'&limit=200');if(!body.isConnected||acState!==current)return;
      if(current.messages.length&&d.messages?.length&&!d.messages.some(m=>current.messages.some(old=>old.id===m.id))&&d.has_more){current.nextBefore=d.next_before;current.hasMore=true;}
      const next=[...new Map([...current.messages,...(d.messages||[])].map(m=>[m.id,m])).values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||String(a.id).localeCompare(String(b.id)));
      if(JSON.stringify(next)!==JSON.stringify(current.messages)){const anchor=[...body.querySelectorAll('[data-message]')].find(el=>el.getBoundingClientRect().bottom>0),top=anchor?.getBoundingClientRect().top,id=anchor?.dataset.message,atTop=window.scrollY<100;current.messages=next;renderAcMessages(false);if(!atTop&&id){const kept=[...body.querySelectorAll('[data-message]')].find(el=>el.dataset.message===id);if(kept)window.scrollBy(0,kept.getBoundingClientRect().top-top);}}
      $('#acSub').textContent=QI.resolve(QI.msg('Updated automatically'))+' · '+QI.resolve(fmtNum(d.total));setConn(true);
    }catch{if(body.isConnected){$('#acSub').textContent=QI.resolve(QI.msg('Connection lost. Reconnecting…'));setConn(false);}}finally{current.busy=false;}
  }

  // Newest message on top; scrolling down goes back in time and loads older history at the bottom.
  // The page's to-top arrow returns to the latest message.
  // A read from the inbox is shown as what it is, never as a wake.
  const AC_DELIVERY = {
    woken: "Woke the agent",
    read_without_wake: "Read from the inbox, nobody was woken",
    waking: "Waking the agent…",
    no_runtime: "Waiting in the inbox: this agent has no runtime to wake",
    wake_failed: "Waiting in the inbox: the wake failed",
  };
  function renderAcMessages(first) {
    const body = $('#acBody'); if (!body) return;
    const p = state.drill.pair;
    if (!acState.messages.length) { body.innerHTML = ("<div class=\"empty\">" + QI.msg("No messages.") + "</div>"); return; }

    const msgs = acState.messages.slice().reverse();

    let html = '<div class="tg-thread">';
    let day = '';
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const k = acDayKey(m.created_at);
      const newDay = k !== day;
      if (newDay) { day = k; html += '<div class="tg-day">' + esc(acDayLabel(m.created_at)) + '</div>'; }
      const side = m.sender_agent_id === p.agent_a.id ? 'left' : 'right';
      const prev = msgs[i - 1], next = msgs[i + 1];
      // Telegram-style grouping, computed in visual order: name on the first
      // message of a run, tail on the last one.
      const samePrev = !newDay && !!prev && prev.sender_agent_id === m.sender_agent_id;
      const sameNext = !!next && next.sender_agent_id === m.sender_agent_id && acDayKey(next.created_at) === k;
      const cls = side + (samePrev ? ' grp' : '') + (sameNext ? '' : ' tail');
      html += '<div data-message="'+esc(m.id)+'" class="tg-row ' + cls + '"><div class="tg-bubble">' +
        (samePrev ? '' : '<div class="tg-from">' + esc(acName({ name: m.sender_name, id: m.sender_agent_id })) + '</div>') +
        '<div class="tg-text">' + esc(m.body) + '</div>' +
        '<div class="tg-meta">' +
        (m.topic ? '<span class="tg-topic" title="' + esc(QI.msg('Topic: {topic}', { topic: m.topic })) + '">' + esc(m.topic) + '</span>' : '') +
        '<span title="' + esc(fmtTimeFull(m.created_at)) + '">' + esc(acClock(m.created_at)) + '</span>' +
        (AC_DELIVERY[m.delivery] ? '<span class="tg-delivery ' + esc(m.delivery) + '">' + esc(QI.msg(AC_DELIVERY[m.delivery])) + '</span>' : '') + '</div>' +
        '</div></div>';
    }
    html += '</div>';
    const historyControl = acState.hasMore
      ? ("<button class=\"btn-more older-messages-button\" id=\"acMore\">" + QI.msg("Load older messages") + "</button>")
      : ("<div class=\"tg-day\">" + QI.msg("Beginning of conversation") + "</div>");

    body.innerHTML = html + historyControl;
    const more = $('#acMore');
    if (more) more.onclick = () => { more.textContent = (QI.msg("Loading…")); loadAcPage(false); };
    if (first) window.scrollTo({ top: 0 });
  }

  // ================= SKILL LOOP: same login and typed authority =================
  let skillContext = null, skillPending = null;
  // A4-07: skill states, evidence and scopes in words; a card shows its real state, not "Draft" for all.
  const SKILL_WORDS = { draft: "Draft", candidate: "Awaiting your review", sealed: "Approved", in_use: "In use", imported: "Imported",
    completed: "Completed", failed: "Failed", unknown: "Unknown", refused: "Refused", started: "Started",
    self_reported: "Reported by the agent", self_report: "Reported by the agent", human_accepted: "Confirmed by you", independently_verified: "Verified independently", verified_outcome: "Verified result", legacy_history: "Earlier history",
    project: "Project", personal: "Personal" };
  const skillWord = v => SKILL_WORDS[v] ? QI.msg(SKILL_WORDS[v]) : QI.code(v);
  function skillCardState(s, loop) {
    const versions = loop.versions.filter(v => v.skill_id === s.id), ids = new Set(versions.map(v => v.id));
    if (loop.assignments.some(a => ids.has(a.version_id) && a.desired_state === "active")) return "in_use";
    if (versions.some(v => v.status === "sealed")) return "sealed";
    if (versions.some(v => v.status === "candidate")) return "candidate";
    return s.draft_id ? "draft" : "imported";
  }
  const loopUrl = '/api/dashboard/authority';
  async function skillApi(path, method = 'GET', body, expected) {
    const key = method === 'GET' ? null : (body.idempotency_key || crypto.randomUUID());
    if (body && key) body.idempotency_key = key;
    if (method !== 'GET') skillPending = {path, method, body: JSON.parse(JSON.stringify(body)), expected};
    const response = await send(loopUrl + path, {method, credentials:'same-origin', signal:AbortSignal.timeout(15000),
      ...(method === 'GET' ? {} : {headers:{'content-type':'application/json','X-Qoopia-CSRF':'1','Idempotency-Key':key,'If-Match':String(expected)}, body:JSON.stringify(body)})});
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = failure(response, value); error.code = value.error?.code; throw error; }
    if (method !== 'GET') skillPending = null;
    return value;
  }
  function skillStatus(text, error = false) {
    const node = $('#skillStatus'); if (!node) return;
    node.textContent = text; node.className = error ? 'err' : 'meta'; node.setAttribute('role',error ? 'alert' : 'status');
  }
  function skillFailure(e) {
    skillStatus(e.message + QI.resolve(QI.msg(". Your edits are kept. Inspect the current state or retry the same request.")),true);
    const retry=$('#skillRetry'); if(retry){retry.hidden=!skillPending;retry.onclick=async()=>{if(!skillPending)return;const p=skillPending;try{await skillApi(p.path,p.method,p.body,p.expected);await skillReconcile();skillStatus((QI.msg("Request reconciled against current server state.")));retry.hidden=true;}catch(e){skillFailure(e);}};}
  }
  async function skillReconcile() { const id=skillContext?.skill?.skill_id; if(id) await skillDetail(id); else await renderSkillsPage(); }
  function skillShell(title) {
    setCrumb(("<span class=\"text-primary\">" + QI.msg("Skills") + "</span>"));
    main.innerHTML=("<section class=\"skill-loop\"><div class=\"detail-head\"><div><h1>")+esc(title)+("</h1></div><button class=\"btn\" id=\"skillLibrary\">" + QI.msg("Library") + "</button></div><p id=\"skillStatus\" role=\"status\" aria-live=\"polite\"></p><button class=\"btn\" id=\"skillRetry\" hidden>" + QI.msg("Retry same request") + "</button><div id=\"skillBody\"></div></section>");
    $('#skillLibrary').onclick=()=>renderSkillsPage();main.querySelector('h1').tabIndex=-1;main.querySelector('h1').focus();
  }
  async function renderSkillsPage() {
    skillShell((QI.msg("Skills that carry their evidence")));
    const body=$('#skillBody');body.innerHTML=("<p class=\"loading\">" + QI.msg("Loading library…") + "</p>");
    try {
      const [library,loop]=await Promise.all([skillApi('/skills'),skillApi('/skill-loop')]);
      body.innerHTML=("<p class=\"ent-sum\">" + QI.msg("Turn a repeatable procedure into reviewed native instructions. Each use stays linked to its exact version.") + "</p><button class=\"btn\" id=\"skillCreate\">" + QI.msg("Create a skill") + "</button><div class=\"skill-grid\" id=\"skillCards\"></div><h2>" + QI.msg("Needs attention") + "</h2><div id=\"skillAttention\"></div>");
      $('#skillCreate').onclick=()=>skillEditor();
      $('#skillCards').innerHTML=library.items.length?library.items.map(s=>'<button class="ent skill-card" data-skill="'+esc(s.id)+("\"><span class=\"type-badge tb-skill\">")+esc(skillWord(skillCardState(s,loop)))+'</span><strong>'+esc(s.title)+("</strong><span class=\"meta\">" + QI.msg("Open procedure, versions and outcomes →") + "</span></button>")).join(''):("<p class=\"empty\">" + QI.msg("Your library is empty. Create a skill from a procedure or the clearly marked CSV sample.") + "</p>");
      $('#skillCards').querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>skillDetail(b.dataset.skill));
      const waiting=loop.assignments.filter(a=>a.desired_state==='active');
      $('#skillAttention').innerHTML=waiting.length?waiting.map(a=>'<p><strong>'+esc(a.slot)+'</strong> — '+(a.readiness?.ready?(QI.msg("Ready for the next session.")):QI.msg('Blocked:')+' '+(a.readiness?.blockers||["readiness unavailable"]).map(b=>esc(QI.msg(b))).join("; "))+' <button class="btn" data-attention="'+esc(a.version_id)+("\">" + QI.msg("Inspect") + "</button></p>")).join(''):("<p class=\"meta\">" + QI.msg("No pending assignments.") + "</p>");
      $('#skillAttention').querySelectorAll('[data-attention]').forEach(b=>b.onclick=()=>skillDetail(loop.versions.find(v=>v.id===b.dataset.attention).skill_id));
      skillStatus((QI.msg("Library is current. Native loading and useful outcomes are separate facts.")));
    } catch(e){body.innerHTML=("<button class=\"btn\" id=\"skillReload\">" + QI.msg("Reload library") + "</button>");$('#skillReload').onclick=renderSkillsPage;skillFailure(e);}
  }
  function skillEditor(existing, fork=false) {
    skillShell(existing?(fork?(QI.msg("Fork a procedure")):(QI.msg("Revise the procedure"))):(QI.msg("Capture a repeatable procedure")));
    const c=existing?.content||{},lines=v=>(v||[]).join('\n');
    const field=(id,label,value='',multiline=false)=>'<label for="'+id+'">'+label+'</label>'+(multiline?'<textarea id="'+id+'" rows="4">'+esc(value)+'</textarea>':'<input id="'+id+'" value="'+esc(value)+'">');
    $('#skillBody').innerHTML='<form id="skillForm" class="skill-form"><div class="skill-grid"><div>'+field('skTitle',(QI.msg("Title")),c.title)+field('skSlug',(QI.msg("Native name (lowercase)")),fork?'':existing?.slug||'')+("</div><div><label for=\"skSource\">" + QI.msg("Source") + "</label><select id=\"skSource\"><option value=\"manual\">" + QI.msg("Manual procedure") + "</option><option value=\"native\">" + QI.msg("Native SKILL.md") + "</option><option value=\"session\">" + QI.msg("Selected session messages") + "</option><option value=\"artifact\">" + QI.msg("Stored artifact") + "</option><option value=\"run\">" + QI.msg("Recorded run") + "</option></select><label for=\"skLocale\">" + QI.msg("Language") + "</label><select id=\"skLocale\"><option value=\"en\">" + QI.msg("English") + "</option><option value=\"ru\">" + QI.msg("Русский") + "</option></select></div></div><details><summary>" + QI.msg("Source selection") + "</summary>")+field('skSourceId',(QI.msg("Source ID (session, artifact or run)")))+field('skFirst',(QI.msg("First message ID")))+field('skLast',(QI.msg("Last message ID")))+field('skRaw',(QI.msg("Selected source text / native SKILL.md")),'',true)+'</details>'+field('skPurpose',(QI.msg("What this repeats")),c.purpose||'',true)+field('skTrigger',(QI.msg("When to use (one per line)")),lines(c.trigger),true)+field('skSteps',(QI.msg("Steps (one per line)")),lines(c.procedure),true)+field('skVerification',(QI.msg("How to verify")),lines(c.verification),true)+field('skFailures',(QI.msg("When to refuse")),lines(c.failure_modes),true)+field('skRollback',(QI.msg("How to undo")),c.rollback||'',true)+("<label for=\"skCaps\">" + QI.msg("Permissions") + "</label><select id=\"skCaps\"><option value=\"read\">" + QI.msg("Read local files") + "</option><option value=\"write\">" + QI.msg("Read and write managed task outputs") + "</option></select><p class=\"meta\">" + QI.msg("Review and accept exact skill contents before assigning them to an agent. Continue your work in the agent’s own application.") + "</p><p class=\"meta\">" + QI.msg("Source sessions and local paths stay private. Redaction cannot recognize every secret; inspect the preview.") + "</p><button class=\"btn\" type=\"submit\">" + QI.msg("Save draft") + "</button> <button class=\"btn\" id=\"skSample\" type=\"button\">" + QI.msg("Use synthetic CSV sample") + "</button> <button class=\"btn\" id=\"skCancel\" type=\"button\">" + QI.msg("Cancel") + "</button></form>");
    if((c.requested_capabilities||[]).includes('file_write_managed'))$('#skCaps').value='write';
    $('#skCancel').onclick=()=>existing?skillDetail(existing.skill_id):renderSkillsPage();
    $('#skSample').onclick=()=>{
      const values={skTitle:'Summarize category amounts',skSlug:'csv-summary',skPurpose:'Validate category,amount CSV and write a deterministic JSON summary in the managed task directory.',skTrigger:'A local CSV needs validation and a summary',skSteps:'Read input.csv. Require category,amount and finite decimal amounts. Refuse invalid rows.\nGroup rows by category. Write summary.json with counts, totals and overall.\nFor invalid.csv write refusal.json with status refused and reason invalid_amount. Do not write invalid-summary.json.',skVerification:'Compare counts and totals with all input rows.\nKeep all writes inside the managed task directory.',skFailures:'Invalid header or nonnumeric amount: refuse without a summary.',skRollback:'Remove only the generated task outputs. Keep the inputs.'};
      Object.entries(values).forEach(([id,value])=>$('#'+id).value=value);$('#skCaps').value='write';skillStatus((QI.msg("Synthetic sample selected. No runtime task has been executed.")));
    };
    $('#skillForm').onsubmit=async event=>{event.preventDefault();const list=id=>$('#'+id).value.split('\n').map(s=>s.trim()).filter(Boolean),kind=$('#skSource').value;
      const content={title:$('#skTitle').value,purpose:$('#skPurpose').value,trigger:list('skTrigger'),procedure:list('skSteps'),verification:list('skVerification'),failure_modes:list('skFailures'),rollback:$('#skRollback').value,requested_capabilities:$('#skCaps').value==='write'?['file_read','file_write_managed']:['file_read']};
      const args={kind,title:content.title,slug:$('#skSlug').value,locale:$('#skLocale').value,content,expected_revision:existing?.draft_id&&!fork?existing.revision:0,choice:existing?(fork?'fork':existing.draft_id?'update':'new'):'new'};
      if(existing&&!fork){if(existing.draft_id)args.draft_id=existing.draft_id;else args.skill_id=existing.skill_id;}if(fork)args.parent_skill_id=existing.skill_id;
      if(kind==='manual'||kind==='native')args.text=$('#skRaw').value||content.procedure.map((s,i)=>(i+1)+'. '+s).join('\n');else args.source_id=$('#skSourceId').value;
      if(kind==='session'){args.first_message_id=Number($('#skFirst').value);args.last_message_id=Number($('#skLast').value);}
      try{const saved=await skillApi('/skills/captures','POST',args,args.expected_revision);if(saved.data.outcome==='refused'){skillStatus(QI.resolve(QI.msg(saved.data.reason||""))+(" " + QI.msg("— keep it as memory or a rule.")),true);return;}await skillDetail(saved.data.skill_id||existing?.skill_id);skillStatus((QI.msg("Draft saved.") + " ")+(saved.data.findings||[]).join(', '));}catch(e){skillFailure(e);}
    };
    $('#skTitle').focus();
  }
  async function skillDetail(id) {
    skillShell((QI.msg("Procedure and evidence")));$('#skillBody').innerHTML=("<p class=\"loading\">" + QI.msg("Loading exact versions…") + "</p>");
    try {
      const [skill,loop]=await Promise.all([skillApi('/skills/'+encodeURIComponent(id)),skillApi('/skill-loop?skill_id='+encodeURIComponent(id))]);skillContext={skill,loop};
      const c=skill.content;$('#skillBody').innerHTML='<h2>'+esc(c?.title||skill.title||skill.slug)+'</h2><p>'+esc(c?.purpose||(QI.msg("Imported immutable skill")))+("</p><div class=\"skill-actions\"><button class=\"btn\" id=\"skRevise\">" + QI.msg("Revise") + "</button><button class=\"btn\" id=\"skFork\">" + QI.msg("Fork") + "</button></div><h2>" + QI.msg("Versions") + "</h2><div id=\"skVersions\"></div>")+(c?("<form id=\"skCompile\"><label for=\"skVersionLabel\">" + QI.msg("New version label") + "</label><input id=\"skVersionLabel\" value=\"")+esc(String((loop.versions||[]).length+1))+("\" required><label for=\"skLicense\">" + QI.msg("License") + "</label><input id=\"skLicense\" value=\"MIT\" required><button class=\"btn\">" + QI.msg("Compile preview") + "</button></form>"):'')+("<div id=\"skPreview\"></div><h2>" + QI.msg("Assignments") + "</h2><div id=\"skAssignments\"></div><h2>" + QI.msg("Runs and outcomes") + "</h2><div id=\"skOutcomes\"></div>");
      $('#skRevise').onclick=()=>skillEditor(skill);$('#skFork').onclick=()=>skillEditor(skill,true);
      $('#skVersions').innerHTML=loop.versions.length?loop.versions.map(v=>'<button class="btn" data-version="'+esc(v.id)+'">'+esc(v.version_label)+' · '+esc(skillWord(v.status))+'</button>').join(''):("<p class=\"meta\">" + QI.msg("No compiled versions. Complete the draft, then inspect its final instructions.") + "</p>");
      $('#skVersions').querySelectorAll('[data-version]').forEach(b=>b.onclick=()=>skillPreview(b.dataset.version));
      if(c)$('#skCompile').onsubmit=async event=>{event.preventDefault();try{const result=await skillApi('/skills/drafts/'+skill.draft_id+'/compile','POST',{expected_revision:skill.revision,version_label:$('#skVersionLabel').value,license:$('#skLicense').value,native_name:skill.slug},skill.revision);await skillPreview(result.data.version_id);}catch(e){skillFailure(e);}};
      $('#skAssignments').innerHTML=loop.assignments.length?loop.assignments.map(a=>'<div class="panel"><strong>'+esc(a.slot)+'</strong><p>'+QI.msg('Desired state:')+' '+esc(QI.code(a.desired_state))+(" " + QI.msg("· revision") + " ")+a.revision+(" " + QI.msg("· next-session changes") + "</p><button class=\"btn\" data-pause=\"")+esc(a.id)+("\">" + QI.msg("Pause") + "</button> <button class=\"btn\" data-rollback=\"")+esc(a.id)+("\">" + QI.msg("Choose rollback version") + "</button></div>")).join(''):("<p class=\"meta\">" + QI.msg("No assignments.") + "</p>");
      $('#skAssignments').querySelectorAll('[data-pause]').forEach(b=>b.onclick=async()=>{const a=loop.assignments.find(a=>a.id===b.dataset.pause);try{await skillApi('/skill-assignments/'+a.id,'PATCH',{assignment_id:a.id,expected_revision:a.revision,desired_state:'paused',reason:'Owner paused from the library'},a.revision);await skillDetail(id);}catch(e){skillFailure(e);}});
      $('#skAssignments').querySelectorAll('[data-rollback]').forEach(b=>b.onclick=()=>{skillStatus((QI.msg("Select an earlier version above, then assign it to the same runtime with Rollback selected.")));$('#skVersions').querySelector('button')?.focus();});
      $('#skOutcomes').innerHTML=loop.runs.length?loop.runs.map(run=>{const outcomes=loop.outcomes.filter(o=>o.run_id===run.id);return '<article class="panel"><strong>'+esc(run.objective)+("</strong><p>" + QI.msg("Run") + " ")+esc(run.id)+(" " + QI.msg("· exact version") + " ")+esc(run.version_id)+'</p>'+(outcomes.length?outcomes.map(o=>'<p>'+esc(skillWord(o.status))+' · '+esc(skillWord(o.evidence_class))+(" " + QI.msg("· revision") + " ")+o.revision+(o.stale?(" " + QI.msg("· late fact after revoke")):'')+("</p><details><summary>" + QI.msg("Evaluator assertions") + "</summary><pre>")+esc(JSON.stringify(JSON.parse(o.assertions_json),null,2))+'</pre></details>').join(''):("<p>" + QI.msg("Unknown — nothing reported.") + "</p>"))+'</article>';}).join(''):("<p class=\"empty\">" + QI.msg("No runtime task has been reported. Installing files does not prove execution.") + "</p>");
      skillStatus(QI.msg(loop.capabilities.limitation));
    }catch(e){skillFailure(e);}
  }
  async function skillPreview(versionId) {
    try{
      const v=await skillApi('/skills/'+skillContext.skill.skill_id+'/versions/'+versionId),descriptor=JSON.parse(v.descriptor_json),members=JSON.parse(v.members_json);
      const bytes=members['SKILL.md']?new TextDecoder().decode(Uint8Array.from(atob(members['SKILL.md']),c=>c.charCodeAt(0))):(QI.msg("Historical format: recompile a derived native version first."));
      const previous=skillContext.loop.versions.filter(x=>x.id!==v.id&&x.status==='sealed'&&x.created_at_ms<=v.created_at_ms).at(-1);
      let previousBytes='',previousLabel=(QI.msg("Empty native projection"));
      if(previous){const old=await skillApi('/skills/'+v.skill_id+'/versions/'+previous.id);const oldMembers=JSON.parse(old.members_json||'{}');previousBytes=oldMembers['SKILL.md']?new TextDecoder().decode(Uint8Array.from(atob(oldMembers['SKILL.md']),c=>c.charCodeAt(0))):(QI.msg("Historical version has no compiled native bytes"));previousLabel=(QI.msg("Previous") + " ")+old.version_label+' · '+old.license;}
      const diff=previousBytes===bytes?(QI.msg("No instruction changes. Review license, renderer and full member map below.")):previousBytes.split('\n').map(line=>'- '+line).join('\n')+'\n'+bytes.split('\n').map(line=>'+ '+line).join('\n');
      const box=$('#skPreview');box.innerHTML=("<section class=\"panel\"><h2>" + QI.msg("Before / after diff") + "</h2><p>")+esc(previousLabel)+' → '+esc(v.version_label)+("</p><pre class=\"skill-diff\" tabindex=\"0\" aria-label=\"" + QI.msg("Before and after native instructions") + "\">")+esc(diff)+'</pre></section>'+("<section class=\"panel\"><h2>" + QI.msg("Review final native bytes") + "</h2><p>" + QI.msg("Version") + " ")+esc(v.version_label)+(" " + QI.msg("· License") + " ")+esc(v.license)+'</p><p>'+QI.msg('Permissions:')+' '+esc((descriptor.requested_capabilities||[]).join(', ')||QI.msg('None'))+'</p><p>'+QI.msg('Format:')+' '+esc(descriptor.renderer||v.original_format)+("</p><pre class=\"skill-diff\" tabindex=\"0\" aria-label=\"" + QI.msg("Final native instructions") + "\">")+esc(bytes)+("</pre><details><summary>" + QI.msg("Exact member map and digest") + "</summary><pre>")+esc(JSON.stringify(descriptor.members||{},null,2))+'</pre><p>'+esc(v.candidate_digest)+'</p></details><div id="skReviewActions"></div></section>';
      box.scrollIntoView({block:'start'});
      if(v.status==='candidate'){
        $('#skReviewActions').innerHTML=("<label for=\"skScope\">" + QI.msg("Target scope") + "</label><select id=\"skScope\"><option value=\"project\">" + QI.msg("Project") + "</option><option value=\"personal\">" + QI.msg("Personal") + "</option></select><p>" + QI.msg("Approval covers the bytes shown above. A change to license, instructions, files or renderer needs a new review.") + "</p><button class=\"btn\" id=\"skAccept\">" + QI.msg("Approve for local use") + "</button> <button class=\"btn\" id=\"skReject\">" + QI.msg("Reject") + "</button>");
        const reviews=skillContext.loop.approvals.filter(a=>a.version_id===v.id&&a.kind==='content_review'),revision=reviews.length;
        $('#skAccept').onclick=async()=>{try{const accepted=await skillApi('/skills/candidates/'+v.id+'/accept','POST',{version_id:v.id,expected_digest:v.candidate_digest,expected_revision:revision,target_scope:$('#skScope').value,expires_at_ms:Date.now()+86400000},v.candidate_digest);await skillDetail(v.skill_id);await skillPreview(accepted.data.version_id);}catch(e){skillFailure(e);}};
        $('#skReject').onclick=async()=>{try{const caps=await skillApi('/capabilities');await skillApi('/skills/candidates/'+v.id+'/reviews','POST',{version_id:v.id,expected_digest:v.candidate_digest,expected_revision:revision,kind:'content_review',decision:'reject',evidence_class:'human_accepted',target_scope:$('#skScope').value,capabilities:descriptor.requested_capabilities,expires_at_ms:Date.now()+86400000,policy_epoch:caps.policy_epoch},v.candidate_digest);await skillDetail(v.skill_id);}catch(e){skillFailure(e);}};
      }else if(v.status==='sealed'){
        const loop=(await skillApi('/skill-loop?skill_id='+v.skill_id));skillContext.loop=loop;
        const approvals=loop.approvals.filter(a=>a.version_id===v.id&&a.decision==='approve'&&a.expires_at_ms>Date.now());
        $('#skReviewActions').innerHTML=("<form id=\"skAssign\"><label for=\"skRuntime\">" + QI.msg("Enrolled runtime") + "</label><select id=\"skRuntime\">")+loop.registrations.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.runtime_kind||r.runtime_id)+' '+esc(r.runtime_version||(QI.msg("configuration required")))+'</option>').join('')+("</select><label for=\"skApproval\">" + QI.msg("Approved scope") + "</label><select id=\"skApproval\">")+approvals.map(a=>'<option value="'+esc(a.id)+'">'+esc(skillWord(a.target_scope))+'</option>').join('')+("</select><label for=\"skAssignReason\">" + QI.msg("Assignment") + "</label><select id=\"skAssignReason\"><option value=\"replace\">" + QI.msg("Assign / update") + "</option><option value=\"rollback\">" + QI.msg("Rollback to this earlier version") + "</option></select><button class=\"btn\" ")+(!loop.registrations.length||!approvals.length?'disabled':'')+(">" + QI.msg("Assign exact version") + "</button></form>");
        $('#skAssign').onsubmit=async event=>{event.preventDefault();const runtimeId=$('#skRuntime').value,approval=approvals.find(a=>a.id===$('#skApproval').value),old=loop.assignments.find(a=>a.runtime_id===runtimeId&&a.target_scope===approval.target_scope);try{const args={runtime_id:runtimeId,version_id:v.id,package_digest:v.package_digest,approval_id:approval.id,adoption_operation_id:crypto.randomUUID(),target_scope:approval.target_scope,expires_at_ms:Math.min(approval.expires_at_ms,Date.now()+3600000),expected_revision:old?.revision||0,reason:old?$('#skAssignReason').value:'assign'};if(old)args.assignment_id=old.id;await skillApi('/skill-assignments','POST',args,args.expected_revision);await skillDetail(v.skill_id);skillStatus((QI.msg("Assigned for the next managed native session. Existing sessions retain their exact versions.")));}catch(e){skillFailure(e);}};
      }
    }catch(e){skillFailure(e);}
  }

  // ================= GLOBAL SEARCH =================
  async function renderSearchPage() {
    setCrumb(("<span class=\"text-primary\">" + QI.msg("Search") + "</span>"));
    if (!agentsCache) {
      try { agentsCache = (await api('/api/dashboard/agents')).items; }
      catch (e) { if (e.message !== 'unauthorized' && state.page === 'search') { setConn(false); main.innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load agents.") + " <button type=\"button\" data-route>" + QI.msg("Retry") + "</button></div>"); } return; }
      if (state.page !== 'search') return; // The user moved on while this loaded.
    }
    main.innerHTML = '<h1 class="sr-only">' + QI.msg("Search") + '</h1>' +
      ("<div class=\"space-after-summary\"><input type=\"text\" id=\"gSearch\" aria-label=\"Search messages\" data-i18n-aria-label=\"Search messages\" class=\"input-text\" placeholder=\"" + QI.msg("Search messages and notes…") + "\"></div>") +
      ("<div class=\"search-count\">" + QI.msg("Agents you can search:") + " ") + fmtNum((agentsCache || []).length) + "</div>" +
      ("<div id=\"gResults\" aria-live=\"polite\"><div class=\"empty\">" + QI.msg("Type to search…") + "</div></div>");
    const inp = $('#gSearch'); focusField(inp); let dt;
    inp.oninput = () => { clearTimeout(dt); dt = setTimeout(() => doGlobalSearch(inp.value.trim()), 400); };
  }
  async function doGlobalSearch(q) {
    const out = $('#gResults');
    if(!out)return;
    out.dataset.query=q;
    if (!q) { out.innerHTML = ("<div class=\"empty\">" + QI.msg("Type to search…") + "</div>"); return; }
    out.innerHTML = ("<div class=\"loading\">" + QI.msg("Searching…") + "</div>");
    // One request per page: the server searches every agent this session may open (F-304).
    let hits = [], next = null;
    const page = async () => {
      const params = new URLSearchParams({ q, limit: '50' });
      for (const [k, v] of Object.entries(next || {})) if (v) params.set(k, v);
      try {
        const data = await api('/api/dashboard/search?' + params);
        if(!out.isConnected||out.dataset.query!==q)return;
        setConn(true);
        const first = hits.length;
        hits = hits.concat(data.items || []); next = data.next;
        if (!hits.length) { out.innerHTML = ("<div class=\"empty\">" + QI.msg("Nothing found across any agent.") + "</div>"); return; }
        out.innerHTML = '<div class="search-count">' + (next ? QI.msg("Showing the newest matches: {n}", { n: hits.length }) : QI.count(hits.length, 'result')) + "</div><div class=\"transcript\">" +
          // One article per hit with real buttons for the agent and the session; the excerpt is plain text (F-326).
          hits.map((m, i) => '<article class="msg" data-i="' + i + '"><div class="msg-head">' + roleIcon(m.role) +
            '<span class="msg-role' + (m.kind === 'message' ? ' ' + esc(m.role) : '') + '">' + esc(m.kind === 'message' ? QI.msg("Message") : QI.msg("Context note")) + '</span>' +
            '<button type="button" class="chip click chip-reset" data-aid="' + esc(m.agent_id) + '">' + esc(m.agent_name) + '</button>' +
            '<span>' + fmtTimeFull(m.created_at) + '</span>' +
            (m.session_id ? '<span class="flex-spacer"></span><button type="button" class="btn" data-open="' + i + '">' + QI.msg("Open session") + '</button>' : '') + '</div>' +
            '<div class="msg-content">' + esc(m.excerpt) + '</div></article>').join('') + '</div>' +
          (next ? '<button type="button" class="btn-more" id="gMore">' + QI.msg("Load more") + '</button>' : '');
        out.querySelectorAll('[data-aid]').forEach(c => c.onclick = () => drillAgentById(c.getAttribute('data-aid')));
        out.querySelectorAll('[data-open]').forEach(el => { el.onclick = () => {
          const m = hits[+el.dataset.open], agent = (agentsCache || []).find(a => a.id === m.agent_id) || { id: m.agent_id, name: m.agent_name };
          openDrill('agents', { kind: 'session', agent, session: { id: m.session_id, title: null } });
        }; });
        const more = $('#gMore'); if (more) more.onclick = () => { more.disabled = true; void page(); };
        if (first) out.querySelector('[data-i="' + first + '"] button')?.focus();
      } catch (e) { if(!out.isConnected||out.dataset.query!==q)return; errBox(out, QI.msg("Search failed."), () => doGlobalSearch(q), e); }
    };
    await page();
  }

  // ---------- Bridges: an external folder owned by this installation ----------
  async function renderBridgesPage(folderOnly=false) {
    pollFn=null;setCrumb((QI.msg("Bridges")));
    main.innerHTML=("<section class=\"work\" id=\"bridgeRoot\"><header><h1>" + QI.msg("Bridges") + "</h1><p>" + QI.msg("Connect spaces and choose what to share.") + "</p></header><p id=\"bridgeStatus\" role=\"status\" aria-live=\"polite\"></p><div class=\"work-controls\"><div><label for=\"bridgeGroup\">" + QI.msg("Your bridge") + "</label><select id=\"bridgeGroup\"><option value=\"\">" + QI.msg("Choose a bridge") + "</option></select></div><div class=\"work-actions\"><button id=\"bridgeInvite\">" + QI.msg("Invite someone") + "</button><button id=\"bridgeRefresh\">" + QI.msg("Refresh catalogs") + "</button></div></div><div id=\"bridgeConnection\"></div><div class=\"bridge-tabs\" role=\"tablist\" aria-label=\"" + QI.msg("External folder") + "\"><button role=\"tab\" data-section=\"outgoing\" aria-selected=\"true\">" + QI.msg("For sending") + "</button><button role=\"tab\" data-section=\"received\" aria-selected=\"false\">" + QI.msg("Received") + "</button><button role=\"tab\" data-section=\"catalogues\" aria-selected=\"false\">" + QI.msg("Other catalogs") + "</button><button role=\"tab\" data-section=\"requests\" aria-selected=\"false\">" + QI.msg("Requests") + "</button><button role=\"tab\" data-section=\"members\" aria-selected=\"false\">" + QI.msg("Members") + "</button></div><div class=\"bridge-search\"><label for=\"bridgeSearch\">" + QI.msg("Find a title or description") + "</label><input id=\"bridgeSearch\" type=\"search\" placeholder=\"" + QI.msg("Search this view") + "\"></div><div id=\"bridgeList\" role=\"tabpanel\"></div><details id=\"bridgeAdd\"><summary>" + QI.msg("Add a material to For sending") + "</summary><p>" + QI.msg("This saves a separate copy. Its title and description remain private until you publish them to a bridge.") + "</p><form id=\"bridgeStage\"><label for=\"bridgeSource\">" + QI.msg("Source") + "</label><select id=\"bridgeSource\"><option value=\"text\">" + QI.msg("Write a note") + "</option><option value=\"upload\">" + QI.msg("Upload a file or skill") + "</option></select><label for=\"bridgeTitle\">" + QI.msg("Title for the catalog") + "</label><input id=\"bridgeTitle\" maxlength=\"120\" required><label for=\"bridgeDescription\">" + QI.msg("Short description for the catalog") + "</label><textarea id=\"bridgeDescription\" maxlength=\"400\" rows=\"2\"></textarea><div id=\"bridgeTextWrap\"><label for=\"bridgeText\">" + QI.msg("Note") + "</label><textarea id=\"bridgeText\" rows=\"6\"></textarea></div><div id=\"bridgeFileWrap\" hidden><label for=\"bridgeFile\">" + QI.msg("File · up to 1 MiB") + "</label><input id=\"bridgeFile\" type=\"file\"><label for=\"bridgeKind\">" + QI.msg("Material type") + "</label><select id=\"bridgeKind\"><option value=\"file\">" + QI.msg("File") + "</option><option value=\"skill\">" + QI.msg("Skill · received without installation") + "</option></select></div><div class=\"work-actions\"><button type=\"submit\">" + QI.msg("Save to For sending") + "</button></div></form></details><div class=\"work-grid space-before-grid\"><section><h2>" + QI.msg("Start a small circle") + "</h2><p>" + QI.msg("Create a bridge for your collaborators. You approve who joins; every owner controls their own catalog and files.") + "</p><form id=\"bridgeCreate\"><label for=\"bridgeName\">" + QI.msg("Bridge name") + "</label><input id=\"bridgeName\" maxlength=\"120\" placeholder=\"" + QI.msg("Our research circle") + "\" required><div class=\"work-actions\"><button type=\"submit\">" + QI.msg("Create bridge") + "</button></div></form></section><section><h2>" + QI.msg("Have an invitation?") + "</h2><p>" + QI.msg("Paste its link or code. The creator confirms your membership before any catalog becomes visible.") + "</p><form id=\"bridgeJoin\"><label for=\"bridgeCode\">" + QI.msg("Invitation link or code") + "</label><textarea id=\"bridgeCode\" rows=\"2\" required></textarea><label for=\"bridgeMyName\">" + QI.msg("Your name in this bridge") + "</label><input id=\"bridgeMyName\" maxlength=\"120\" required><div class=\"work-actions\"><button type=\"submit\">" + QI.msg("Request to join") + "</button></div></form></section></div><details class=\"space-before-section\"><summary>" + QI.msg("Your external agent") + "</summary><p>" + QI.msg("Choose which of your existing agents can browse catalogs, request materials and prepare drafts. Publication and manual sending remain owner actions.") + "</p><label for=\"bridgeAgent\">" + QI.msg("Agent in this installation") + "</label><select id=\"bridgeAgent\"><option value=\"\">" + QI.msg("No agent selected") + "</option></select><div class=\"work-actions\"><button id=\"bridgeAgentSave\">" + QI.msg("Save agent") + "</button></div></details><p class=\"meta space-before-note\">" + QI.msg("Each space keeps its own data. The Qoopia relay connects members and temporarily buffers encrypted deliveries. Received files are not automatically installed, added to memory or shared onward.") + "</p><dialog class=\"bridge-dialog work\" id=\"bridgeDialog\"><div id=\"bridgeDialogContent\"></div><div class=\"work-actions\"><button id=\"bridgeDialogClose\">" + QI.msg("Close") + "</button></div></dialog></section>");
    const root=$('#bridgeRoot'),dialog=$('#bridgeDialog');let data,section=folderOnly?'outgoing':'members',busy=false,first=true,stageId=crypto.randomUUID(),createId=crypto.randomUUID();
    setCrumb(QI.msg(folderOnly?'External folder':'Bridges'));
    const head=root.querySelector('header');head.innerHTML='<h1>'+esc(QI.msg(folderOnly?'External folder':'Bridges'))+'</h1><p>'+esc(QI.msg(folderOnly?'Add a copy, review it, then choose who can receive it.':'Connect your space to another person’s Qoopia. You choose what to share.'))+'</p>';
    root.querySelector('#bridgeAdd summary').textContent=QI.msg('Add to external folder');
    root.querySelector('#bridgeStage button[type=submit]').textContent=QI.msg('Add a private copy');
    const group=root.querySelector('.work-grid');
    if(group){const sections=[...group.children];group.className='bridge-setup';sections.forEach((section,i)=>{const details=document.createElement('details');details.innerHTML='<summary>'+esc(QI.msg(i?'Accept an invitation':'Create a bridge'))+'</summary>';section.querySelector('h2')?.remove();section.before(details);details.appendChild(section);});}
    if(folderOnly){if(group)group.hidden=true;root.querySelector('[data-section=members]').hidden=true;root.querySelector('[data-section=catalogues]').hidden=true;root.querySelector('[data-section=requests]').hidden=true;}
    else {root.querySelector('#bridgeAdd').hidden=true;root.querySelector('[data-section=outgoing]').hidden=true;root.querySelector('[data-section=received]').hidden=true;root.querySelector('.bridge-tabs').insertAdjacentHTML('afterend','<p><a href="#external">'+esc(QI.msg('Open external folder'))+'</a></p>');}
    const here=()=>root.isConnected;
    const status=text=>{if(here())$('#bridgeStatus').textContent=text;};
    const selected=()=>data?.groups.find(g=>g.id===$('#bridgeGroup').value);
    const name=(g,peer)=>g?.members?.find(m=>m.peer===peer)?.name||(QI.msg("Member"));
    async function act(action,body={}) {
      if(busy)throw new Error((QI.msg("Please wait for the current action")));busy=true;
      try {const r=await send('/api/dashboard/bridges',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify({action,...body})});const result=await r.json().catch(()=>({}));if(!r.ok)throw failure(r,result);return result;}
      finally{busy=false;}
    }
    function show(content){$('#bridgeDialogContent').innerHTML=content;if(!dialog.open)dialog.showModal();}
    $('#bridgeDialogClose').onclick=()=>dialog.close();
    async function load() {
      if(!here()||busy||dialog.open)return;
      try {
        data=await api('/api/dashboard/bridges');if(!here())return;
        const old=$('#bridgeGroup').value;
        $('#bridgeGroup').innerHTML=("<option value=\"\">" + QI.msg("Choose a bridge") + "</option>")+data.groups.filter(g=>!['left','removed'].includes(g.state)).map(g=>'<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>').join('');
        $('#bridgeGroup').value=data.groups.some(g=>g.id===old&&!['left','removed'].includes(g.state))?old:data.groups.find(g=>!['left','removed'].includes(g.state))?.id||'';
        if(first){$('#bridgeAgent').innerHTML=("<option value=\"\">" + QI.msg("No agent selected") + "</option>")+data.agents.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name+(a.type==='steward'?(" " + QI.msg("· steward")):''))+'</option>').join('');$('#bridgeAgent').value=data.agent_id||'';
          $('#bridgeSource').insertAdjacentHTML('beforeend',(data.recent_sources||[]).map(s=>'<option value="'+esc(s.kind+':'+s.id)+'">'+esc(s.kind+' · '+s.title)+'</option>').join(''));first=false;}
        const empty=!data.groups.length;if(group&&!folderOnly){root.querySelector('header').after(group);if(!group.dataset.initialized){group.querySelector('details').open=empty;group.dataset.initialized='true';}}root.querySelector('.work-controls').hidden=empty;root.querySelector('.bridge-tabs').hidden=empty&&!folderOnly;root.querySelector('.bridge-search').hidden=empty&&!folderOnly;
        draw();
      }catch(e){status(e.message);}
    }
    function draw() {
      const g=selected(),query=$('#bridgeSearch').value.toLocaleLowerCase(),matches=m=>(m.title+' '+(m.description||'')).toLocaleLowerCase().includes(query),list=$('#bridgeList');
      $('#bridgeInvite').disabled=!g?.creator||g.state!=='active';$('#bridgeRefresh').disabled=g?.state!=='active';$('#bridgeAdd').hidden=section!=='outgoing';
      $('#bridgeConnection').innerHTML=(g?'<p class="meta">'+esc(g.state==='pending'?(QI.msg("Waiting for the creator to confirm your membership.")):g.state==='creating'?(QI.msg("Creating your bridge…")):g.online?(QI.msg("Connected ·") + " ")+QI.count(g.members.filter(m=>m.state==='active').length,'member'):(QI.msg("Offline · deliveries remain in their owners’ queues.")))+'</p>':'')+(data.pending_controls.length?("<p role=\"status\">" + QI.msg("Access changes are saved locally and waiting for the relay. They will be retried automatically.") + "</p>"):'')+(g?.state==='pending'?'<div class="work-actions"><button id="bridgeWithdraw">'+QI.msg("Withdraw request")+'</button></div>':'');
      const withdraw=$('#bridgeWithdraw');if(withdraw)withdraw.onclick=()=>{show('<h2>'+esc(QI.msg("Withdraw request"))+'</h2><p>'+esc(QI.msg("The creator will no longer see your request. You can ask again with an invitation."))+'</p><div class="work-actions"><button class="primary" id="bridgeWithdrawConfirm">'+esc(QI.msg("Withdraw request"))+'</button></div>');$('#bridgeWithdrawConfirm').onclick=async()=>{try{await act('membership',{group:g.id,operation:'leave'});dialog.close();await load();}catch(e){status(e.message);}};};
      const empty=text=>'<p class="bridge-empty">'+text+'</p>';
      if(section==='outgoing'||section==='received') {
        const materials=data.materials.filter(m=>m.direction===section&&matches(m));
        list.innerHTML=materials.length?materials.map(m=>{const pub=g&&data.publications.find(p=>p.group_id===g.id&&p.material_id===m.id);return '<article class="bridge-row"><div><h3>'+esc(m.title)+'</h3><p>'+esc(m.description)+'</p><p class="meta">'+(section==='received'?(QI.msg("Received · kept separate from your memory")):pub?(pub.auto_send?(QI.msg("Listed · automatic sending on request")):(QI.msg("Listed · sending needs approval"))):(QI.msg("Private draft · not listed")))+'</p></div><div class="work-actions"><button data-material="'+esc(m.id)+'">'+(section==='received'?(QI.msg("Review received")):(QI.msg("Review & publish")))+'</button></div></article>';}).join(''):empty(section==='received'?(QI.msg("Received materials will appear here, with their source.")):(QI.msg("Add a note, file or skill you are willing to share.")));
      }else if(section==='catalogues') {
        const entries=data.catalogues.filter(c=>c.group_id===g?.id).flatMap(c=>c.items.map(m=>({...m,peer:c.peer_id}))).filter(matches);
        list.innerHTML=entries.length?entries.map(m=>'<article class="bridge-row"><div><h3>'+esc(m.title)+'</h3><p>'+esc(m.description)+'</p><p class="meta">'+esc(name(g,m.peer))+(" " + QI.msg("· catalog only") + "</p></div><button data-request=\"")+esc(m.id)+'" data-peer="'+esc(m.peer)+'" data-version="'+esc(m.version)+("\">" + QI.msg("Request material") + "</button></article>")).join(''):empty((QI.msg("Choose a connected bridge and refresh its catalogs. Only titles and descriptions appear here.")));
      }else if(section==='requests') {
        const requests=data.requests.filter(r=>r.group_id===g?.id);
        list.innerHTML=requests.length?requests.map(r=>{const m=data.materials.find(m=>m.id===r.material_id),title=m?.title||data.catalogues.flatMap(c=>c.items).find(m=>m.id===r.material_id)?.title||(QI.msg("Requested material"));return '<article class="bridge-row"><div><h3>'+esc(title)+'</h3><p>'+esc((r.direction==='incoming'?(QI.msg("From") + " "):(QI.msg("To") + " "))+name(g,r.peer_id))+' · '+esc(QI.code(r.state))+'</p></div>'+(r.direction==='incoming'&&r.state==='requested'?'<button data-review-request="'+esc(r.id)+("\">" + QI.msg("Review request") + "</button>"):'')+'</article>';}).join(''):empty((QI.msg("Requests for materials will appear here.")));
      }else {
        list.innerHTML=g?.members?.length?g.members.map(m=>'<article class="bridge-row"><div><h3>'+esc(m.name)+(m.peer===data.peer_id?(" " + QI.msg("· you")):'')+'</h3><p>'+esc(QI.code(m.state))+'</p><div class="bridge-fingerprint">'+esc(m.peer)+'</div></div>'+(g.creator&&m.peer!==data.peer_id?'<button data-member="'+esc(m.peer)+'" data-operation="'+(m.state==='active'?'remove':'admit')+'">'+(m.state==='active'?(QI.msg("Remove")):(QI.msg("Review membership")))+'</button>':'')+'</article>').join('')+(g.state==='active'?'<div class="work-actions space-before-section"><button data-end="'+(g.creator?'close':'leave')+'">'+(g.creator?(QI.msg("Close bridge")):(QI.msg("Leave bridge")))+'</button></div>':''):empty((QI.msg("Create or join a bridge to see its members.")));
      }
      if(section==='members'&&g?.creator) {
        const invitations=data.invitations.filter(i=>i.group_id===g.id);
        if(invitations.length)list.insertAdjacentHTML('beforeend',("<h3 class=\"space-before-section\">" + QI.msg("Invitations") + "</h3>")+invitations.map(i=>'<article class="bridge-row"><p>'+esc(i.revoked===2?(QI.msg("Revocation queued")):i.revoked?(QI.msg("Revoked")):i.expires_at_ms<=Date.now()?(QI.msg("Expired")):(QI.msg("Expires") + " ")+QI.date(i.expires_at_ms))+'</p>'+(!i.revoked&&i.expires_at_ms>Date.now()?'<button data-revoke-invite="'+esc(i.id)+("\">" + QI.msg("Revoke invitation") + "</button>"):'')+'</article>').join(''));
        list.querySelectorAll('[data-revoke-invite]').forEach(b=>b.onclick=async()=>{try{await act('revoke-invite',{id:b.dataset.revokeInvite});await load();}catch(e){status(e.message);}});
      }
      list.querySelectorAll('[data-material]').forEach(b=>b.onclick=()=>reviewMaterial(b.dataset.material).catch(e=>status(e.message)));
      list.querySelectorAll('[data-request]').forEach(b=>b.onclick=async()=>{try{await act('request',{id:crypto.randomUUID(),group:g.id,peer:b.dataset.peer,material_id:b.dataset.request,version:b.dataset.version});status((QI.msg("Request queued. The owner decides whether to send this version.")));await load();}catch(e){status(e.message);}});
      list.querySelectorAll('[data-review-request]').forEach(b=>b.onclick=()=>{const r=data.requests.find(r=>r.id===b.dataset.reviewRequest);reviewMaterial(r.material_id,r).catch(e=>status(e.message));});
      list.querySelectorAll('[data-member]').forEach(b=>b.onclick=()=>{const m=g.members.find(m=>m.peer===b.dataset.member),admit=b.dataset.operation==='admit';show('<h2>'+esc(admit?(QI.msg("Confirm this participant")):(QI.msg("Remove participant")))+'</h2><p>'+esc(m.name)+'</p><p class="bridge-fingerprint">'+esc(m.peer)+'</p><p>'+(admit?(QI.msg("Confirm that this is the person you invited. Membership opens published catalogs; it does not grant file access.")):(QI.msg("This ends new access to the bridge. Previously received copies remain with their recipients.")))+'</p><div class="work-actions"><button class="primary" id="bridgeMemberConfirm">'+(admit?(QI.msg("Admit to bridge")):(QI.msg("Remove from bridge")))+'</button>'+(admit?'<button id="bridgeMemberDecline">'+QI.msg("Decline request")+'</button>':'')+'</div>');const decide=operation=>async()=>{try{await act('membership',{group:g.id,operation,peer:m.peer});dialog.close();await load();}catch(e){status(e.message);}};$('#bridgeMemberConfirm').onclick=decide(b.dataset.operation);if(admit)$('#bridgeMemberDecline').onclick=decide('remove');});
      list.querySelectorAll('[data-end]').forEach(b=>b.onclick=()=>{show('<h2>'+esc(b.textContent)+("</h2><p>" + QI.msg("New access will stop. Your own data and received copies remain in your installation.") + "</p><div class=\"work-actions\"><button class=\"primary\" id=\"bridgeEndConfirm\">")+esc(b.textContent)+'</button></div>');$('#bridgeEndConfirm').onclick=async()=>{try{await act('membership',{group:g.id,operation:b.dataset.end});dialog.close();await load();}catch(e){status(e.message);}};});
    }
    async function reviewMaterial(materialId,transfer) {
      const m=await act('material',{id:materialId}),g=selected(),bytes=Uint8Array.from(atob(m.content_base64),c=>c.charCodeAt(0)),text=m.mime.startsWith('text/')||m.kind==='note'?new TextDecoder().decode(bytes):null;
      const pub=g&&data.publications.find(p=>p.group_id===g.id&&p.material_id===materialId);
      show('<h2>'+esc(m.title)+'</h2><p>'+esc(m.description)+'</p><p class="meta">'+esc(m.filename)+' · '+humanSize(bytes.length)+'</p>'+(m.direction==='received'?("<p>" + QI.msg("Received from") + " ")+esc(name(data.groups.find(x=>x.id===m.source.group),m.source.peer))+(QI.msg(". Treat this material as a reference until you decide how to use it.") + "</p>"):'')+(transfer?("<p>" + QI.msg("Request from") + " <strong>")+esc(name(g,transfer.peer_id))+("</strong>" + QI.msg(". Approve sends only the version shown here.") + "</p>"):'')+(text!==null?'<pre>'+esc(text.slice(0,64000))+'</pre>'+(text.length>64000?("<p class=\"meta\">" + QI.msg("Preview shortened. Download to review the complete file.") + "</p>"):''):("<p>" + QI.msg("Download the original to review its contents.") + "</p>"))+("<button id=\"bridgeDownload\">" + QI.msg("Download original") + "</button>")+(transfer?("<div class=\"work-actions\"><button class=\"primary\" id=\"bridgeApprove\">" + QI.msg("Approve sending") + "</button><button id=\"bridgeSkip\">" + QI.msg("Skip") + "</button></div>"):m.direction==='outgoing'&&g?.state==='active'?("<hr><h3>" + QI.msg("Catalogue in") + " ")+esc(g.name)+("</h3><p>" + QI.msg("Publish only the title and short description. File contents are sent separately, on request.") + "</p><label><input type=\"checkbox\" id=\"bridgeAuto\"> " + QI.msg("Automatically send this version when a member of this bridge requests it") + "</label><div class=\"work-actions\"><button class=\"primary\" id=\"bridgePublish\">")+(pub?(QI.msg("Save sharing rule")):(QI.msg("Publish catalog entry")))+'</button>'+(pub?("<button id=\"bridgeWithdraw\">" + QI.msg("Withdraw entry") + "</button>"):'')+'</div>':m.direction==='received'?("<div class=\"work-actions\"><button id=\"bridgePrepareAgain\">" + QI.msg("Prepare a copy for sharing") + "</button></div>"):("<p>" + QI.msg("Create or join a bridge before publishing this draft.") + "</p>")));
      $('#bridgeDownload').onclick=()=>{const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=m.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      if(transfer)for(const [button,approve] of [['bridgeApprove',true],['bridgeSkip',false]])$('#'+button).onclick=async()=>{try{await act('decide',{id:transfer.id,version:m.version,approve});dialog.close();status(approve?(QI.msg("Approved. Delivery will appear in the recipient’s Received folder.")):(QI.msg("Request skipped.")));await load();}catch(e){status(e.message);}};
      if($('#bridgeAuto'))$('#bridgeAuto').checked=!!pub?.auto_send;
      if($('#bridgePublish'))$('#bridgePublish').onclick=async()=>{try{await act('publish',{group:g.id,material_id:materialId,version:m.version,visible:true,auto_send:$('#bridgeAuto').checked});dialog.close();status((QI.msg("Catalogue entry published to") + " ")+g.name+'.');await load();}catch(e){status(e.message);}};
      if($('#bridgeWithdraw'))$('#bridgeWithdraw').onclick=async()=>{try{await act('publish',{group:g.id,material_id:materialId,version:m.version,visible:false,auto_send:false});dialog.close();status((QI.msg("Entry withdrawn. Already delivered copies cannot be recalled.")));await load();}catch(e){status(e.message);}};
      if($('#bridgePrepareAgain'))$('#bridgePrepareAgain').onclick=async()=>{try{await act('copy',{id:crypto.randomUUID(),source:'received',source_id:materialId,title:m.title,description:m.description});dialog.close();status(QI.msg('A private draft was added to For sending. Publish it only after review.'));await load();}catch(e){status(e.message);}};
    }
    $('#bridgeGroup').onchange=draw;$('#bridgeSearch').oninput=draw;
    const tabs=[...root.querySelectorAll('[data-section]')].filter(b=>!b.hidden);
    tabs.forEach((b,i)=>{b.id='bridgeTab'+i;b.setAttribute('aria-controls','bridgeList');b.tabIndex=b.dataset.section===section?0:-1;b.setAttribute('aria-selected',String(b.dataset.section===section));b.onclick=()=>{section=b.dataset.section;tabs.forEach(t=>{t.setAttribute('aria-selected',String(t===b));t.tabIndex=t===b?0:-1;});$('#bridgeList').setAttribute('aria-labelledby',b.id);draw();};b.onkeydown=e=>{let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();tabs[next].click();tabs[next].focus();}};});
    $('#bridgeList').setAttribute('aria-labelledby',tabs.find(b=>b.dataset.section===section).id);
    $('#bridgeCreate').onsubmit=async e=>{e.preventDefault();try{await act('create',{id:createId,name:$('#bridgeName').value});createId=crypto.randomUUID();$('#bridgeName').value='';status((QI.msg("Bridge created. Invite the people you want to connect.")));await load();}catch(e){status(e.message);}};
    $('#bridgeJoin').onsubmit=async e=>{e.preventDefault();try{await act('join',{code:$('#bridgeCode').value,name:$('#bridgeMyName').value});$('#bridgeCode').value='';status((QI.msg("Membership requested. The creator will confirm your installation.")));await load();}catch(e){status(e.message);}};
    $('#bridgeInvite').onclick=async()=>{try{const invitation=await act('invite',{id:crypto.randomUUID(),group:selected().id});show(("<h2>" + QI.msg("Invite to") + " ")+esc(selected().name)+("</h2><p>" + QI.msg("Share this link, code or QR with your collaborator. You confirm who joins. The invitation expires in 24 hours.") + "</p><div class=\"bridge-qr\">")+invitation.svg+("</div><label for=\"bridgeInviteLink\">" + QI.msg("Invitation link") + "</label><textarea id=\"bridgeInviteLink\" rows=\"3\" readonly>")+esc(invitation.url)+("</textarea><label for=\"bridgeInviteCode\">" + QI.msg("Invitation code") + "</label><textarea id=\"bridgeInviteCode\" rows=\"2\" readonly>")+esc(invitation.code)+("</textarea><div class=\"work-actions\"><button class=\"primary\" id=\"bridgeCopyLink\">" + QI.msg("Copy link") + "</button><button id=\"bridgeCopyCode\">" + QI.msg("Copy code") + "</button><button id=\"bridgeRevoke\">" + QI.msg("Revoke invitation") + "</button></div>"));$('#bridgeCopyLink').onclick=()=>copyText($('#bridgeCopyLink'),invitation.url);$('#bridgeCopyCode').onclick=()=>copyText($('#bridgeCopyCode'),invitation.code);$('#bridgeRevoke').onclick=async()=>{try{const result=await act('revoke-invite',{id:invitation.id});dialog.close();status(result.revoked?(QI.msg("Invitation revoked.")):(QI.msg("Revocation saved; it will reach the relay when connected.")));}catch(e){status(e.message);}};}catch(e){status(e.message);}};
    $('#bridgeRefresh').onclick=async()=>{try{await act('refresh',{group:selected().id});status((QI.msg("Catalogue requests queued. Replies arrive when the other installations are online.")));await load();}catch(e){status(e.message);}};
    $('#bridgeAgentSave').onclick=async()=>{try{await act('agent',{id:$('#bridgeAgent').value||null});status((QI.msg("External agent saved. Reconnect its MCP client to discover the bridge tools.")));await load();}catch(e){status(e.message);}};
    $('#bridgeSource').onchange=()=>{const value=$('#bridgeSource').value;$('#bridgeTextWrap').hidden=value!=='text';$('#bridgeFileWrap').hidden=value!=='upload';const source=data.recent_sources.find(s=>s.kind+':'+s.id===value);if(source)$('#bridgeTitle').value=source.title.slice(0,120);};
    const add=$('#bridgeAdd');add.ondragover=e=>{e.preventDefault();add.open=true;};add.ondrop=e=>{e.preventDefault();const file=e.dataTransfer.files[0];if(!file)return;const transfer=new DataTransfer();transfer.items.add(file);$('#bridgeFile').files=transfer.files;$('#bridgeSource').value='upload';$('#bridgeSource').onchange();$('#bridgeTitle').value=file.name.slice(0,120);$('#bridgeTitle').focus();};
    $('#bridgeStage').onsubmit=async e=>{
      e.preventDefault();try {
        const source=$('#bridgeSource').value,common={id:stageId,title:$('#bridgeTitle').value,description:$('#bridgeDescription').value};
        if(source.includes(':')){const [kind,sourceId]=source.split(':');await act('copy',{...common,source:kind,source_id:sourceId});}
        else {
          let content,filename='note.md',mime='text/markdown',kind='note';
          if(source==='upload'){const file=$('#bridgeFile').files[0];if(!file)throw new Error((QI.msg("Choose a file")));if(file.size>data.limits.file_bytes)throw new Error((QI.msg("Choose a file up to 1 MiB")));filename=file.name;mime=file.type.split(';')[0]||'application/octet-stream';kind=$('#bridgeKind').value;content=new Uint8Array(await file.arrayBuffer());}
          else content=new TextEncoder().encode($('#bridgeText').value);
          if(content.length>data.limits.file_bytes)throw new Error((QI.msg("Choose a material up to 1 MiB")));
          let binary='';for(let i=0;i<content.length;i+=8192)binary+=String.fromCharCode(...content.subarray(i,i+8192));
          await act('stage',{...common,filename,mime,kind,content_base64:btoa(binary)});
        }
        stageId=crypto.randomUUID();$('#bridgeStage').reset();$('#bridgeTextWrap').hidden=false;$('#bridgeFileWrap').hidden=true;$('#bridgeAdd').open=false;status((QI.msg("Saved privately to For sending. Review and publish its catalog entry when ready.")));await load();
      }catch(e){status(e.message);}
    };
    await load();pollFn=load;
  }

  // ---------- Memory ----------
  async function renderWorkspace(snapshot) {
    pollFn=null;setCrumb((QI.msg("Memory")));
    let data;try{data=snapshot||await api('/api/dashboard/memory');}catch(e){if(state.page==='work')errBox(main,QI.msg('Could not load memory settings.'),()=>renderWorkspace(),e);return;}
    if(state.page!=='work')return;
    const names={claude_code:'Claude',codex:'ChatGPT'},model=data.model;
    const messages={not_connected:(QI.msg("Choose the subscription you want Qoopia to use.")),selected:(QI.msg("Sign in if needed, then check the connection.")),ready:(QI.msg("Connected. Ready to organize your memory.")),auth_required:(QI.msg("The memory model is signed out. Sign in again below. Your conversations are still saved and will be processed after sign-in.")),quota:(QI.msg("Your subscription limit was reached. Saved events are waiting safely.")),timeout:(QI.msg("The model took too long. Search and saved events are still available.")),unavailable:(QI.msg("The model is unavailable. Check your subscription connection.")),invalid_response:(QI.msg("The model returned an unusable result. Your last saved context is preserved."))};
    main.innerHTML=("<section class=\"work\"><header><h1>" + QI.msg("Memory settings") + "</h1><p>" + QI.msg("Configure how this workspace keeps and finds context.") + "</p></header><div class=\"work-grid\"><div><section class=\"memory-first\"><h2>" + QI.msg("Your agents, connected.") + "</h2><p>" + QI.msg("Connect ChatGPT, Claude and your native agents in one place. Your steward and existing connections stay with this workspace.") + "</p><div class=\"work-actions\"><button id=\"memoryConnections\">" + QI.msg("Open connections →") + "</button></div></section><h2>" + QI.msg("Optional: a model for your memory") + "</h2><p>" + QI.msg("Use your own subscription to organize session notes and assess search results. Text search and built-in semantic search remain available without it.") + "</p><div class=\"work-controls memory-model-controls\"><div><label for=\"memoryProvider\">" + QI.msg("Your subscription") + "</label><select id=\"memoryProvider\"><option value=\"claude_code\">Claude · Haiku</option><option value=\"codex\">ChatGPT · Codex</option></select></div><div class=\"work-actions\"><button id=\"memorySelect\">" + QI.msg("Use this subscription") + "</button></div></div><p class=\"work-status\" role=\"status\" id=\"memoryModelStatus\">")+esc(messages[model.state]||model.state)+(model.model?' · '+esc(model.model_label||model.model):'')+("</p><div class=\"work-actions\"><button id=\"memoryLogin\">" + QI.msg("Sign in to") + " ")+esc(names[model.runtime]||(QI.msg("subscription")))+("</button><button class=\"primary\" id=\"memoryCheck\">" + QI.msg("Check connection") + "</button></div><div id=\"memoryLoginInfo\"></div><p id=\"memoryActionStatus\" role=\"status\" aria-live=\"polite\" class=\"work-status\"></p></div><aside><h2>" + QI.msg("Already in your memory") + "</h2><p><strong>")+esc(data.embedding.embedded)+' / '+esc(data.embedding.total_notes)+("</strong><br>" + QI.msg("notes indexed for semantic search") + "</p><p><strong>")+esc(data.sessions.summarized)+' / '+esc(data.sessions.tracked)+("</strong><br>" + QI.msg("tracked sessions with a context note") + "</p><div class=\"work-result\"><h2>" + QI.msg("How continuity works") + "</h2><p>" + QI.msg("Events are saved as you work. A compact note evolves with the session. When you return, your agent receives the note and recent events that have not yet been summarized.") + "</p><p>" + QI.msg("Everything stays in this workspace. Existing notes, namespaces and connections remain in place.") + "</p><button id=\"memorySessions\">" + QI.msg("Browse agent sessions →") + "</button></div></aside></div></section>");
    const signIn=model.sign_in;
    if(signIn&&['expiring','expired'].includes(signIn.state)&&model.state!=='auth_required'){
      const warning=document.createElement('p');warning.className='work-status';warning.setAttribute('role','status');
      warning.textContent=QI.msg(signIn.state==='expiring'?'Memory model access expires soon: {date}.':'Memory model access expired at {date}.',{date:fmtTimeFull(signIn.access_expires_at)})+' '+QI.msg(signIn.refresh_available?'Qoopia will try to renew it automatically. If renewal fails, sign in again below.':'Sign in again below to keep memory processing available.');
      $('#memoryModelStatus').after(warning);
    }else if(signIn?.state==='unknown'){
      const info=document.createElement('p');info.className='meta';info.textContent=QI.msg('The provider does not expose a sign-in deadline. Qoopia will alert you if a new sign-in is needed.');$('#memoryModelStatus').after(info);
    }
    const root=main.firstElementChild;let actionBusy=false,polling=false;
    let savedProvider;try{savedProvider=sessionStorage.getItem('qoopia.memory.provider');}catch{/* Storage unavailable; use the configured runtime. */}$('#memoryProvider').value=['claude_code','codex'].includes(savedProvider)?savedProvider:model.runtime||'claude_code';
    $('#memoryProvider').onchange=e=>{try{sessionStorage.setItem('qoopia.memory.provider',e.target.value);}catch{/* Storage unavailable; the choice is not remembered. */}};
    const op=data.operation;if(op?.state==='running')$('#memoryActionStatus').textContent=QI.msg('Preparing your subscription. You can use other pages.');else if(op?.state==='failed')$('#memoryActionStatus').textContent=QI.msg(op.error);else if(op?.state==='completed'&&op.action==='check')$('#memoryActionStatus').textContent=QI.msg('Connection checked with a real model response.');
    $('#memoryLogin').disabled=!model.runtime||data.busy;$('#memoryCheck').disabled=!model.runtime||data.busy;$('#memorySelect').disabled=data.busy;
    $('#memorySessions').onclick=()=>go('agents');
    $('#memoryConnections').onclick=()=>go('connections');
    const login=data.login;
    if(login?.state==='cancelled')$('#memoryActionStatus').textContent=QI.msg("Sign-in canceled.");
    if(login?.state==='failed')$('#memoryActionStatus').textContent=QI.msg("Sign-in did not finish. Try signing in again.");
    if(login?.state==='waiting') {
      const box=$('#memoryLoginInfo');box.innerHTML=("<p>" + QI.msg("Waiting for subscription sign-in…") + "</p>");
      const cancel=document.createElement('button');cancel.textContent=QI.msg('Cancel sign-in');cancel.onclick=()=>action({action:'cancel-login'});box.append(cancel);
      if(login.url){const a=document.createElement('a');a.href=login.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=(QI.msg("Open secure sign-in →"));box.append(a);}
      if(login.code){const code=document.createElement('p');code.textContent=(QI.msg("Enter this code:") + " ")+login.code;box.append(code);}
      if(model.runtime==='claude_code'){
        const form=document.createElement('form');form.innerHTML=("<label for=\"memoryLoginCode\">" + QI.msg("Code shown after signing in to Claude") + "</label><input id=\"memoryLoginCode\" type=\"password\" autocomplete=\"one-time-code\" maxlength=\"8192\" required><button>" + QI.msg("Complete sign-in") + "</button>");
        form.onsubmit=async e=>{e.preventDefault();const code=$('#memoryLoginCode').value;$('#memoryLoginCode').value='';await action({action:'login-code',code});};box.append(form);
      }
    }
    async function action(payload) {
      if(actionBusy||!root.isConnected)return;actionBusy=true;
      const status=$('#memoryActionStatus');status.textContent=payload.action==='select'?(QI.msg("Preparing the official client…")):(QI.msg("Working…"));
      const buttons=[...root.querySelectorAll('button')].filter(b=>!['memoryConnections','memorySessions'].includes(b.id));buttons.forEach(b=>b.disabled=true);
      try{
        const result=await apiWrite('/api/dashboard/memory',payload);
        if(!root.isConnected||state.page!=='work')return;
        await renderWorkspace();
        if(result.accepted)$('#memoryActionStatus').textContent=QI.msg('Preparing your subscription. You can use other pages.');
        else if(result.next)$('#memoryActionStatus').textContent=QI.msg(result.next);
        else if(payload.action==='check')$('#memoryActionStatus').textContent=(QI.msg("Connection checked with a real model response."));
      }catch(e){if(root.isConnected){status.textContent=e.message;buttons.forEach(b=>b.disabled=false);}}finally{actionBusy=false;}
    }
    $('#memorySelect').onclick=()=>action({action:'select',runtime:$('#memoryProvider').value});
    $('#memoryLogin').onclick=()=>action({action:'login'});$('#memoryCheck').onclick=()=>action({action:'check'});
    // Keep inputs stable. Refresh only when a login or background index changes.
    pollFn=async()=>{if(polling||actionBusy||!root.isConnected)return;polling=true;try{const next=await api('/api/dashboard/memory');if(root.isConnected&&!actionBusy&&state.page==='work'&&JSON.stringify(next)!==JSON.stringify(data)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))await renderWorkspace(next);}catch(e){if(root.isConnected)$('#memoryActionStatus').textContent=e.message;}finally{polling=false;}};
  }


  const SURFACE_NAMES={codex:'Codex CLI',claude_code:'Claude Code',muse_code:'Muse Code CLI',muse_app:'Muse.app',grok_bot:'Grok Bot',claude_desktop:'Claude Desktop',claude_web:'Claude Web',chatgpt_web:'ChatGPT Web',chatgpt_desktop:'ChatGPT Desktop'};
  async function renderConnectionWizard(host,workspaceName,workspaceId,onRefresh) {

    const names=SURFACE_NAMES;
    const guides={
      chatgpt_web:{url:'https://chatgpt.com/plugins',text:QI.msg("Open Plugins → + → New plugin. Choose OAuth and paste this address. Developer mode may be required in Settings → Security and login."),limit:QI.msg("Last verified with ChatGPT Pro in the web client on 15 September 2026: OAuth, connection check, reading, adding and repeat requests. The current consent and automatic confirmation have not been re-verified with a real ChatGPT account. Availability depends on your ChatGPT plan and workspace settings. If a client check is blocked, stop and leave the connection unverified.")},
      chatgpt_desktop:{url:'https://developers.openai.com/apps-sdk/deploy/connect-chatgpt',text:QI.msg("Open Plugins in the desktop client and add this address using OAuth. If the desktop app does not offer custom plugins, use another supported client."),limit:QI.msg("On 15 September 2026 OAuth, authenticated verification, reading, writing and retries without duplicates passed on Mac. The current consent and automatic confirmation have not been re-verified with a real ChatGPT account. Use New chat → Chat. Stop any client-blocked action.")},
      claude_web:{url:'https://claude.ai/customize/connectors',text:QI.msg("Open Customize → Connectors → + → Add custom connector. Paste this address, add it and choose Connect. Enable it in the conversation."),limit:QI.msg("Free allows one custom connector. Team/Enterprise require an organization owner to add it.")},
      claude_desktop:{url:'https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop',text:QI.msg("Add the local adapter on your Mac, or open the downloaded setup file there. Approve this connection in Qoopia, restart Claude Desktop, then send the request below in a new conversation."),limit:QI.msg("The local adapter targets Claude Desktop on macOS. A server workspace still needs its external address to be reachable. Actual Desktop acceptance is reported separately.")},
      codex:{url:'https://developers.openai.com/codex/mcp',text:QI.msg("Add this URL as a Streamable HTTP MCP server in Codex, then use its OAuth login. Approve access when asked, then send the request below in Codex."),limit:QI.msg("MCP grants access to memory. Background model authorization remains separate.")},
      claude_code:{url:'https://code.claude.com/docs/en/mcp',text:QI.msg("Add this URL as an HTTP MCP server in Claude Code. Open /mcp to sign in, then send the request below in Claude Code."),limit:QI.msg("The client stores its own OAuth credential; never paste a token into chat.")},
      muse_app:{url:QI.resolve(QI.msg("/connections-guide-en.html#client-8")),text:QI.msg("Send the setup request to your Muse.app agent. Its cloud runtime needs a supported remote MCP client and secure OAuth sign-in. Muse Code CLI settings do not configure Muse.app."),limit:QI.msg("Runtime MCP calls have been verified for FIBI. This does not qualify a native custom-connector screen in Muse.app or automatic session capture. Never paste OAuth tokens or callback codes into chat.")},
      muse_code:{url:'https://meta-models.github.io/muse-code-sdk/next/guides/extend/mcp-servers/',text:QI.msg("Merge the copied entry into ~/.config/muse/settings.json without replacing other settings. Start a new Muse Code process, run muse mcp login for this server, then send the request below in a Muse Code conversation."),limit:QI.msg("The setup snippet includes no secret. Muse Code stores OAuth separately. Automatic session capture requires a separate adapter and is not enabled by this MCP connection.")},
      grok_bot:{url:'https://cursor.com/help/grok-bot/connect-plugins',text:QI.msg("Copy the setup request below into your cloud Grok Bot chat. Let the bot add this exact remote MCP address and complete OAuth in the client; The first protocol call confirms the connection automatically."),limit:QI.msg("Custom MCP setup varies by Grok Bot account and app version. If your bot cannot add a custom server, leave this connection unverified. Grok Bot plugins are account-wide.")}
    };
    const link=(url,label)=>'<a class="connect-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+label+' ↗</a>';
    const connectionName=c=>'qoopia_'+c.id.replaceAll('-','');
    function setupText(c){
      const name=connectionName(c);
      if(c.surface==='muse_code')return JSON.stringify({schema_version:1,mcpServers:{[name]:{type:'streamable-http',url:c.mcp_url}}},null,2);
      if(c.surface==='muse_app')return QI.resolve(QI.msg("Connect {value1} to this exact Qoopia MCP URL: {value2}. Use the supported remote MCP client in your cloud runtime and secure OAuth sign-in. Preserve existing connections. Do not use Muse Code CLI settings or ask for tokens or OAuth callback codes in chat. Read qoopia_protocol and qoopia_capabilities, then call qoopia_protocol on this exact connection. If secure OAuth setup is unavailable, report that specific blocker; do not claim completion.",{value1:(c.agent_name||QI.msg('this Muse.app agent')),value2:c.mcp_url}));
      if(c.surface==='grok_bot')return QI.resolve(QI.msg("Add a custom remote MCP server named {value1} to this Grok Bot account: {value2}. Use OAuth in the client; do not ask me to paste a token into chat. If custom MCP is unavailable, tell me instead of claiming it is connected.",{value1:name,value2:c.mcp_url}));
      return '';
    }
    function connectRequest(c){
      const request=QI.resolve(QI.msg("Read qoopia_protocol and qoopia_capabilities from the Qoopia connection at {value1}. Keep your role and instructions. Tell me what is available, or report the exact error.",{value1:c.mcp_url}));
      return ['muse_app','grok_bot'].includes(c.surface)?setupText(c)+'\n\n'+request:request;
    }
    host.innerHTML='<p id="setupFeedback" role="status" aria-live="polite"></p><div id="setupConnections"></div><details id="setupNew" class="connection-add"><summary>'+QI.msg("Add an application")+'</summary><div class="work-controls"><div><label for="setupSurface">'+QI.msg("Application")+'</label><select id="setupSurface">'+Object.entries(names).map(([id,name])=>'<option value="'+id+'">'+name+'</option>').join('')+'</select></div><div><label for="setupAccess">'+QI.msg("Access")+'</label><select id="setupAccess"><option value="read">'+QI.msg("Read only")+'</option><option value="read_write">'+QI.msg("Read and add")+'</option></select></div><div><label for="setupAgentName">'+QI.msg("Agent name (optional)")+'</label><input id="setupAgentName" maxlength="64" placeholder="FIBI" autocomplete="off"></div><button id="setupApply" class="primary">'+QI.msg("Continue")+'</button></div><p class="meta">'+QI.msg("A separate connection for this application. Existing agents keep their access.")+'</p><p class="meta">'+QI.msg("Read and add allows new notes, without editing or deleting existing ones.")+'</p></details><details id="setupNetworkDetails" class="connection-options"><summary>'+QI.msg("External access settings")+'</summary><div id="setupNetwork"></div><p id="setupNetworkFeedback" role="status" aria-live="polite"></p></details>';
    const feedback=host.querySelector('#setupFeedback'),networkFeedback=host.querySelector('#setupNetworkFeedback');
    let actionBusy=false,revision=0,refreshing=false,lastResult='',lastConnections='',lastNetwork='';
    const call=async(body,target=feedback)=>{if(actionBusy)throw Error(QI.resolve(QI.msg('Please wait for the current action')));actionBusy=true;revision++;target.textContent=QI.msg('Working…');host.setAttribute('aria-busy','true');try{return await apiWrite('/api/dashboard/connection-setup',body);}finally{actionBusy=false;if(host.isConnected)host.removeAttribute('aria-busy');}};
    let networkBusy=false;
    const draftKey='qoopia-connection-draft:'+workspaceName;
    let draft;try{draft=JSON.parse(sessionStorage.getItem(draftKey));}catch{/* No usable draft (storage unavailable or corrupt). */}
    if(draft&&names[draft.surface]&&['read','read_write'].includes(draft.access_mode)&&typeof draft.request_key==='string'){
      host.querySelector('#setupSurface').value=draft.surface;host.querySelector('#setupAccess').value=draft.access_mode;host.querySelector('#setupAgentName').value=draft.agent_name||'';
    }else draft=null;
    function selection(){
      const surface=host.querySelector('#setupSurface').value,access_mode=host.querySelector('#setupAccess').value,agent_name=host.querySelector('#setupAgentName').value.normalize('NFC').trim();
      if(agent_name&&!/^(?=[\s\S]{1,64}$)(?:[A-Za-z0-9_\-\s]+|(?:(?=\p{Script=Cyrillic})\p{L}|[0-9_\-\s])+)$/u.test(agent_name))throw Error(QI.resolve(QI.msg("Use up to 64 Latin or Cyrillic letters (one alphabet per name), digits, spaces, underscores or hyphens.")));
      if(!draft||draft.surface!==surface||draft.access_mode!==access_mode||(draft.agent_name||'')!==agent_name)draft={surface,access_mode,...(agent_name?{agent_name}:{}),request_key:crypto.randomUUID()};
      try{sessionStorage.setItem(draftKey,JSON.stringify(draft));}catch{/* Storage unavailable; the draft lives only in this page. */}return draft;
    }
    const networkLine=n=>{const r=n.operation?.result;return r&&(!(r.code||'').startsWith('NETWORK_')||r.code===n.code)?r:n;};
    const showResult=(r,target=feedback)=>{
      const messages={ACTION_IN_PROGRESS:QI.msg("Working. You can use other pages."),TOO_MANY_SIGN_INS:QI.msg("Too many sign-in emails were sent in the last hour. Use “Confirm with Google”, or try again later."),CLIENT_AUTH_STARTING:QI.msg("Preparing the secure sign-in page…"),CLIENT_AUTHORIZATION_REQUIRED:QI.msg("Open the consent page, review this connection’s permissions, and approve. Then restart Claude Desktop."),CLIENT_CALL_REQUIRED:QI.msg("Access is saved. Restart the client and send the connection request."),CLIENT_AUTH_EXPIRED:QI.msg("The sign-in expired. Choose Approve access again."),CLIENT_CONFIG_REQUIRED:QI.msg("Add the client on this computer first."),SIGN_IN_REQUIRED:QI.msg("Account confirmation expired. Start sign-in again; the installation and memory are preserved."),ACCOUNT_CONFIRMATION_REQUIRED:QI.msg("Confirm the email sent to your Qoopia account, then choose Continue setup."),OWNER_ACCOUNT_REQUIRED:QI.msg("Finish signing in to your Qoopia account first."),NETWORK_ONLINE:QI.msg("External connection is running."),NETWORK_CONNECTING:QI.msg("Reconnecting. Local memory is preserved."),NETWORK_SERVICE_UNAVAILABLE:QI.msg("The connection service is unavailable. Keep this setup and try Continue setup later."),NETWORK_DISABLED:QI.msg("External access is paused."),DEVICE_REVOKED:QI.msg("This installation was revoked as an external device. Choose one of the enable buttons below to register it again."),DEVICE_CODE_UNSUPPORTED:QI.msg("The Qoopia sign-in service does not offer code confirmation yet. Use email or Google from a browser on this network.")};
      target.textContent=messages[r.code]||(r.next_action?QI.msg(r.next_action):'');
      // Device-code confirmation: the code and the sign-in service's page, to use on any device.
      if(r.user_code){target.textContent=QI.msg("On your phone or another computer, open the page, sign in to the Qoopia account linked to this installation and enter the code ");
        const code=document.createElement('strong');code.textContent=r.user_code;const a=document.createElement('a');a.href=r.open_url||r.verification_uri;a.target='_blank';a.rel='noopener noreferrer';a.className='connect-link';a.textContent=r.verification_uri;
        target.append(code,document.createTextNode('. '+QI.msg("Then choose Continue setup.")+' '),a);return;}
      if(r.open_url){const a=document.createElement('a');a.href=r.open_url;a.target='_blank';a.rel='noopener noreferrer';a.className='connect-link';a.textContent=r.code==='CLIENT_AUTHORIZATION_REQUIRED'?QI.msg("Open consent page"):QI.msg("Open account sign-in");target.append(document.createTextNode(' '),a);}
    };
    async function refresh(showNetworkStatus=false){
      if(refreshing||actionBusy||!host.isConnected)return;refreshing=true;const started=revision;
      let result;try{result=await api('/api/dashboard/connection-setup');}finally{refreshing=false;}
      if(!host.isConnected||actionBusy||started!==revision)return;
      if(onRefresh)await onRefresh();
      if(!host.isConnected||actionBusy||started!==revision)return;
      const network=result.network,key=JSON.stringify(result);
      if(!showNetworkStatus&&key===lastResult)return;lastResult=networkBusy?'':key;
      if(!networkBusy&&network?.operation){if(network.operation.result)showResult(networkLine(network),networkFeedback);else if(network.operation.state==='running')showResult({code:'ACTION_IN_PROGRESS'},networkFeedback);}else if(showNetworkStatus&&!networkBusy)showResult(network,networkFeedback);
      const networkKey=JSON.stringify([network?.code,network?.enabled,network?.device?.state,network?.transport?.reachable,network?.operation?.state,networkBusy]);
      if(networkKey!==lastNetwork){lastNetwork=networkKey;
      const section=host.querySelector('#setupNetwork');
      host.querySelector('#setupNetworkDetails').hidden=network?.code==='MANAGED_INSTALLATION_REQUIRED';
      if(network?.code==='MANAGED_INSTALLATION_REQUIRED')section.innerHTML='<h3>'+QI.msg("External connection")+'</h3><p>'+QI.msg("The current server manages its external address. Availability is checked when the client connects.")+'</p>';
      else{
        const ready=network?.transport?.reachable;
        section.innerHTML='<h3>'+QI.msg("External connection")+'</h3><p>'+esc(ready?QI.msg("Tunnel connected"):network?.code==='DEVICE_REVOKED'?QI.msg("This installation was revoked as an external device. Enable external access again to register it as a new device: memory and local connections stay; ChatGPT, Claude.ai and other remote applications must be connected again at the new address."):network?.enabled?QI.msg("Connecting…"):QI.msg("External access is off"))+'</p><p>'+QI.msg("Memory stays on this machine. Cloudflare handles encrypted transport and terminates HTTPS; it can process MCP traffic and connection metadata. The dashboard stays local.")+'</p><div class="work-actions">'+
          (!network?.device||network.device.state==='revoked'?'<button data-network="network-start">'+QI.msg("Enable with email confirmation")+'</button><button data-network="network-start-google">'+QI.msg("Confirm with Google")+'</button><button data-network="network-start-device">'+QI.msg("Confirm on another device")+'</button>':'<button data-network="'+(network.enabled?'network-disable':'network-enable')+'">'+(network.enabled?QI.msg("Pause external access"):QI.msg("Enable external access"))+'</button>')+
          '<button data-network="network-resume">'+QI.msg("Continue setup")+'</button></div><p class="meta">'+QI.msg("Sleeping or offline machines cannot answer requests. The service reconnects when connectivity returns.")+'</p>';
        section.querySelectorAll('[data-network]').forEach(b=>{
          b.disabled=networkBusy||network?.operation?.state==='running';
          b.onclick=async()=>{
            if(networkBusy)return;networkBusy=true;
            section.querySelectorAll('[data-network]').forEach(button=>button.disabled=true);
            networkFeedback.textContent=QI.msg("Updating external connection…");
            try{
              const action=b.dataset.network;
              const r=await call(action.startsWith('network-start')?{action:'network-start',language:QI.language,method:action.endsWith('google')?'google':action.endsWith('device')?'device':'email'}:{action},networkFeedback);
              showResult(r,networkFeedback);await refresh();
            }catch(e){networkFeedback.textContent=e.message;}
            finally{networkBusy=false;section.querySelectorAll('[data-network]').forEach(button=>button.disabled=false);networkFeedback.scrollIntoView({block:'nearest'});}
          };
        });
      }
      }
      const connectionKey=JSON.stringify(result.connections);if(connectionKey===lastConnections)return;
      const previous=lastConnections?JSON.parse(lastConnections):[];lastConnections=connectionKey;
      const connected=result.connections.find(c=>c.state==='ready'&&previous.some(p=>p.id===c.id&&p.state!=='ready'));
      if(connected)feedback.textContent=(connected.agent_name||names[connected.surface])+' · '+QI.resolve(QI.msg("Connected. Your agent can use Qoopia."));
      const openIds=new Set([...host.querySelectorAll('[data-connection][open]')].map(el=>el.dataset.connection));
      const requestIds=new Set([...host.querySelectorAll('[data-request-details][open]')].map(el=>el.dataset.requestDetails));
      const reconnectIds=new Set([...host.querySelectorAll('[data-reconnect][open]')].map(el=>el.dataset.reconnect));
      const labels=new Map([...host.querySelectorAll('[data-label-name]')].map(el=>[el.dataset.labelName,{name:el.value,surface:host.querySelector('[data-label-surface="'+el.dataset.labelName+'"]')?.value,open:el.closest('details').open}]));
      const active=result.connections.filter(c=>c.code!=='REVOKED');
      function connectionRow(c){
        const guide=guides[c.surface],revoked=c.code==='REVOKED',ready=c.state==='ready',reauth=c.code==='CLIENT_REAUTHORIZATION_REQUIRED';
        const title=(c.agent_name?c.agent_name+' · ':'')+(names[c.surface]||c.surface);
        const stateLabel=ready?QI.msg("Connected"):revoked?QI.msg("Access revoked"):c.code==='RECONNECT_REQUIRED'?QI.msg("Connect again at the new address"):reauth?QI.msg("Sign in again in the application"):QI.msg("Waiting for the agent’s first request");
        const cloud=['muse_app','grok_bot'].includes(c.surface);
        const authHtml=c.surface==='claude_desktop'&&c.client_config==='on_this_computer'?'<div class="work-actions"><button data-client-auth="'+c.id+'">'+QI.msg("Approve access")+'</button>'+(c.client_auth?.open_url?link(c.client_auth.open_url,QI.msg("Open consent page")):'')+'</div>':'';
        const request='<button class="'+(cloud?'primary':'')+'" data-copy-request="'+c.id+'">'+(cloud?QI.msg("Copy setup request"):QI.msg("Copy request for your agent"))+'</button><details class="connection-help" data-request-details="'+c.id+'"><summary>'+QI.msg("View request")+'</summary><pre class="connection-request" data-request="'+c.id+'">'+esc(connectRequest(c))+'</pre></details>';
        const setup=revoked?'':(cloud?'<h3>'+QI.msg("Send this request to your agent")+'</h3><p>'+QI.msg("Ask the agent to add Qoopia. Approve access in its secure sign-in window.")+'</p>'+request:
          '<h3>'+QI.msg("Add Qoopia in ")+esc(names[c.surface])+'</h3><p>'+esc(guide.text)+'</p><div class="work-actions">'+(c.client_config?'<button class="primary" data-client-setup="'+c.id+'">'+(c.client_config==='on_this_computer'?QI.msg("Add to this computer"):QI.msg("Download setup file"))+'</button>':c.surface==='muse_code'?'<button class="primary" data-copy-setup="'+c.id+'">'+QI.msg("Copy config")+'</button>':'<button class="primary" data-copy-connection="'+c.id+'">'+QI.msg("Copy address")+'</button>')+'</div>'+authHtml+
          '<h3>'+QI.msg("Send this request in the application")+'</h3>'+request)+
          '<p class="meta">'+QI.msg("Qoopia updates this status automatically after the first successful protocol call. There is no temporary verification code. This confirms access to Qoopia; automatic chat saving is configured separately.")+'</p><details class="connection-help"><summary>'+QI.msg("Connection details and help")+'</summary><p class="connection-endpoint">'+esc(c.mcp_url)+'</p><button data-copy-connection="'+c.id+'">'+QI.msg("Copy address")+'</button>'+(c.surface==='muse_code'?'<pre>'+esc(setupText(c))+'</pre><p><code>'+esc('muse mcp login '+connectionName(c))+'</code></p>':'')+'<p>'+esc(guide.limit)+'</p>'+link(guide.url,QI.msg("Open instructions"))+'</details>';
        return '<details class="connection-record" data-connection="'+c.id+'"'+(openIds.has(c.id)?' open':'')+'><summary><span>'+esc(title)+'</span><span class="connection-state">'+stateLabel+'</span><span class="connection-action">'+(revoked?QI.msg("Details"):ready?QI.msg("Manage"):QI.msg("Continue"))+'</span></summary><div class="connection-body"><p>'+QI.msg("Access: ")+(c.access_mode==='read'?QI.msg("Read only"):QI.msg("Read and add"))+'</p>'+(c.last_seen?'<p class="meta">'+QI.msg("Last request: ")+esc(QI.date(c.last_seen))+'</p>':'')+
          (ready?'<p>'+QI.msg("Last verified call: ")+esc(QI.date(c.verified_at))+'. '+QI.msg("This records a successful call, not continuous availability.")+'</p><details data-reconnect="'+c.id+'"'+(reconnectIds.has(c.id)?' open':'')+'><summary>'+QI.msg("Connect again")+'</summary>'+setup+'</details>':setup)+
          (revoked?'':'<details class="connection-options"><summary>'+QI.msg("Name and application")+'</summary><label for="label-'+c.id+'">'+QI.msg("Agent name")+'</label><input id="label-'+c.id+'" data-label-name="'+c.id+'" maxlength="64" value="'+esc(c.agent_name||'')+'">'+(['muse_code','muse_app'].includes(c.surface)?'<label for="surface-'+c.id+'">'+QI.msg("Application")+'</label><select id="surface-'+c.id+'" data-label-surface="'+c.id+'"><option value="muse_app"'+(c.surface==='muse_app'?' selected':'')+'>Muse.app</option><option value="muse_code"'+(c.surface==='muse_code'?' selected':'')+'>Muse Code CLI</option></select>':'')+'<button data-label-connection="'+c.id+'">'+QI.msg("Save name")+'</button></details><details class="connection-options"><summary>'+QI.msg("Remove access")+'</summary><p>'+QI.msg("Only this connection will stop working. Notes and other agents are preserved.")+'</p><button data-revoke-connection="'+c.id+'">'+QI.msg("Revoke access")+'</button></details>')+'</div></details>';
      }
      // Only a setup in progress shows here: one created in the last day whose agent has not come yet.
      // Once the agent makes a request it is in the connected list; an abandoned setup drops out.
      const pending=active.filter(c=>c.state!=='ready'&&!c.last_seen&&Date.now()-new Date(c.created_at).getTime()<86400000);
      host.querySelector('#setupConnections').innerHTML=(pending.length?'<h3>'+QI.msg("Being connected")+'</h3>':'')+pending.map(connectionRow).join('');
      host.querySelectorAll('[data-request-details]').forEach(el=>el.open=requestIds.has(el.dataset.requestDetails));
      host.querySelectorAll('[data-label-name]').forEach(el=>{const edit=labels.get(el.dataset.labelName);if(edit){el.value=edit.name;el.closest('details').open=edit.open;const surface=host.querySelector('[data-label-surface="'+el.dataset.labelName+'"]');if(surface&&edit.surface)surface.value=edit.surface;}});
      host.querySelectorAll('[data-client-setup]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{
        const c=result.connections.find(c=>c.id===b.dataset.clientSetup);
        if(c.client_config==='on_this_computer'){
          const plan=await call({action:'client-plan',id:c.id,language:QI.language});
          if(plan.can_apply===false){feedback.textContent=QI.msg("This client entry changed outside Qoopia. Review it in your client settings before continuing.");return;}
          const applied=await call({action:'client-apply',id:c.id,language:QI.language});
          if(c.surface==='claude_desktop'){showResult(await call({action:'client-auth-start',id:c.id}));await refresh();return;}
          feedback.textContent=(applied.code==='CLIENT_AUTH_REQUIRED'?QI.msg("Address added. Open the client, authenticate its Qoopia connection, then send the connection request below."):QI.msg(applied.next_action||''))+
            (applied.protocol?.state==='refused'?' '+QI.msg("Local Qoopia instructions were not installed: ")+applied.protocol.code+(applied.protocol.file?' — '+applied.protocol.file:'')+'. '+QI.msg("The agent reads qoopia_protocol over this connection."):'');
        }else{
          const r=await call({action:'client-export',id:c.id});
          if(!r.binding){feedback.textContent=QI.msg(r.next_action||'');return;}
          const url=URL.createObjectURL(new Blob([JSON.stringify(r.binding)],{type:'application/json'})),a=document.createElement('a');
          a.href=url;a.download='Qoopia-'+c.surface+'.qoopia-connection';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          feedback.textContent=QI.msg("Open the downloaded file with Qoopia on your client’s computer. Review the address, add it, then authenticate in the client.");
        }
      }catch(e){feedback.textContent=e.message;}finally{b.disabled=false;}});
      host.querySelectorAll('[data-client-auth]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{showResult(await call({action:'client-auth-start',id:b.dataset.clientAuth}));await refresh();}catch(e){feedback.textContent=e.message;}finally{b.disabled=false;}});
      host.querySelectorAll('[data-copy-connection]').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(result.connections.find(c=>c.id===b.dataset.copyConnection).mcp_url);feedback.textContent=QI.msg("Address copied.");}catch{feedback.textContent=QI.msg("Select and copy the address above.");}});
      host.querySelectorAll('[data-copy-setup], [data-copy-request]').forEach(b=>b.onclick=async()=>{try{
        const id=b.dataset.copySetup||b.dataset.copyRequest,c=result.connections.find(c=>c.id===id);
        await navigator.clipboard.writeText(b.dataset.copySetup?setupText(c):connectRequest(c));
        feedback.textContent=b.dataset.copySetup?QI.msg("Config copied. Add it to Muse Code settings, then run the login command in connection details."):QI.msg("Request copied. Send it in the selected application; this page will show the result automatically.");
      }catch{const request=host.querySelector('[data-request="'+b.dataset.copyRequest+'"]');if(request)request.closest('details').open=true;feedback.textContent=QI.msg("Copy failed. Select and copy the request or config shown in this connection.");}});
      host.querySelectorAll('[data-label-connection]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const id=b.dataset.labelConnection,surface=host.querySelector('[data-label-surface="'+id+'"]')?.value;await call({action:'label',id,agent_name:host.querySelector('[data-label-name="'+id+'"]').value.trim(),...(surface?{surface}:{})});host.querySelector('[data-label-name="'+id+'"]').closest('details').open=false;await refresh();feedback.textContent=QI.msg("Name saved. Connection, access and memory preserved.");}catch(e){feedback.textContent=e.message;}finally{b.disabled=false;}});
      host.querySelectorAll('[data-revoke-connection]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await call({action:'disconnect',id:b.dataset.revokeConnection});await refresh();}catch(e){feedback.textContent=e.message;b.disabled=false;}});
    }
    host.querySelector('#setupApply').onclick=async e=>{e.target.disabled=true;try{
      const created=await call({action:'apply',...selection()});draft=null;try{sessionStorage.removeItem(draftKey);}catch{/* Storage unavailable; nothing was stored. */}
      await refresh();host.querySelector('#setupNew').open=false;
      const detail=host.querySelector('[data-connection="'+created.connection.id+'"]');if(detail){const group=detail.closest('[data-connection-drafts]');if(group)group.open=true;detail.open=true;detail.querySelector('summary').focus();}
      feedback.textContent=QI.msg("Connection prepared. Finish setup in the selected application.");
    }catch(e){
      // The server's English hint names CLI commands; on a phone the owner needs the switch on this page instead.
      const network=host.querySelector('#setupNetworkDetails');
      if(e.code==='NOT_READY'&&!network.hidden){feedback.textContent='';network.open=true;networkFeedback.textContent=QI.msg("Turn on external access here first, then tap Continue again.");network.scrollIntoView({block:'start'});}
      else feedback.textContent=e.message;
    }finally{host.querySelector('#setupApply').disabled=false;}};
    await refresh();
    const proposal=new URL(location.href),params=proposal.searchParams;
    if(params.has('connect')){
      const surface=params.get('connect'),name=params.get('agent')||'',access=params.get('access'),id=params.get('connection');
      if(params.get('workspace')!==workspaceId||!names[surface]||!['read','read_write'].includes(access)||!/^(?=[\s\S]{1,64}$)(?:[A-Za-z0-9_\-\s]+|(?:(?=\p{Script=Cyrillic})\p{L}|[0-9_\-\s])+)$/u.test(name.normalize('NFC').trim())||id&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))feedback.textContent=QI.msg("This setup link does not match your workspace or has invalid settings.");
      else if(id){
        const detail=host.querySelector('[data-connection="'+id+'"]');
        if(detail){const group=detail.closest('[data-connection-drafts]');if(group)group.open=true;detail.open=true;const input=detail.querySelector('[data-label-name]');input.value=name;input.closest('details').open=true;const select=detail.querySelector('[data-label-surface]');if(select)select.value=surface;input.focus();feedback.textContent=QI.msg("Review this existing connection. Saving its name preserves its access and verification.");}
        else feedback.textContent=QI.msg("This connection is unavailable in your workspace.");
      }else{host.querySelector('#setupNew').open=true;host.querySelector('#setupSurface').value=surface;host.querySelector('#setupAccess').value=access;host.querySelector('#setupAgentName').value=name;host.querySelector('#setupApply').focus();feedback.textContent=QI.msg("Review the application, name and access before preparing the connection.");}
      for(const key of ['connect','agent','access','workspace','connection'])params.delete(key);
      history.replaceState(null,'',proposal.href);
    }
    if(host.isConnected)pollFn=()=>refresh().catch(e=>{if(host.isConnected)feedback.textContent=e.message;});
  }

  async function renderConnections() {
    pollFn=null;setCrumb(QI.msg('Connections'));main.innerHTML='<p class="loading">'+QI.msg('Loading your connections…')+'</p>';
    let data;try{data=await api('/api/dashboard/connections');}catch(e){if(state.page==='connections')errBox(main,QI.msg('Could not load connections.'),()=>renderConnections(),e);return;}
    if(state.page!=='connections')return;
    const stewards=data.stewards.map(a=>a.name).join(', ');
    $('#workspaceName').textContent=data.workspace;
    const date=value=>QI.date(value,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const lastSeen=value=>value?QI.msg("Last request: ")+date(value):QI.msg("No requests recorded");
    const modelStates={ready:QI.msg("Responding"),not_connected:QI.msg("Not selected"),selected:QI.msg("Sign-in or check needed"),auth_required:QI.msg("Sign in again"),quota:QI.msg("Subscription limit reached"),timeout:QI.msg("Response timed out"),unavailable:QI.msg("Unavailable"),invalid_response:QI.msg("Response could not be used"),busy:QI.msg("Working")};
    // One row per application that came at least once: what it is, which agent, and in one word whether it is used.
    const DAY=86400000,appName=a=>a.client||SURFACE_NAMES[a.surface]||a.name;
    const appRow=a=>{const days=Math.floor((Date.now()-new Date(a.last_seen).getTime())/DAY);
      return '<div class="connection-line"><div><strong>'+esc(appName(a))+'</strong>'+(appName(a)!==a.name?' <span class="meta">· '+esc(a.name)+'</span>':'')+'</div>'+
        '<div class="connection-app"><span>'+(a.state&&a.state!=='verified'?'○ '+QI.msg("Setup not finished: the application has not signed in yet"):a.reconnect?'○ '+QI.msg("Connect again: its address stopped with the revoked device"):!a.authorized?'○ '+QI.msg("Sign in again in the application"):days<7?'● '+QI.msg("Working"):'○ '+QI.msg("Not used for {value1} days",{value1:days}))+'</span><p class="meta">'+esc(a.state&&a.state!=='verified'?QI.msg("Added ")+date(a.created_at):lastSeen(a.last_seen))+'</p></div>'+
        '<button data-disconnect="'+esc(a.kind+':'+a.id)+'" data-name="'+esc(appName(a)+' · '+a.name)+'"'+(a.state&&a.state!=='verified'?' data-unfinished="1">'+QI.msg("Cancel setup"):'>'+QI.msg("Disconnect"))+'</button></div>';};
    main.innerHTML='<section class="work connections"><header><h1>'+QI.msg("Connections")+'</h1><p>'+esc(data.workspace)+'. '+QI.msg("MCP clients connected to this memory, and how it is processed.")+'</p></header><p id="connectionsStatus" class="work-status" role="status" aria-live="polite"></p>'+
      '<section aria-labelledby="connectedTitle"><h2 id="connectedTitle"></h2><div id="connectedApplications"></div><div id="connectionWizard"></div></section>'+
      '<section class="connection-summary"><div class="connection-line"><div><h2>'+QI.msg("Memory model")+'</h2><p id="connectionsModelSummary"></p><p id="connectionsModelChecked" class="meta"></p></div><button id="connectionsModel">'+QI.msg("Settings")+'</button></div>'+
      '<div class="connection-line"><div><h2>'+QI.msg("My Qoopia agent")+'</h2><p id="connectionsStewardName">'+esc(stewards||QI.msg("Not assigned"))+'</p></div><button id="connectionsSteward">'+QI.msg("Open agent")+'</button></div></section>'+
      '<details class="connection-options"><summary>'+QI.msg("Session memory settings")+'</summary><p>'+QI.msg("Configure automatic context for a Claude Code or Codex agent. This is separate from its access to notes.")+'</p>'+
        (data.installed?'<h3>'+QI.msg("On this computer")+'</h3>':'')+'<div class="work-actions"><button data-memory-client="claude_code">Claude Code</button><button data-memory-client="codex">Codex</button></div>'+
        (data.installed?'<h3>'+QI.msg("On another computer")+'</h3><p>'+QI.msg("Downloads a .qoopia-memory file that reaches this installation through its external address. Enable external access first.")+'</p><p>'+QI.msg('This file contains a key to your Qoopia memory: whoever has it can save sessions and search memory, including all workspace notes while shared context is on. Keep it private; if it leaks, ask your Qoopia agent to deactivate its memory agent.')+'</p><div class="work-actions"><button data-memory-client="claude_code" data-memory-target="another_computer">Claude Code</button><button data-memory-client="codex" data-memory-target="another_computer">Codex</button></div>':'')+
        '</details></section>';
    function overview(next){
      $('#connectionsStewardName').textContent=next.stewards.map(a=>a.name).join(', ')||QI.msg("Not assigned");
      const model=next.memory_model||{state:'not_connected'};
      $('#connectionsModelSummary').textContent=(model.model_label||model.model||QI.msg("Optional"))+' · '+(modelStates[model.state]||QI.msg("Check needed"));
      $('#connectionsModelChecked').textContent=model.checked_at?QI.msg("Last response: ")+date(model.checked_at):'';
      const apps=(next.apps||[]).filter(a=>a.last_seen);
      $('#connectedTitle').textContent=QI.msg("Connected applications")+' · '+apps.length;
      $('#connectedApplications').innerHTML=apps.map(appRow).join('')||'<p class="meta">'+QI.msg("No application has connected yet.")+'</p>';
    }
    overview(data);
    void renderConnectionWizard($('#connectionWizard'),data.workspace,data.workspace_id,async()=>{const next=await api('/api/dashboard/connections');if(state.page==='connections')overview(next);}).catch(e=>{if(state.page==='connections')$('#connectionWizard').textContent=e.message;});
    if(state.page!=='connections')return;
    const status=$('#connectionsStatus');
    $('#connectionsSteward').onclick=()=>go('my-agent');$('#connectionsModel').onclick=()=>go('work');
    // Disconnecting ends the application's access; the agent's notes and conversations stay.
    $('#connectedApplications').onclick=async e=>{
      const b=e.target.closest('[data-disconnect]');if(!b)return;
      if(!window.confirm(QI.resolve(b.dataset.unfinished?QI.msg("Cancel the unfinished setup {value1}? An agent already working with its own key keeps working.",{value1:b.dataset.name})
        :QI.msg("Disconnect {value1}? It loses access to this memory; its notes and conversations stay.",{value1:b.dataset.name}))))return;
      const [kind,id]=b.dataset.disconnect.split(/:(.*)/);b.disabled=true;
      try{await apiWrite('/api/dashboard/connection-setup',kind==='oauth'?{action:'revoke-oauth',agent_id:id}:{action:'disconnect',id});
        status.textContent=QI.resolve(QI.msg("Disconnected: "))+b.dataset.name;const next=await api('/api/dashboard/connections');if(state.page==='connections')overview(next);}
      catch(err){b.disabled=false;status.textContent=err.message;}
    };
    main.querySelectorAll('[data-memory-client]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;status.textContent=QI.msg('Preparing your connection…');
      try {
        const result=await apiWrite('/api/dashboard/memory',{action:'connect-agent',runtime:button.dataset.memoryClient,...(button.dataset.memoryTarget?{target:button.dataset.memoryTarget}:{})});
        if(result.state==='download_connection') {
          const url=URL.createObjectURL(new Blob([JSON.stringify(result.connection)],{type:'application/json'})),a=document.createElement('a');
          a.href=url;a.download='Qoopia-'+button.dataset.memoryClient+'.qoopia-memory';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          status.textContent=QI.msg('Open the downloaded file with Qoopia where your agent runs and confirm that the address shown is your Qoopia. On Linux, run qoopia memory-link --file FILE and follow the plan it prints. The file contains a private connection key; keep it on your own device.');
        }else status.textContent=QI.msg(result.next||'Connection configured.');
      }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
    });
  }

  // ---------- Boot ----------
  async function boot() {
    state = { page: 'overview', drill: null }; tickClock();
    try{const r=await send(BASE+'/api/dashboard/profile',{credentials:'same-origin'});const p=r.ok?await r.json():null;serviceOwner=!!p?.service_owner;$('#ownerEmail').textContent=p?.email||'';$('#ownerEmail').hidden=!p?.email;}catch{serviceOwner=false;$('#ownerEmail').hidden=true;}
    $('#workspaceHost').textContent=location.host;
    try {
      const response=await send(BASE+'/api/dashboard/memory',{credentials:'same-origin'});
      localWorkspace=response.ok?await response.json():null;
      $('#workspaceName').textContent=localWorkspace?(QI.msg("Owner workspace")):(QI.msg("Agent view"));
    }catch{localWorkspace=null;}
    chat?.dispose();chat=localWorkspace?window.QoopiaChat({api,send,esc,humanSize,onUnauthorized:showLogin}):null;
    state=await stateFromHash();
    route();
  }

  $('#uiReload').onclick=()=>location.reload();
  async function checkInterfaceVersion() {
    if(document.hidden)return;
    try {const r=await send(BASE+'/dashboard',{method:'HEAD',cache:'no-store'}),version=r.headers.get('x-qoopia-dashboard-version');
      if(version&&version!==document.querySelector('meta[name="qoopia-dashboard-version"]').content)$('#uiUpdate').hidden=false;
    }catch{/* Version check is best-effort; retried every 60 s and on visibility change. */}
  }
  setInterval(checkInterfaceVersion,60000);
  document.addEventListener('visibilitychange',checkInterfaceVersion);

  // ---------- Scroll to top ----------
  (function () {
    var btn = document.getElementById('toTopBtn');
    if (!btn) return;
    var sync = function () { btn.classList.toggle('show', window.scrollY > 200); };
    window.addEventListener('scroll', sync, { passive: true });
    btn.onclick = function () { window.scrollTo({ top: 0, behavior: motion() }); };
    sync();
  })();

  (async()=>{
    let identity=null,identityDone=false,r;
    try{if(setupCode)await identityPost('setup',{code:setupCode});}catch(e){loginError(e);}
    // Only a 401 means signed out. A phone that drops the request, a restarting server (502/503) or a rate
    // limit (429) used to land on the sign-in page, often without its sign-in buttons: keep checking instead.
    const get=path=>send(BASE+path,{credentials:'same-origin',signal:AbortSignal.timeout(15000)});
    for(let attempt=0;;attempt++){
      try{
        if(!identityDone){const i=await get('/api/dashboard/identity');if(i.ok){identity=await i.json();$('#emailLogin').hidden=false;identityDone=true;}else{i.body?.cancel().catch(()=>{});identityDone=i.status<500&&i.status!==429;}}
        r=await get('/api/dashboard/agents');
        r.body?.cancel().catch(()=>{}); // Only r.ok is read; an unread body held the request open until the timeout (F-331).
        if(r.ok||r.status===401&&identityDone)break;
      }catch{/* Offline or timed out: checked again below. */}
      if($('#sessionCheck'))$('#sessionCheck').textContent=QI.msg('Connection lost. Reconnecting…');
      await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,10000)));
    }
    // An authenticated dashboard session is valid without an email binding (local owner login).
    if(r.ok){finishAccountSignIn();if(consumeSafeNext())return;showApp();boot();}
    else{
      showLogin();$('#accountLoginBtn').hidden=!identity?.linked||!accountSignIn;
      if(accountSignIn==='complete'&&accountCode){$('#loginView').classList.add('account-connecting');await awaitEmailConfirmation(null,false,accountCode);}
      else if(['account','complete'].includes(accountSignIn)&&identity?.linked)await startAccountLogin();
      else if(identity?.pending)await awaitEmailConfirmation(null,false);
    }
  })().catch(e=>{showLogin();loginError(e);});
})();
