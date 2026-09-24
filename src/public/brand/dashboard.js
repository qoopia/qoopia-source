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

  // ---------- API ----------
  async function api(path) {
    const r = await fetch(BASE + path, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error_description || data.error?.message || data.error || ('HTTP ' + r.status));
    return data;
  }
  async function apiWrite(path, body) {
    const r = await fetch(BASE + path, {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', 'X-Qoopia-CSRF': '1' },
      body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error_description || ('HTTP ' + r.status));
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
    const r=await fetch(BASE+'/api/dashboard/identity/'+route,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(25000),...(loginAbort?[loginAbort.signal]:[])])});
    const data=await r.json();if(!r.ok)throw new Error(data.error||(QI.msg("Sign-in is temporarily unavailable")));return data;
  }
  function finishAccountSignIn(){const url=new URL(location.href);url.searchParams.delete('signin');history.replaceState(null,'',url.pathname+url.search+url.hash);$('#loginView').classList.remove('account-connecting');}
  async function startAccountLogin(){
    ++loginPoll;loginAbort?.abort();loginAbort=new AbortController();
    $('#loginErr').style.display='none';$('#loginView').classList.add('account-connecting');$('#emailLoginStatus').textContent=QI.msg('Opening your dashboard…');
    try{const data=await identityPost('start',{method:'account',language:QI.language});const url=new URL(data.accountUrl);if(url.origin!=='https://auth.qoopia.ai'||url.pathname!=='/profile')throw new Error(QI.msg('Sign-in is temporarily unavailable'));location.assign(url.href);}catch(e){loginError(e);}
  }
  $('#accountLoginBtn').onclick=startAccountLogin;
  async function awaitEmailConfirmation(googleUrl,openGoogle=false,code=null){
    const poll=++loginPoll;
    $('#emailLoginStatus').textContent=QI.msg(code?'Opening your dashboard…':googleUrl?"Choose your Google account in the browser, then confirm the email from Qoopia. Return here to finish signing in.":"Confirm the new email, then return here. This page will open your workspace automatically.");
    if(googleUrl){const a=document.createElement('a');a.href=googleUrl;a.target='_blank';a.rel='noopener';a.textContent=QI.msg("Choose your Google account");$('#emailLoginStatus').append(' ',a);if(openGoogle)a.click();}
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent=QI.msg("Cancel sign-in");cancel.onclick=()=>{++loginPoll;loginAbort?.abort();$('#loginView').classList.remove('account-connecting');$('#emailLoginStatus').textContent=QI.msg("Sign-in cancelled. You can try again.");$('#googleLoginBtn').disabled=false;$('#emailLoginBtn').disabled=false;};$('#emailLoginStatus').append(' ',cancel);
    for(let i=0;i<240&&poll===loginPoll;i++){
      if(!code||i>0)await new Promise(resolve=>setTimeout(resolve,2500));
      if(poll!==loginPoll)return;
      const data=await identityPost('poll',code?{accountCode:code}:{});
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
  $('#emailLoginForm').onsubmit=e=>{e.preventDefault();startEmailLogin('email');};
  $('#googleLoginBtn').onclick=()=>startEmailLogin('google');
  function showLogin() { chat?.dispose();chat=null;localWorkspace=null; $('#loginView').style.display = 'flex'; $('#appView').style.display = 'none'; pollFn = null; }
  function showApp() { $('#loginView').style.display = 'none'; $('#appView').style.display = 'block'; }
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
      const r=await fetch(BASE+'/api/dashboard/local-login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
      const data=await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(data.error || (QI.msg("Code expired or invalid")));
      form.reset(); if (consumeSafeNext()) return; showApp(); boot();
    } catch (e) { $('#loginErr').textContent=e.message+(QI.msg(". Run qoopia owner-login locally for a new code.")); $('#loginErr').style.display='block'; inp.focus(); }
    finally { btn.disabled=false; btn.textContent=(QI.msg("Sign in as owner")); }
  };
  $('#loginBtn').onclick = async () => {
    const btn = $('#loginBtn'); const inp = $('#tokenInput'); const t = inp.value.trim();
    if (!t) return;
    btn.disabled = true; btn.textContent = (QI.msg("Checking…"));
    try {
      const r = await fetch(BASE + '/api/dashboard/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Authorization': 'Bearer ' + t },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      inp.value = '';
      if (consumeSafeNext()) return;
      showApp(); boot();
    } catch (e) { $('#loginErr').textContent=e.message+(QI.msg(". Check that this agent key is active.")); $('#loginErr').style.display='block'; inp.focus(); }
    finally { btn.disabled = false; btn.textContent = (QI.msg("Sign in with API key")); }
  };
  $('#tokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#loginBtn').click();
    $('#loginErr').style.display = 'none';
  });
  $('#logoutBtn').onclick = async () => {
    loginPoll++;
    try {
      const r=await fetch(BASE + '/api/dashboard/logout', { method: 'POST', credentials: 'same-origin' });
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
  function avatarClass(name) {
    const n = (name || '').toLowerCase();
    if (['alan','aizek','aidan','dan','liam','claude','gpt'].includes(n)) return n;
    return 'other';
  }
  function initial(name) { return (name || '?').charAt(0).toUpperCase(); }
  function liveStatus(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 90) return ("<span class=\"live-dot\" title=\"" + QI.msg("active now") + "\"></span>");
    if (diff < 600) return ("<span class=\"recent-dot\" title=\"" + QI.msg("active recently") + "\"></span>");
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

  // ---------- Navigation ----------
  const NAV = [
    { id: 'work', label: (QI.msg("Memory")), icon: '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>' },
    { id: 'connections', label: (QI.msg("Connections")), icon: '<path d="m8 12 8 0M8 6H4v12h4M16 6h4v12h-4"/>' },
    { id: 'overview', label: (QI.msg("Overview")), icon: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z"/>' },
    { id: 'agents', label: (QI.msg("Agents")), icon: '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.87"/>' },
    { id: 'agentcomm', label: (QI.msg("Agent conversations")), icon: '<path d="M8 10h8M8 14h5"/><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>' },
    { id: 'bridges', label: (QI.msg("Bridges")), icon: '<circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><path d="m8 10 8-4M8 14l8 4"/>' },
    { id:'external',label:QI.msg('External folder'),icon:'<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>' },
    { id: 'skills', label: (QI.msg("Skills")), icon: '<path d="M12 3l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/>' },
    { id: 'files', label: (QI.msg("Files")), icon: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>' },
    { id: 'search', label: (QI.msg("Search")), icon: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>' },
  ];
  const navOrder=['overview','work','agents','connections','agentcomm','skills','bridges','external','files','search'];
  NAV.sort((a,b)=>navOrder.indexOf(a.id)-navOrder.indexOf(b.id));
  let navBadges = {};
  function renderNav() {
    $('#nav').innerHTML = NAV.filter(n => (!['work','connections','my-agent'].includes(n.id) || localWorkspace)).map(n => {
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
    return NAV.some(n=>n.id===page)&&(!['work','connections'].includes(page)||localWorkspace)?page:'overview';
  }
  function go(page) {
    if(page==='my-agent'){chat?.open();return;}
    if(page!=='profile'&&!(page==='owner'&&serviceOwner)&&!NAV.some(n=>n.id===page))return;
    try{localStorage.setItem('qoopia.dashboard.page',page);}catch{}
    history.pushState(null,'',location.pathname+location.search+'#'+(page==='work'?'memory':page));
    state={page:pageFromHash(),drill:null};Promise.resolve(route()).then(()=>{if(document.contains(main))main.focus({preventScroll:true});});
  }
  window.addEventListener('hashchange',()=>{if($('#appView').style.display!=='none'){state={page:pageFromHash(),drill:null};Promise.resolve(route()).then(()=>{if(document.contains(main))main.focus({preventScroll:true});});}});

  function setCrumb(html) { crumb.innerHTML = html;document.title=QI.resolve(crumb.textContent)+' · Qoopia'; }

  // ---------- Router ----------
  function route(force) {
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
  let lastPoll=0,pollRunning=false;async function pollPage(){if(pollRunning||!pollFn)return;pollRunning=true;try{await pollFn();}catch{}finally{pollRunning=false;}}setInterval(() => { if (!document.hidden && pollFn && Date.now()-lastPoll>=5000){lastPoll=Date.now();void pollPage();} }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollFn) void pollPage(); });

  // ================= FILES =================
  function humanSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + (" " + QI.msg("B"));
    if (n < 1048576) return (n / 1024).toFixed(1) + (" " + QI.msg("KB"));
    return (n / 1048576).toFixed(1) + (" " + QI.msg("MB"));
  }
  function filesCurrentFolder() {
    const nf = $('#fNewFolder') && $('#fNewFolder').value.trim();
    if (nf) return nf;
    const s = $('#fFolder');
    return (s && s.value) ? s.value : 'inbox';
  }
  async function renderFilesPage() {
    setCrumb(("<span style=\"color:var(--text)\">" + QI.msg("Files") + "</span>"));
    main.innerHTML =
      '<div class="panel">' +
        ("<div class=\"panel-h\"><h3>" + QI.msg("My Files") + "</h3><span class=\"meta\">" + QI.msg("upload from phone or mac · any agent can read them") + "</span></div>") +
        '<div class="filter-bar">' +
          '<select class="sel" id="fFolder" aria-label="Folder" data-i18n-aria-label="Folder"></select>' +
          ("<input class=\"input-text\" id=\"fNewFolder\" aria-label=\"New folder\" data-i18n-aria-label=\"New folder\" placeholder=\"" + QI.msg("or type a new folder") + "\" style=\"max-width:180px\">") +
        '</div>' +
        '<label id="fDrop" style="display:block;text-align:center;padding:22px;margin:10px 0;border:1px dashed var(--border);border-radius:8px;cursor:pointer">' +
          '<input type="file" id="fInput" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden">' +
          ("<div>" + QI.msg("Tap to choose files — or drag & drop here") + "</div>") +
          '<div id="fProg" class="meta" style="margin-top:6px"></div>' +
        '</label>' +
        ("<div id=\"fList\" class=\"loading\">" + QI.msg("Loading…") + "</div>") +
      '</div>';
    const inp = $('#fInput'), drop = $('#fDrop');
    // input is visually-hidden inside the <label>, so a tap on the box opens the
    // native picker (reliable on iOS). Keep an explicit trigger for the inner divs.
    drop.addEventListener('click', (e) => { if (e.target !== inp) { e.preventDefault(); inp.click(); } });
    inp.onchange = () => filesUpload(inp.files);
    drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
    drop.ondragleave = () => { drop.style.borderColor = ''; };
    drop.ondrop = (e) => { e.preventDefault(); drop.style.borderColor = ''; if (e.dataTransfer.files.length) filesUpload(e.dataTransfer.files); };
    $('#fFolder').onchange = () => filesLoadList();
    await filesLoadFolders();
  }
  async function filesLoadFolders() {
    try {
      const d = await api('/api/dashboard/files/folders');
      const sel = $('#fFolder'); if (!sel) return;
      const cur = sel.value;
      const folders = d.folders || [];
      const names = folders.map(f => f.folder);
      if (!names.includes('inbox')) names.unshift('inbox');
      sel.innerHTML = names.map(n => {
        const c = (folders.find(f => f.folder === n) || {}).count || 0;
        return '<option value="' + esc(n) + '">' + esc(n) + ' (' + c + ')</option>';
      }).join('');
      if (cur && names.includes(cur)) sel.value = cur;
      setConn(true);
    } catch (e) { if (e.message === 'unauthorized') return; }
    await filesLoadList();
  }
  async function filesLoadList() {
    const sel = $('#fFolder');
    const folder = sel ? sel.value : 'inbox';
    const list = $('#fList'); if (!list) return;
    list.className = 'loading'; list.textContent = (QI.msg("Loading…"));
    try {
      const d = await api('/api/dashboard/files?folder=' + encodeURIComponent(folder));
      const files = d.files || [];
      if (!files.length) { list.className = 'empty'; list.textContent = (QI.msg("No files in this folder yet.")); return; }
      list.className = '';
      list.innerHTML = files.map(f =>
        '<div class="panel" style="display:flex;align-items:center;gap:10px;justify-content:space-between">' +
          '<div style="min-width:0">' +
            '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.filename) + '</div>' +
            '<div class="meta">' + humanSize(f.size) + ' · ' + fmtTime(f.created_at) + (f.readable ? (" " + QI.msg("· readable")) : '') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex:0 0 auto">' +
            '<a class="btn-more" href="' + BASE + '/api/dashboard/files/' + encodeURIComponent(f.id) + '/download">Download</a>' +
            '<button class="btn-more" data-del="' + esc(f.id) + ("\">" + QI.msg("Delete") + "</button>") +
          '</div>' +
        '</div>'
      ).join('');
      list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => filesDelete(b.getAttribute('data-del')));
      setConn(true);
    } catch (e) { if (e.message !== 'unauthorized') { list.className = 'err'; list.textContent = (QI.msg("Failed to load.")); setConn(false); } }
  }
  function filesUpload(fileList) {
    if (!fileList || !fileList.length) return;
    const folder = filesCurrentFolder();
    const prog = $('#fProg'); if (prog) prog.textContent = (QI.msg("Uploading") + " ") + fileList.length + (" " + QI.msg("file(s)…"));
    const fd = new FormData();
    fd.append('folder', folder);
    for (const f of fileList) fd.append('file', f);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/api/dashboard/files');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && prog) prog.textContent = (QI.msg("Uploading…") + " ") + Math.round(e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      if (xhr.status === 401) { showLogin(); return; }
      if (xhr.status === 403) { if (prog) prog.textContent = (QI.msg("Only the owner can upload.")); return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (prog) prog.textContent = (QI.msg("Uploaded ✓"));
        const nf = $('#fNewFolder'); if (nf) nf.value = '';
        filesLoadFolders().then(() => { const sel = $('#fFolder'); if (sel && [].some.call(sel.options, o => o.value === folder)) { sel.value = folder; } filesLoadList(); });
      } else if (xhr.status === 413) { if (prog) prog.textContent = QI.msg('File too large (maximum 100 MB).'); }
      else { var d = ''; try { var j = JSON.parse(xhr.responseText); d = ' — ' + (j.detail || j.error || ''); } catch (e) {} if (prog) prog.textContent = QI.msg('Could not load (') + xhr.status + ')' + d; }
    };
    xhr.onerror = () => { if (prog) prog.textContent = (QI.msg("Upload error.")); };
    xhr.send(fd);
  }
  async function filesDelete(id) {
    if(!window.confirm(QI.resolve(QI.msg('Delete this file? This cannot be undone.'))))return;
    try {
      const r = await fetch(BASE + '/api/dashboard/files/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      if (r.status === 401) { showLogin(); return; }
      if (r.status === 403) { alert((QI.msg("Only the owner can delete."))); return; }
      await filesLoadList();
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
        view.querySelector('#'+link.dataset.ownerSection)?.scrollIntoView({behavior:'smooth',block:'start'});
      };
    } catch(e) {
      if(state.page==='owner'&&view.isConnected)view.innerHTML='<p class="err">'+esc(e.message)+'</p><button class="btn" id="ownerRetry" type="button">'+esc(QI.msg('Retry'))+'</button>';
      if($('#ownerRetry'))$('#ownerRetry').onclick=()=>renderOwner(page);
    }
  }

  window.addEventListener('qoopia:language',()=>{
    if(state?.page==='owner')void renderOwner(ownerPage);
  });

  async function renderOverview() {
    setCrumb(QI.msg('Overview'));
    main.innerHTML='<section class="overview"><header class="page-heading"><div><h1>'+esc(QI.msg('Overview'))+'</h1><p>'+esc(QI.msg('Your agents, memory and recent work.'))+'</p></div>'+(localWorkspace?'<button class="btn primary" id="overviewChat">'+esc(QI.msg('Open chat'))+'</button>':'')+'</header><div class="pulse-grid" id="ccCards"><p class="loading">'+esc(QI.msg('Loading…'))+'</p></div><div class="cols"><section><div class="section-title">'+esc(QI.msg('Agents'))+'<a href="#agents">'+esc(QI.msg('View all'))+'</a></div><div class="agent-grid overview-agents" id="ccAgents"></div></section><section><div class="section-title">'+esc(QI.msg('Recent activity'))+'<span class="sub" id="feedSub"></span></div><div class="feed" id="ccFeed"></div></section></div><details class="system-status"><summary>'+esc(QI.msg('System status'))+'</summary><div class="health" id="ccHealth"></div></details></section>';
    if($('#overviewChat'))$('#overviewChat').onclick=()=>chat?.open();
    const view=$('#ccCards');await fillOverview();if(view.isConnected)pollFn=fillOverview;
  }

  async function fillOverview() {
    const view=$('#ccCards');if(!view)return;
    try {
      const [ov, act, agts] = await Promise.all([
        api('/api/dashboard/overview'),
        api('/api/dashboard/activity?limit=12'),
        api('/api/dashboard/agents'),
      ]);
      if(!view.isConnected)return;
      setConn(true);
      agentsCache = agts.items;
      paintCards(ov);
      paintHealth(ov.health);
      paintFeed(act.items, $('#ccFeed'));
      const sub = $('#feedSub'); if (sub) sub.textContent = (act.items || []).length + (" " + QI.msg("recent events"));
      paintAgentsBoard($('#ccAgents'), agentsCache, true);
    } catch (e) {
      setConn(false);
      const cards=$('#ccCards'); if(cards) cards.innerHTML=("<div class=\"err\" style=\"grid-column:1/-1\">" + QI.msg("Could not load the overview.") + " ")+esc(e.message)+(" <button type=\"button\" id=\"overviewRetry\">" + QI.msg("Retry") + "</button></div>");
      const retry=$('#overviewRetry'); if(retry) retry.onclick=fillOverview;
    }
  }

  function paintCards(ov) {
    const rows=[['Active agents',ov.agents?.total_active],['Sessions 24h',ov.sessions?.last_24h],['Messages 24h',ov.messages?.last_24h],['Skills',ov.skills?.total]];
    $('#ccCards').innerHTML=rows.map(([label,value])=>'<div class="overview-stat"><span>'+esc(QI.msg(label))+'</span><strong>'+fmtNum(value)+'</strong></div>').join('');
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
      ("<div class=\"hi\" style=\"margin-left:auto\"><span class=\"k\">" + QI.msg("Server") + "</span><span class=\"v\">") + esc((h.now || '').replace('T', ' ').slice(0, 19)) + 'Z</span></div>';
  }
  function hItem(dot, k, v) {
    return '<div class="hi">' + (dot !== undefined ? '<span class="hdot ' + dot + '"></span>' : '') +
      '<span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  }

  function paintFeed(items, el) {
    if (!el) return;
    if (!items || !items.length) { el.innerHTML = ("<div class=\"empty\">" + QI.msg("No activity yet.") + "</div>"); return; }
    el.innerHTML = items.map(it => {
      const st = actionStyle(it.action);
      const who = it.agent_name || (it.agent_id ? it.agent_id.slice(0, 8) : 'system');
      const summary = it.summary || (it.action + (it.entity_type ? ' · ' + it.entity_type : ''));
      const agentChip = it.agent_id
        ? '<span class="chip click" data-aid="' + esc(it.agent_id) + '">' + esc(who) + '</span>'
        : '<span class="chip">' + esc(who) + '</span>';
      return '<div class="frow">' +
        '<div class="fic" style="color:' + st.color + '">' + st.icon + '</div>' +
        '<div class="fbody">' +
          '<div class="fline">' + esc(summary) + '</div>' +
          '<div class="fmeta">' + agentChip +
            '<span class="faction">' + esc(it.action || '') + (it.entity_type ? ' · ' + esc(it.entity_type) : '') + '</span>' +
            '<span class="ftime">' + fmtTime(it.created_at) + '</span>' +
            (it.origin_host ? '<span class="ftime" style="opacity:.6">@' + esc(it.origin_host) + '</span>' : '') +
          '</div>' +
        '</div></div>';
    }).join('');
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
  function agentCard(a) {
    const lastIso = a.last_session_active || a.last_seen;
    return '<button type="button" class="agent-card" data-id="' + esc(a.id) + '">' +
      '<div class="agent-head">' +
        '<div class="agent-avatar ' + avatarClass(a.name) + '">' + initial(a.name) + '</div>' +
        '<div style="min-width:0"><div class="agent-name">' + liveStatus(lastIso) + esc(a.name) + '</div>' +
        '<div class="agent-meta">' + esc(a.type || 'agent') + ' · ' + fmtTime(lastIso) + '</div></div>' +
      '</div>' + coverageLine(a) +
      '<div class="agent-stats">' +
        '<div class="stat"><div class="stat-val">' + fmtNum(a.sessions_count) + ("</div><div class=\"stat-lbl\">" + QI.msg("Sessions") + "</div></div>") +
        '<div class="stat"><div class="stat-val">' + fmtNum(a.messages_count) + ("</div><div class=\"stat-lbl\">" + QI.msg("Messages") + "</div></div>") +
        '<div class="stat"><div class="stat-val">' + fmtNum(a.notes_count) + ("</div><div class=\"stat-lbl\">" + QI.msg("Notes") + "</div></div>") +
      '</div></button>';
  }
  function paintAgentsBoard(el, items, compact) {
    if (!el) return;
    if (!items || !items.length) { el.innerHTML = ("<div class=\"empty\" style=\"grid-column:1/-1\">" + QI.msg("No agents.") + "</div>"); return; }
    const live = items.filter(a => !isInfra(a)).sort(byRecent);
    const sys = items.filter(a => isInfra(a)).sort(byRecent);
    let html = live.map(agentCard).join('');
    if (!compact && sys.length) {
      html += ("</div><div class=\"section-title\" style=\"margin-top:28px\">" + QI.msg("System & integration agents") + "</div><div class=\"agent-grid system-grid\">") + sys.map(agentCard).join('');
    }
    el.innerHTML = html;
    el.querySelectorAll('.agent-card').forEach(c => {
      c.onclick = () => drillAgentById(c.getAttribute('data-id'));
    });
    // wire system grid cards if appended into a sibling (handled below for full page)
  }
  async function renderAgentsPage() {
    setCrumb(("<span style=\"color:var(--text)\">" + QI.msg("Agents") + "</span>"));
    main.innerHTML = ("<div class=\"section-title\">" + QI.msg("Your agents · open their notes and sessions") + "</div><div id=\"agentsWrap\"><div class=\"loading\">" + QI.msg("Loading agents…") + "</div></div>");
    try {
      const d = await api('/api/dashboard/agents');
      setConn(true); agentsCache = d.items;
      const items = d.items || [];
      const live = items.filter(a => !isInfra(a)).sort(byRecent);
      const sys = items.filter(a => isInfra(a)).sort(byRecent);
      $('#agentsWrap').innerHTML =
        '<div class="agent-grid">' + (live.map(agentCard).join('') || ("<div class=\"empty\" style=\"grid-column:1/-1\">" + QI.msg("None") + "</div>")) + '</div>' +
        (sys.length ? ("<div class=\"section-title\" style=\"margin-top:30px; color:var(--text3)\">" + QI.msg("System & integration agents") + "</div><div class=\"agent-grid system-grid\">") + sys.map(agentCard).join('') + '</div>' : '');
      $('#agentsWrap').querySelectorAll('.agent-card').forEach(c => c.onclick = () => drillAgentById(c.getAttribute('data-id')));
    } catch (e) { setConn(false); $('#agentsWrap').innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load agents.") + "</div>"); }
  }

  function drillAgentById(id) {
    const a = (agentsCache || []).find(x => x.id === id);
    if (a) { state = { page: 'agents', drill: { kind: 'agent', agent: a, tab: 'memory', noteType: null } }; route(); }
  }

  // ================= AGENT DETAIL (drill-down, preserved) =================
  // Wanted mode and the factual channel state are shown together; the glyph and the text
  // carry the meaning, colour only reinforces it.
  const memoryState = state => ({
    working: ['●', QI.msg("Saving automatically")], manual: ['○', QI.msg("Only on request")],
    waiting: ['◌', QI.msg("Waiting for this agent to connect")], behind: ['◐', QI.msg("Saving; the summary is catching up")],
    sign_in: ['!', QI.msg("The memory model needs sign-in or quota")], error: ['!', QI.msg("Saving needs attention")]
  })[state];
  // One contract for every agent: the same rows the agent reads in qoopia_capabilities.
  const mechanismState = status => ({
    available: ['●', QI.msg("Available")], forbidden: ['○', QI.msg("Not permitted")], client_unsupported: ['◌', QI.msg("The client cannot do this")],
    needs_setup: ['◐', QI.msg("Needs setup")], faulty: ['!', QI.msg("Needs attention")]
  })[status] || ['!', QI.msg("Needs attention")];
  function coverageLine(a) {
    const st = a.memory && memoryState(a.memory.state); if (!st) return '';
    return '<div class="agent-meta coverage-line"><span aria-hidden="true">' + st[0] + '</span> ' + esc(st[1]) + '</div>';
  }
  // Fetched when the card opens: the list endpoint stays cheap for a workspace with many agents.
  async function loadMechanisms(a) {
    if ((a.mechanisms || []).length || !$('#mechanismsPanel')) return;
    try { a.mechanisms = (await api('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/contract')).mechanisms || []; } catch { return; }
    const host = $('#mechanismsPanel'); if (!host || !a.mechanisms.length) return;
    const open = host.open; host.outerHTML = mechanismsPanel(a); if (open) $('#mechanismsPanel').open = true;
  }
  function mechanismsPanel(a) {
    if (!(a.mechanisms || []).length) return '<details class="mechanisms-panel" id="mechanismsPanel"><summary>' + esc(QI.msg("What this agent can use")) + '</summary><p class="meta">' + esc(QI.msg("Loading…")) + '</p></details>';
    return '<details class="mechanisms-panel" id="mechanismsPanel"><summary>' + esc(QI.msg("What this agent can use")) + '</summary><ul>' + a.mechanisms.map(m => { const st = mechanismState(m.status);
      return '<li><span aria-hidden="true">' + st[0] + '</span> <strong>' + esc(QI.msg(m.title)) + '</strong> — ' + esc(st[1]) +
        (m.reason ? '<br><span class="meta">' + esc(QI.msg(m.reason)) + ' ' + esc(QI.msg(m.action || '')) + '</span>' : '') + '</li>'; }).join('') + '</ul></details>';
  }
  function memoryPanel(a) {
    const m = a.memory; if (!m) return '';
    const st = memoryState(m.state) || memoryState('error'), auto = m.mode === 'auto';
    return '<section class="memory-panel" aria-labelledby="memoryPanelTitle"><div><h3 id="memoryPanelTitle">' + esc(QI.msg("Session memory")) + '</h3>' +
      '<p class="memory-state"><span aria-hidden="true">' + st[0] + '</span> ' + esc(st[1]) + '</p>' +
      '<p class="memory-facts">' + esc(QI.msg("Last saved:")) + ' ' + (m.last_capture_at ? fmtTime(m.last_capture_at) : '—') + ' · ' +
        esc(QI.msg("Last summary:")) + ' ' + (m.last_summary_at_ms ? fmtTime(new Date(m.last_summary_at_ms).toISOString()) : '—') +
        (m.pending_sessions ? ' · ' + esc(QI.msg("Conversations awaiting a summary:")) + ' ' + fmtNum(m.pending_sessions) : '') + '</p>' +
      '<p class="memory-note">' + esc(auto ? QI.msg("New conversations are saved to Qoopia automatically.") : QI.msg("Nothing new is saved unless you ask. Existing memory stays available. The history kept by Claude, ChatGPT or Telegram is separate.")) + '</p></div>' +
      '<div class="memory-action"><button type="button" id="memoryToggle" aria-describedby="memoryResult">' + esc(auto ? QI.msg("Switch to only on request") : QI.msg("Turn automatic saving on")) + '</button>' +
      '<p id="memoryResult" role="status" aria-live="polite"></p></div>' +
      (m.pending_saves ? '<div class="memory-saves" id="memorySaves"><h4>' + esc(QI.msg("Waiting for your confirmation:")) + ' ' + fmtNum(m.pending_saves) + '</h4></div>' : '') + '</section>';
  }
  // The agent prepared these notes while it saves only on request; nothing is memory until the owner confirms.
  async function bindMemorySaves(a) {
    const host = $('#memorySaves'); if (!host) return;
    let items; try { items = ((await api('/api/dashboard/memory-saves')).items || []).filter(x => x.agent_id === a.id); } catch { return; }
    host.insertAdjacentHTML('beforeend', items.map(x => '<article data-save="' + esc(x.id) + '"><p class="meta">' + esc(x.operation === 'note_update' ? QI.msg("Change to an existing note") : (x.type || 'note')) +
      ' · ' + esc(QI.msg("Expires:")) + ' ' + fmtTimeFull(new Date(x.expires_at_ms).toISOString()) + '</p><pre>' + esc(x.text || '') + '</pre>' +
      '<button type="button" data-accept="1">' + esc(QI.msg("Save to memory")) + '</button> <button type="button" data-accept="">' + esc(QI.msg("Decline")) + '</button></article>').join(''));
    host.querySelectorAll('button').forEach(button => button.onclick = async () => {
      const card = button.closest('article'), result = $('#memoryResult'), accept = !!button.dataset.accept;
      card.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        await apiWrite('/api/dashboard/memory-saves/' + encodeURIComponent(card.dataset.save), { accept });
        card.remove(); result.textContent = accept ? QI.msg("Saved to memory.") : QI.msg("Declined. The prepared text was removed.");
        const left = host.querySelectorAll('article').length;
        if (a.memory) a.memory.pending_saves = left;
        if (left) host.querySelector('h4').textContent = QI.resolve(QI.msg("Waiting for your confirmation:")) + ' ' + fmtNum(left);
        else host.remove();
      } catch (e) { result.textContent = QI.msg("Could not complete this. Only the workspace owner can confirm a save."); card.querySelectorAll('button').forEach(b => b.disabled = false); }
    });
  }
  function bindMemoryPanel(a) {
    const button = $('#memoryToggle'), result = $('#memoryResult'); if (!button) return;
    button.onclick = async () => {
      button.disabled = true; result.textContent = QI.msg("Saving…");
      try {
        const next = await apiWrite('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/memory-policy', { mode: a.memory.mode === 'auto' ? 'manual' : 'auto', expected_revision: a.memory.revision });
        const fresh = ((await api('/api/dashboard/agents')).items || []).find(x => x.id === a.id);
        agentsCache = null; state.drill.agent = fresh || { ...a, memory: { ...a.memory, mode: next.mode, revision: next.revision, state: next.mode === 'manual' ? 'manual' : a.memory.state } };
        renderAgentDetail(); const done = $('#memoryResult'); if (done) done.textContent = next.mode === 'manual' ? QI.msg("Done. Only on request from now on.") : QI.msg("Done. Automatic saving is on from now on.");
      } catch (e) { result.textContent = QI.msg("Could not change the setting. Only the workspace owner can do this."); button.disabled = false; }
    };
  }
  function renderAgentDetail() {
    const a = state.drill.agent;
    setCrumb(("<a data-go=\"agents\">" + QI.msg("Agents") + "</a><span class=\"crumb-sep\">›</span><span style=\"color:var(--text)\">") + esc(a.name) + '</span>');
    main.innerHTML =
      '<div class="detail-head">' +
        '<div class="agent-avatar ' + avatarClass(a.name) + '">' + initial(a.name) + '</div>' +
        '<div><div class="detail-title">' + esc(a.name) + '</div>' +
        '<div class="detail-sub">' + fmtNum(a.sessions_count) + (" " + QI.msg("sessions ·") + " ") + fmtNum(a.messages_count) + (" " + QI.msg("messages ·") + " ") + fmtNum(a.notes_count) + (" " + QI.msg("notes") + "</div></div>") +
      '</div>' + memoryPanel(a) + mechanismsPanel(a) +
      '<div class="tabs">' +
        '<button class="tab ' + (state.drill.tab === 'sessions' ? 'active' : '') + ("\" data-tab=\"sessions\">" + QI.msg("Sessions") + " <span class=\"tab-badge\">") + fmtNum(a.sessions_count) + '</span></button>' +
        '<button class="tab ' + (state.drill.tab === 'memory' ? 'active' : '') + ("\" data-tab=\"memory\">" + QI.msg("Notes") + " <span class=\"tab-badge\">") + fmtNum(a.notes_count) + '</span></button>' +
        '<button class="tab ' + (state.drill.tab === 'search' ? 'active' : '') + ("\" data-tab=\"search\">" + QI.msg("Search") + "</button>") +
      ("</div><div id=\"tabBody\"><div class=\"loading\">" + QI.msg("Loading…") + "</div></div>");
    main.querySelectorAll('.tab').forEach(el => el.onclick = () => { state.drill.tab = el.getAttribute('data-tab'); renderAgentDetail(); });
    bindMemoryPanel(a); void bindMemorySaves(a); void loadMechanisms(a);
    if (state.drill.tab === 'sessions') return renderSessions();
    if (state.drill.tab === 'memory') return renderMemory();
    if (state.drill.tab === 'search') return renderAgentSearch();
  }
  async function renderSessions() {
    const a = state.drill.agent; const body = $('#tabBody');
    try {
      const data = await api('/api/dashboard/agents/' + encodeURIComponent(a.id) + '/sessions?limit=200');
      setConn(true);
      if (!data.items.length) { body.innerHTML = ("<div class=\"empty\">" + QI.msg("No sessions yet.") + "</div>"); return; }
      body.innerHTML = '<div class="sess-list">' + data.items.map(s => {
        return '<button type="button" class="sess-item" data-id="' + esc(s.id) + '"><div class="sess-info">' +
          '<div class="sess-title">' + liveStatus(s.last_active) + esc(s.title || '(untitled)') + '</div>' +
          '<div class="sess-id">' + esc(s.id) + '</div></div>' +
          '<div class="sess-badges"><span class="sess-badge">' + s.message_count + (" " + QI.msg("msgs") + "</span>") +
          '<span class="sess-badge">' + fmtTime(s.last_active) + '</span></div><div class="sess-chev">›</div></button>';
      }).join('') + '</div>';
      body.querySelectorAll('.sess-item').forEach(el => el.onclick = () => {
        const s = data.items.find(x => x.id === el.getAttribute('data-id'));
        if (s) { state = { page: 'agents', drill: { kind: 'session', agent: a, session: s } }; route(); }
      });
    } catch (e) { setConn(false); body.innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load sessions.") + "</div>"); }
  }
  const NOTE_TYPES = ['memory','rule','decision','knowledge','task','deal','project','context','contact','finance','note'];
  async function renderMemory() {
    const a = state.drill.agent; const body = $('#tabBody');
    const sortBy = state.drill.notesSort || 'created_desc';
    const url = '/api/dashboard/agents/' + encodeURIComponent(a.id) + '/notes?limit=500' + (state.drill.noteType ? '&type=' + encodeURIComponent(state.drill.noteType) : '');
    try {
      const data = await api(url); setConn(true);
      const bd = Object.fromEntries((data.type_breakdown || []).map(x => [x.type, x.c]));
      const filters = ['<button class="note-filter ' + (state.drill.noteType === null ? 'active' : '') + ("\" data-t=\"\">" + QI.msg("All") + "</button>")]
        .concat(NOTE_TYPES.filter(t => bd[t]).map(t => '<button class="note-filter ' + (state.drill.noteType === t ? 'active' : '') + '" data-t="' + t + '">' + t + ' <span style="opacity:.6">· ' + bd[t] + '</span></button>')).join('');
      const sorted = data.items.slice().sort((x, y) => { const k = sortBy === 'updated_desc' ? 'updated_at' : 'created_at'; return (y[k] || '').localeCompare(x[k] || ''); });
      const sortToggle = '<div style="display:flex; justify-content:flex-end; gap:6px; margin-bottom:12px;">' +
        '<button class="note-filter ' + (sortBy === 'created_desc' ? 'active' : '') + ("\" data-sort=\"created_desc\">" + QI.msg("Newest created") + "</button>") +
        '<button class="note-filter ' + (sortBy === 'updated_desc' ? 'active' : '') + ("\" data-sort=\"updated_desc\">" + QI.msg("Recently updated") + "</button></div>");
      const items = sorted.length ? sorted.map(n => '<div class="note t-' + esc(QI.code(n.type)) + '"><div class="note-head">' +
        '<span class="note-type">' + esc(QI.code(n.type)) + '</span><span>' + fmtTimeFull(n.created_at) + '</span>' +
        (n.updated_at && n.updated_at !== n.created_at ? ("<span>" + QI.msg("· upd") + " ") + fmtTime(n.updated_at) + '</span>' : '') +
        '<span style="flex:1"></span><span class="copyable mono" style="opacity:.55" data-copy="' + esc(n.id) + '" title="copy id">' + esc(String(n.id).slice(0, 12)) + '</span></div>' +
        '<div class="note-text">' + esc(n.text) + '</div>' +
        (n.tags && n.tags.length ? '<div class="note-meta">tags: ' + n.tags.map(esc).join(', ') + '</div>' : '') + '</div>').join('') : ("<div class=\"empty\">" + QI.msg("No notes matching filter.") + "</div>");
      body.innerHTML = '<div class="note-filters">' + filters + '</div>' + sortToggle + '<div class="note-list">' + items + '</div>';
      body.querySelectorAll('[data-t]').forEach(el => el.onclick = () => { state.drill.noteType = el.getAttribute('data-t') || null; renderMemory(); });
      body.querySelectorAll('[data-sort]').forEach(el => el.onclick = () => { state.drill.notesSort = el.getAttribute('data-sort'); renderMemory(); });
      body.querySelectorAll('.copyable[data-copy]').forEach(el => el.onclick = (ev) => { ev.stopPropagation(); copyText(el, el.getAttribute('data-copy')); });
    } catch (e) { setConn(false); body.innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load memory.") + "</div>"); }
  }
  async function renderAgentSearch() {
    const a = state.drill.agent; const body = $('#tabBody'); const q = state.drill.searchQuery || '';
    body.innerHTML = '<div style="margin-bottom:16px"><input type="text" id="searchInp" aria-label="Search this agent’s messages" data-i18n-aria-label="Search this agent’s messages" class="input-text" placeholder="Search this agent\'s messages…" value="' + esc(q) + '"></div><div id="searchResults"></div>';
    const inp = $('#searchInp'); inp.focus(); let dbnc;
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
          '<span class="msg-role ' + esc(m.role) + '">' + esc(m.role) + '</span><span>' + fmtTimeFull(m.created_at) + '</span><span style="flex:1"></span>' +
          ("<span class=\"copyable mono\" style=\"opacity:.55\" title=\"" + QI.msg("copy session_id") + "\">") + esc(String(m.session_id).slice(0, 16)) + '…</span></div>' +
          '<div class="msg-content">' + esc(m.content) + '</div></button>').join('') + '</div>';
        results.querySelectorAll('.copyable').forEach((el, i) => { const sid = data.items[i].session_id; el.onclick = (ev) => { ev.stopPropagation(); copyText(el, sid); }; });
        results.querySelectorAll('.msg').forEach(el => { el.onclick = () => { state = { page: 'agents', drill: { kind: 'session', agent: a, session: { id: el.getAttribute('data-session'), title: null } } }; route(); }; });
      } catch (e) { setConn(false); results.innerHTML = ("<div class=\"err\">" + QI.msg("Search failed.") + "</div>"); }
    }
  }
  async function renderSession() {
    const a = state.drill.agent; const s = state.drill.session;
    setCrumb(("<a data-go=\"agents\">" + QI.msg("Agents") + "</a><span class=\"crumb-sep\">›</span><a data-route id=\"bkAgent\">") + esc(a.name) + '</a><span class="crumb-sep">›</span>' + esc(String(s.id).slice(0, 12)));
    main.innerHTML = '<div class="detail-head"><div class="agent-avatar ' + avatarClass(a.name) + '">' + initial(a.name) + '</div>' +
      '<div style="flex:1; min-width:0"><div class="detail-title">' + esc(s.title || '(untitled session)') + '</div>' +
      ("<div class=\"detail-sub mono\"><span class=\"copyable\" id=\"sidCopy\" title=\"" + QI.msg("copy") + "\">") + esc(s.id) + '</span></div></div></div>' +
      ("<div id=\"tabBody\"><div class=\"loading\">" + QI.msg("Loading transcript…") + "</div></div>");
    const bk = $('#bkAgent'); if (bk) bk.onclick = () => { state = { page: 'agents', drill: { kind: 'agent', agent: a, tab: 'memory', noteType: null } }; route(); };
    const sidEl = $('#sidCopy'); if (sidEl) sidEl.onclick = () => copyText(sidEl, s.id);
    const body = $('#tabBody');
    try {
      const data = await api('/api/dashboard/sessions/' + encodeURIComponent(s.id) + '/messages?limit=1000');
      setConn(true);
      if (!data.messages.length) { body.innerHTML = ("<div class=\"empty\">" + QI.msg("No messages.") + "</div>"); return; }
      body.innerHTML = '<div class="transcript">' + data.messages.map(m => '<div class="msg ' + esc(m.role) + '"><div class="msg-head">' + roleIcon(m.role) +
        '<span class="msg-role ' + esc(m.role) + '">' + esc(m.role) + '</span><span>' + fmtTimeFull(m.created_at) + '</span>' +
        (m.token_count != null ? '<span>· ' + m.token_count + (" " + QI.msg("tok") + "</span>") : '') + '</div><div class="msg-content">' + esc(m.content) + '</div></div>').join('') + '</div>';
    } catch (e) { setConn(false); body.innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load transcript.") + "</div>"); }
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
    setCrumb(("<span style=\"color:var(--text)\">" + QI.msg("Agent conversations") + "</span>"));
    main.innerHTML = ("<div class=\"panel\"><div class=\"panel-h\"><h3>" + QI.msg("Conversations") + ("</h3><span class=\"meta\">" + QI.msg("read-only") + "</span></div>")) +
      ("<div id=\"acChats\"><div class=\"loading\">" + QI.msg("Loading conversations…") + "</div></div></div>");
    $('#acChats').insertAdjacentHTML('beforebegin','<div class="agent-toolbar"><label for="acSearch">'+esc(QI.msg('Find a conversation'))+'</label><input type="search" id="acSearch"><label for="acRecent">'+esc(QI.msg('Period'))+'</label><select id="acRecent"><option value="all">'+esc(QI.msg('All conversations'))+'</option><option value="day">'+esc(QI.msg('Last 24 hours'))+'</option></select></div>');$('#acSearch').oninput=()=>fillAcThreads(true);$('#acRecent').onchange=()=>fillAcThreads(true);
    await fillAcThreads();
    pollFn = ()=>fillAcThreads();
  }

  async function fillAcThreads(cached=false) {
    const box = $('#acChats'); if (!box) return;
    try {
      if(!cached){const d=await api('/api/dashboard/agentcomm/threads?limit=100');if(!box.isConnected)return;acThreads=d.items||[];setConn(true);}
      const query=($('#acSearch')?.value||'').toLocaleLowerCase(),recent=$('#acRecent')?.value==='day';const items=acThreads.filter(t=>(!recent||Date.now()-new Date(t.last_message_at).getTime()<86400000)&&(!query||[acName(t.agent_a),acName(t.agent_b),t.last_message?.preview||''].join(' ').toLocaleLowerCase().includes(query)));
      if (!items.length) { box.innerHTML = ("<div class=\"empty\">" + QI.msg("No agent conversations yet.") + "</div>"); return; }
      box.innerHTML = '<div class="tg-chats">' + items.map((t, i) => {
        const an = acName(t.agent_a), bn = acName(t.agent_b);
        const last = t.last_message;
        const prev = last
          ? '<b>' + esc(acName({ name: last.sender_name, id: last.sender_agent_id })) + ':</b> ' + esc(String(last.preview || '').replace(/\s+/g, ' '))
          : (QI.msg("No messages"));
        return '<button type="button" class="tg-chat" data-i="' + i + '">' +
          '<div class="tg-duo">' +
            '<div class="agent-avatar ' + avatarClass(t.agent_a.name) + '">' + initial(an) + '</div>' +
            '<div class="agent-avatar ' + avatarClass(t.agent_b.name) + '">' + initial(bn) + '</div>' +
          '</div>' +
          '<div class="tg-chat-main">' +
            '<div class="tg-chat-title">' + esc(an) + ' <span style="color:var(--text3);font-weight:400">↔</span> ' + esc(bn) + '</div>' +
            '<div class="tg-chat-prev">' + prev + '</div>' +
          '</div>' +
          '<div class="tg-chat-side">' +
            '<span class="tg-chat-time">' + fmtTime(t.last_message_at) + '</span>' +
            '<span class="tg-count">' + fmtNum(t.message_count) + '</span>' +
          '</div></button>';
      }).join('') + '</div>';
      box.querySelectorAll('.tg-chat').forEach(el => {
        el.onclick = () => {
          const t = items[parseInt(el.getAttribute('data-i'), 10)];
          state = { page: 'agentcomm', drill: { kind: 'acthread', pair: t } };
          route();
        };
      });
    } catch (e) { setConn(false); box.innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load conversations.") + "</div>"); }
  }

  async function renderAcThread() {
    const p = state.drill.pair;
    const an = acName(p.agent_a), bn = acName(p.agent_b);
    setCrumb(("<a data-go=\"agentcomm\">" + QI.msg("Agent conversations") + "</a><span class=\"crumb-sep\">›</span>") + esc(an) + ' ↔ ' + esc(bn));
    main.innerHTML = '<div class="detail-head">' +
      '<div class="tg-duo"><div class="agent-avatar ' + avatarClass(p.agent_a.name) + '">' + initial(an) + '</div>' +
      '<div class="agent-avatar ' + avatarClass(p.agent_b.name) + '">' + initial(bn) + '</div></div>' +
      '<div style="flex:1;min-width:0"><div class="detail-title">' + esc(an) + ' ↔ ' + esc(bn) + '</div>' +
      ("<div class=\"detail-sub\" id=\"acSub\">" + QI.msg("loading…") + "</div></div></div>") +
      ("<div class=\"panel tg-panel\"><div id=\"acBody\"><div class=\"loading\">" + QI.msg("Loading conversation…") + "</div></div></div>");
    acState = { messages: [], nextBefore: null, hasMore: false, busy: false };
    main.insertAdjacentHTML('beforeend','<button id="acLatest" class="btn-more" hidden style="position:fixed;bottom:24px;right:24px;z-index:5">'+esc(QI.msg('New messages ↓'))+'</button>');$('#acLatest').onclick=()=>{window.scrollTo({top:document.documentElement.scrollHeight});$('#acLatest').hidden=true;};
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
      if (sub) sub.textContent = fmtNum(d.total) + (" " + QI.msg("messages · showing") + " ") + fmtNum(acState.messages.length);
      renderAcMessages(first);
    } catch (e) {
      setConn(false);
      const b = $('#acBody'); if (b && first) b.innerHTML = ("<div class=\"err\">" + QI.msg("Failed to load conversation.") + "</div>");
    } finally { current.busy = false; }
  }

  async function refreshAcThread() {
    const body=$('#acBody'),pair=state.drill?.pair,current=acState;if(!body||!pair||current.busy)return;
    current.busy=true;
    try {const d=await api('/api/dashboard/agentcomm/thread?a='+encodeURIComponent(pair.agent_a.id)+'&b='+encodeURIComponent(pair.agent_b.id)+'&limit=200');if(!body.isConnected||acState!==current)return;
      if(current.messages.length&&d.messages?.length&&!d.messages.some(m=>current.messages.some(old=>old.id===m.id))&&d.has_more){current.nextBefore=d.next_before;current.hasMore=true;}
      const next=[...new Map([...current.messages,...(d.messages||[])].map(m=>[m.id,m])).values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||String(a.id).localeCompare(String(b.id)));
      if(JSON.stringify(next)!==JSON.stringify(current.messages)){const anchor=[...body.querySelectorAll('[data-message]')].find(el=>el.getBoundingClientRect().bottom>0),top=anchor?.getBoundingClientRect().top,id=anchor?.dataset.message,follow=window.scrollY+innerHeight>=document.documentElement.scrollHeight-100;current.messages=next;renderAcMessages(false);if(follow)window.scrollTo({top:document.documentElement.scrollHeight});else if(id){const kept=[...body.querySelectorAll('[data-message]')].find(el=>el.dataset.message===id);if(kept)window.scrollBy(0,kept.getBoundingClientRect().top-top);$('#acLatest').hidden=false;}}
      $('#acSub').textContent=QI.resolve(QI.msg('Updated automatically'))+' · '+QI.resolve(fmtNum(d.total));setConn(true);
    }catch{if(body.isConnected){$('#acSub').textContent=QI.resolve(QI.msg('Connection lost. Reconnecting…'));setConn(false);}}finally{current.busy=false;}
  }

  function renderAcMessages(first) {
    const body = $('#acBody'); if (!body) return;
    const p = state.drill.pair;
    if (!acState.messages.length) { body.innerHTML = ("<div class=\"empty\">" + QI.msg("No messages.") + "</div>"); return; }

    // Chronological conversation; open at the latest message and load older history above.
    const msgs = acState.messages.slice();

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
        (m.topic ? '<span class="tg-topic" title="Topic: ' + esc(m.topic) + '">' + esc(m.topic) + '</span>' : '') +
        '<span title="' + esc(fmtTimeFull(m.created_at)) + '">' + esc(acClock(m.created_at)) + '</span></div>' +
        '</div></div>';
    }
    html += '</div>';
    // Older history is prepended without moving the message being read.
    const historyControl = acState.hasMore
      ? ("<button class=\"btn-more\" id=\"acMore\" style=\"margin:10px auto 0\">" + QI.msg("Load older messages") + "</button>")
      : ("<div class=\"tg-day\">" + QI.msg("Beginning of conversation") + "</div>");

    const oldHeight=body.scrollHeight,oldY=window.scrollY;body.innerHTML = historyControl+html;
    if(!first&&acState.loadingOlder)window.scrollTo({top:oldY+body.scrollHeight-oldHeight});
    const more = $('#acMore');
    if (more) more.onclick = () => { more.textContent = (QI.msg("Loading…")); acState.loadingOlder=true;loadAcPage(false).finally(()=>{acState.loadingOlder=false;}); };
    if (first) window.scrollTo({ top:document.documentElement.scrollHeight });
  }

  // ================= SKILL LOOP: same login and typed authority =================
  let skillContext = null, skillPending = null;
  const loopUrl = '/api/dashboard/authority';
  async function skillApi(path, method = 'GET', body, expected) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    const key = method === 'GET' ? null : (body.idempotency_key || crypto.randomUUID());
    if (body && key) body.idempotency_key = key;
    if (method !== 'GET') skillPending = {path, method, body: JSON.parse(JSON.stringify(body)), expected};
    try {
      const response = await fetch(loopUrl + path, {method, credentials:'same-origin', signal:controller.signal,
        headers: method === 'GET' ? {} : {'content-type':'application/json','X-Qoopia-CSRF':'1','Idempotency-Key':key,'If-Match':String(expected)},
        body: method === 'GET' ? undefined : JSON.stringify(body)});
      const value = await response.json();
      if (!response.ok) { const error = new Error(value.error?.message || (QI.msg("Request failed"))); error.code = value.error?.code || 'HTTP_' + response.status; throw error; }
      if (method !== 'GET') skillPending = null;
      return value;
    } finally { clearTimeout(timer); }
  }
  function skillStatus(text, error = false) {
    const node = $('#skillStatus'); if (!node) return;
    node.textContent = text; node.className = error ? 'err' : 'meta'; node.setAttribute('role',error ? 'alert' : 'status');
  }
  function skillFailure(e) {
    skillStatus((e.code || (navigator.onLine ? 'UNKNOWN_RESULT' : (QI.msg("OFFLINE")))) + ': ' + e.message + (QI.msg(". Your edits are kept. Inspect the current state or retry the same request.")),true);
    const retry=$('#skillRetry'); if(retry){retry.hidden=!skillPending;retry.onclick=async()=>{if(!skillPending)return;const p=skillPending;try{await skillApi(p.path,p.method,p.body,p.expected);await skillReconcile();skillStatus((QI.msg("Request reconciled against current server state.")));retry.hidden=true;}catch(e){skillFailure(e);}};}
  }
  async function skillReconcile() { const id=skillContext?.skill?.skill_id; if(id) await skillDetail(id); else await renderSkillsPage(); }
  function skillShell(title) {
    setCrumb(("<span style=\"color:var(--text)\">" + QI.msg("Skills") + "</span>"));
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
      $('#skillCards').innerHTML=library.items.length?library.items.map(s=>'<button class="ent skill-card" data-skill="'+esc(s.id)+("\"><span class=\"type-badge tb-skill\">" + QI.msg("Draft") + " ")+esc(String(s.revision))+'</span><strong>'+esc(s.title)+("</strong><span class=\"meta\">" + QI.msg("Open procedure, versions and outcomes →") + "</span></button>")).join(''):("<p class=\"empty\">" + QI.msg("Your library is empty. Create a skill from a procedure or the clearly marked CSV sample.") + "</p>");
      $('#skillCards').querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>skillDetail(b.dataset.skill));
      const waiting=loop.assignments.filter(a=>a.desired_state==='active');
      $('#skillAttention').innerHTML=waiting.length?waiting.map(a=>'<p><strong>'+esc(a.slot)+'</strong> — '+(a.readiness?.ready?(QI.msg("Ready for the next session.")):'Blocked: '+esc((a.readiness?.blockers||[(QI.msg("readiness unavailable"))]).join('; ')))+' <button class="btn" data-attention="'+esc(a.version_id)+("\">" + QI.msg("Inspect") + "</button></p>")).join(''):("<p class=\"meta\">" + QI.msg("No pending assignments.") + "</p>");
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
      try{const saved=await skillApi('/skills/captures','POST',args,args.expected_revision);if(saved.data.outcome==='refused'){skillStatus(saved.data.reason+(" " + QI.msg("— keep it as memory or a rule.")),true);return;}await skillDetail(saved.data.skill_id||existing?.skill_id);skillStatus((QI.msg("Draft saved.") + " ")+(saved.data.findings||[]).join(', '));}catch(e){skillFailure(e);}
    };
    $('#skTitle').focus();
  }
  async function skillDetail(id) {
    skillShell((QI.msg("Procedure and evidence")));$('#skillBody').innerHTML=("<p class=\"loading\">" + QI.msg("Loading exact versions…") + "</p>");
    try {
      const [skill,loop]=await Promise.all([skillApi('/skills/'+encodeURIComponent(id)),skillApi('/skill-loop?skill_id='+encodeURIComponent(id))]);skillContext={skill,loop};
      const c=skill.content;$('#skillBody').innerHTML='<h2>'+esc(c?.title||skill.title||skill.slug)+'</h2><p>'+esc(c?.purpose||(QI.msg("Imported immutable skill")))+("</p><div class=\"skill-actions\"><button class=\"btn\" id=\"skRevise\">" + QI.msg("Revise") + "</button><button class=\"btn\" id=\"skFork\">" + QI.msg("Fork") + "</button></div><h2>" + QI.msg("Versions") + "</h2><div id=\"skVersions\"></div>")+(c?("<form id=\"skCompile\"><label for=\"skVersionLabel\">" + QI.msg("New version label") + "</label><input id=\"skVersionLabel\" value=\"")+esc(String((loop.versions||[]).length+1))+("\" required><label for=\"skLicense\">" + QI.msg("License") + "</label><input id=\"skLicense\" value=\"MIT\" required><button class=\"btn\">" + QI.msg("Compile preview") + "</button></form>"):'')+("<div id=\"skPreview\"></div><h2>" + QI.msg("Assignments") + "</h2><div id=\"skAssignments\"></div><h2>" + QI.msg("Runs and outcomes") + "</h2><div id=\"skOutcomes\"></div>");
      $('#skRevise').onclick=()=>skillEditor(skill);$('#skFork').onclick=()=>skillEditor(skill,true);
      $('#skVersions').innerHTML=loop.versions.length?loop.versions.map(v=>'<button class="btn" data-version="'+esc(v.id)+'">'+esc(v.version_label)+' · '+esc(v.status)+'</button>').join(''):("<p class=\"meta\">" + QI.msg("No compiled versions. Complete the draft, then inspect its final instructions.") + "</p>");
      $('#skVersions').querySelectorAll('[data-version]').forEach(b=>b.onclick=()=>skillPreview(b.dataset.version));
      if(c)$('#skCompile').onsubmit=async event=>{event.preventDefault();try{const result=await skillApi('/skills/drafts/'+skill.draft_id+'/compile','POST',{expected_revision:skill.revision,version_label:$('#skVersionLabel').value,license:$('#skLicense').value,native_name:skill.slug},skill.revision);await skillPreview(result.data.version_id);}catch(e){skillFailure(e);}};
      $('#skAssignments').innerHTML=loop.assignments.length?loop.assignments.map(a=>'<div class="panel"><strong>'+esc(a.slot)+'</strong><p>Desired: '+esc(a.desired_state)+(" " + QI.msg("· revision") + " ")+a.revision+(" " + QI.msg("· next-session changes") + "</p><button class=\"btn\" data-pause=\"")+esc(a.id)+("\">" + QI.msg("Pause") + "</button> <button class=\"btn\" data-rollback=\"")+esc(a.id)+("\">" + QI.msg("Choose rollback version") + "</button></div>")).join(''):("<p class=\"meta\">" + QI.msg("No assignments.") + "</p>");
      $('#skAssignments').querySelectorAll('[data-pause]').forEach(b=>b.onclick=async()=>{const a=loop.assignments.find(a=>a.id===b.dataset.pause);try{await skillApi('/skill-assignments/'+a.id,'PATCH',{assignment_id:a.id,expected_revision:a.revision,desired_state:'paused',reason:'Owner paused from the library'},a.revision);await skillDetail(id);}catch(e){skillFailure(e);}});
      $('#skAssignments').querySelectorAll('[data-rollback]').forEach(b=>b.onclick=()=>{skillStatus((QI.msg("Select an earlier version above, then assign it to the same runtime with Rollback selected.")));$('#skVersions').querySelector('button')?.focus();});
      $('#skOutcomes').innerHTML=loop.runs.length?loop.runs.map(run=>{const outcomes=loop.outcomes.filter(o=>o.run_id===run.id);return '<article class="panel"><strong>'+esc(run.objective)+("</strong><p>" + QI.msg("Run") + " ")+esc(run.id)+(" " + QI.msg("· exact version") + " ")+esc(run.version_id)+'</p>'+(outcomes.length?outcomes.map(o=>'<p>'+esc(o.status)+' · '+esc(o.evidence_class)+(" " + QI.msg("· revision") + " ")+o.revision+(o.stale?(" " + QI.msg("· late fact after revoke")):'')+("</p><details><summary>" + QI.msg("Evaluator assertions") + "</summary><pre>")+esc(JSON.stringify(JSON.parse(o.assertions_json),null,2))+'</pre></details>').join(''):("<p>" + QI.msg("Unknown — nothing reported.") + "</p>"))+'</article>';}).join(''):("<p class=\"empty\">" + QI.msg("No runtime task has been reported. Installing files does not prove execution.") + "</p>");
      skillStatus(loop.capabilities.limitation);
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
      const box=$('#skPreview');box.innerHTML=("<section class=\"panel\"><h2>" + QI.msg("Before / after diff") + "</h2><p>")+esc(previousLabel)+' → '+esc(v.version_label)+("</p><pre class=\"skill-diff\" tabindex=\"0\" aria-label=\"" + QI.msg("Before and after native instructions") + "\">")+esc(diff)+'</pre></section>'+("<section class=\"panel\"><h2>" + QI.msg("Review final native bytes") + "</h2><p>" + QI.msg("Version") + " ")+esc(v.version_label)+(" " + QI.msg("· License") + " ")+esc(v.license)+'</p><p>Permissions: '+esc((descriptor.requested_capabilities||[]).join(', ')||'none')+'</p><p>Renderer: '+esc(descriptor.renderer||v.original_format)+("</p><pre class=\"skill-diff\" tabindex=\"0\" aria-label=\"" + QI.msg("Final native instructions") + "\">")+esc(bytes)+("</pre><details><summary>" + QI.msg("Exact member map and digest") + "</summary><pre>")+esc(JSON.stringify(descriptor.members||{},null,2))+'</pre><p>'+esc(v.candidate_digest)+'</p></details><div id="skReviewActions"></div></section>';
      box.scrollIntoView({block:'start'});
      if(v.status==='candidate'){
        $('#skReviewActions').innerHTML=("<label for=\"skScope\">" + QI.msg("Target scope") + "</label><select id=\"skScope\"><option value=\"project\">" + QI.msg("Project") + "</option><option value=\"personal\">" + QI.msg("Personal") + "</option></select><p>" + QI.msg("Approval covers the bytes shown above. A change to license, instructions, files or renderer needs a new review.") + "</p><button class=\"btn\" id=\"skAccept\">" + QI.msg("Approve for local use") + "</button> <button class=\"btn\" id=\"skReject\">" + QI.msg("Reject") + "</button>");
        const reviews=skillContext.loop.approvals.filter(a=>a.version_id===v.id&&a.kind==='content_review'),revision=reviews.length;
        $('#skAccept').onclick=async()=>{try{const accepted=await skillApi('/skills/candidates/'+v.id+'/accept','POST',{version_id:v.id,expected_digest:v.candidate_digest,expected_revision:revision,target_scope:$('#skScope').value,expires_at_ms:Date.now()+86400000},v.candidate_digest);await skillDetail(v.skill_id);await skillPreview(accepted.data.version_id);}catch(e){skillFailure(e);}};
        $('#skReject').onclick=async()=>{try{const caps=await skillApi('/capabilities');await skillApi('/skills/candidates/'+v.id+'/reviews','POST',{version_id:v.id,expected_digest:v.candidate_digest,expected_revision:revision,kind:'content_review',decision:'reject',evidence_class:'human_accepted',target_scope:$('#skScope').value,capabilities:descriptor.requested_capabilities,expires_at_ms:Date.now()+86400000,policy_epoch:caps.policy_epoch},v.candidate_digest);await skillDetail(v.skill_id);}catch(e){skillFailure(e);}};
      }else if(v.status==='sealed'){
        const loop=(await skillApi('/skill-loop?skill_id='+v.skill_id));skillContext.loop=loop;
        const approvals=loop.approvals.filter(a=>a.version_id===v.id&&a.decision==='approve'&&a.expires_at_ms>Date.now());
        $('#skReviewActions').innerHTML=("<form id=\"skAssign\"><label for=\"skRuntime\">" + QI.msg("Enrolled runtime") + "</label><select id=\"skRuntime\">")+loop.registrations.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.runtime_kind||r.runtime_id)+' '+esc(r.runtime_version||(QI.msg("configuration required")))+'</option>').join('')+("</select><label for=\"skApproval\">" + QI.msg("Approved scope") + "</label><select id=\"skApproval\">")+approvals.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.target_scope)+'</option>').join('')+("</select><label for=\"skAssignReason\">" + QI.msg("Assignment") + "</label><select id=\"skAssignReason\"><option value=\"replace\">" + QI.msg("Assign / update") + "</option><option value=\"rollback\">" + QI.msg("Rollback to this earlier version") + "</option></select><button class=\"btn\" ")+(!loop.registrations.length||!approvals.length?'disabled':'')+(">" + QI.msg("Assign exact version") + "</button></form>");
        $('#skAssign').onsubmit=async event=>{event.preventDefault();const runtimeId=$('#skRuntime').value,approval=approvals.find(a=>a.id===$('#skApproval').value),old=loop.assignments.find(a=>a.runtime_id===runtimeId&&a.target_scope===approval.target_scope);try{const args={runtime_id:runtimeId,version_id:v.id,package_digest:v.package_digest,approval_id:approval.id,adoption_operation_id:crypto.randomUUID(),target_scope:approval.target_scope,expires_at_ms:Math.min(approval.expires_at_ms,Date.now()+3600000),expected_revision:old?.revision||0,reason:old?$('#skAssignReason').value:'assign'};if(old)args.assignment_id=old.id;await skillApi('/skill-assignments','POST',args,args.expected_revision);await skillDetail(v.skill_id);skillStatus((QI.msg("Assigned for the next managed native session. Existing sessions retain their exact versions.")));}catch(e){skillFailure(e);}};
      }
    }catch(e){skillFailure(e);}
  }

  // ================= GLOBAL SEARCH =================
  async function renderSearchPage() {
    setCrumb(("<span style=\"color:var(--text)\">" + QI.msg("Search") + "</span>"));
    if (!agentsCache) { try { agentsCache = (await api('/api/dashboard/agents')).items; } catch {} }
    main.innerHTML =
      ("<div style=\"margin-bottom:18px\"><input type=\"text\" id=\"gSearch\" aria-label=\"Search messages\" data-i18n-aria-label=\"Search messages\" class=\"input-text\" placeholder=\"" + QI.msg("Search messages across all visible agents…") + "\"></div>") +
      ("<div style=\"font-size:.74rem;color:var(--text3);margin-bottom:14px\">" + QI.msg("Searches") + " ") + ((agentsCache || []).length) + (" " + QI.msg("agents you can access.") + "</div>") +
      ("<div id=\"gResults\" aria-live=\"polite\"><div class=\"empty\">" + QI.msg("Type to search…") + "</div></div>");
    const inp = $('#gSearch'); inp.focus(); let dt;
    inp.oninput = () => { clearTimeout(dt); dt = setTimeout(() => doGlobalSearch(inp.value.trim()), 400); };
  }
  async function doGlobalSearch(q) {
    const out = $('#gResults');
    if(!out)return;
    out.dataset.query=q;
    if (!q) { out.innerHTML = ("<div class=\"empty\">" + QI.msg("Type to search…") + "</div>"); return; }
    out.innerHTML = ("<div class=\"loading\">" + QI.msg("Searching") + " ") + ((agentsCache || []).length) + (" " + QI.msg("agents…") + "</div>");
    try {
      const results = await Promise.all((agentsCache || []).map(async a => {
        const base='/api/dashboard/agents/'+encodeURIComponent(a.id);
        const [messages,notes]=await Promise.all([api(base+'/search?q='+encodeURIComponent(q)+'&limit=20'),api(base+'/notes?limit=500')]);
        return (messages.items||[]).map(m=>({...m,_agent:a,_kind:(QI.msg("Message"))})).concat((notes.items||[]).filter(n=>(n.text||'').toLowerCase().includes(q.toLowerCase())).map(n=>({...n,content:n.text,created_at:n.updated_at,_agent:a,_kind:(QI.msg("Context note"))})));
      }));
      setConn(true);
      if(!out.isConnected||out.dataset.query!==q)return;
      let merged = [].concat.apply([], results);
      merged.sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''));
      merged = merged.slice(0, 120);
      if (!merged.length) { out.innerHTML = ("<div class=\"empty\">" + QI.msg("Nothing found across any agent.") + "</div>"); return; }
      out.innerHTML = '<div style="font-size:.74rem;color:var(--text3);margin-bottom:12px">' + merged.length + (" " + QI.msg("results") + "</div><div class=\"transcript\">") +
        merged.map((m, i) => '<button type="button" class="msg search-result" data-role="' + esc(m.role||'note') + '" data-i="' + i + '" '+(m.session_id?'data-session="'+esc(m.session_id)+'"':'')+'><div class="msg-head">' + roleIcon(m.role) +
          '<span class="msg-role ' + esc(m.role||'note') + '">' + esc(m._kind) + '</span>' +
          '<span class="chip click" data-aid="' + esc(m._agent.id) + '">' + esc(m._agent.name) + '</span>' +
          '<span>' + fmtTimeFull(m.created_at) + '</span></div>' +
          '<div class="msg-content">' + esc(m.content) + '</div></button>').join('') + '</div>';
      out.querySelectorAll('[data-aid]').forEach(c => c.onclick = (ev) => { ev.stopPropagation(); drillAgentById(c.getAttribute('data-aid')); });
      out.querySelectorAll('.msg[data-session]').forEach(el => { el.onclick = () => {
        const m = merged[+el.getAttribute('data-i')];
        state = { page: 'agents', drill: { kind: 'session', agent: m._agent, session: { id: m.session_id, title: null } } }; route();
      }; });
    } catch (e) { if(!out.isConnected||out.dataset.query!==q)return;setConn(false); out.innerHTML = ("<div class=\"err\">" + QI.msg("Search failed:") + " ")+esc(e.message)+'. Retry, or open an agent to search its visible scope.</div>'; }
  }

  // ---------- Bridges: an external folder owned by this installation ----------
  async function renderBridgesPage(folderOnly=false) {
    pollFn=null;setCrumb((QI.msg("Bridges")));
    main.innerHTML=("<section class=\"work\" id=\"bridgeRoot\"><header><h1>" + QI.msg("Bridges") + "</h1><p>" + QI.msg("Connect spaces and choose what to share.") + "</p></header><p id=\"bridgeStatus\" role=\"status\" aria-live=\"polite\"></p><div class=\"work-controls\"><div><label for=\"bridgeGroup\">" + QI.msg("Your bridge") + "</label><select id=\"bridgeGroup\"><option value=\"\">" + QI.msg("Choose a bridge") + "</option></select></div><div class=\"work-actions\"><button id=\"bridgeInvite\">" + QI.msg("Invite someone") + "</button><button id=\"bridgeRefresh\">" + QI.msg("Refresh catalogues") + "</button></div></div><div id=\"bridgeConnection\"></div><div class=\"bridge-tabs\" role=\"tablist\" aria-label=\"" + QI.msg("External folder") + "\"><button role=\"tab\" data-section=\"outgoing\" aria-selected=\"true\">" + QI.msg("For sending") + "</button><button role=\"tab\" data-section=\"received\" aria-selected=\"false\">" + QI.msg("Received") + "</button><button role=\"tab\" data-section=\"catalogues\" aria-selected=\"false\">" + QI.msg("Other catalogues") + "</button><button role=\"tab\" data-section=\"requests\" aria-selected=\"false\">" + QI.msg("Requests") + "</button><button role=\"tab\" data-section=\"members\" aria-selected=\"false\">" + QI.msg("Members") + "</button></div><div class=\"bridge-search\"><label for=\"bridgeSearch\">" + QI.msg("Find a title or description") + "</label><input id=\"bridgeSearch\" type=\"search\" placeholder=\"" + QI.msg("Search this view") + "\"></div><div id=\"bridgeList\" role=\"tabpanel\"></div><details id=\"bridgeAdd\"><summary>" + QI.msg("Add a material to For sending") + "</summary><p>" + QI.msg("This saves a separate copy. Its title and description remain private until you publish them to a bridge.") + "</p><form id=\"bridgeStage\"><label for=\"bridgeSource\">" + QI.msg("Source") + "</label><select id=\"bridgeSource\"><option value=\"text\">" + QI.msg("Write a note") + "</option><option value=\"upload\">" + QI.msg("Upload a file or skill") + "</option></select><label for=\"bridgeTitle\">" + QI.msg("Title for the catalogue") + "</label><input id=\"bridgeTitle\" maxlength=\"120\" required><label for=\"bridgeDescription\">" + QI.msg("Short description for the catalogue") + "</label><textarea id=\"bridgeDescription\" maxlength=\"400\" rows=\"2\"></textarea><div id=\"bridgeTextWrap\"><label for=\"bridgeText\">" + QI.msg("Note") + "</label><textarea id=\"bridgeText\" rows=\"6\"></textarea></div><div id=\"bridgeFileWrap\" hidden><label for=\"bridgeFile\">" + QI.msg("File · up to 1 MiB") + "</label><input id=\"bridgeFile\" type=\"file\"><label for=\"bridgeKind\">" + QI.msg("Material type") + "</label><select id=\"bridgeKind\"><option value=\"file\">" + QI.msg("File") + "</option><option value=\"skill\">" + QI.msg("Skill · received without installation") + "</option></select></div><div class=\"work-actions\"><button type=\"submit\">" + QI.msg("Save to For sending") + "</button></div></form></details><div class=\"work-grid\" style=\"margin-top:36px\"><section><h2>" + QI.msg("Start a small circle") + "</h2><p>" + QI.msg("Create a bridge for your collaborators. You approve who joins; every owner controls their own catalogue and files.") + "</p><form id=\"bridgeCreate\"><label for=\"bridgeName\">" + QI.msg("Bridge name") + "</label><input id=\"bridgeName\" maxlength=\"120\" placeholder=\"" + QI.msg("Our research circle") + "\" required><div class=\"work-actions\"><button type=\"submit\">" + QI.msg("Create bridge") + "</button></div></form></section><section><h2>" + QI.msg("Have an invitation?") + "</h2><p>" + QI.msg("Paste its link or code. The creator confirms your membership before any catalogue becomes visible.") + "</p><form id=\"bridgeJoin\"><label for=\"bridgeCode\">" + QI.msg("Invitation link or code") + "</label><textarea id=\"bridgeCode\" rows=\"2\" required></textarea><label for=\"bridgeMyName\">" + QI.msg("Your name in this bridge") + "</label><input id=\"bridgeMyName\" maxlength=\"120\" required><div class=\"work-actions\"><button type=\"submit\">" + QI.msg("Request to join") + "</button></div></form></section></div><details style=\"margin-top:24px\"><summary>" + QI.msg("Your external agent") + "</summary><p>" + QI.msg("Choose which of your existing agents can browse catalogues, request materials and prepare drafts. Publication and manual sending remain owner actions.") + "</p><label for=\"bridgeAgent\">" + QI.msg("Agent in this installation") + "</label><select id=\"bridgeAgent\"><option value=\"\">" + QI.msg("No agent selected") + "</option></select><div class=\"work-actions\"><button id=\"bridgeAgentSave\">" + QI.msg("Save agent") + "</button></div></details><p class=\"meta\" style=\"margin-top:28px\">" + QI.msg("Each space keeps its own data. The Qoopia relay connects members and temporarily buffers encrypted deliveries. Received files are not automatically installed, added to memory or shared onward.") + "</p><dialog class=\"bridge-dialog work\" id=\"bridgeDialog\"><div id=\"bridgeDialogContent\"></div><div class=\"work-actions\"><button id=\"bridgeDialogClose\">" + QI.msg("Close") + "</button></div></dialog></section>");
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
      try {const r=await fetch('/api/dashboard/bridges',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify({action,...body})});const result=await r.json();if(!r.ok)throw new Error(result.error_description||(QI.msg("Bridge action failed")));return result;}
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
      $('#bridgeConnection').innerHTML=(g?'<p class="meta">'+esc(g.state==='pending'?(QI.msg("Waiting for the creator to confirm your membership.")):g.state==='creating'?(QI.msg("Creating your bridge…")):g.online?(QI.msg("Connected ·") + " ")+QI.count(g.members.filter(m=>m.state==='active').length,'member'):(QI.msg("Offline · deliveries remain in their owners’ queues.")))+'</p>':'')+(data.pending_controls.length?("<p role=\"status\">" + QI.msg("Access changes are saved locally and waiting for the relay. They will be retried automatically.") + "</p>"):'');
      const empty=text=>'<p class="bridge-empty">'+text+'</p>';
      if(section==='outgoing'||section==='received') {
        const materials=data.materials.filter(m=>m.direction===section&&matches(m));
        list.innerHTML=materials.length?materials.map(m=>{const pub=g&&data.publications.find(p=>p.group_id===g.id&&p.material_id===m.id);return '<article class="bridge-row"><div><h3>'+esc(m.title)+'</h3><p>'+esc(m.description)+'</p><p class="meta">'+(section==='received'?(QI.msg("Received · kept separate from your memory")):pub?(pub.auto_send?(QI.msg("Listed · automatic sending on request")):(QI.msg("Listed · sending needs approval"))):(QI.msg("Private draft · not listed")))+'</p></div><div class="work-actions"><button data-material="'+esc(m.id)+'">'+(section==='received'?(QI.msg("Review received")):(QI.msg("Review & publish")))+'</button></div></article>';}).join(''):empty(section==='received'?(QI.msg("Received materials will appear here, with their source.")):(QI.msg("Add a note, file or skill you are willing to share.")));
      }else if(section==='catalogues') {
        const entries=data.catalogues.filter(c=>c.group_id===g?.id).flatMap(c=>c.items.map(m=>({...m,peer:c.peer_id}))).filter(matches);
        list.innerHTML=entries.length?entries.map(m=>'<article class="bridge-row"><div><h3>'+esc(m.title)+'</h3><p>'+esc(m.description)+'</p><p class="meta">'+esc(name(g,m.peer))+(" " + QI.msg("· catalogue only") + "</p></div><button data-request=\"")+esc(m.id)+'" data-peer="'+esc(m.peer)+'" data-version="'+esc(m.version)+("\">" + QI.msg("Request material") + "</button></article>")).join(''):empty((QI.msg("Choose a connected bridge and refresh its catalogues. Only titles and descriptions appear here.")));
      }else if(section==='requests') {
        const requests=data.requests.filter(r=>r.group_id===g?.id);
        list.innerHTML=requests.length?requests.map(r=>{const m=data.materials.find(m=>m.id===r.material_id),title=m?.title||data.catalogues.flatMap(c=>c.items).find(m=>m.id===r.material_id)?.title||(QI.msg("Requested material"));return '<article class="bridge-row"><div><h3>'+esc(title)+'</h3><p>'+esc((r.direction==='incoming'?(QI.msg("From") + " "):(QI.msg("To") + " "))+name(g,r.peer_id))+' · '+esc(QI.code(r.state))+'</p></div>'+(r.direction==='incoming'&&r.state==='requested'?'<button data-review-request="'+esc(r.id)+("\">" + QI.msg("Review request") + "</button>"):'')+'</article>';}).join(''):empty((QI.msg("Requests for materials will appear here.")));
      }else {
        list.innerHTML=g?.members?.length?g.members.map(m=>'<article class="bridge-row"><div><h3>'+esc(m.name)+(m.peer===data.peer_id?(" " + QI.msg("· you")):'')+'</h3><p>'+esc(QI.code(m.state))+'</p><div class="bridge-fingerprint">'+esc(m.peer)+'</div></div>'+(g.creator&&m.peer!==data.peer_id?'<button data-member="'+esc(m.peer)+'" data-operation="'+(m.state==='active'?'remove':'admit')+'">'+(m.state==='active'?(QI.msg("Remove")):(QI.msg("Review membership")))+'</button>':'')+'</article>').join('')+(g.state==='active'?'<div class="work-actions" style="margin-top:24px"><button data-end="'+(g.creator?'close':'leave')+'">'+(g.creator?(QI.msg("Close bridge")):(QI.msg("Leave bridge")))+'</button></div>':''):empty((QI.msg("Create or join a bridge to see its members.")));
      }
      if(section==='members'&&g?.creator) {
        const invitations=data.invitations.filter(i=>i.group_id===g.id);
        if(invitations.length)list.insertAdjacentHTML('beforeend',("<h3 style=\"margin-top:24px\">" + QI.msg("Invitations") + "</h3>")+invitations.map(i=>'<article class="bridge-row"><p>'+esc(i.revoked===2?(QI.msg("Revocation queued")):i.revoked?(QI.msg("Revoked")):i.expires_at_ms<=Date.now()?(QI.msg("Expired")):(QI.msg("Expires") + " ")+QI.date(i.expires_at_ms))+'</p>'+(!i.revoked&&i.expires_at_ms>Date.now()?'<button data-revoke-invite="'+esc(i.id)+("\">" + QI.msg("Revoke invitation") + "</button>"):'')+'</article>').join(''));
        list.querySelectorAll('[data-revoke-invite]').forEach(b=>b.onclick=async()=>{try{await act('revoke-invite',{id:b.dataset.revokeInvite});await load();}catch(e){status(e.message);}});
      }
      list.querySelectorAll('[data-material]').forEach(b=>b.onclick=()=>reviewMaterial(b.dataset.material).catch(e=>status(e.message)));
      list.querySelectorAll('[data-request]').forEach(b=>b.onclick=async()=>{try{await act('request',{id:crypto.randomUUID(),group:g.id,peer:b.dataset.peer,material_id:b.dataset.request,version:b.dataset.version});status((QI.msg("Request queued. The owner decides whether to send this version.")));await load();}catch(e){status(e.message);}});
      list.querySelectorAll('[data-review-request]').forEach(b=>b.onclick=()=>{const r=data.requests.find(r=>r.id===b.dataset.reviewRequest);reviewMaterial(r.material_id,r).catch(e=>status(e.message));});
      list.querySelectorAll('[data-member]').forEach(b=>b.onclick=()=>{const m=g.members.find(m=>m.peer===b.dataset.member),admit=b.dataset.operation==='admit';show('<h2>'+esc(admit?(QI.msg("Confirm this participant")):(QI.msg("Remove participant")))+'</h2><p>'+esc(m.name)+'</p><p class="bridge-fingerprint">'+esc(m.peer)+'</p><p>'+(admit?(QI.msg("Confirm that this is the person you invited. Membership opens published catalogues; it does not grant file access.")):(QI.msg("This ends new access to the bridge. Previously received copies remain with their recipients.")))+'</p><div class="work-actions"><button class="primary" id="bridgeMemberConfirm">'+(admit?(QI.msg("Admit to bridge")):(QI.msg("Remove from bridge")))+'</button></div>');$('#bridgeMemberConfirm').onclick=async()=>{try{await act('membership',{group:g.id,operation:b.dataset.operation,peer:m.peer});dialog.close();await load();}catch(e){status(e.message);}};});
      list.querySelectorAll('[data-end]').forEach(b=>b.onclick=()=>{show('<h2>'+esc(b.textContent)+("</h2><p>" + QI.msg("New access will stop. Your own data and received copies remain in your installation.") + "</p><div class=\"work-actions\"><button class=\"primary\" id=\"bridgeEndConfirm\">")+esc(b.textContent)+'</button></div>');$('#bridgeEndConfirm').onclick=async()=>{try{await act('membership',{group:g.id,operation:b.dataset.end});dialog.close();await load();}catch(e){status(e.message);}};});
    }
    async function reviewMaterial(materialId,transfer) {
      const m=await act('material',{id:materialId}),g=selected(),bytes=Uint8Array.from(atob(m.content_base64),c=>c.charCodeAt(0)),text=m.mime.startsWith('text/')||m.kind==='note'?new TextDecoder().decode(bytes):null;
      const pub=g&&data.publications.find(p=>p.group_id===g.id&&p.material_id===materialId);
      show('<h2>'+esc(m.title)+'</h2><p>'+esc(m.description)+'</p><p class="meta">'+esc(m.filename)+' · '+humanSize(bytes.length)+'</p>'+(m.direction==='received'?("<p>" + QI.msg("Received from") + " ")+esc(name(data.groups.find(x=>x.id===m.source.group),m.source.peer))+(QI.msg(". Treat this material as a reference until you decide how to use it.") + "</p>"):'')+(transfer?("<p>" + QI.msg("Request from") + " <strong>")+esc(name(g,transfer.peer_id))+("</strong>" + QI.msg(". Approve sends only the version shown here.") + "</p>"):'')+(text!==null?'<pre>'+esc(text.slice(0,64000))+'</pre>'+(text.length>64000?("<p class=\"meta\">" + QI.msg("Preview shortened. Download to review the complete file.") + "</p>"):''):("<p>" + QI.msg("Download the original to review its contents.") + "</p>"))+("<button id=\"bridgeDownload\">" + QI.msg("Download original") + "</button>")+(transfer?("<div class=\"work-actions\"><button class=\"primary\" id=\"bridgeApprove\">" + QI.msg("Approve sending") + "</button><button id=\"bridgeSkip\">" + QI.msg("Skip") + "</button></div>"):m.direction==='outgoing'&&g?.state==='active'?("<hr><h3>" + QI.msg("Catalogue in") + " ")+esc(g.name)+("</h3><p>" + QI.msg("Publish only the title and short description. File contents are sent separately, on request.") + "</p><label><input type=\"checkbox\" id=\"bridgeAuto\"> " + QI.msg("Automatically send this version when a member of this bridge requests it") + "</label><div class=\"work-actions\"><button class=\"primary\" id=\"bridgePublish\">")+(pub?(QI.msg("Save sharing rule")):(QI.msg("Publish catalogue entry")))+'</button>'+(pub?("<button id=\"bridgeWithdraw\">" + QI.msg("Withdraw entry") + "</button>"):'')+'</div>':m.direction==='received'?("<div class=\"work-actions\"><button id=\"bridgePrepareAgain\">" + QI.msg("Prepare a copy for sharing") + "</button></div>"):("<p>" + QI.msg("Create or join a bridge before publishing this draft.") + "</p>")));
      $('#bridgeDownload').onclick=()=>{const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=m.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      if(transfer)for(const [button,approve] of [['bridgeApprove',true],['bridgeSkip',false]])$('#'+button).onclick=async()=>{try{await act('decide',{id:transfer.id,version:m.version,approve});dialog.close();status(approve?(QI.msg("Approved. Delivery will appear in the recipient’s Received folder.")):(QI.msg("Request skipped.")));await load();}catch(e){status(e.message);}};
      if($('#bridgeAuto'))$('#bridgeAuto').checked=!!pub?.auto_send;
      if($('#bridgePublish'))$('#bridgePublish').onclick=async()=>{try{await act('publish',{group:g.id,material_id:materialId,version:m.version,visible:true,auto_send:$('#bridgeAuto').checked});dialog.close();status((QI.msg("Catalogue entry published to") + " ")+g.name+'.');await load();}catch(e){status(e.message);}};
      if($('#bridgeWithdraw'))$('#bridgeWithdraw').onclick=async()=>{try{await act('publish',{group:g.id,material_id:materialId,version:m.version,visible:false,auto_send:false});dialog.close();status((QI.msg("Entry withdrawn. Already delivered copies cannot be recalled.")));await load();}catch(e){status(e.message);}};
      if($('#bridgePrepareAgain'))$('#bridgePrepareAgain').onclick=async()=>{try{await act('copy',{id:crypto.randomUUID(),source:'received',source_id:materialId,title:m.title,description:m.description});dialog.close();status('A private draft was added to For sending. Publish it only after review.');await load();}catch(e){status(e.message);}};
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
        stageId=crypto.randomUUID();$('#bridgeStage').reset();$('#bridgeTextWrap').hidden=false;$('#bridgeFileWrap').hidden=true;$('#bridgeAdd').open=false;status((QI.msg("Saved privately to For sending. Review and publish its catalogue entry when ready.")));await load();
      }catch(e){status(e.message);}
    };
    await load();pollFn=load;
  }

  // ---------- Memory ----------
  async function renderWorkspace(snapshot) {
    pollFn=null;setCrumb((QI.msg("Memory")));
    let data;try{data=snapshot||await api('/api/dashboard/memory');}catch(e){if(state.page==='work')main.innerHTML='<p role="alert">'+esc(e.message)+'</p>';return;}
    if(state.page!=='work')return;
    const names={claude_code:'Claude',codex:'ChatGPT'},model=data.model;
    const messages={not_connected:(QI.msg("Choose the subscription you want Qoopia to use.")),selected:(QI.msg("Sign in if needed, then check the connection.")),ready:(QI.msg("Connected. Ready to organise your memory.")),auth_required:(QI.msg("Sign in again to resume.")),quota:(QI.msg("Your subscription limit was reached. Saved events are waiting safely.")),timeout:(QI.msg("The model took too long. Search and saved events are still available.")),unavailable:(QI.msg("The model is unavailable. Check your subscription connection.")),invalid_response:(QI.msg("The model returned an unusable result. Your last saved context is preserved."))};
    main.innerHTML=("<section class=\"work\"><header><h1>" + QI.msg("Memory settings") + "</h1><p>" + QI.msg("Configure how this workspace keeps and finds context.") + "</p></header><div class=\"work-grid\"><div><section class=\"memory-first\"><h2>" + QI.msg("Your agents, connected.") + "</h2><p>" + QI.msg("Connect ChatGPT, Claude and your native agents in one place. Your steward and existing connections stay with this workspace.") + "</p><div class=\"work-actions\"><button id=\"memoryConnections\">" + QI.msg("Open connections →") + "</button></div></section><h2>" + QI.msg("Optional: a model for your memory") + "</h2><p>" + QI.msg("Use your own subscription to organise session notes and assess search results. Text search and built-in semantic search remain available without it.") + "</p><div class=\"work-controls memory-model-controls\"><div><label for=\"memoryProvider\">" + QI.msg("Your subscription") + "</label><select id=\"memoryProvider\"><option value=\"claude_code\">Claude · Haiku</option><option value=\"codex\">ChatGPT · Codex</option></select></div><div class=\"work-actions\"><button id=\"memorySelect\">" + QI.msg("Use this subscription") + "</button></div></div><p class=\"work-status\" role=\"status\" id=\"memoryModelStatus\">")+esc(messages[model.state]||model.state)+(model.model?' · '+esc(model.model):'')+("</p><div class=\"work-actions\"><button id=\"memoryLogin\">" + QI.msg("Sign in to") + " ")+esc(names[model.runtime]||(QI.msg("subscription")))+("</button><button class=\"primary\" id=\"memoryCheck\">" + QI.msg("Check connection") + "</button></div><div id=\"memoryLoginInfo\"></div><p id=\"memoryActionStatus\" role=\"status\" aria-live=\"polite\" class=\"work-status\"></p></div><aside><h2>" + QI.msg("Already in your memory") + "</h2><p><strong>")+esc(data.embedding.embedded)+' / '+esc(data.embedding.total_notes)+("</strong><br>" + QI.msg("notes indexed for semantic search") + "</p><p><strong>")+esc(data.sessions.summarized)+' / '+esc(data.sessions.tracked)+("</strong><br>" + QI.msg("tracked sessions with a context note") + "</p><div class=\"work-result\"><h2>" + QI.msg("How continuity works") + "</h2><p>" + QI.msg("Events are saved as you work. A compact note evolves with the session. When you return, your agent receives the note and recent events that have not yet been summarised.") + "</p><p>" + QI.msg("Everything stays in this workspace. Existing notes, namespaces and connections remain in place.") + "</p><button id=\"memorySessions\">" + QI.msg("Browse agent sessions →") + "</button></div></aside></div></section>");
    const root=main.firstElementChild;let actionBusy=false,polling=false;
    let savedProvider;try{savedProvider=sessionStorage.getItem('qoopia.memory.provider');}catch{}$('#memoryProvider').value=['claude_code','codex'].includes(savedProvider)?savedProvider:model.runtime||'claude_code';
    $('#memoryProvider').onchange=e=>{try{sessionStorage.setItem('qoopia.memory.provider',e.target.value);}catch{}};
    const op=data.operation;if(op?.state==='running')$('#memoryActionStatus').textContent=QI.msg('Preparing your subscription. You can use other pages.');else if(op?.state==='failed')$('#memoryActionStatus').textContent=QI.msg(op.error);else if(op?.state==='completed'&&op.action==='check')$('#memoryActionStatus').textContent=QI.msg('Connection checked with a real model response.');
    $('#memoryLogin').disabled=!model.runtime||data.busy;$('#memoryCheck').disabled=!model.runtime||data.busy;$('#memorySelect').disabled=data.busy;
    $('#memorySessions').onclick=()=>go('agents');
    $('#memoryConnections').onclick=()=>go('connections');
    const login=data.login;
    if(login?.state==='cancelled')$('#memoryActionStatus').textContent=QI.pair('Sign-in cancelled.','Вход отменён.');
    if(login?.state==='failed')$('#memoryActionStatus').textContent=QI.pair('Sign-in did not finish. Try signing in again.','Вход не завершён. Попробуйте войти ещё раз.');
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
        else if(result.next)$('#memoryActionStatus').textContent=result.next;
        else if(payload.action==='check')$('#memoryActionStatus').textContent=(QI.msg("Connection checked with a real model response."));
      }catch(e){if(root.isConnected){status.textContent=e.message;buttons.forEach(b=>b.disabled=false);}}finally{actionBusy=false;}
    }
    $('#memorySelect').onclick=()=>action({action:'select',runtime:$('#memoryProvider').value});
    $('#memoryLogin').onclick=()=>action({action:'login'});$('#memoryCheck').onclick=()=>action({action:'check'});
    // Keep inputs stable. Refresh only when a login or background index changes.
    pollFn=async()=>{if(polling||actionBusy||!root.isConnected)return;polling=true;try{const next=await api('/api/dashboard/memory');if(root.isConnected&&!actionBusy&&state.page==='work'&&JSON.stringify(next)!==JSON.stringify(data)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))await renderWorkspace(next);}catch(e){if(root.isConnected)$('#memoryActionStatus').textContent=e.message;}finally{polling=false;}};
  }


  async function renderConnectionWizard(host,workspaceName,onRefresh) {
    const t=(en,ru)=>QI.pair(en,ru);
    const names={codex:'Codex CLI',claude_code:'Claude Code',muse_code:'Muse Code',grok_bot:'Grok Bot',claude_desktop:'Claude Desktop',claude_web:'Claude Web',chatgpt_web:'ChatGPT Web',chatgpt_desktop:'ChatGPT Desktop'};
    const guides={
      chatgpt_web:{url:'https://chatgpt.com/plugins',text:t('Open Plugins → + → New plugin. Choose OAuth and paste this address. Developer mode may be required in Settings → Security and login.','Откройте Плагины → + → Новый плагин. Выберите OAuth и вставьте адрес. При необходимости включите режим разработчика в Настройки → Безопасность и вход.'),limit:t('Verified with ChatGPT Pro in the web client: OAuth, connection check, reading, adding and repeat requests. Availability depends on your ChatGPT plan and workspace settings. If a client check is blocked, stop and leave the connection unverified.','Проверено с ChatGPT Pro в браузере: OAuth, проверка подключения, чтение, добавление и повторные запросы. Доступность зависит от плана ChatGPT и настроек пространства. Если клиент блокирует проверку, остановите её и оставьте подключение неподтверждённым.')},
      chatgpt_desktop:{url:'https://developers.openai.com/apps-sdk/deploy/connect-chatgpt',text:t('Open Plugins in the desktop client and add this address using OAuth. If the desktop app does not offer custom plugins, use another supported client.','Откройте Плагины в настольном клиенте и добавьте адрес с OAuth. Если приложение не позволяет добавлять свои плагины, используйте другой поддерживаемый клиент.'),limit:t('OAuth, authenticated verification, reading, writing and retries without duplicates passed on Mac. Use New chat → Chat. A repeated one-use verification does not undo an earlier success. Stop any client-blocked action.','OAuth, подтверждение подключения, чтение, запись и повтор без дублей проверены на Mac. Используйте Новый чат → Чат. Повтор одноразовой проверки не отменяет прежний успех. Не повторяйте действие, заблокированное клиентом.')},
      claude_web:{url:'https://claude.ai/customize/connectors',text:t('Open Customize → Connectors → + → Add custom connector. Paste this address, add it and choose Connect. Enable it in the conversation.','Откройте Настройка → Коннекторы → + → Добавить свой коннектор. Вставьте адрес, добавьте коннектор и нажмите Подключить. Включите его в беседе.'),limit:t('Free allows one custom connector. Team/Enterprise require an organization owner to add it.','На Free доступен один собственный коннектор. В Team/Enterprise его добавляет владелец организации.')},
      claude_desktop:{url:'https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop',text:t('Add the local adapter on your Mac, or open the downloaded setup file there. Approve this connection in Qoopia, restart Claude Desktop, then verify in a new conversation.','Добавьте локальный адаптер на Mac или откройте там скачанный файл настройки. Подтвердите доступ в Qoopia, перезапустите Claude Desktop и выполните проверку в новой беседе.'),limit:t('The local adapter targets Claude Desktop on macOS. A server workspace still needs its external address to be reachable. Actual Desktop acceptance is reported separately.','Локальный адаптер предназначен для Claude Desktop на macOS. Для памяти на сервере требуется доступный внешний адрес. Приёмка реального приложения учитывается отдельно.')},
      codex:{url:'https://developers.openai.com/codex/mcp',text:t('Add this URL as a Streamable HTTP MCP server in Codex, then use its OAuth login. Complete the verification below inside Codex.','Добавьте адрес как MCP-сервер Streamable HTTP в Codex, затем выполните его OAuth-вход. Проверку ниже выполните внутри Codex.'),limit:t('MCP grants access to memory. Background model authorization remains separate.','MCP даёт доступ к памяти. Авторизация модели для фоновых задач выполняется отдельно.')},
      claude_code:{url:'https://code.claude.com/docs/en/mcp',text:t('Add this URL as an HTTP MCP server in Claude Code. Open /mcp to sign in, then run the verification below inside Claude Code.','Добавьте адрес как HTTP MCP-сервер в Claude Code. Откройте /mcp для входа и выполните проверку ниже внутри Claude Code.'),limit:t('The client stores its own OAuth credential; never paste a token into chat.','Клиент хранит собственные данные OAuth; не вставляйте токен в чат.')},
      muse_code:{url:'https://meta-models.github.io/muse-code-sdk/next/guides/extend/mcp-servers/',text:t('Merge the copied entry into ~/.config/muse/settings.json without replacing other settings. Start a new Muse Code process, run muse mcp login for this server, then verify from a Muse Code conversation.','Добавьте скопированную запись в ~/.config/muse/settings.json, сохранив остальные настройки. Запустите новый процесс Muse Code, выполните muse mcp login для этого сервера и проверьте вызов из беседы.'),limit:t('The setup snippet includes no secret. Muse Code stores OAuth separately. Automatic session capture requires a separate adapter and is not enabled by this MCP connection.','В фрагменте настройки нет секретов. Muse Code хранит OAuth отдельно. Автосохранение сессии требует отдельного адаптера и этим MCP-подключением не включается.')},
      grok_bot:{url:'https://cursor.com/help/grok-bot/connect-plugins',text:t('Copy the setup request below into your cloud Grok Bot chat. Let the bot add this exact remote MCP address and complete OAuth in the client; then verify with one real tool call.','Скопируйте запрос настройки ниже в чат облачного Grok Bot. Попросите бота добавить именно этот удалённый MCP-адрес и завершите OAuth в клиенте; затем подтвердите подключение реальным вызовом.'),limit:t('Custom MCP setup varies by Grok Bot account and app version. If your bot cannot add a custom server, leave this connection unverified. Grok Bot plugins are account-wide.','Добавление своего MCP зависит от аккаунта и версии Grok Bot. Если бот не может добавить сервер, оставьте подключение неподтверждённым. Плагины Grok Bot доступны всем ботам этого аккаунта.')}
    };
    const link=(url,label)=>'<a class="connect-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+label+' ↗</a>';
    const connectionName=c=>'qoopia_'+c.id.replaceAll('-','');
    function setupText(c){
      const name=connectionName(c);
      if(c.surface==='muse_code')return JSON.stringify({schema_version:1,mcpServers:{[name]:{type:'streamable-http',url:c.mcp_url}}},null,2);
      if(c.surface==='grok_bot')return QI.resolve(t('Add a custom remote MCP server named '+name+' to this Grok Bot account: '+c.mcp_url+'. Use OAuth in the client; do not ask me to paste a token into chat. If custom MCP is unavailable, tell me instead of claiming it is connected.','Добавь в этот аккаунт Grok Bot удалённый MCP-сервер '+name+': '+c.mcp_url+'. Используй OAuth в клиенте; не проси вставлять токен в чат. Если свой MCP недоступен, скажи об этом и не объявляй подключение успешным.'));
      return '';
    }
    host.innerHTML='<p id="setupFeedback" role="status" aria-live="polite"></p><div id="setupConnections"></div><details id="setupNew" class="connection-add"><summary>'+t('Add an application','Добавить приложение')+'</summary><div class="work-controls"><div><label for="setupSurface">'+t('Application','Приложение')+'</label><select id="setupSurface">'+Object.entries(names).map(([id,name])=>'<option value="'+id+'">'+name+'</option>').join('')+'</select></div><div><label for="setupAccess">'+t('Access','Права')+'</label><select id="setupAccess"><option value="read">'+t('Read only','Только чтение')+'</option><option value="read_write">'+t('Read and add','Чтение и добавление')+'</option></select></div><button id="setupApply" class="primary">'+t('Prepare connection','Подготовить подключение')+'</button></div><p class="meta">'+t('A separate connection for this application. Existing agents keep their access.','Отдельное подключение для этого приложения. Доступ существующих агентов сохраняется.')+'</p><p class="meta">'+t('Read and add allows new notes, without editing or deleting existing ones.','Чтение и добавление разрешает создавать заметки, без изменения и удаления существующих.')+'</p></details><button id="setupRefresh">'+t('Refresh status','Обновить статусы')+'</button><details id="setupNetworkDetails" class="connection-options"><summary>'+t('External access settings','Настройки внешнего доступа')+'</summary><div id="setupNetwork"></div><p id="setupNetworkFeedback" role="status" aria-live="polite"></p></details>';
    const feedback=host.querySelector('#setupFeedback'),networkFeedback=host.querySelector('#setupNetworkFeedback');
    let actionBusy=false,revision=0,refreshing=false,lastResult='',lastConnections='',lastNetwork='';
    const call=async body=>{if(actionBusy)throw Error(QI.resolve(QI.msg('Please wait for the current action')));actionBusy=true;revision++;feedback.textContent=QI.msg('Working…');host.setAttribute('aria-busy','true');try{return await apiWrite('/api/dashboard/connection-setup',body);}finally{actionBusy=false;if(host.isConnected)host.removeAttribute('aria-busy');}};
    let networkBusy=false;
    const draftKey='qoopia-connection-draft:'+workspaceName;
    let draft;try{draft=JSON.parse(sessionStorage.getItem(draftKey));}catch{}
    if(draft&&names[draft.surface]&&['read','read_write'].includes(draft.access_mode)&&typeof draft.request_key==='string'){
      host.querySelector('#setupSurface').value=draft.surface;host.querySelector('#setupAccess').value=draft.access_mode;
    }else draft=null;
    function selection(){
      const surface=host.querySelector('#setupSurface').value,access_mode=host.querySelector('#setupAccess').value;
      if(!draft||draft.surface!==surface||draft.access_mode!==access_mode)draft={surface,access_mode,request_key:crypto.randomUUID()};
      try{sessionStorage.setItem(draftKey,JSON.stringify(draft));}catch{}return draft;
    }
    const showResult=(r,target=feedback)=>{
      const messages={ACTION_IN_PROGRESS:t('Working. You can use other pages.','Выполняем. Можно пользоваться другими страницами.'),CLIENT_AUTH_STARTING:t('Preparing the secure sign-in page…','Подготавливаем защищённую страницу входа…'),CLIENT_AUTHORIZATION_REQUIRED:t('Open the consent page, review this connection’s permissions, and approve. Then restart Claude Desktop.','Откройте страницу подтверждения, проверьте права этого подключения и подтвердите доступ. Затем перезапустите Claude Desktop.'),CLIENT_CALL_REQUIRED:t('Access is saved. Restart the client and run the verification prompt.','Доступ сохранён. Перезапустите клиент и выполните запрос проверки.'),CLIENT_AUTH_EXPIRED:t('The sign-in expired. Choose Approve access again.','Время входа истекло. Снова нажмите Подтвердить доступ.'),CLIENT_CONFIG_REQUIRED:t('Add the client on this computer first.','Сначала добавьте клиент на этом компьютере.'),SIGN_IN_REQUIRED:t('Account confirmation expired. Start sign-in again; the installation and memory are preserved.','Подтверждение аккаунта истекло. Начните вход заново; установка и память сохранены.'),ACCOUNT_CONFIRMATION_REQUIRED:t('Confirm the email sent to your Qoopia account, then choose Continue setup.','Подтвердите письмо на почте аккаунта Qoopia и нажмите Продолжить настройку.'),OWNER_ACCOUNT_REQUIRED:t('Finish signing in to your Qoopia account first.','Сначала завершите вход в аккаунт Qoopia.'),NETWORK_ONLINE:t('External connection is running.','Внешняя связь работает.'),NETWORK_CONNECTING:t('Reconnecting. Local memory is preserved.','Восстанавливаем связь. Локальная память сохранена.'),NETWORK_SERVICE_UNAVAILABLE:t('The connection service is unavailable. Keep this setup and try Continue setup later.','Сервис подключения недоступен. Сохраните настройку и позднее нажмите Продолжить настройку.'),NETWORK_DISABLED:t('External access is paused.','Внешний доступ приостановлен.'),DEVICE_REVOKED:t('This device was revoked.','Это устройство отозвано.')};
      target.textContent=messages[r.code]||r.next_action||r.code||'';
      if(r.open_url){const a=document.createElement('a');a.href=r.open_url;a.target='_blank';a.rel='noopener noreferrer';a.className='connect-link';a.textContent=r.code==='CLIENT_AUTHORIZATION_REQUIRED'?t('Open consent page','Открыть подтверждение'):t('Open account sign-in','Открыть вход в аккаунт');target.append(document.createTextNode(' '),a);}
    };
    async function refresh(showNetworkStatus=false){
      if(refreshing||actionBusy||!host.isConnected)return;refreshing=true;const started=revision;
      let result;try{result=await api('/api/dashboard/connection-setup');}finally{refreshing=false;}
      if(!host.isConnected||actionBusy||started!==revision)return;
      const network=result.network,key=JSON.stringify(result);
      if(!showNetworkStatus&&key===lastResult)return;lastResult=key;
      if(!networkBusy&&network?.operation){if(network.operation.result)showResult(network.operation.result,networkFeedback);else if(network.operation.state==='running')showResult({code:'ACTION_IN_PROGRESS'},networkFeedback);}else if(showNetworkStatus&&!networkBusy)showResult(network,networkFeedback);
      const networkKey=JSON.stringify([network?.code,network?.enabled,network?.device?.state,network?.transport?.reachable,network?.operation?.state,networkBusy]);
      if(networkKey!==lastNetwork){lastNetwork=networkKey;
      const section=host.querySelector('#setupNetwork');
      host.querySelector('#setupNetworkDetails').hidden=network?.code==='MANAGED_INSTALLATION_REQUIRED';
      if(network?.code==='MANAGED_INSTALLATION_REQUIRED')section.innerHTML='<h3>'+t('External connection','Внешняя связь')+'</h3><p>'+t('The current server manages its external address. Availability is checked when the client connects.','Внешним адресом управляет текущий сервер. Доступность проверяется при обращении клиента.')+'</p>';
      else{
        const ready=network?.transport?.reachable;
        section.innerHTML='<h3>'+t('External connection','Внешняя связь')+'</h3><p>'+esc(ready?t('Tunnel connected','Туннель подключён'):network?.code==='DEVICE_REVOKED'?t('Device revoked','Устройство отозвано'):network?.enabled?t('Connecting…','Подключение…'):t('External access is off','Внешний доступ выключен'))+'</p><p>'+t('Memory stays on this machine. Cloudflare handles encrypted transport and terminates HTTPS; it can process MCP traffic and connection metadata. The dashboard stays local.','Память остаётся на этой машине. Cloudflare обеспечивает защищённую передачу и завершает HTTPS; провайдер может обрабатывать MCP-трафик и метаданные соединений. Панель управления остаётся локальной.')+'</p><div class="work-actions">'+
          (!network?.device?'<button data-network="network-start">'+t('Enable with email confirmation','Включить с подтверждением по почте')+'</button><button data-network="network-start-google">'+t('Confirm with Google','Подтвердить через Google')+'</button>':network.device.state!=='revoked'?'<button data-network="'+(network.enabled?'network-disable':'network-enable')+'">'+(network.enabled?t('Pause external access','Приостановить внешний доступ'):t('Enable external access','Включить внешний доступ'))+'</button>':'')+
          '<button data-network="network-resume">'+t('Continue setup','Продолжить настройку')+'</button></div><p class="meta">'+t('Sleeping or offline machines cannot answer requests. The service reconnects when connectivity returns.','Спящая или отключённая от сети машина не отвечает на запросы. Служба переподключается после восстановления связи.')+'</p>';
        section.querySelectorAll('[data-network]').forEach(b=>{
          b.disabled=networkBusy||network?.operation?.state==='running';
          b.onclick=async()=>{
            if(networkBusy)return;networkBusy=true;
            section.querySelectorAll('[data-network]').forEach(button=>button.disabled=true);
            networkFeedback.textContent=t('Updating external connection…','Настраиваем внешнюю связь…');
            try{
              const action=b.dataset.network;
              const r=await call(action.startsWith('network-start')?{action:'network-start',language:QI.language,method:action.endsWith('google')?'google':'email'}:{action});
              showResult(r,networkFeedback);await refresh();
            }catch(e){networkFeedback.textContent=e.message;}
            finally{networkBusy=false;section.querySelectorAll('[data-network]').forEach(button=>button.disabled=false);networkFeedback.scrollIntoView({block:'nearest'});}
          };
        });
      }
      }
      const connectionKey=JSON.stringify(result.connections);if(connectionKey===lastConnections)return;lastConnections=connectionKey;
      const openIds=new Set([...host.querySelectorAll('[data-connection][open]')].map(el=>el.dataset.connection));
      const reconnectIds=new Set([...host.querySelectorAll('[data-reconnect][open]')].map(el=>el.dataset.reconnect));
      const proofs=new Map([...host.querySelectorAll('[data-proof]')].map(el=>[el.dataset.proof,el.textContent]));
      const active=result.connections.filter(c=>c.code!=='REVOKED'),revoked=result.connections.filter(c=>c.code==='REVOKED');
      function connectionRow(c){
        const guide=guides[c.surface],revoked=c.code==='REVOKED',ready=c.state==='ready';
        const title=names[c.surface]||c.surface;
        const stateLabel=ready?t('Client call verified','Вызов подтверждён'):revoked?t('Access revoked','Доступ отозван'):t('Setup unfinished','Настройка не завершена');
        const authHtml=c.surface==='claude_desktop'&&c.client_config==='on_this_computer'?'<div class="work-actions"><button data-client-auth="'+c.id+'">'+t('Approve access','Подтвердить доступ')+'</button>'+(c.client_auth?.open_url?link(c.client_auth.open_url,t('Open consent page','Открыть подтверждение')):'')+'</div>':'';
        const setup=revoked?'':'<h3>'+t('Connect this application','Подключить это приложение')+'</h3><p>'+esc(guide.text)+'</p><p class="connection-endpoint">'+esc(c.mcp_url)+'</p><div class="work-actions">'+(c.client_config?'<button data-client-setup="'+c.id+'">'+(c.client_config==='on_this_computer'?t('Add to this computer','Добавить на этот компьютер'):t('Download setup file','Скачать файл настройки'))+'</button>':'')+'<button data-copy-connection="'+c.id+'">'+t('Copy address','Скопировать адрес')+'</button>'+(setupText(c)?'<button data-copy-setup="'+c.id+'">'+(c.surface==='muse_code'?t('Copy config','Скопировать конфиг'):t('Copy request','Скопировать запрос'))+'</button>':'')+'</div>'+(c.surface==='muse_code'?'<p class="meta">'+t('Then run:','Затем выполните:')+' <code>'+esc('muse mcp login '+connectionName(c))+'</code></p>':'')+authHtml+'<h3>'+t('Confirm a real call','Подтвердить реальный вызов')+'</h3><p>'+t('Run the verification prompt in this application, then refresh its status here.','Выполните проверочный запрос в этом приложении и обновите статус здесь.')+'</p><button data-verify-connection="'+c.id+'">'+t('Get verification prompt','Получить запрос проверки')+'</button><pre data-proof="'+c.id+'"></pre><details class="connection-help"><summary>'+t('Help and limitations','Помощь и ограничения')+'</summary><p>'+esc(guide.limit)+'</p>'+link(guide.url,t('Open instructions','Открыть инструкцию'))+'</details>';
        return '<details class="connection-record" data-connection="'+c.id+'"'+(openIds.has(c.id)?' open':'')+'><summary><span>'+esc(title)+'</span><span class="connection-state">'+stateLabel+'</span><span class="connection-action">'+(revoked?t('Details','Подробнее'):ready?t('Manage','Управление'):t('Continue','Продолжить'))+'</span></summary><div class="connection-body"><p>'+t('Access: ','Права: ')+(c.access_mode==='read'?t('Read only','Только чтение'):t('Read and add','Чтение и добавление'))+'</p>'+
          (ready?'<p>'+t('Last verified call: ','Последний подтверждённый вызов: ')+esc(new Date(c.verified_at).toLocaleString(QI.language==='ru'?'ru-RU':'en-US'))+'. '+t('This records a successful call, not continuous availability.','Это подтверждение успешного вызова, а не постоянного присутствия в сети.')+'</p><details data-reconnect="'+c.id+'"'+(reconnectIds.has(c.id)?' open':'')+'><summary>'+t('Reconnect or verify again','Переподключить или проверить снова')+'</summary>'+setup+'</details>':setup)+
          (revoked?'':'<details class="connection-options"><summary>'+t('Remove access','Отключить доступ')+'</summary><p>'+t('Only this connection will stop working. Notes and other agents are preserved.','Перестанет работать только это подключение. Заметки и другие агенты сохранятся.')+'</p><button data-revoke-connection="'+c.id+'">'+t('Revoke access','Отозвать доступ')+'</button></details>')+'</div></details>';
      }
      host.querySelector('#setupConnections').innerHTML=active.map(connectionRow).join('')+(revoked.length?'<details class="connection-options"><summary>'+t('Disconnected applications','Отключённые приложения')+' ('+revoked.length+')</summary>'+revoked.map(connectionRow).join('')+'</details>':'');
      host.querySelectorAll('[data-proof]').forEach(el=>el.textContent=proofs.get(el.dataset.proof)||'');
      host.querySelectorAll('[data-client-setup]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{
        const c=result.connections.find(c=>c.id===b.dataset.clientSetup);
        if(c.client_config==='on_this_computer'){
          const plan=await call({action:'client-plan',id:c.id});
          if(plan.can_apply===false){feedback.textContent=t('This client entry changed outside Qoopia. Review it in your client settings before continuing.','Запись клиента изменена вне Qoopia. Проверьте её в настройках клиента перед продолжением.');return;}
          const applied=await call({action:'client-apply',id:c.id});
          if(c.surface==='claude_desktop'){showResult(await call({action:'client-auth-start',id:c.id}));await refresh();return;}
          feedback.textContent=applied.code==='CLIENT_AUTH_REQUIRED'?t('Address added. Open the client, authenticate its Qoopia connection, then run the verification prompt below.','Адрес добавлен. Откройте клиент, подтвердите его подключение к Qoopia и выполните запрос проверки ниже.'):applied.next_action;
        }else{
          const r=await call({action:'client-export',id:c.id});
          const url=URL.createObjectURL(new Blob([JSON.stringify(r.binding)],{type:'application/json'})),a=document.createElement('a');
          a.href=url;a.download='Qoopia-'+c.surface+'.qoopia-connection';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          feedback.textContent=t('Open the downloaded file with Qoopia on your client’s computer. Review the address, add it, then authenticate in the client.','Откройте скачанный файл в Qoopia на компьютере с клиентом. Проверьте адрес, добавьте его и подтвердите доступ в клиенте.');
        }
      }catch(e){feedback.textContent=e.message;}finally{b.disabled=false;}});
      host.querySelectorAll('[data-client-auth]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{showResult(await call({action:'client-auth-start',id:b.dataset.clientAuth}));await refresh();}catch(e){feedback.textContent=e.message;}finally{b.disabled=false;}});
      host.querySelectorAll('[data-copy-connection]').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(result.connections.find(c=>c.id===b.dataset.copyConnection).mcp_url);feedback.textContent=t('Address copied.','Адрес скопирован.');}catch{feedback.textContent=t('Select and copy the address above.','Выделите и скопируйте адрес выше.');}});
      host.querySelectorAll('[data-copy-setup]').forEach(b=>b.onclick=async()=>{try{const c=result.connections.find(c=>c.id===b.dataset.copySetup);await navigator.clipboard.writeText(setupText(c));feedback.textContent=c.surface==='muse_code'?t('Config copied. Merge it into Muse Code user settings.','Конфиг скопирован. Добавьте его в пользовательские настройки Muse Code.'):t('Request copied. Send it to Grok Bot.','Запрос скопирован. Отправьте его Grok Bot.');}catch{feedback.textContent=t('Could not copy setup. Copy the address above and follow the instructions.','Не удалось скопировать настройку. Скопируйте адрес выше и следуйте инструкции.');}});
      host.querySelectorAll('[data-verify-connection]').forEach(b=>b.onclick=async()=>{try{const r=await call({action:'verify',id:b.dataset.verifyConnection});host.querySelector('[data-proof="'+b.dataset.verifyConnection+'"]').textContent=r.prompt;feedback.textContent=t('Run the prompt in the selected client within 10 minutes.','Выполните запрос в выбранном клиенте в течение 10 минут.');}catch(e){feedback.textContent=e.message;}});
      host.querySelectorAll('[data-revoke-connection]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await call({action:'disconnect',id:b.dataset.revokeConnection});await refresh();}catch(e){feedback.textContent=e.message;b.disabled=false;}});
    }
    host.querySelector('#setupApply').onclick=async e=>{e.target.disabled=true;try{
      const created=await call({action:'apply',...selection()});draft=null;try{sessionStorage.removeItem(draftKey);}catch{}
      await refresh();host.querySelector('#setupNew').open=false;
      const detail=host.querySelector('[data-connection="'+created.connection.id+'"]');if(detail){detail.open=true;detail.querySelector('summary').focus();}
      feedback.textContent=t('Connection prepared. Finish setup in the selected application.','Подключение подготовлено. Завершите настройку в выбранном приложении.');
    }catch(e){feedback.textContent=e.message;}finally{host.querySelector('#setupApply').disabled=false;}};
    host.querySelector('#setupRefresh').onclick=async()=>{try{await refresh(true);if(onRefresh)await onRefresh();}catch(e){feedback.textContent=e.message;}};await refresh();
    if(host.isConnected)pollFn=()=>refresh().catch(e=>{if(host.isConnected)feedback.textContent=e.message;});
  }

  async function renderConnections() {
    pollFn=null;setCrumb(QI.msg('Connections'));main.innerHTML='<p class="loading">'+QI.msg('Loading your connections…')+'</p>';
    let data;try{data=await api('/api/dashboard/connections');}catch(e){if(state.page==='connections')main.innerHTML='<p role="alert">'+esc(e.message)+'</p>';return;}
    if(state.page!=='connections')return;
    const t=(en,ru)=>QI.pair(en,ru),stewards=data.stewards.map(a=>a.name).join(', ');
    $('#workspaceName').textContent=data.workspace;
    const date=value=>new Date(value).toLocaleString(QI.language==='ru'?'ru-RU':'en-US',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const lastSeen=value=>value?t('Agent activity: ','Активность агента: ')+date(value):t('No requests recorded','Обращений пока нет');
    const modelStates={ready:t('Responding','Отвечает'),not_connected:t('Not selected','Не выбрана'),selected:t('Sign-in or check needed','Нужен вход или проверка'),auth_required:t('Sign in again','Нужно войти снова'),quota:t('Subscription limit reached','Достигнут лимит подписки'),timeout:t('Response timed out','Время ответа истекло'),unavailable:t('Unavailable','Недоступна'),invalid_response:t('Response could not be used','Не удалось обработать ответ'),busy:t('Working','Работает')};
    const active=data.clients.filter(c=>c.active_grants>0);
    const clientRow=c=>'<div class="connection-line"><strong>'+esc(c.name)+'</strong><div><span>'+t('Access granted','Доступ разрешён')+'</span><p class="meta">'+esc(lastSeen(c.last_seen))+'</p></div></div>';
    main.innerHTML='<section class="work connections"><header><h1>'+t('Connections','Подключения')+'</h1><p>'+esc(data.workspace)+'. '+t('See existing access or add an application.','Посмотрите действующие подключения или добавьте приложение.')+'</p></header><p id="connectionsStatus" class="work-status" role="status" aria-live="polite"></p><section class="connection-summary"><div class="connection-line"><div><h2>'+t('My Qoopia agent','Мой Qoopia агент')+'</h2><p id="connectionsStewardName">'+esc(stewards||t('Not assigned','Не назначен'))+'</p></div><button id="connectionsSteward">'+t('Open agent','Открыть агента')+'</button></div><div class="connection-line"><div><h2>'+t('Memory model','Модель памяти')+'</h2><p id="connectionsModelSummary"></p><p id="connectionsModelChecked" class="meta"></p>'+'</div><button id="connectionsModel">'+t('Settings','Настройки')+'</button></div></section><section aria-labelledby="applicationTitle"><h2 id="applicationTitle">'+t('Applications','Приложения')+'</h2>'+'<div id="connectedApplications">'+active.map(clientRow).join('')+'</div><div id="existingGrokBot"></div><div id="connectionWizard"></div></section><details class="connection-options"><summary id="connectionsAgentCount">'+t('Agents with access','Агенты с доступом')+' ('+(data.agents||[]).length+')</summary><p>'+t('An agent already using this memory does not need a new connection.','Агенту, который уже работает с этой памятью, новое подключение не нужно.')+'</p>'+'<div id="connectionAgentList">'+(data.agents||[]).map(a=>'<div class="connection-line"><strong>'+esc(a.name)+'</strong><span class="meta">'+esc(lastSeen(a.last_seen))+'</span></div>').join('')+'</div><button id="connectionsAgents">'+t('Open agents and notes','Открыть агентов и заметки')+'</button></details><details class="connection-options"><summary>'+t('Session memory settings','Настройки памяти сессий')+'</summary><p>'+t('Configure automatic context for a local agent. This is separate from its access to notes.','Настройте автоматическое сохранение контекста локального агента. Это отдельно от его доступа к заметкам.')+'</p><div class="work-actions"><button data-memory-client="claude_code">Claude Code</button><button data-memory-client="codex">Codex</button></div></details>'+'<details id="connectionPrevious" class="connection-options"><summary>'+t('Previous authorizations','Прежние авторизации')+'</summary><p>'+t('No current OAuth authorization. These records do not determine API-key access.','Действующей OAuth-авторизации нет. Эти записи не определяют доступ по ключу агента.')+'</p><div id="connectionPreviousList"></div></details>'+'</section>';
    function overview(next){
      $('#connectionsStewardName').textContent=next.stewards.map(a=>a.name).join(', ')||t('Not assigned','Не назначен');
      const model=next.memory_model||{state:'not_connected'};
      $('#connectionsModelSummary').textContent=(model.model==='claude-haiku-4-5'?'Claude · Haiku':model.model==='gpt-5.6-luna'?'ChatGPT · Luna':model.model||t('Optional','По желанию'))+' · '+(modelStates[model.state]||t('Check needed','Нужна проверка'));
      $('#connectionsModelChecked').textContent=model.checked_at?t('Last response check: ','Последняя проверка ответа: ')+date(model.checked_at):'';
      $('#connectedApplications').innerHTML=next.clients.filter(c=>c.active_grants>0).map(clientRow).join('');
      const grok=(next.agents||[]).find(a=>/^grok[\s_-]?bot$/i.test(a.name));
      $('#existingGrokBot').innerHTML=grok?'<div class="connection-line"><strong>'+esc(grok.name)+'</strong><div><span>'+t('Already connected as an agent. No new setup is needed.','Уже подключён как агент. Повторная настройка не нужна.')+'</span><p class="meta">'+esc(lastSeen(grok.last_seen))+'</p></div></div>':'';
      const inactive=next.clients.filter(c=>!c.active_grants);$('#connectionPrevious').hidden=!inactive.length;
      $('#connectionPreviousList').innerHTML=inactive.map(c=>'<p>'+esc(c.name)+' · '+esc(lastSeen(c.last_seen))+'</p>').join('');
      $('#connectionsAgentCount').textContent=t('Agents with access','Агенты с доступом')+' ('+(next.agents||[]).length+')';
      $('#connectionAgentList').innerHTML=(next.agents||[]).map(a=>'<div class="connection-line"><strong>'+esc(a.name)+'</strong><span class="meta">'+esc(lastSeen(a.last_seen))+'</span></div>').join('');
    }
    overview(data);
    void renderConnectionWizard($('#connectionWizard'),data.workspace,async()=>{const next=await api('/api/dashboard/connections');if(state.page==='connections')overview(next);}).catch(e=>{if(state.page==='connections')$('#connectionWizard').textContent=e.message;});
    if(state.page!=='connections')return;
    const status=$('#connectionsStatus');
    $('#connectionsSteward').onclick=()=>go('my-agent');$('#connectionsAgents').onclick=()=>go('agents');$('#connectionsModel').onclick=()=>go('work');
    main.querySelectorAll('[data-memory-client]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;status.textContent=QI.msg('Preparing your connection…');
      try {
        const result=await apiWrite('/api/dashboard/memory',{action:'connect-agent',runtime:button.dataset.memoryClient});
        if(result.state==='download_connection') {
          const url=URL.createObjectURL(new Blob([JSON.stringify(result.connection)],{type:'application/json'})),a=document.createElement('a');
          a.href=url;a.download='Qoopia-'+button.dataset.memoryClient+'.qoopia-memory';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          status.textContent=QI.msg('Open the downloaded file with Qoopia where your agent runs. It contains a private connection key; keep it on your own device.');
        }else status.textContent=result.next||QI.msg('Connection configured.');
      }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
    });
  }

  // ---------- Boot ----------
  async function boot() {
    state = { page: 'overview', drill: null }; tickClock();
    try{const r=await fetch(BASE+'/api/dashboard/profile',{credentials:'same-origin'});const p=r.ok?await r.json():null;serviceOwner=!!p?.service_owner;$('#ownerEmail').textContent=p?.email||'';$('#ownerEmail').hidden=!p?.email;}catch{serviceOwner=false;$('#ownerEmail').hidden=true;}
    $('#workspaceHost').textContent=location.host;
    try {
      const response=await fetch(BASE+'/api/dashboard/memory',{credentials:'same-origin'});
      localWorkspace=response.ok?await response.json():null;
      $('#workspaceName').textContent=localWorkspace?(QI.msg("Owner workspace")):(QI.msg("Agent view"));
    }catch{localWorkspace=null;}
    chat?.dispose();chat=localWorkspace?window.QoopiaChat({api,esc,humanSize,onUnauthorized:showLogin}):null;
    state.page=pageFromHash();
    route();
  }

  $('#uiReload').onclick=()=>location.reload();
  async function checkInterfaceVersion() {
    if(document.hidden)return;
    try {const r=await fetch(BASE+'/dashboard',{method:'HEAD',cache:'no-store'}),version=r.headers.get('x-qoopia-dashboard-version');
      if(version&&version!==document.querySelector('meta[name="qoopia-dashboard-version"]').content)$('#uiUpdate').hidden=false;
    }catch{}
  }
  setInterval(checkInterfaceVersion,60000);
  document.addEventListener('visibilitychange',checkInterfaceVersion);

  // ---------- Scroll to top ----------
  (function () {
    var btn = document.getElementById('toTopBtn');
    if (!btn) return;
    var sync = function () { btn.classList.toggle('show', window.scrollY > 500); };
    window.addEventListener('scroll', sync, { passive: true });
    btn.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); };
    sync();
  })();

  (async()=>{
    let identity=null;
    try{
      if(setupCode)await identityPost('setup',{code:setupCode});
      const r=await fetch(BASE+'/api/dashboard/identity',{credentials:'same-origin',signal:AbortSignal.timeout(15000)});
      if(r.ok){identity=await r.json();$('#emailLogin').hidden=false;}
    }catch(e){loginError(e);}
    const r=await fetch(BASE+'/api/dashboard/agents',{credentials:'same-origin',signal:AbortSignal.timeout(15000)});
    // An authenticated dashboard session is valid without an email binding (local owner login).
    if(r.ok){finishAccountSignIn();if(consumeSafeNext())return;showApp();boot();}
    else{
      showLogin();$('#accountLoginBtn').hidden=!identity?.linked||!accountSignIn;
      if(accountSignIn==='complete'&&accountCode){$('#loginView').classList.add('account-connecting');await awaitEmailConfirmation(null,false,accountCode);}
      else if(['account','complete'].includes(accountSignIn)&&identity?.linked)await startAccountLogin();
      else if(identity?.pending)await awaitEmailConfirmation();
    }
  })().catch(e=>{showLogin();loginError(e);});
})();
