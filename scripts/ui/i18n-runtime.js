/* Explicit UI messages only. User content is never matched against a dictionary. */
(() => {
  'use strict';
  const catalog = __CATALOG__;
  const countForms = {member:[['member','members','members'],['участник','участника','участников']],session:[['session','sessions','sessions'],['сессия','сессии','сессий']],
    message:[['message','messages','messages'],['сообщение','сообщения','сообщений']],note:[['note','notes','notes'],['заметка','заметки','заметок']],file:[['file','files','files'],['файл','файла','файлов']],
    result:[['result','results','results'],['результат','результата','результатов']],token:[['token','tokens','tokens'],['токен','токена','токенов']]};
  const key = 'qoopia.language';
  const valid = value => value === 'en' || value === 'ru';
  const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const cookie = document.cookie.match(/(?:^|; )qoopia_language=(en|ru)(?:;|$)/)?.[1];
  const requested = new URLSearchParams(location.search).get('lang');
  const preferred = [requested, cookie, read()].find(valid);
  // A page published in one language (qoopia.ai/ru/...) keeps it; an explicit other choice opens its translation.
  const fixed = document.documentElement.dataset?.staticLanguage !== undefined && valid(document.documentElement.lang) ? document.documentElement.lang : null;
  const translation = fixed && preferred && preferred !== fixed && document.querySelector('link[rel="alternate"][hreflang="' + preferred + '"]');
  // On the site ?lang= (older links) is a choice too: remember it, or the stored language would send the visitor back.
  if (fixed && valid(requested)) remember(requested);
  // stop() first: the rest of this page must not parse, run its scripts or count a view.
  if (translation) { window.stop(); location.replace(new URL(translation.href).pathname + location.hash); }
  let language = fixed || preferred || (navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en');
  const nonce = 'q' + Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('');
  const pattern = new RegExp('\\uE000' + nonce + ':([0-9]+)\\uE001', 'g');
  // id → {entry,key}; ids only grow, so Map order is age order.
  const messages = new Map(), bindings = new Map(), tokenValues = new Map();
  let nextId = 0;
  const LIMIT = 20000; // A4-21: see prune().
  const translate = source => language === 'ru' ? (catalog[source] ?? source) : source;
  const resolve = template => String(template).replace(pattern, (_, id) => {
    const entry = messages.get(Number(id))?.entry;
    if (!entry) return '';
    if (entry.kind === 'number') return new Intl.NumberFormat(language,{maximumFractionDigits:1}).format(entry.value);
    if (entry.kind === 'pair') return language==='ru'?entry.ru:entry.en;
    if (entry.kind === 'date') {const date=new Date(entry.value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(language,entry.options).format(date);}
    if(entry.kind === 'count'){const forms=countForms[entry.unit]?.[language==='ru'?1:0]||[entry.unit,entry.unit,entry.unit];const rule=new Intl.PluralRules(language).select(entry.value);return new Intl.NumberFormat(language).format(entry.value)+' '+forms[rule==='one'?0:rule==='few'?1:2];}
    if (entry.kind === 'relative') return new Intl.RelativeTimeFormat(language, {numeric:'auto'}).format(entry.value,entry.unit);
    return translate(entry.source).replace(/\{(\w+)\}/g, (whole, name) => String(entry.params[name] ?? whole));
  });
  const cache = new Map();
  const token = entry => {
    const key=JSON.stringify(entry);let value=tokenValues.get(key);
    if(!value){const id=nextId++;messages.set(id,{entry,key});tokenValues.set(key,value='\uE000'+nonce+':'+id+'\uE001');if(messages.size>LIMIT)prune();}
    return value;
  };
  // A4-21: a page that polls for hours created a token per new date, count or parameter set and kept them all.
  // Past LIMIT the oldest tokens no live node, attribute or plain message uses are dropped, down to half.
  // ponytail: a token held only in a JS string for longer than LIMIT/2 newer tokens resolves to ''; raise LIMIT if one does.
  function prune() {
    const live = new Set(), mark = text => { for (const m of String(text).matchAll(pattern)) live.add(Number(m[1])); };
    for (const binding of bindings.values()) for (const template of binding.values()) mark(template);
    for (const value of cache.values()) mark(value);
    for (const [id, {key}] of messages) {
      if (messages.size <= LIMIT / 2) break;
      if (!live.has(id)) { messages.delete(id); tokenValues.delete(key); }
    }
  }
  const msg = (source, params) => {
    if (params) return token({source,params});
    if (!cache.has(source)) cache.set(source, token({source,params:{}}));
    return cache.get(source);
  };
  function renderBinding(node, binding) {
    if (!node.isConnected) { bindings.delete(node); return; }
    for (const [attribute, template] of binding) {
      const value = resolve(template);
      if (attribute === '#text') { if(node.nodeValue !== value) node.nodeValue = value; }
      else if(node.getAttribute(attribute) !== value) node.setAttribute(attribute,value);
    }
  }
  function scan(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      const source = root.nodeValue || '';
      if (source.includes('\uE000'+nonce+':')) {
        const binding = new Map([['#text',source]]);bindings.set(root,binding);renderBinding(root,binding);
      } else if(bindings.has(root) && resolve(bindings.get(root).get('#text')) !== source) bindings.delete(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if(root.nodeType === Node.ELEMENT_NODE) {
      if(root.matches('script,style,[translate="no"]')) return;
      const binding = bindings.get(root) || new Map();
      for(const attr of ['placeholder','title','aria-label','alt','content']) {
        const staticKey = root.getAttribute('data-i18n-'+attr);
        const source = staticKey ? msg(staticKey) : root.getAttribute(attr);
        if(source?.includes('\uE000'+nonce+':'))binding.set(attr,source);
      }
      if(binding.size){bindings.set(root,binding);renderBinding(root,binding);}
      // Code bytes stay untouched; explicit UI accessibility labels still resolve.
      if(root.matches('code,pre')) return;
      const staticKey=root.getAttribute('data-i18n');
      if(staticKey && root.childNodes.length===1 && root.firstChild.nodeType===Node.TEXT_NODE) {
        const child=root.firstChild,b=new Map([['#text',msg(staticKey)]]);bindings.set(child,b);renderBinding(child,b);return;
      }
    }
    for(const child of root.childNodes)scan(child);
  }
  function syncControls() {
    document.documentElement.lang=language;
    document.querySelectorAll('[data-language]').forEach(b => {
      const current = b.dataset.language === language;
      if (b.tagName !== 'A') b.setAttribute('aria-pressed', String(current));
      else if (current) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }
  function remember(value) {
    try{localStorage.setItem(key,value);}catch{/* Storage unavailable (private mode or blocked); the choice lasts for this page. */}
    const shared=location.hostname==='qoopia.ai'||location.hostname.endsWith('.qoopia.ai');
    if(shared)document.cookie='qoopia_language='+value+'; Path=/; Domain=qoopia.ai; Max-Age=31536000; SameSite=Lax; Secure';
  }
  function setLanguage(value) {
    if(!valid(value))return;
    language=value;
    const address=new URL(location.href);if(address.searchParams.has("lang")){address.searchParams.set("lang",value);history.replaceState(null,"",address.pathname+address.search+address.hash);}
    remember(value);
    syncControls();
    for(const [node,binding] of bindings)renderBinding(node,binding);
    window.dispatchEvent(new CustomEvent('qoopia:language',{detail:value}));
  }
  window.QI = {msg,pair:(en,ru)=>token({kind:'pair',en,ru}),plain:source=>translate(source),resolve,get language(){return language;},setLanguage,
    number:value=>token({kind:'number',value:Number(value)}),
    date:(value,options={dateStyle:'medium',timeStyle:'short'})=>token({kind:'date',value,options}),
    count:(value,unit)=>token({kind:'count',value,unit}),
    code:value=>{const label=({active:'Active',pending:'Pending',removed:'Removed',left:'Left',creating:'Creating',requested:'Requested',approved:'Approved',rejected:'Rejected',delivered:'Delivered',sending:'Sending',queued:'Queued',failed:'Failed',cancelled:'Cancelled',ready:'Ready',paused:'Paused',owner:'Owner',steward:'Steward',assistant:'Assistant',tool:'Tool',user:'User',system:'System',on:'On',off:'Off',NO_SCHEDULED_BACKUP:'No scheduled backup',hybrid:'Hybrid'})[value];return label?msg(label):String(value??'—');},
    relative:(value,unit)=>token({kind:'relative',value,unit}),scan};
  document.documentElement.lang=language;
  document.addEventListener('DOMContentLoaded',()=>{
    scan(document);syncControls();
    // On a fixed-language page the switcher is a link to the translation: remember the choice and let it navigate.
    document.addEventListener('click',event=>{const button=event.target.closest('[data-language]');if(!button||!valid(button.dataset.language))return;if(fixed)remember(button.dataset.language);else setLanguage(button.dataset.language);});
    const observer=new MutationObserver(records=>{
      for(const record of records){
        if(record.type==='childList'){for(const node of record.addedNodes)scan(node);}
        else scan(record.target);
      }
      for(const node of bindings.keys())if(!node.isConnected)bindings.delete(node);
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','alt']});
  });
  window.addEventListener('storage',event=>{if(!fixed&&event.key===key&&valid(event.newValue)&&event.newValue!==language)setLanguage(event.newValue);});
})();
