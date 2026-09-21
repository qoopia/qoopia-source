import {mobileDashboard} from './account-handoff.ts';

type Page=(title:string,content:string,script?:string,status?:number,language?:'en'|'ru')=>Response;
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** App entry is a sign-in step, not the website's account-management page. */
export function appProfileView(page:Page,ru:boolean,account:{email:string;url:string|null}|null,pending:boolean,requestId:string|null) {
  const t=(en:string,ruText:string)=>ru?ruText:en,lang=ru?'ru':'en';
  const dashboard=mobileDashboard(account?.url);
  const messages={google:t('Choose your Google account, then confirm the email from Qoopia.','Выберите аккаунт Google, затем подтвердите письмо от Qoopia.'),sent:t('Open the latest email, tap Confirm sign-in on the page, then return here.','Откройте последнее письмо, нажмите «Подтвердить вход» на странице и вернитесь сюда.'),checking:t('Checking your confirmation…','Проверяем подтверждение…'),unconfirmed:t('This sign-in is not confirmed yet. Open the latest email and tap Confirm sign-in on its page.','Этот вход ещё не подтверждён. Откройте последнее письмо и нажмите «Подтвердить вход» на странице.'),network:t('Could not check your sign-in. Check your connection, then try again.','Не удалось проверить вход. Проверьте соединение и повторите попытку.'),waiting:t('Opening your dashboard…','Открываем ваш дашборд…'),failed:t('Could not sign in. Try again.','Не удалось войти. Попробуйте ещё раз.'),expired:t('This sign-in expired. Request a new link.','Время входа истекло. Запросите новую ссылку.'),address:t('Use the HTTPS dashboard address reachable from this iPhone.','Укажите HTTPS-адрес дашборда, доступный с этого iPhone.')};
  const content=`<section class="q-profile q-app-entry">
    <p id="app-status" role="status" aria-live="polite">${account&&(requestId||dashboard)?messages.waiting:pending?messages.sent:''}</p>
    ${!account?`<p>${t('Use the email linked to your Qoopia.','Используйте почту, связанную с вашей Qoopia.')}</p>
      <form id="app-signin" ${pending?'hidden':''}><label for="email">${t('Email address','Электронная почта')}</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"><button class="profile-primary">${t('Continue','Продолжить')}</button></form>
      <button class="deny profile-primary" id="app-google" ${pending?'hidden':''}>${t('Continue with Google','Продолжить с Google')}</button>
      <a id="app-google-link" class="btn profile-primary" hidden target="_blank" rel="noopener">${t('Choose Google account','Выбрать аккаунт Google')}</a>
      <button class="deny profile-primary" id="app-check" ${pending?'':'hidden'}>${t('I confirmed my email','Я подтвердил почту')}</button>
      <button class="deny profile-primary" id="app-restart" ${pending?'':'hidden'}>${t('Start a new sign-in','Начать вход заново')}</button>`:
    !requestId&&!dashboard?`<p>${t('Your email is confirmed. Connect the Qoopia you already use on your computer or server.','Почта подтверждена. Подключите Qoopia, которой уже пользуетесь на компьютере или сервере.')}</p>
      <form id="app-workspace"><label for="dashboard-url">${t('Dashboard address','Адрес дашборда')}</label><input id="dashboard-url" type="url" inputmode="url" required placeholder="https://your-server.example/dashboard"><button class="profile-primary">${t('Open my dashboard','Открыть мой дашборд')}</button></form>
      <p class="profile-small">${t('Copy its HTTPS address from Qoopia on your computer. The computer or server must be online.','Скопируйте HTTPS-адрес из Qoopia на компьютере. Компьютер или сервер должен быть включён.')}</p>`:''}
    <a id="app-recover" hidden href="/profile?app=ios">${t('Return to sign-in','Вернуться ко входу')}</a>
    <footer class="profile-footer"><a href="/privacy">${t('Privacy','Конфиденциальность')}</a><a href="/profile?app=ios&lang=${ru?'en':'ru'}${requestId?'&request='+escape(requestId):''}">${ru?'English':'Русский'}</a></footer>
  </section>`;
  return page(account?t('Your Qoopia','Ваша Qoopia'):t('Sign in to Qoopia','Вход в Qoopia'),content,`
    const M=${JSON.stringify(messages)},status=document.querySelector('#app-status');let timer,polling=false,starting=false,deadline=Date.now()+600000,pending=${pending};
    async function post(path,body={}){const r=await fetch('/profile/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const d=await r.json();if(!r.ok)throw new Error(r.status===410?M.expired:M.failed);return d;}
    const failed=e=>{status.textContent=Object.values(M).includes(e.message)?e.message:M.failed;};
    const form=document.querySelector('#app-signin'),google=document.querySelector('#app-google'),check=document.querySelector('#app-check'),restart=document.querySelector('#app-restart');
    async function poll(manual=false){if(polling||!pending)return;clearTimeout(timer);polling=true;check.disabled=true;if(manual)status.textContent=M.checking;try{const d=await post('poll');if(d.ok){location.reload();return;}if(manual)status.textContent=M.unconfirmed;if(Date.now()<deadline)timer=setTimeout(()=>poll(),2500);else{pending=false;status.textContent=M.expired;}}catch(e){status.textContent=e.message===M.expired?M.expired:M.network;}finally{polling=false;check.disabled=false;}}
    async function start(method){if(starting||method==='email'&&!form.reportValidity())return;starting=true;clearTimeout(timer);form.querySelector('button').disabled=true;google.disabled=true;try{const d=await post('start',{method,email:document.querySelector('#email').value.trim(),language:'${lang}'});const link=document.querySelector('#app-google-link');link.hidden=!d.google_url;if(d.google_url)link.href=d.google_url;status.textContent=d.google_url?M.google:M.sent;form.hidden=true;google.hidden=true;check.hidden=false;restart.hidden=false;pending=true;deadline=Date.now()+600000;timer=setTimeout(()=>poll(),2500);}catch(e){failed(e);}finally{starting=false;form.querySelector('button').disabled=false;google.disabled=false;}}
    if(form){form.onsubmit=e=>{e.preventDefault();start('email');};google.onclick=()=>start('google');check.onclick=()=>poll(true);restart.onclick=()=>{clearTimeout(timer);pending=false;form.hidden=false;google.hidden=false;check.hidden=true;restart.hidden=true;document.querySelector('#app-google-link').hidden=true;status.textContent='';document.querySelector('#email').focus();};if(pending)poll();}
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});addEventListener('pageshow',()=>poll());addEventListener('pagehide',()=>clearTimeout(timer));
    const workspace=document.querySelector('#app-workspace');if(workspace)workspace.onsubmit=async e=>{e.preventDefault();const button=workspace.querySelector('button');button.disabled=true;try{await post('dashboard',{url:document.querySelector('#dashboard-url').value.trim(),mobile:true});location.reload();}catch(e){status.textContent=M.address;}finally{button.disabled=false;}};
    ${account&&requestId?`post('authorize',{request:${JSON.stringify(requestId)}}).then(d=>location.replace(d.url)).catch(e=>{failed(e);document.querySelector('#app-recover').hidden=false;});`:
      account&&dashboard?`location.replace(${JSON.stringify(dashboard+'?signin=account')});`:''}
  `,200,lang);
}
