/* Install on this workspace origin, so the icon opens the same data and owner sign-in. */
(()=>{
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone;
 const install=document.querySelector('#installApp'),guide=document.querySelector('#installGuide'),update=document.querySelector('#appUpdate'),status=document.querySelector('#appConnection');
 // The native iPhone client owns installation, updates and network recovery.
 if(/Qoopia-iOS\//.test(navigator.userAgent)){for(const element of [install,guide,update,status])if(element)element.hidden=true;document.querySelectorAll('[data-native-app-settings]').forEach(link=>link.hidden=false);return;}
 let prompt,registration;
 function visibility(){if(install)install.hidden=!!standalone();}
 visibility();
 if(new URLSearchParams(location.search).get('install')==='1'&&guide&&!standalone())guide.hidden=false;
 addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;visibility();});
 addEventListener('appinstalled',()=>{prompt=null;if(guide)guide.hidden=true;visibility();});
 if(install)install.onclick=async()=>{if(prompt){await prompt.prompt();prompt=null;}else if(guide){guide.hidden=!guide.hidden;if(!guide.hidden)guide.focus();}};
 document.querySelector('#closeInstall')?.addEventListener('click',()=>{guide.hidden=true;install.focus();});
 const connection=()=>{if(status)status.hidden=navigator.onLine;};connection();addEventListener('offline',connection);addEventListener('online',connection);
 if(!('serviceWorker' in navigator)||!isSecureContext)return;
 let requestedUpdate=false;
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(requestedUpdate)location.reload();});
 navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(reg=>{
  registration=reg;
  const available=()=>{if(update&&reg.waiting&&navigator.serviceWorker.controller)update.hidden=false;};available();
  reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker?.addEventListener('statechange',available);});
  addEventListener('visibilitychange',()=>{if(!document.hidden)reg.update().catch(()=>{});});
 }).catch(()=>{/* Dashboard remains fully usable when installation is unavailable. */});
 if(update)update.onclick=()=>{if(registration?.waiting){requestedUpdate=true;registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});}};
})();
