import { escapeHtml as escape } from '../utils/html.ts';
type Page=(title:string,content:string,script?:string,status?:number,language?:'en'|'ru')=>Response;

/** Confirmation of a sign-in started by another installation. Anti-phishing: the page names the requesting
 * installation, its network and time, says who must have started it, and needs an explicit click. */
export function deviceView(page:Page,ru:boolean,email:string,code:string) {
  const t=(en:string,ruText:string)=>ru?ruText:en,lang=ru?'ru':'en';
  const content=`<section class="q-profile">
    <p>${t('Enter the code shown by your Qoopia installation (for example by qoopia connections, or on its sign-in page).','Введите код, который показала ваша установка Qoopia (например, команда qoopia connections или её страница входа).')}</p>
    <p class="info warn"><strong>${t('Continue only if you started this sign-in yourself, just now, on your own computer or server.','Продолжайте, только если вы сами только что начали этот вход на своём компьютере или сервере.')}</strong> ${t('Qoopia never asks for this code by email, chat or phone. Whoever holds an approved code gets access to this account’s installation sign-in.','Qoopia никогда не просит этот код по почте, в чате или по телефону. Тот, у кого одобренный код, получает вход в установку от имени этого аккаунта.')}</p>
    <form id="device-form"><label for="device-code">${t('Code','Код')}</label><input id="device-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" required value="${escape(code)}" placeholder="XXXX-XXXX"><div class="actions"><button type="submit">${t('Continue','Продолжить')}</button></div></form>
    <div id="device-review" hidden><h2>${t('Authorize this installation?','Разрешить вход этой установке?')}</h2><dl>
      <dt>${t('Installation (name it reported)','Установка (название, которое она сообщила)')}</dt><dd id="device-label"></dd>
      <dt>${t('Requested from network','Запрос из сети')}</dt><dd id="device-network"></dd>
      <dt>${t('Requested at','Время запроса')}</dt><dd id="device-time"></dd>
      <dt>${t('Grants','Даёт')}</dt><dd id="device-grants"></dd>
      <dt>${t('Signs in as','Войдёт как')}</dt><dd><!--email_off-->${escape(email)}<!--/email_off--></dd></dl>
      <div class="actions"><button type="button" class="deny" id="device-deny">${t('Deny','Отклонить')}</button><button type="button" id="device-approve">${t('Authorize this installation','Разрешить этой установке')}</button></div></div>
    <p id="device-status" role="status" aria-live="polite" tabindex="-1"></p>
  </section>`;
  const M={expired:t('This code is wrong, expired or already used. Start the sign-in again on your installation.','Код неверный, истёк или уже использован. Начните вход заново на своей установке.'),
    limit:t('Too many attempts. Please try again later.','Слишком много попыток. Попробуйте позже.'),failed:t('Could not complete the action. Please try again.','Не удалось выполнить действие. Попробуйте ещё раз.'),
    approved:t('Authorized. Return to your installation; it continues by itself.','Разрешено. Вернитесь к установке — она продолжит сама.'),denied:t('Denied. The installation will not be signed in.','Отклонено. Установка не получит вход.'),
    unknown:t('unknown','неизвестно'),signIn:t('Sign-in to this installation as this account.','Вход в эту установку от имени этого аккаунта.'),
    addsDevice:t('External access: adds this installation as a device of this account. A device of the account can list and disconnect the account’s other devices.','Внешний доступ: добавляет эту установку как устройство этого аккаунта. Устройство аккаунта может видеть и отключать другие его устройства.')};
  return page(t('Connect an installation','Подключение установки'),content,`
    const M=${JSON.stringify(M)},status=document.querySelector('#device-status'),review=document.querySelector('#device-review');let code='';
    async function post(path,body){const r=await fetch('/profile/device/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const d=await r.json();if(!r.ok)throw new Error(r.status===429?M.limit:r.status===410?M.expired:M.failed);return d;}
    const show=m=>{status.textContent=m;status.focus();};
    document.querySelector('#device-form').onsubmit=async e=>{e.preventDefault();review.hidden=true;code=document.querySelector('#device-code').value.trim();
      try{const d=await post('lookup',{code});document.querySelector('#device-label').textContent=d.label;document.querySelector('#device-network').textContent=d.network||M.unknown;document.querySelector('#device-grants').textContent=d.adds_device?M.addsDevice:M.signIn;
        document.querySelector('#device-time').textContent=new Date(d.requested_at).toLocaleString(${JSON.stringify(lang)});review.hidden=false;status.textContent='';document.querySelector('#device-approve').focus();}catch(e){show(e.message);}};
    for(const [id,path,done] of [['device-approve','approve',M.approved],['device-deny','deny',M.denied]])document.getElementById(id).onclick=async()=>{
      try{await post(path,{code});review.hidden=true;document.querySelector('#device-form').hidden=true;show(done);}catch(e){show(e.message);}};
  `,200,lang);
}
