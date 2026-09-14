/* Explicit UI messages only. User content is never matched against a dictionary. */
(() => {
  'use strict';
  const catalog = __CATALOG__;
  const key = 'qoopia.language';
  const valid = value => value === 'en' || value === 'ru';
  const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const cookie = document.cookie.match(/(?:^|; )qoopia_language=(en|ru)(?:;|$)/)?.[1];
  const requested = new URLSearchParams(location.search).get('lang');
  let language = [requested, cookie, read()].find(valid) || (navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en');
  const nonce = 'q' + Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('');
  const pattern = new RegExp('\\uE000' + nonce + ':([0-9]+)\\uE001', 'g');
  const messages = [], bindings = new Map(), tokenValues = new Map();
  const translate = source => language === 'ru' ? (catalog[source] ?? source) : source;
  const resolve = template => String(template).replace(pattern, (_, id) => {
    const entry = messages[Number(id)];
    if (!entry) return '';
    if (entry.kind === 'number') return new Intl.NumberFormat(language,{maximumFractionDigits:1}).format(entry.value);
    if (entry.kind === 'pair') return language==='ru'?entry.ru:entry.en;
    if (entry.kind === 'date') {const date=new Date(entry.value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(language,entry.options).format(date);}
    if(entry.kind === 'count'){const forms=entry.unit==='member'?(language==='ru'?['участник','участника','участников']:['member','members','members']):[entry.unit,entry.unit,entry.unit];const rule=new Intl.PluralRules(language).select(entry.value);return new Intl.NumberFormat(language).format(entry.value)+' '+forms[rule==='one'?0:rule==='few'?1:2];}
    if (entry.kind === 'relative') return new Intl.RelativeTimeFormat(language, {numeric:'auto'}).format(entry.value,entry.unit);
    return translate(entry.source).replace(/\{(\w+)\}/g, (whole, name) => String(entry.params[name] ?? whole));
  });
  const token = entry => {const key=JSON.stringify(entry);if(!tokenValues.has(key))tokenValues.set(key,'\uE000'+nonce+':'+(messages.push(entry)-1)+'\uE001');return tokenValues.get(key);};
  const cache = new Map();
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
    document.querySelectorAll('[data-language]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.language===language)));
  }
  function setLanguage(value) {
    if(!valid(value))return;
    language=value;
    const address=new URL(location.href);if(address.searchParams.has("lang")){address.searchParams.set("lang",value);history.replaceState(null,"",address.pathname+address.search+address.hash);}
    try{localStorage.setItem(key,value);}catch{}
    const shared=location.hostname==='qoopia.ai'||location.hostname.endsWith('.qoopia.ai');
    if(shared)document.cookie='qoopia_language='+value+'; Path=/; Domain=qoopia.ai; Max-Age=31536000; SameSite=Lax; Secure';
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
    document.addEventListener('click',event=>{const button=event.target.closest('[data-language]');if(button)setLanguage(button.dataset.language);});
    const observer=new MutationObserver(records=>{
      for(const record of records){
        if(record.type==='childList'){for(const node of record.addedNodes)scan(node);}
        else scan(record.target);
      }
      for(const node of bindings.keys())if(!node.isConnected)bindings.delete(node);
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','alt']});
  });
  window.addEventListener('storage',event=>{if(event.key===key&&valid(event.newValue)&&event.newValue!==language)setLanguage(event.newValue);});
})();
