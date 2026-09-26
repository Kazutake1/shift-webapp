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
 await stale.locator('#editor').getByRole('button',{name:'バックアップ内容を確認'}).click();
 await expect(stale.locator('#editor')).toContainText('復元対象');
 await stale.locator('#editor').getByRole('button',{name:'確認したバックアップで全店舗を復元'}).click();
 await expect(stale.locator('#dialog-body .error').filter({hasText:'安全のため復元を停止しました'})).toHaveCount(1);
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
 await page.locator('#editor').getByRole('button',{name:'バックアップ内容を確認'}).click();
 await expect(page.locator('#editor')).toContainText('復元対象：復元確認店');

 page.on('dialog',dialog=>dialog.accept());
 await page.locator('#editor').getByRole('button',{name:'確認したバックアップで全店舗を復元'}).click();
 await page.locator('#settings-back').click();

 await expect(page.locator('#store-name')).toHaveText('復元確認店');
 await expect(page.locator('td.notes-cell button').first()).toHaveText('復元テスト成功');
 expect(await savedRoot(page)).toEqual(candidate);
});


test('バックアップ画面は作成と復元を分け、復元時の注意を明示する',async({page})=>{
 await openApp(page);
 await page.locator('#settings').click();
 await page.locator('#backup').click();

 await expect(page.locator('#editor')).toContainText('1. バックアップを作成');
 await expect(page.locator('#editor')).toContainText('2. バックアップから復元');
 await expect(page.locator('#editor')).toContainText('復元すると、現在の全店舗データをバックアップ内の内容で置き換えます');
 await expect(page.locator('#editor')).toContainText('① ファイルを選択');
 await expect(page.locator('#editor')).toContainText('作成したファイルが保存先に残っているかまでは確認できません');
 await expect(page.locator('#editor').getByRole('button',{name:'確認したバックアップで全店舗を復元'})).toBeDisabled();
});


test('従業員検索は名前・シフト表名・従業員番号で絞り込み、表示順と対象条件を維持する',async({page})=>{
 await openApp(page);
 await page.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  const store=root.stores.find(s=>s.id===root.activeStoreId);
  Object.assign(store.employees[0],{name:'山田 太郎',shiftName:'山田',employeeNumber:'0012'});
  Object.assign(store.employees[1],{name:'佐藤 花子',shiftName:'さとう',employeeNumber:'0099'});
  localStorage.setItem(key,JSON.stringify(root));
 },STORAGE_KEY);
 await page.reload();
 await expect(page.locator('#schedule')).toBeVisible();

 await page.getByRole('button',{name:/予備従業員 6:00〜9:00 空欄/}).first().click();
 const search=page.getByRole('searchbox',{name:'従業員を検索'});
 await expect(search).toBeVisible();

 await search.fill('0012');
 await expect(page.locator('#dialog-body .choices button')).toHaveCount(1);
 await expect(page.locator('#dialog-body .choices button').first()).toContainText('山田 太郎');

 await search.fill('さとう');
 await expect(page.locator('#dialog-body .choices button')).toHaveCount(1);
 await expect(page.locator('#dialog-body .choices button').first()).toContainText('佐藤 花子');

 await search.fill('該当なし');
 await expect(page.locator('#dialog-body .choices button')).toHaveCount(0);
 await expect(page.locator('#dialog-body')).toContainText('検索条件に一致する従業員がいません');
});

test('同じ従業員の勤務時間が重なる登録は警告し、利用者が中止または続行できる',async({page})=>{
 await openApp(page);
 const before=await savedRoot(page);
 const store=before.stores.find(s=>s.id===before.activeStoreId);
 const employee=store.employees[0];

 await page.getByRole('button',{name:/予備従業員 6:00〜9:00 空欄/}).first().click();
 const search=page.getByRole('searchbox',{name:'従業員を検索'});
 await search.fill(employee.name);

 let warning='';
 page.once('dialog',async dialog=>{warning=dialog.message();await dialog.dismiss();});
 await page.locator('#dialog-body .choices button').filter({hasText:employee.name}).first().click();
 await expect.poll(()=>warning).toContain('勤務時間が重複しています');
 expect(warning).toContain('登録済み：6:00〜9:00');
 expect(warning).toContain('今回：6:00〜9:00');

 let after=await savedRoot(page);
 let afterStore=after.stores.find(s=>s.id===after.activeStoreId);
 expect(afterStore.weeks[afterStore.current].days[0].shifts[2][0]).toBeNull();

 page.once('dialog',dialog=>dialog.accept());
 await page.locator('#dialog-body .choices button').filter({hasText:employee.name}).first().click();
 await expect(page.locator('#editor')).not.toBeVisible();

 after=await savedRoot(page);
 afterStore=after.stores.find(s=>s.id===after.activeStoreId);
 expect(afterStore.weeks[afterStore.current].days[0].shifts[2][0].employeeId).toBe(employee.id);
});


test('従業員管理の追加・編集・非表示を分離後も維持する',async({page})=>{
 await openApp(page);
 await page.locator('#settings').click();
 await page.locator('#employees').click();

 await expect(page.locator('#editor')).toContainText('従業員管理');
 await page.getByRole('button',{name:'＋ 従業員を追加'}).click();
 await page.getByLabel('フルネーム（20文字まで）').fill('分離テスト 太郎');
 await page.getByLabel('シフト表で使う名前（20文字まで）').fill('分離太郎');
 await page.getByLabel('従業員番号').fill('E999');
 await page.getByRole('button',{name:'保存',exact:true}).click();

 const row=page.locator('#dialog-body .employee-row').filter({hasText:'分離テスト 太郎'});
 await expect(row).toHaveCount(1);
 await expect(row).toContainText('シフト：分離太郎');

 await row.getByRole('button',{name:'編集'}).click();
 await page.getByLabel('シフト表で使う名前（20文字まで）').fill('分離T');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'保存',exact:true}).click();

 const edited=page.locator('#dialog-body .employee-row').filter({hasText:'分離テスト 太郎'});
 await expect(edited).toContainText('シフト：分離T');
 await edited.getByRole('button',{name:'非表示'}).click();
 await expect(page.locator('#dialog-body .employee-row').filter({hasText:'分離テスト 太郎'})).toContainText('非表示');

 const root=await savedRoot(page);
 const store=root.stores.find(s=>s.id===root.activeStoreId);
 const employee=store.employees.find(e=>e.employeeNumber==='E999');
 expect(employee).toMatchObject({name:'分離テスト 太郎',shiftName:'分離T',hidden:true});
});
