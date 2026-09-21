/* Cache only the public recovery page and its font. Never cache private responses. */
const CACHE='qoopia-offline-__QOOPIA_APP_REVISION__';
const PUBLIC_ASSETS=['/offline','/brand/Manrope.ttf'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PUBLIC_ASSETS))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('qoopia-offline-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method==='GET'&&url.origin===self.location.origin&&url.pathname==='/brand/Manrope.ttf'){
  event.respondWith(caches.match('/brand/Manrope.ttf').then(cached=>cached||fetch(event.request)));return;
 }
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||url.origin!==self.location.origin||!['/dashboard','/local-login'].includes(url.pathname))return;
 event.respondWith(fetch(event.request).catch(async()=>await caches.match('/offline')||new Response('Qoopia is offline. Reconnect and retry.',{status:503,headers:{'content-type':'text/plain;charset=utf-8'}})));
});
