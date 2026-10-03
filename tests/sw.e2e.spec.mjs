import {test,expect} from '@playwright/test';

test('Service Workerのキャッシュ・更新・controllerchange・オフライン起動を確認する',async({page,context})=>{
 await page.goto('/');
 await expect(page.locator('#schedule')).toBeVisible();
 await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));

 const cacheState=await page.evaluate(async()=>{
  const keys=await caches.keys();
  const current=keys.find(key=>key.startsWith('shift-ipad-step1-shell-'));
  const requests=current?await (await caches.open(current)).keys():[];
  return {keys,urls:requests.map(request=>request.url)};
 });
 expect(cacheState.keys.filter(key=>key.startsWith('shift-ipad-step1-shell-'))).toHaveLength(1);
 expect(cacheState.keys.find(key=>key.startsWith('shift-ipad-step1-shell-'))).toMatch(/^shift-ipad-step1-shell-v\d+$/);
 expect(cacheState.urls.some(url=>url.endsWith('/index.html'))).toBe(true);
 expect(cacheState.urls.some(url=>url.endsWith('/app.js'))).toBe(true);

 await page.goto('/tests/sw-harness.html');
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
 const updatedScript=await page.evaluate(async()=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('controllerchange timeout')),10000);
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
   clearTimeout(timer);
   resolve(navigator.serviceWorker.controller?.scriptURL||'');
  },{once:true});
  navigator.serviceWorker.register('../sw.js?e2e-update=1',{scope:'/',updateViaCache:'none'}).catch(error=>{
   clearTimeout(timer);
   reject(error);
  });
 }));
 expect(updatedScript).toContain('sw.js?e2e-update=1');

 await page.goto('/');
 await expect(page.locator('#schedule')).toBeVisible();
 await context.setOffline(true);
 await page.reload({waitUntil:'domcontentloaded'});
 await expect(page.locator('#schedule')).toBeVisible();
 await expect(page.locator('#store')).toBeVisible();
 const controller=await page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL||'');
 expect(controller).toMatch(/\/sw\.js(?:\?.*)?$/);
 await context.setOffline(false);
});
