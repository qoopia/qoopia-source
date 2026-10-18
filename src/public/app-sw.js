/* Cache only the public recovery page and its font. Never cache private responses. */
const CACHE='qoopia-offline-__QOOPIA_APP_REVISION__';
const PUBLIC_ASSETS=['/offline','/brand/Manrope.woff2'];
// It never serves the dashboard's own files, so a new worker cannot mismatch an open page: it takes over at once
// instead of waiting for every tab to close (the page's own banner announces a new interface).
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PUBLIC_ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('qoopia-offline-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method==='GET'&&url.origin===self.location.origin&&url.pathname==='/brand/Manrope.woff2'){
  event.respondWith(caches.match('/brand/Manrope.woff2').then(cached=>cached||fetch(event.request)));return;
 }
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||url.origin!==self.location.origin||!['/dashboard','/local-login'].includes(url.pathname))return;
 event.respondWith(fetch(event.request).catch(async()=>await caches.match('/offline')||new Response('Qoopia is offline. Reconnect and retry.',{status:503,headers:{'content-type':'text/plain;charset=utf-8'}})));
});
