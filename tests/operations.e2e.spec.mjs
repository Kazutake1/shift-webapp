import {test,expect} from '@playwright/test';

const STORAGE_KEY='shift-ipad-stores-v2';

async function openApp(page){
 await page.goto('/');
 await expect(page.locator('#schedule')).toBeVisible();
 await page.waitForFunction(key=>!!localStorage.getItem(key),STORAGE_KEY);
}

async function editFirstNote(page,text){
 await page.locator('td.notes-cell button').first().click();
 await page.locator('#editor textarea').fill(text);
 await page.locator('#editor').getByRole('button',{name:'保存',exact:true}).click();
}

async function savedRoot(page){
 return page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
}

function backupFile(root,name='restore.json'){
 const text=JSON.stringify({
  format:'shift-ipad-backup',
  version:1,
  exportedAt:'2026-09-26T00:00:00.000Z',
  data:root
 });
 return {name,mimeType:'application/json',buffer:Buffer.from(text)};
}

test('複数画面の競合後は誕生日確認・Undo・復元で古いデータを上書きしない',async({browser})=>{
 const context=await browser.newContext({
  serviceWorkers:'block',
  viewport:{width:1180,height:820}
 });
 const stale=await context.newPage();
 await openApp(stale);

 // 誕生日通知を当日分として用意し、同時に最初の備考を空欄へそろえる。
 await stale.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  const parts=Object.fromEntries(
   new Intl.DateTimeFormat('en-US',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
   }).formatToParts(new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value])
  );
  const store=root.stores.find(s=>s.id===root.activeStoreId);
  const employee=store.employees[0];
  employee.birthDate=`1992-${parts.month}-${parts.day}`;
  employee.hireDate='2000-01-01';
  store.weeks[store.current].days[0].notes='';
  localStorage.setItem(key,JSON.stringify(root));
 },STORAGE_KEY);
 await stale.reload();
 await expect(stale.locator('#birthday-notices')).toBeVisible();

 // 古い画面側にUndo履歴を1件作る。
 await editFirstNote(stale,'古い画面の変更');
 await expect(stale.locator('td.notes-cell button').first()).toHaveText('古い画面の変更');
 await expect(stale.locator('#shift-page [data-undo]')).toBeEnabled();

 // 最新画面は古い画面の保存後に開く。
 const latest=await context.newPage();
 await openApp(latest);
 latest.on('dialog',dialog=>dialog.accept());

 const staleDialogs=[];
 stale.on('dialog',dialog=>{
  staleDialogs.push(dialog.message());
  return dialog.accept();
 });

 // 最新画面でさらに変更し、古い画面を競合状態にする。
 await editFirstNote(latest,'最新画面の変更');
 await expect(latest.locator('td.notes-cell button').first()).toHaveText('最新画面の変更');
 await expect.poll(()=>staleDialogs.some(message=>message.includes('別のタブまたはウインドウ'))).toBe(true);
 await expect(stale.locator('#saved')).toContainText('別の画面でデータが変更されました');

 // 誕生日の「確認済み」から古いroot全体を書き戻せないことを確認。
 await stale.locator('#birthday-notices').getByRole('button',{name:'確認済み'}).first().click();
 await expect(stale.locator('#birthday-notices')).toBeVisible();
 let root=await savedRoot(latest);
 let store=root.stores.find(s=>s.id===root.activeStoreId);
 expect(store.weeks[store.current].days[0].notes).toBe('最新画面の変更');
 expect(root.birthdayAcknowledgements||[]).toHaveLength(0);

 // Undoも保存されず、最新データを維持する。
 await stale.locator('#shift-page [data-undo]').click();
 await stale.locator('#editor').getByRole('button',{name:'はい',exact:true}).click();
 await expect(stale.locator('#dialog-body .error')).toContainText('別の画面でデータが変更されています');
 root=await savedRoot(latest);
 store=root.stores.find(s=>s.id===root.activeStoreId);
 expect(store.weeks[store.current].days[0].notes).toBe('最新画面の変更');
 await stale.locator('#close').click();

 // バックアップ復元も競合中は停止する。
 const restoreCandidate=structuredClone(root);
 restoreCandidate.stores.find(s=>s.id===restoreCandidate.activeStoreId).store='競合復元店';
 await stale.locator('#settings').click();
 await stale.locator('#backup').click();
 await stale.locator('#editor input[type=file]').setInputFiles(backupFile(restoreCandidate,'conflict-restore.json'));
 await stale.locator('#editor').getByRole('button',{name:'バックアップを確認'}).click();
 await expect(stale.locator('#editor')).toContainText('復元対象');
 await stale.locator('#editor').getByRole('button',{name:'このバックアップで全店舗を復元'}).click();
 await expect(stale.locator('#dialog-body .error')).toContainText('安全のため復元を停止しました');
 root=await savedRoot(latest);
 store=root.stores.find(s=>s.id===root.activeStoreId);
 expect(store.store).not.toBe('競合復元店');
 expect(store.weeks[store.current].days[0].notes).toBe('最新画面の変更');

 await context.close();
});

test('localStorage保存失敗時は画面と保存データを変更前へ戻す',async({page})=>{
 await openApp(page);
 const beforeRaw=await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY);
 const beforeNote=await page.locator('td.notes-cell button').first().textContent();

 await page.evaluate(key=>{
  const original=Storage.prototype.setItem;
  Object.defineProperty(Storage.prototype,'setItem',{
   configurable:true,
   value:function(storageKey,value){
    if(storageKey===key)throw new DOMException('simulated quota error','QuotaExceededError');
    return original.call(this,storageKey,value);
   }
  });
 },STORAGE_KEY);

 page.on('dialog',dialog=>dialog.accept());
 await editFirstNote(page,'保存されてはいけない変更');
 await expect(page.locator('#saved')).toContainText('保存できません');

 const afterRaw=await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY);
 expect(afterRaw).toBe(beforeRaw);

 if(await page.locator('#editor').evaluate(el=>el.open))await page.locator('#close').click();
 await expect(page.locator('td.notes-cell button').first()).toHaveText(beforeNote||'');
});

test('バックアップ復元は実際の画面とlocalStorageを復元データへ置き換える',async({page})=>{
 await openApp(page);
 const candidate=await savedRoot(page);
 const store=candidate.stores.find(s=>s.id===candidate.activeStoreId);
 store.store='復元確認店';
 store.weeks[store.current].days[0].notes='復元テスト成功';

 await page.locator('#settings').click();
 await page.locator('#backup').click();
 await page.locator('#editor input[type=file]').setInputFiles(backupFile(candidate));
 await page.locator('#editor').getByRole('button',{name:'バックアップを確認'}).click();
 await expect(page.locator('#editor')).toContainText('復元対象：復元確認店');

 page.on('dialog',dialog=>dialog.accept());
 await page.locator('#editor').getByRole('button',{name:'このバックアップで全店舗を復元'}).click();
 await page.locator('#settings-back').click();

 await expect(page.locator('#store-name')).toHaveText('復元確認店');
 await expect(page.locator('td.notes-cell button').first()).toHaveText('復元テスト成功');
 expect(await savedRoot(page)).toEqual(candidate);
});
