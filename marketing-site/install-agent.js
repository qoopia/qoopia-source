/* Versioned, inspectable tasks. No credentials or user identifiers enter prompts. */
(() => {
 'use strict';
 const client=document.querySelector('#install-client');
 if(!client)return;
 const prompt=document.querySelector('#install-prompt'),copy=document.querySelector('#install-copy');
 const status=document.querySelector('#install-release-status'),feedback=document.querySelector('#install-copy-status');
 const preview=document.querySelector('#install-preview');
 const releases={};let revision=0;
 const say=(en,ru)=>QI.language==='ru'?ru:en;
 function validate(r){
  if(!/^[0-9a-f]{40}$/.test(r.source)||!/^v[\w.-]+$/.test(r.tag))throw Error('Invalid release');
  const packages=[r.packages?.mac,r.packages?.linux];
  for(const pkg of packages){
   if(!pkg||!/^[0-9a-f]{64}$/.test(pkg.sha256))throw Error('Invalid checksum');
   const url=new URL(pkg.url);
   if(url.origin!=='https://github.com'||url.search||url.hash||!url.pathname.startsWith('/qoopia/qoopia-downloads/releases/download/'+r.tag+'/'))throw Error('Invalid artifact URL');
  }
  return {source:r.source,tag:r.tag,packages};
 }
 function task(r){
  const name=client.value==='codex'?'Codex':'Claude Code';
  const labels=QI.language==='ru'?['Mac · Apple Silicon','Linux · x64']:['Mac · Apple Silicon','Linux · x64'];
  const artifacts=r.packages.map((p,i)=>labels[i]+':\n'+p.url+'\nSHA-256: '+p.sha256).join('\n\n');
  const release='https://github.com/qoopia/qoopia-downloads/releases/tag/'+r.tag;
  const publisherKey='publisher-public-key.pem';
  const trust='Developer ID Application: Askhat Soltanov (TW25T8SUKH)';
  if(QI.language==='ru')return `Установи Qoopia V1 на этот компьютер и подключи ${name} к моей собственной локальной памяти. Доведи работу до реального проверенного подключения. Для входа и согласия дай мне конкретное действие и продолжи после него.

Разрешаю установить официальный пакет, запустить Qoopia, создать мою собственную установку, добавить отдельное подключение ${name} с чтением и добавлением записей, сохранив другие настройки и их резервные копии. Разрешаю одну небольшую синтетическую заметку для проверки. Дополнительные клиенты, серверы, внешний доступ, память сессий, модель по подписке и автозапуск включай по моему отдельному выбору.

Сначала определи ОС, архитектуру и реальный профиль клиента без чтения секретов. Если Qoopia уже установлена, не заменяй базу и не переключай пространство: проверь текущее состояние и предложи конкретный следующий шаг. Облачная сессия без доступа к этому компьютеру не может выполнить локальную установку.

Поставка: ${release}
Исходный коммит: ${r.source}
Mac требует Apple Silicon и macOS 15+.
Linux требует x64 и glibc 2.34+. Windows и Intel Mac не поддерживаются.

${artifacts}

До запуска сверь SHA-256 и подпись. Mac: проверь подпись приложения и штатное принятие Gatekeeper; издатель ${trust}. Linux: проверь manifest.sig и инвентарь по инструкции пакета. Публичный ключ ${publisherKey} находится в том же релизе, его SHA-256: 542bd3715cfbc89fbb2df47b8c40f4964e340993f316f0c32866a2972965e33b. При несовпадении остановись; не отключай защиту и не удаляй quarantine.

Открой Qoopia штатно (Mac: Applications; Linux: ./qoopia open из распакованного пакета). Мне предстоит вход через Google/email. Пароли, коды и согласие я ввожу в предназначенном интерфейсе, не в чате. Не подключай чужую память и не клонируй приватный репозиторий.

Используй connections-agent.md и connections-guide-ru.html из проверенного пакета, help установленной версии и https://qoopia.ai/docs.html#connect. В Connections выбери ${name}, подготовь настройку, примени её и заверши отдельную OAuth-авторизацию. Если работаешь через CLI, используй plan/apply/status/resume с одним request_key при повторах. ${client.value==='codex'?'Для OAuth Codex используй codex mcp login с фактическим именем созданного подключения.':'В Claude Code авторизуй подготовленное подключение через /mcp.'}

Если я выберу встроенный чат, открой «Мой Qoopia агент» и предложи выбрать ChatGPT/Codex или Claude/Claude Code и общение в Qoopia или Telegram. Сохрани существующего стюарда, если он уже назначен; не создавай второго ради обхода настройки. Для Telegram токен бота вводится в защищённом поле дашборда, не в сообщениях.

Спросить один раз о дополнительных возможностях допустимо. Если я выберу память сессий, отдельно подключи её в «Память сессий локальных агентов» и объясни сохранение видимых событий; Codex требует /hooks trust review. Файл .qoopia-memory содержит секретный ключ и отличается от OAuth-файла .qoopia-connection. Не выводи их содержимое. Если я выберу модель памяти, используй Memory → моя выбранная подписка → официальный вход → Check connection; лимиты подписки сохраняются, API fallback и покупки не разрешены.

Проверь из настоящего ${name}: одноразовый verification prompt выбранного подключения, создание тестовой заметки, чтение по ID и поиск. Не подменяй вызов пересказом из чата, прямым HTTP или другим connector. Если включены hooks, проверь новую тестовую сессию и восстановление контекста в следующей. Если включена модель, отдельно проверь реальный вызов по подписке. Настроенный конфиг или сохранённый токен не означает успех.

Если нужен перезапуск клиента или действие в недоступном тебе интерфейсе, подготовь точный шаг для меня. Не закрывай несохранённую работу. Не обходи блокировки, не меняй verified вручную, не читай личные заметки/письма и не выводи секреты. При прерывании продолжай существующую настройку.

В конце сообщи версию, местонахождение моей памяти и адрес дашборда, клиент/профиль, результаты MCP/hooks/модели по отдельности (PASS, FAIL, NOT_TESTED или BLOCKED), резервную копию настроек, как отключить доступ и что ещё нужно от меня. Установку не называй завершённой без реального вызова из клиента.`;
  return `Install Qoopia V1 on this computer and connect ${name} to my own local memory. Complete the setup and verify real client calls. Give me a specific action when sign-in or consent requires me, then continue afterward.

I authorize installing and launching the official package, creating my own installation, adding a separate ${name} connection with read-and-add access while preserving other settings and private backups, and creating one harmless synthetic test note. Enable additional clients, servers, external access, session capture, a subscription model or login autostart only if I separately choose them.

Check OS, architecture and the actual client profile without reading secrets. If Qoopia already exists, preserve its database and selected workspace, inspect its state and propose a concrete next step. A cloud session without access to this computer cannot install locally.

Release: ${release}
Source: ${r.source}
Mac requires Apple Silicon and macOS 15+.
Linux requires x64 and glibc 2.34+. Windows and Intel Macs are unsupported.

${artifacts}

Before execution, verify SHA-256 and the signature. Mac: verify the application signature and normal Gatekeeper acceptance; publisher ${trust}. Linux: verify manifest.sig and the inventory using the package instructions. ${publisherKey} is in the same release; its SHA-256 is 542bd3715cfbc89fbb2df47b8c40f4964e340993f316f0c32866a2972965e33b. Stop on a mismatch; do not disable protections or remove quarantine.

Open Qoopia normally (Mac: Applications; Linux: ./qoopia open from the extracted package). Hand Google/email sign-in to me. I enter passwords, codes and consent in their intended interfaces, never in chat. Do not connect someone else's memory or clone a private repository.

Use connections-agent.md and connections-guide-en.html in the verified package, its installed help and https://qoopia.ai/docs.html#connect. In Connections select ${name}, prepare and apply its configuration, then complete separate OAuth consent. For CLI operations use plan/apply/status/resume, preserving the request_key on retries. ${client.value==='codex'?'Use codex mcp login with the actual prepared server name.':'Authenticate the prepared connection through /mcp in Claude Code.'}

If I choose the built-in chat, open My Qoopia agent and let me choose ChatGPT/Codex or Claude/Claude Code and the Qoopia or Telegram channel. Preserve an existing steward; do not create a second one to work around setup. Enter a Telegram bot token in the protected dashboard field, never in messages.

You may ask once about optional features. If I choose session continuity, enable it separately in Native session continuity, explaining that visible session events are captured; Codex needs a /hooks trust review. A .qoopia-memory file contains a secret and differs from a .qoopia-connection OAuth binding. Do not print their contents. If I choose a memory model, use Memory → my selected subscription → official sign-in → Check connection. Subscription limits still apply; API fallback and purchases are not authorized.

From the real ${name} client run the prepared one-use verification prompt, create the test note, retrieve its ID and search for it. Do not substitute text recalled from this chat, direct HTTP or another connector. If hooks are enabled, verify a fresh test session and restoration in a subsequent session. If a model is enabled, separately verify an actual subscription model call. A saved configuration or token is not proof of success.

If a client restart or an interface you cannot operate needs me, provide the exact next step. Preserve unsaved work. Do not bypass client blocks, forge verification, read personal notes/mail or expose secrets. Resume existing setup after interruptions.

Report the version, memory location and dashboard URL, client/profile, separate MCP/hooks/model results (PASS, FAIL, NOT_TESTED or BLOCKED), settings backup, how to revoke access and any remaining human action. Do not call installation complete without a real client call.`;
 }
 async function render(){
  const current=++revision,key='stable';
  copy.disabled=true;prompt.value='';feedback.textContent='';
  status.textContent=say('Loading the installation task…','Загружаем задание на установку…');
  try{
   if(!releases[key]){
    const response=await fetch('release.json');
    if(!response.ok)throw Error('Release unavailable');
    releases[key]=validate(await response.json());
   }
   if(current!==revision)return;
   prompt.value=task(releases[key]);copy.disabled=false;
   status.textContent=say('Qoopia V1 · current release. Review the task and copy it to your agent.','Qoopia V1 · текущий релиз. Прочитайте задание и скопируйте его своему агенту.');
  }catch{
   if(current!==revision)return;
   status.textContent=say('Could not load the release. Reload this page or use the manual installation guide below.','Не удалось загрузить сведения о релизе. Обновите страницу или используйте ручную инструкцию ниже.');
  }
 }
 copy.addEventListener('click',async()=>{
  const value=prompt.value;if(!value||copy.disabled)return;
  try{await navigator.clipboard.writeText(value);feedback.textContent=say('Copied. Paste it into your local agent session.','Скопировано. Вставьте задание в локальную сессию агента.');}
  catch{preview.open=true;prompt.focus();prompt.select();feedback.textContent=say('Automatic copying is unavailable. Copy the selected task below.','Автоматическое копирование недоступно. Скопируйте выделенное задание ниже.');}
 });
 client.addEventListener('change',render);window.addEventListener('qoopia:language',render);render();
})();
