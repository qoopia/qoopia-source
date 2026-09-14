(() => {
 const key='qoopia.site-analytics.v1',endpoint='https://auth.qoopia.ai/analytics/events';
 const privacySignal=()=>navigator.globalPrivacyControl===true||navigator.doNotTrack==='1';
 let enabled=false,viewSent=false;
 try{enabled=localStorage.getItem(key)==='allow'&&!privacySignal();}catch{}
 const page=({'/':'home','/index.html':'home','/docs':'docs','/docs.html':'docs','/releases':'releases','/releases.html':'releases'})[location.pathname]||'404';
 const language=()=>window.QI?.language==='ru'?'ru':'en';
 const viewport=()=>innerWidth<600?'small':innerWidth<1024?'medium':'large';
 const referral=()=>{
  try {if(!document.referrer)return 'direct';const host=new URL(document.referrer).hostname;
   if(host===location.hostname)return 'internal';
   if(/(^|\.)(google|bing|yandex|duckduckgo)\./.test(host))return 'search';
   if(/(^|\.)(t\.co|x\.com|facebook\.com|instagram\.com|linkedin\.com|reddit\.com)$/.test(host))return 'social';
   return 'other';
  }catch{return 'other';}
 };
 const send=(kind,extra={})=>{
  if(!enabled||privacySignal()||!crypto.randomUUID)return;
  try{fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),kind,page,language:language(),viewport:viewport(),...extra}),credentials:'omit',keepalive:true,mode:'cors',cache:'no-store'}).catch(()=>{});}catch{}
 };
 const view=()=>{if(enabled&&!viewSent){viewSent=true;send('site_view',{referrer:referral()});}};
 const details=document.createElement('details');details.className='site-analytics';
 const summary=document.createElement('summary'),description=document.createElement('p'),label=document.createElement('label'),check=document.createElement('input'),labelText=document.createElement('span');
 check.type='checkbox';check.checked=enabled;check.disabled=privacySignal();
 label.append(check,labelText);details.append(summary,description,label);
 const render=()=>{
  const msg=text=>window.QI?.msg(text)||text;
  summary.textContent=msg('Website statistics');
  description.textContent=msg('Optional: share page views, download clicks, language, screen size category and loading times. No cookies, persistent visitor ID, full referrer address or page content are sent.');
  labelText.textContent=msg(privacySignal()?'Your browser privacy signal has disabled website statistics.':'Allow technical website statistics');
 };
 render();document.querySelector('footer')?.append(details);window.addEventListener('qoopia:language',render);
 check.addEventListener('change',()=>{enabled=check.checked&&!privacySignal();try{localStorage.setItem(key,enabled?'allow':'deny');}catch{}view();});
 document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('#download-action a'):null;if(link){const selected=document.querySelector('#platform')?.value;send('download_click',{platform:['mac','linux'].includes(selected)?selected:'other'});}});
 view();
 const timing=()=>{const entry=performance.getEntriesByType('navigation')[0];if(!entry)return;for(const [measurement,value] of [['dom_ready',entry.domContentLoadedEventEnd],['load',entry.loadEventEnd]])if(value>0)send('site_performance',{measurement,value:Math.min(300000,Math.round(value))});};
 if(document.readyState==='complete')timing();else window.addEventListener('load',()=>setTimeout(timing,0),{once:true});
 try{let lcp;const observer=new PerformanceObserver(list=>{lcp=list.getEntries().at(-1)?.startTime;});observer.observe({type:'largest-contentful-paint',buffered:true});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){observer.disconnect();if(lcp!==undefined){send('site_performance',{measurement:'lcp',value:Math.min(300000,Math.round(lcp))});lcp=undefined;}}});
 }catch{}
})();
