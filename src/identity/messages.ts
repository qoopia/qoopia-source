const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export type LoginLanguage='en'|'ru';
export const loginLanguage=(value:unknown):LoginLanguage=>value==='ru'?'ru':'en';

/** One transactional template for every sign-in entry point; no remote images. */
export function confirmationMail(link:string,language:LoginLanguage) {
  const t=(en:string,ru:string)=>language==='ru'?ru:en;
  const title=t('Confirm your sign-in to Qoopia','Подтвердите вход в Qoopia');
  const intro=t('Continue only if you requested this sign-in.','Продолжайте, только если вы запрашивали этот вход.');
  const action=t('Confirm sign-in','Подтвердить вход');
  const expiry=t('This link works once, for 10 minutes. If you did not request it, ignore this email.','Ссылка действует один раз в течение 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.');
  const next=t('After confirming, return to the Qoopia page where you started. Your memory stays in your installation.','После подтверждения вернитесь на страницу Qoopia, где начали вход. Ваша память остаётся в вашей установке.');
  const fallback=t('If the button does not work, copy this entire link into your browser:','Если кнопка не работает, скопируйте эту ссылку целиком в браузер:');
  return {subject:title,text:`${title}: ${link}\n\n${intro}\n\n${expiry}\n\n${next}`,
    html:`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head><body style="margin:0;background:#0B0A09;color:#FFFFFF"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0B0A09"><tr><td style="padding:40px 24px"><div style="max-width:480px;margin:auto;font:17px/1.5 'IBM Plex Sans',Arial,sans-serif"><img src="cid:qoopia-brand" width="240" height="80" alt="Qoopia" style="display:block;max-width:100%;height:auto;border:0;margin:0 0 40px"><h1 style="font-size:32px;line-height:1.2;font-weight:500;color:#FFFFFF">${title}</h1><p style="color:#B7B1A6">${intro}</p><p><a href="${escape(link)}" style="display:inline-block;background:#FFFFFF;color:#0B0A09;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:500">${action}</a></p><p style="color:#B7B1A6">${expiry}</p><p style="color:#B7B1A6">${next}</p><p style="color:#B7B1A6;font-size:14px">${fallback}<br><a href="${escape(link)}" style="color:#FFFFFF;word-break:break-all">${escape(link)}</a></p></div></td></tr></table></body></html>`};
}

export function confirmationView(language:LoginLanguage) {
  const t=(en:string,ru:string)=>language==='ru'?ru:en;
  const messages={busy:t('Confirming…','Подтверждаем…'),done:t('Sign-in confirmed. Return to the Qoopia page where you started.','Вход подтверждён. Вернитесь на страницу Qoopia, где начали вход.'),missing:t('Open the complete link from your email. If you already confirmed it, return to the Qoopia page where you started. Otherwise, request a new sign-in link there.','Откройте полную ссылку из письма. Если вы уже подтвердили вход, вернитесь на страницу Qoopia, где начали вход. Иначе запросите там новую ссылку.'),expired:t('This link expired or was already used. Return to the Qoopia page where you started and request a new link if needed.','Ссылка истекла или уже использована. Вернитесь на страницу Qoopia, где начали вход, и при необходимости запросите новую ссылку.'),failed:t('Could not confirm the sign-in. Check your connection and try again.','Не удалось подтвердить вход. Проверьте подключение и попробуйте ещё раз.'),limited:t('Too many attempts. Wait a minute, then try again.','Слишком много попыток. Подождите минуту и попробуйте ещё раз.')};
  return {title:t('Confirm your sign-in','Подтвердите вход'),content:`<p>${t('Only continue if you requested a Qoopia sign-in.','Продолжайте, только если вы запрашивали вход в Qoopia.')}</p><button id="confirm">${t('Confirm sign-in','Подтвердить вход')}</button><p id="status" role="status" aria-live="polite"></p>`,script:`
    const M=${JSON.stringify(messages)};let token='';
    const button=document.querySelector('#confirm'),status=document.querySelector('#status'),label=button.textContent;
    function readLink(){token=location.hash.slice(1);history.replaceState(null,'',location.pathname+location.search);button.hidden=!/^[A-Za-z0-9_-]{43}$/.test(token);status.textContent=button.hidden?M.missing:'';}
    readLink();addEventListener('hashchange',()=>{if(location.hash&&!button.disabled)readLink();});
    button.onclick=async()=>{button.disabled=true;button.textContent=M.busy;status.textContent=M.busy;try{
      const r=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(20000)});
      if(!r.ok){status.textContent=r.status===429?M.limited:r.status>=500?M.failed:M.expired;if(r.status<429)button.hidden=true;return;}
      status.textContent=M.done;button.hidden=true;
    }catch{status.textContent=M.failed;}finally{button.disabled=false;button.textContent=label;}};`};
}
