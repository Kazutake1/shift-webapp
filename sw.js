const CACHE_PREFIX='shift-ipad-step1-shell-';
const CACHE=CACHE_PREFIX+'v65';
const FILES=['./','./index.html','./style.css','./app.js','./print-pdf.js','./backup-dialog.js','./employee-dialog.js','./store-dialog.js','./state-manager.js','./model.js','./stores.js','./crypto-backup.js','./birthdays.js','./birthday-ui.js','./holidays.js','./manifest.webmanifest','./icon.svg','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
 caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE).map(key=>caches.delete(key)))),
 self.clients.claim()
])));
// 同じ版の画面と処理をまとめて使い、通信切断や更新途中の混在を防ぐ。
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
 e.respondWith(caches.open(CACHE).then(async c=>{
  if(e.request.mode==='navigate')return (await c.match('./index.html'))||fetch(e.request);
  return (await c.match(e.request))||fetch(e.request);
 }));
});

