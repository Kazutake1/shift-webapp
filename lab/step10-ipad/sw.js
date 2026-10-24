// Service Worker for the isolated FAKE DATA laboratory only.
const PREFIX='shift-step10-fake-shell-';
const CURRENT=PREFIX+'v1';
const FILES=['./','./index.html','./style.css','./app.js','./vault.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',event=>event.waitUntil(
 caches.open(CURRENT).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())
));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([
 caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX)&&key!==CURRENT).map(key=>caches.delete(key)))),
 self.clients.claim()
])));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||
   !url.pathname.startsWith(new URL(self.registration.scope).pathname))return;
 event.respondWith(caches.open(CURRENT).then(async cache=>
  (await cache.match(request))||(await cache.match('./index.html')&&request.mode==='navigate'?
   cache.match('./index.html'):fetch(request))
 ));
});
