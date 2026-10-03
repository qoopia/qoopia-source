import {escapeHtml as escape} from '../utils/html.ts';
export type LoginLanguage='en'|'ru';
export const loginLanguage=(value:unknown):LoginLanguage=>value==='ru'?'ru':'en';

/** One transactional template for every sign-in entry point; no remote images. */
export function confirmationMail(link:string,language:LoginLanguage) {
  const t=(en:string,ru:string)=>language==='ru'?ru:en;
  const title=t('Confirm your sign-in to Qoopia','Подтвердите вход в Qoopia');
  const intro=t('Continue only if you requested this sign-in.','Продолжайте, только если вы запрашивали этот вход.');
  const action=t('Sign in to Qoopia','Войти в Qoopia');
  const expiry=t('This link works once, for 10 minutes. If you did not request it, ignore this email.','Ссылка действует один раз в течение 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.');
  const next=t('Open it on the device where you started; Qoopia then opens by itself. Your memory stays in your installation.','Откройте её на том же устройстве, где начали вход, — Qoopia откроется сам. Ваша память остаётся в вашей установке.');
  const fallback=t('If the button does not work, copy this entire link into your browser:','Если кнопка не работает, скопируйте эту ссылку целиком в браузер:');
  return {subject:title,text:`${title}: ${link}\n\n${intro}\n\n${expiry}\n\n${next}`,
    html:`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head><body style="margin:0;background:#111110;color:#F2EFE9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#111110"><tr><td style="padding:40px 24px"><div style="max-width:480px;margin:auto;font:16px/1.6 'Manrope',Arial,sans-serif"><img src="cid:qoopia-brand" width="200" height="50" alt="qoopia" style="display:block;max-width:100%;height:auto;border:0;margin:0 0 40px"><h1 style="font-size:28px;line-height:1.25;font-weight:500;letter-spacing:-.02em;color:#F2EFE9">${title}</h1><p style="color:#C3BDB4">${intro}</p><p><a href="${escape(link)}" style="display:inline-block;background:#F2EFE9;color:#111110;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:500">${action}</a></p><p style="color:#C3BDB4">${expiry}</p><p style="color:#C3BDB4">${next}</p><p style="color:#C3BDB4;font-size:14px">${fallback}<br><a href="${escape(link)}" style="color:#F2EFE9;word-break:break-all">${escape(link)}</a></p></div></td></tr></table></body></html>`};
}

/** The email link page. A network-bound sign-in (`auto`) confirms by itself on the device where it
 * started; a code-bound one from clients up to 5.0.15 (F-125) still asks for the code shown there. */
