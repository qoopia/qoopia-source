/* Install on this workspace origin, so the icon opens the same data and owner sign-in. */
(()=>{
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone;
 const install=document.querySelector('#installApp'),guide=document.querySelector('#installGuide'),status=document.querySelector('#appConnection');
 // The native iPhone client owns installation, updates and network recovery.
 if(/Qoopia-iOS\//.test(navigator.userAgent)){for(const element of [install,guide,status])if(element)element.hidden=true;document.querySelectorAll('[data-native-app-settings]').forEach(link=>link.hidden=false);return;}
 let prompt;
 // A phone can never open a loopback dashboard, and a tunnel publishes MCP only: say so instead of Home Screen steps.
 const loopback=/^(127\.|localhost$|\[::1\]$)/.test(location.hostname);
 if(loopback&&guide){guide.querySelectorAll('[data-install-steps]').forEach(p=>p.hidden=true);guide.querySelectorAll('[data-install-loopback]').forEach(p=>p.hidden=false);}
 function visibility(){if(install)install.hidden=!!standalone();}
 visibility();
 if(new URLSearchParams(location.search).get('install')==='1'&&guide&&!standalone())guide.hidden=false;
 addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;visibility();});
 addEventListener('appinstalled',()=>{prompt=null;if(guide)guide.hidden=true;visibility();});
 if(install)install.onclick=async()=>{if(prompt&&!loopback){await prompt.prompt();prompt=null;}else if(guide){guide.hidden=!guide.hidden;if(!guide.hidden)guide.focus();}};
 document.querySelector('#closeInstall')?.addEventListener('click',()=>{guide.hidden=true;install.focus();});
 const connection=()=>{if(status)status.hidden=navigator.onLine;};connection();addEventListener('offline',connection);addEventListener('online',connection);
 if(!('serviceWorker' in navigator)||!isSecureContext)return;
 navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(reg=>{
  addEventListener('visibilitychange',()=>{if(!document.hidden)reg.update().catch(()=>{/* Update check is retried on the next visibility change. */});});
 }).catch(()=>{/* Dashboard remains fully usable when installation is unavailable. */});
})();