export function confirmationView(language:LoginLanguage,bound=false,auto=false) {
  const t=(en:string,ru:string)=>language==='ru'?ru:en;
  const messages={busy:t('Signing you in…','Входим…'),done:t('Done. Return to Qoopia — it opens by itself. You can close this tab.','Готово. Вернитесь в Qoopia — он откроется сам. Эту вкладку можно закрыть.'),
    device:t('Open this link on the device where you started signing in to Qoopia.','Откройте эту ссылку на том же устройстве, где начали вход в Qoopia.'),missing:t('Open the complete link from your email. If you already confirmed it, return to the Qoopia page where you started. Otherwise, request a new sign-in link there.','Откройте полную ссылку из письма. Если вы уже подтвердили вход, вернитесь на страницу Qoopia, где начали вход. Иначе запросите там новую ссылку.'),expired:t('This link expired or was already used. Return to the Qoopia page where you started and request a new link if needed.','Ссылка истекла или уже использована. Вернитесь на страницу Qoopia, где начали вход, и при необходимости запросите новую ссылку.'),failed:t('Could not confirm the sign-in. Check your connection and try again.','Не удалось подтвердить вход. Проверьте подключение и попробуйте ещё раз.'),limited:t('Too many attempts. Wait a minute, then try again.','Слишком много попыток. Подождите минуту и попробуйте ещё раз.'),mismatch:t('This code does not match. Enter the code shown on the Qoopia page where you started. After five wrong codes, start the sign-in again.','Код не совпадает. Введите код со страницы Qoopia, где вы начали вход. После пяти неверных кодов начните вход заново.')};
  const code=bound?`<label for="code">${t('Code shown on the Qoopia page where you started','Код со страницы Qoopia, где вы начали вход')}</label><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><p>${t('If you did not start this sign-in yourself, do not enter a code someone sent you.','Если вы не начинали этот вход сами, не вводите код, который вам прислали.')}</p>`:'';
  return {title:auto?t('Signing in to Qoopia','Вход в Qoopia'):t('Confirm your sign-in','Подтвердите вход'),content:`${auto?'':`<p>${t('Only continue if you requested a Qoopia sign-in.','Продолжайте, только если вы запрашивали вход в Qoopia.')}</p>`}${code}<button id="confirm"${auto?' hidden':''}>${t('Confirm sign-in','Подтвердить вход')}</button><p id="status" role="status" aria-live="polite"></p>`,script:`
    const M=${JSON.stringify(messages)};let token='';
    const button=document.querySelector('#confirm'),status=document.querySelector('#status'),label=button.textContent;
    function readLink(){token=location.hash.slice(1);history.replaceState(null,'',location.pathname+location.search);button.hidden=!/^[A-Za-z0-9_-]{43}$/.test(token);status.textContent=button.hidden?M.missing:'';}
    readLink();addEventListener('hashchange',()=>{if(location.hash&&!button.disabled)readLink();});
    const code=document.querySelector('#code');
    button.onclick=async()=>{if(code&&!code.reportValidity())return;button.disabled=true;button.textContent=M.busy;status.textContent=M.busy;try{
      const r=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(code?{token,code:code.value.trim()}:{token}),signal:AbortSignal.timeout(20000)});
      if(!r.ok){const e=r.status===400?await r.json().catch(()=>({})):{};if(e.code_required){status.textContent=M.mismatch;return;}if(e.same_device){status.textContent=M.device;button.hidden=true;return;}
        status.textContent=r.status===429?M.limited:r.status>=500?M.failed:M.expired;if(r.status<429)button.hidden=true;return;}
      status.textContent=M.done;button.hidden=true;setTimeout(()=>window.close(),1500);
    }catch{status.textContent=M.failed;button.hidden=false;}finally{button.disabled=false;button.textContent=label;}};
    if(${auto}&&!button.hidden)button.click();`};
}

/** After Google, in the browser where it finished: nothing to confirm, the starting page continues. */
export function finishedView(language:LoginLanguage,done:boolean) {
  const t=(en:string,ru:string)=>language==='ru'?ru:en;
  return done?{title:t('You are signed in','Вход выполнен'),content:`<p>${t('Return to Qoopia — it opens by itself. You can close this tab.','Вернитесь в Qoopia — он откроется сам. Эту вкладку можно закрыть.')}</p>`,script:'setTimeout(()=>window.close(),1500);'}
    :{title:t('Finish on your own device','Завершите вход на своём устройстве'),content:`<p>${t('This sign-in was started on another device. Start it again on the device you use and choose your Google account there.','Этот вход был начат на другом устройстве. Начните вход на том устройстве, которым пользуетесь, и выберите аккаунт Google там же.')}</p>`,script:''};
}

/** The one email a new account receives after its first sign-in: no link, nothing to confirm. */
export function welcomeMail(language:LoginLanguage) {
  const t=(en:string,ru:string)=>language==='ru'?ru:en;
  const title=t('Welcome to Qoopia','Добро пожаловать в Qoopia');
  const body=t('You are signed in. Your agents share one memory, and it stays in your own installation.','Вы вошли в Qoopia. Ваши агенты работают с общей памятью, и она остаётся в вашей установке.');
  const next=t('You stay signed in on this device; nothing else is needed.','На этом устройстве вы остаётесь в системе — больше ничего делать не нужно.');
  return {subject:title,text:`${title}\n\n${body}\n\n${next}`,
    html:`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head><body style="margin:0;background:#111110;color:#F2EFE9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#111110"><tr><td style="padding:40px 24px"><div style="max-width:480px;margin:auto;font:16px/1.6 'Manrope',Arial,sans-serif"><img src="cid:qoopia-brand" width="200" height="50" alt="qoopia" style="display:block;max-width:100%;height:auto;border:0;margin:0 0 40px"><h1 style="font-size:28px;line-height:1.25;font-weight:500;letter-spacing:-.02em;color:#F2EFE9">${title}</h1><p style="color:#C3BDB4">${body}</p><p style="color:#C3BDB4">${next}</p></div></td></tr></table></body></html>`};
}
