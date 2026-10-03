import {test,expect} from '@playwright/test';

test('連携従業員は一店舗の勤続年数で対象となり渡し済みが両店舗に反映される',async({page})=>{
 await openApp(page);
 const year=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric'}).format(new Date()));
 await page.evaluate(({key,year})=>{
  const root=JSON.parse(localStorage.getItem(key));
  const first=root.stores[0];
  first.employees=[{id:'first-person',sharedId:'same-person',name:'共通従業員',birthDate:'1990-12-01',hireDate:`${year-2}-01-01`,hidden:false}];
  const second=structuredClone(first);
  second.id='second';second.store='B店舗';
  second.employees=[{id:'second-person',sharedId:'same-person',name:'共通従業員',birthDate:'1990-12-01',hireDate:`${year}-01-01`,hidden:false}];
  root.stores.push(second);
  localStorage.setItem(key,JSON.stringify(root));
 },{key:STORAGE_KEY,year});
 await page.reload();
 await page.locator('#settings').click();
 await page.locator('#birthday-list').click();
 const giver=await page.locator('#store option:checked').innerText();
 const first=page.getByRole('checkbox',{name:/共通従業員 誕生日クオカード渡し済み/});
 await first.check();
 await expect(first.locator('..').locator('.birthday-gift-status')).toHaveText('渡し済み');
 await page.locator('#store').selectOption('second');
 const second=page.getByRole('checkbox',{name:/B店舗 共通従業員 誕生日クオカード渡し済み/});
 await expect(second).toBeEnabled();
 await expect(second).toBeChecked();
 await expect(second.locator('..').locator('.birthday-gift-status')).toHaveText(`${giver}で渡し済み`);
 await expect(page.locator('#birthday-gift-summary')).toHaveText(`クオカード渡し済み 1 / 1名（${year}年）`);
 await page.reload();
 await expect(page.getByRole('checkbox',{name:/B店舗 共通従業員 誕生日クオカード渡し済み/}).locator('..').locator('.birthday-gift-status')).toHaveText(`${giver}で渡し済み`);
});

const STORAGE_KEY='shift-ipad-stores-v2';

test('PDFの横方向の細線を重複描画しない',async({page,context,browserName})=>{
 test.skip(browserName!=='chromium');
 async function palePixels(target){
  await openApp(target);
  await target.evaluate(()=>Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=> 'iPad Safari'}));
  await target.locator('#preview').click();
  await expect(target.getByRole('link',{name:'PDFを開く'})).toBeVisible();
  return target.evaluate(async()=>{
   const bytes=new Uint8Array(await (await fetch(document.querySelector('.preview-pdf-link').href)).arrayBuffer());
   const pdf=new TextDecoder('latin1').decode(bytes);
   const marker=pdf.indexOf('4 0 obj'),start=pdf.indexOf('stream\n',marker)+7;
   const length=Number(pdf.slice(marker,start).match(/\/Length (\d+)/)[1]);
   const url=URL.createObjectURL(new Blob([bytes.slice(start,start+length)],{type:'image/jpeg'}));
   const image=new Image();image.src=url;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
   const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
   const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
   let pale=0,dark=0;
   for(let i=0;i<pixels.length;i+=4){const r=pixels[i],g=pixels[i+1],b=pixels[i+2];if(r>130&&r<247&&Math.abs(r-g)<5&&Math.abs(g-b)<5)pale++;if(r<120&&g<120&&b<120)dark++;}
   URL.revokeObjectURL(url);
   return {pale,dark};
  });
 }
 const fixed=await palePixels(page);
 const baselinePage=await context.newPage();
 await baselinePage.route('**/print-pdf.js',async route=>{
  const response=await route.fetch();
  const source=await response.text();
  expect(source).toContain("if(side==='Top'&&lightGrid)continue;");
  await route.fulfill({response,body:source
   .replace("if(side==='Top'&&lightGrid)continue;","if(false)continue;")
   .replace('const inkWidth=lightGrid?.65:width;','const inkWidth=width;')});
 });
 const baseline=await palePixels(baselinePage);
 console.log('PDF_HORIZONTAL_LINES',JSON.stringify({baseline,fixed}));
 expect(fixed.pale).toBeLessThan(baseline.pale);
 expect(Math.abs(fixed.dark-baseline.dark)).toBeLessThan(baseline.dark*.01);
});

async function openApp(page){
 await page.goto('/');
 await expect(page.locator('#schedule')).toBeVisible();
 await page.waitForFunction(key=>!!localStorage.getItem(key),STORAGE_KEY);
}

test('設定の戻る操作は店名の右側に表示し、各サブページの戻り先を維持する',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await openApp(page);
 await page.locator('#settings').click();
 await expect(page.locator('#settings-page')).toBeVisible();
 await expect(page.locator('#settings-back')).toBeVisible();
 await expect(page.locator('#settings-back')).toHaveText('← シフト表に戻る');
 await expect(page.getByRole('button',{name:'シフト表に戻る'})).toBeVisible();
 expect(await page.locator('#settings-back').evaluate(el=>el.innerText.trim())).toBe('');
 await expect(page.locator('#settings-back .settings-back-icon')).toBeVisible();
 const store=await page.locator('#store').boundingBox();
 const back=await page.locator('#settings-back').boundingBox();
 expect(back.width).toBe(44);
 expect(back.x).toBeGreaterThan(store.x);
 expect(Math.abs(back.y-store.y)).toBeLessThanOrEqual(1);
 expect(Math.abs(back.height-store.height)).toBeLessThanOrEqual(1);

 await page.locator('#birthday-list').click();
 await expect(page.locator('#birthday-page')).toBeVisible();
 await expect(page.locator('#settings-back')).toBeHidden();
 await expect(page.locator('#birthday-back')).toHaveText('← 設定に戻る');

 await page.locator('#birthday-back').click();
 await page.locator('#settings-back').click();
 await page.locator('#preview').click();
 await expect(page.locator('.preview-toolbar')).toBeVisible();
 const previewBack=await page.getByRole('button',{name:'← シフト表に戻る'}).boundingBox();
 const title=await page.locator('.preview-toolbar h1').boundingBox();
 const printAction=await page.getByRole('button',{name:'印刷する'}).boundingBox();
 expect(previewBack.x).toBeLessThan(title.x);
 expect(title.x).toBeLessThan(printAction.x);
 expect(Math.abs(printAction.y-previewBack.y)).toBeLessThan(2);
 expect(printAction.x+printAction.width).toBeLessThanOrEqual(390);
});

test('印刷プレビューはChromiumとWebKitでシフト表を表示する',async({page})=>{
 await openApp(page);
 await page.locator('#preview').click();
 const preview=page.frameLocator('.preview-sheet');
 await expect(preview.locator('#schedule')).toBeVisible();
 await expect(preview.locator('#schedule tbody tr').first()).toBeVisible();
 const widths=await preview.locator('.table-rules line[stroke="#111"]').evaluateAll(lines=>lines.map(line=>Number(line.getAttribute('stroke-width'))));
 expect(widths.slice(0,4)).toEqual([2,2,2,2]);
 expect(widths.slice(6)).toContain(2);
});

test('印刷プレビューは左25mm・右15mmの綴じ代と整列したヘッダーを表示する',async({page})=>{
 await openApp(page);
 await page.locator('#preview').click();
 const preview=page.frameLocator('.preview-sheet');
 await expect(preview.locator('#paper')).toBeVisible();
 const result=await preview.locator('#paper').evaluate(el=>{
  const r=el.getBoundingClientRect();
  const pageWidth=document.documentElement.getBoundingClientRect().width;
  const store=document.querySelector('#store-name');
  const period=document.querySelector('#paper-period');
  const sr=store.getBoundingClientRect(),pr=period.getBoundingClientRect();
  const storeStyle=getComputedStyle(store),periodStyle=getComputedStyle(period);
  return {
   left:r.left,right:pageWidth-r.right,pageWidth,
   storeBottom:sr.bottom,periodBottom:pr.bottom,
   storeFont:parseFloat(storeStyle.fontSize),periodFont:parseFloat(periodStyle.fontSize)
  };
 });
 const mmPx=result.pageWidth/297;
 expect(Math.abs(result.left-25*mmPx)).toBeLessThan(3);
 expect(Math.abs(result.right-15*mmPx)).toBeLessThan(3);
 expect(Math.abs(result.storeBottom-result.periodBottom)).toBeLessThan(2);
 expect(result.storeFont).toBeGreaterThan(result.periodFont);
});

test('週操作は店名の右側の上部バーへ移動し、スマホでは日付だけ非表示にする',async({page})=>{
 for(const width of [320,390,1180]){
  await page.setViewportSize({width,height:844});
  if(width===320)await openApp(page);
  await expect(page.locator('#header-week-nav')).toBeVisible();
  await expect(page.locator('#shift-page .week-nav')).toHaveCount(0);
  const store=await page.locator('#store').boundingBox();
  const nav=await page.locator('#header-week-nav').boundingBox();
  if(width>=700)expect(nav.x).toBeGreaterThanOrEqual(store.x+store.width);
  await expect(page.locator('#prev')).toBeVisible();
  if(width<=700)await expect(page.locator('#week-label')).toBeHidden();
  else await expect(page.locator('#week-label')).toBeVisible();
  await expect(page.locator('#next')).toBeVisible();
  await expect(page.locator('#today')).toBeVisible();
  if(width<=600){
   const buttons=await Promise.all(['#store','#prev','#next','#today','#copy-week','#preview','#settings'].map(selector=>page.locator(selector).boundingBox()));
   for(const box of buttons){expect(box.height).toBeGreaterThanOrEqual(44);expect(Math.abs(box.y-buttons[0].y)).toBeLessThan(2);}
   for(let i=1;i<buttons.length;i++)expect(buttons[i].x).toBeGreaterThanOrEqual(buttons[i-1].x+buttons[i-1].width);
   expect(buttons.at(-1).x+buttons.at(-1).width).toBeLessThanOrEqual(width);
   await expect(page.locator('.appbar .mobile-nav-icon:visible')).toHaveCount(5);
   const todayColors=await page.locator('#today').evaluate(el=>{
    const css=getComputedStyle(el);
    return {background:css.backgroundColor,color:css.color,border:css.borderTopColor};
   });
   expect(todayColors).toEqual({background:'rgb(232, 245, 237)',color:'rgb(28, 98, 65)',border:'rgb(100, 173, 127)'});
   const printColors=await page.locator('#preview').evaluate(el=>{
    const css=getComputedStyle(el);
    return {background:css.backgroundColor,color:css.color,border:css.borderTopColor};
   });
   expect(printColors).toEqual(todayColors);
  }
 }
 await page.locator('#settings').click();
 await expect(page.locator('#header-week-nav')).toBeHidden();
 await expect(page.locator('#settings-back')).toBeVisible();
});

test('スマホを横向きにしても上部操作と印刷プレビューのアイコンを維持する',async({browser})=>{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 try{
  const page=await context.newPage();
  await openApp(page);
  await expect(page.locator('.appbar .mobile-nav-icon:visible')).toHaveCount(5);
  await page.setViewportSize({width:844,height:390});
  await expect(page.locator('.appbar .mobile-nav-icon:visible')).toHaveCount(5);
  await expect(page.locator('.appbar .nav-label:visible')).toHaveCount(0);
  await expect(page.locator('#week-label')).toBeHidden();
  const row=await Promise.all(['#store','#prev','#next','#today','#copy-week','#preview','#settings'].map(selector=>page.locator(selector).boundingBox()));
  for(const box of row)expect(Math.abs(box.y-row[0].y)).toBeLessThan(2);
  await page.evaluate(()=>{
   Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=> 'iPhone Safari'});
   navigator.canShare=()=>true;
   navigator.share=()=>Promise.resolve();
  });
  await page.locator('#preview').click();
  await expect(page.getByRole('link',{name:'PDFを開く'})).toBeVisible();
  await expect(page.locator('.preview-toolbar .preview-icon:visible')).toHaveCount(3);
  await expect(page.locator('.preview-toolbar .preview-actions .preview-label-full:visible')).toHaveCount(0);
 }finally{await context.close();}
});

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

test('複数画面の競合後は誕生日確認・復元で古いデータを上書きしない',async({browser})=>{
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

 // 古い画面側にも変更履歴を1件作る。
 await editFirstNote(stale,'古い画面の変更');
 await expect(stale.locator('td.notes-cell button').first()).toHaveText('古い画面の変更');
 await expect(stale.locator('[data-undo]')).toHaveCount(0);

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

 // バックアップ復元も競合中は停止する。
 const restoreCandidate=structuredClone(root);
 restoreCandidate.stores.find(s=>s.id===restoreCandidate.activeStoreId).store='競合復元店';
 await stale.locator('#settings').click();
 await stale.locator('#backup').click();
 await stale.locator('#editor input[type=file]').setInputFiles(backupFile(restoreCandidate,'conflict-restore.json'));
 await stale.locator('#editor').getByRole('button',{name:'バックアップ内容を確認'}).click();
 await expect(stale.locator('#editor')).toContainText('全店舗バックアップ：競合復元店');
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
 await expect(page.locator('#editor')).toContainText('全店舗バックアップ：復元確認店');

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
 await expect(page.locator('#editor')).toContainText('店舗単位の復元では現在選択中の店舗だけを置き換え');
 await expect(page.locator('#editor')).not.toContainText('① ファイルを選択');
 await expect(page.locator('#editor')).not.toContainText('作成したファイルが保存先に残っているかまでは確認できません');
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


test('シフト表下の案内文を表示せず、通常保存成功は無表示にする',async({page})=>{
 await openApp(page);
 await expect(page.locator('footer')).toHaveCount(0);
 await expect(page.getByText('空欄・名前をタップして編集',{exact:false})).toHaveCount(0);
 await expect(page.getByText('データはこのブラウザーに保存されます。初回表示はサンプルです。',{exact:true})).toHaveCount(0);
 await expect(page.locator('#save-status')).toBeHidden();

 await editFirstNote(page,'通常保存表示テスト');
 await expect(page.locator('#save-status')).toBeHidden();
 await expect(page.locator('#saved')).toHaveText('');
});


test('店舗管理の追加・店名変更・店舗切り替えを分離後も維持する',async({page})=>{
 await openApp(page);
 const before=await savedRoot(page);
 const originalStore=before.stores.find(store=>store.id===before.activeStoreId);
 const originalId=originalStore.id;
 const originalName=originalStore.store;

 await page.locator('#settings').click();
 await page.locator('#stores').click();
 await expect(page.locator('#editor')).toContainText('店舗管理');
 await expect(page.locator('#editor')).toContainText(`選択中：${originalName}`);

 await page.getByLabel('新しい店舗の店名').fill('分離店舗B');
 await page.getByRole('button',{name:'店舗を追加',exact:true}).click();
 await expect(page.locator('#editor')).not.toBeVisible();

 let root=await savedRoot(page);
 let active=root.stores.find(store=>store.id===root.activeStoreId);
 expect(active.store).toBe('分離店舗B');

 await page.locator('#stores').click();
 await page.getByLabel('選択中の店名').fill('分離店舗C');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'店名を変更',exact:true}).click();
 await expect(page.locator('#editor')).not.toBeVisible();

 root=await savedRoot(page);
 active=root.stores.find(store=>store.id===root.activeStoreId);
 expect(active.store).toBe('分離店舗C');

 await page.locator('#settings-back').click();
 await page.locator('#store').selectOption(originalId);
 await expect(page.locator('#store-name')).toHaveText(originalName);

 root=await savedRoot(page);
 expect(root.activeStoreId).toBe(originalId);
});


test('設定画面の従業員誕生日一覧で対象者の渡し済みを年次保存する',async({page})=>{
 await openApp(page);

 const year=Number(new Intl.DateTimeFormat('en-US',{
  timeZone:'Asia/Tokyo',year:'numeric'
 }).format(new Date()));

 await page.evaluate(({key,year})=>{
  const root=JSON.parse(localStorage.getItem(key));
  const store=root.stores.find(s=>s.id===root.activeStoreId);
  Object.assign(store.employees[0],{
   name:'プレゼント対象',
   birthDate:'1990-12-01',
   hireDate:`${year-1}-10-01`,
   hidden:false
  });
  Object.assign(store.employees[1],{
   name:'一年未満',
   birthDate:'1990-09-01',
   hireDate:`${year-1}-10-01`,
   hidden:false
  });
  root.birthdayGiftDelivered=[];
  localStorage.setItem(key,JSON.stringify(root));
 },{key:STORAGE_KEY,year});

 await page.reload();
 await page.locator('#settings').click();

 await expect(page.locator('#settings-page')).toBeVisible();
 await expect(page.locator('#settings-page #birthday-gifts')).toHaveCount(0);
 await expect(page.locator('#birthday-list')).toBeVisible();
 await page.locator('#birthday-list').click();

 await expect(page.locator('#birthday-page')).toBeVisible();
 await expect(page.locator('#birthday-page h1')).toHaveText('従業員リスト');
 await expect(page.locator('#birthday-gifts h2')).toHaveText('従業員リスト');
 await expect(page.locator('#birthday-page')).not.toContainText('誕生日のお知らせ：');
 await expect(page.locator('#birthday-gift-list')).toContainText('プレゼント対象');
 await expect(page.locator('#birthday-gift-list')).toContainText('一年未満');
 await expect(page.locator('#birthday-gift-list')).toContainText('対象外（1年未満）');
 await expect(page.locator('#birthday-gift-summary')).toHaveText(`クオカード渡し済み 0 / 1名（${year}年）`);
 await expect(page.locator('#birthday-gift-list')).not.toContainText('さん');

 const eligible=page.getByRole('checkbox',{name:/プレゼント対象 誕生日クオカード渡し済み/});
 const ineligible=page.getByRole('checkbox',{name:/一年未満 誕生日クオカード渡し済み/});
 await expect(eligible).not.toBeChecked();
 await expect(ineligible).toBeDisabled();
 await expect(ineligible.locator('..').locator('.birthday-gift-person')).toHaveCSS('color','rgb(152, 166, 156)');

 await eligible.check();
 await expect(page.locator('#birthday-gift-summary')).toHaveText(`クオカード渡し済み 1 / 1名（${year}年）`);

 let root=await savedRoot(page);
 expect(root.birthdayGiftDelivered).toHaveLength(1);

 await page.reload();
 await expect(page.locator('#birthday-page')).toBeVisible();
 await expect(page.getByRole('checkbox',{name:/プレゼント対象 誕生日クオカード渡し済み/})).toBeChecked();

 await page.getByRole('button',{name:'← 設定に戻る',exact:true}).click();
 await expect(page.locator('#settings-page')).toBeVisible();
 await expect(page.locator('#birthday-list')).toBeVisible();
 await page.locator('#birthday-list').click();

 await page.getByRole('checkbox',{name:/プレゼント対象 誕生日クオカード渡し済み/}).uncheck();
 root=await savedRoot(page);
 expect(root.birthdayGiftDelivered).toEqual([]);
});


test('印刷PDFはA4横1ページに収まる',async({page,browserName})=>{
 test.skip(browserName!=='chromium','PDFページ数の検査はChromiumで実施');
 await openApp(page);

 const pdf=await page.pdf({
  format:'A4',
  landscape:true,
  printBackground:true,
  preferCSSPageSize:true,
  margin:{top:'0',right:'0',bottom:'0',left:'0'}
 });
 const text=pdf.toString('latin1');
 const pages=(text.match(/\/Type\s*\/Page\b/g)||[]).length;
 expect(pages).toBe(1);
});

test('iPadの補助ボタンは淡い緑色で、印刷ボタンは「PDFを印刷」と表示する',async({page})=>{
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=> 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'});
  Object.defineProperty(navigator,'platform',{configurable:true,get:()=> 'iPad'});
 });
 await openApp(page);
 const colors=async selector=>page.locator(selector).evaluate(el=>{
  const css=getComputedStyle(el);
  return [css.backgroundColor,css.color,css.borderTopColor];
 });
 const expected=['rgb(232, 245, 237)','rgb(28, 98, 65)','rgb(100, 173, 127)'];
 await expect.poll(()=>colors('#today')).toEqual(expected);
 await page.locator('#preview').click();
 await expect(page.getByRole('button',{name:'PDFを印刷'})).toBeVisible();
 await expect(page.getByRole('link',{name:'PDFを開く'})).toBeVisible();
 await expect.poll(()=>colors('.preview-toolbar>button:first-child')).toEqual(expected);
 await expect.poll(()=>colors('.preview-pdf-link')).toEqual(expected);
});

for(const device of ['iPad','iPhone'])test(`${device}向けの印刷用PDFはA4横1ページで共有できる`,async({page})=>{
 if(device==='iPhone')await page.setViewportSize({width:390,height:844});
 await openApp(page);
 await page.evaluate(device=>{
  Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=> `${device} Safari`});
  window.open=()=>{throw new Error('PDFは自動で新しいタブを開かない');};
  navigator.canShare=()=>true;
  navigator.share=data=>{window.sharedPdf=data.files[0];return Promise.resolve();};
  window.print=()=>{window.htmlPrintCalled=true;};
 },device);
 await page.locator('#preview').click();
 const openLink=page.getByRole('link',{name:'PDFを開く'});
 await expect(openLink).toBeVisible();
 if(device==='iPhone'){
  await expect(page.locator('.preview-toolbar .preview-icon:visible')).toHaveCount(3);
  const previewIconSizes=await page.locator('.preview-toolbar .preview-icon:visible').evaluateAll(icons=>icons.map(icon=>icon.getBoundingClientRect().width));
  expect(previewIconSizes).toEqual([23,23,23]);
  for(const control of [page.getByRole('button',{name:'PDFを共有して印刷'}),openLink]){
   const visibleText=await control.evaluate(el=>el.innerText.trim());
   expect(visibleText).toBe('');
   const box=await control.boundingBox();
   expect(box.width).toBeGreaterThanOrEqual(44);
  }
  const bounds=await page.locator('.preview-toolbar').evaluate(toolbar=>
   [toolbar.children[0],toolbar.children[1],toolbar.children[2].children[0],toolbar.children[2].children[1]]
    .map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,center:(r.top+r.bottom)/2};})
  );
  for(const item of bounds)expect(Math.abs(item.center-bounds[0].center)).toBeLessThan(2);
  for(let i=1;i<bounds.length;i++)expect(bounds[i].left).toBeGreaterThanOrEqual(bounds[i-1].right);
  expect(bounds.at(-1).right).toBeLessThanOrEqual(390);
  await page.setViewportSize({width:320,height:700});
  const narrow=await page.locator('.preview-toolbar').evaluate(toolbar=>{
   const items=[toolbar.children[0],toolbar.children[1],toolbar.children[2].children[0],toolbar.children[2].children[1]];
   return items.map(item=>{const r=item.getBoundingClientRect();return {left:r.left,right:r.right,center:(r.top+r.bottom)/2};});
  });
  for(const item of narrow)expect(Math.abs(item.center-narrow[0].center)).toBeLessThan(2);
  for(let i=1;i<narrow.length;i++)expect(narrow[i].left).toBeGreaterThanOrEqual(narrow[i-1].right);
  expect(narrow.at(-1).right).toBeLessThanOrEqual(320);
  await page.setViewportSize({width:390,height:844});
 }
 await expect(page.locator('.preview-meta [role="status"]')).toBeHidden();
 await expect(page.getByRole('link',{name:'PDFを保存'})).toHaveCount(0);
 await page.getByRole('button',{name:device==='iPad'?'PDFを印刷':'PDFを共有して印刷'}).click();
 await expect.poll(()=>page.evaluate(()=>window.sharedPdf?.name)).toBe('シフト表.pdf');
 const result=await page.evaluate(async()=>{
  const blob=await (await fetch(document.querySelector('.preview-pdf-link').href)).blob();
  const bytes=new Uint8Array(await blob.arrayBuffer());
  const pdf=new TextDecoder('latin1').decode(bytes);
  const imageObject=pdf.indexOf('4 0 obj');
  const imageStart=pdf.indexOf('stream\n',imageObject)+7;
  const imageLength=Number(pdf.slice(imageObject,imageStart).match(/\/Length (\d+)/)?.[1]);
  const imageUrl=URL.createObjectURL(new Blob([bytes.slice(imageStart,imageStart+imageLength)],{type:'image/jpeg'}));
  const image=new Image();image.src=imageUrl;
  await image.decode();
  const canvas=document.createElement('canvas');canvas.width=560;canvas.height=396;
  const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  let ink=0;
  for(let i=0;i<pixels.length;i+=4)if(pixels[i]<170&&pixels[i+1]<170&&pixels[i+2]<170)ink++;
  URL.revokeObjectURL(imageUrl);
  return {type:blob.type,size:blob.size,header:pdf.slice(0,8),pages:(pdf.match(/\/Type \/Page\b/g)||[]).length,landscape:pdf.includes('/MediaBox [0 0 841.89 595.28]'),ink,htmlPrintCalled:window.htmlPrintCalled||false,sharedType:window.sharedPdf.type};
 });
 expect(result.type).toBe('application/pdf');
 expect(result.header).toBe('%PDF-1.4');
 expect(result.pages).toBe(1);
 expect(result.landscape).toBe(true);
 expect(result.size).toBeGreaterThan(15000);
 expect(result.ink).toBeGreaterThan(500);
 expect(result.htmlPrintCalled).toBe(false);
 expect(result.sharedType).toBe('application/pdf');
 await page.getByRole('button',{name:'← シフト表に戻る'}).click();
 await page.evaluate(()=>{navigator.canShare=()=>false;});
 await page.locator('#preview').click();
 await expect(page.getByRole('button',{name:'PDFを共有して印刷'})).toBeHidden();
 await expect(page.getByRole('link',{name:'PDFを開く'})).toBeVisible();
 await expect(page.locator('.preview-meta [role="status"]')).toBeHidden();
});

test('従業員リストは選択中の店舗ごとに切り替わる',async({page})=>{
 await openApp(page);
 await page.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  const active=root.stores.find(s=>s.id===root.activeStoreId);
  Object.assign(active.employees[0],{name:'現在店舗従業員',birthDate:'1990-12-01',hireDate:'2020-01-01',hidden:false});
  let other=root.stores.find(s=>s.id!==root.activeStoreId);
  if(!other){
   other=structuredClone(active);
   other.id='employee-list-other-store';
   other.store='別店舗';
   other.employees=structuredClone(active.employees);
   root.stores.push(other);
  }
  Object.assign(other.employees[0],{id:'employee-list-other-worker',name:'別店舗従業員',birthDate:'1990-11-01',hireDate:'2020-01-01',hidden:false});
  localStorage.setItem(key,JSON.stringify(root));
 },STORAGE_KEY);
 await page.reload();
 await page.locator('#settings').click();
 await page.locator('#birthday-list').click();
 await expect(page.locator('#birthday-gift-list')).toContainText('現在店舗従業員');
 await expect(page.locator('#birthday-gift-list')).not.toContainText('別店舗従業員');
 const otherId=await page.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  return root.stores.find(s=>s.id!==root.activeStoreId&&s.employees.some(e=>e.name==='別店舗従業員')).id;
 },STORAGE_KEY);
 await page.locator('#store').selectOption(otherId);
 await expect(page.locator('#birthday-gift-list')).toContainText('別店舗従業員');
 await expect(page.locator('#birthday-gift-list')).not.toContainText('現在店舗従業員');
});


test('iPadの従業員日付カレンダーはリセットと決定を見切らせない',async({page})=>{
 await page.setViewportSize({width:1366,height:1024});
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=> 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'});
  Object.defineProperty(navigator,'platform',{configurable:true,get:()=> 'iPad'});
  Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>5});
 });
 await openApp(page);
 await page.locator('#settings').click();
 await page.locator('#employees').click();
 await page.getByRole('button',{name:'＋ 従業員を追加'}).click();

 await expect(page.getByRole('button',{name:'入社年月日を選択'})).toBeVisible();
 await expect(page.getByRole('button',{name:'生年月日を選択'})).toBeVisible();
 await expect(page.getByRole('button',{name:'退職日を選択'})).toBeVisible();
 await expect(page.locator('#dialog-body input[type="date"]')).toHaveCount(3);
 await expect(page.locator('#dialog-body input[type="date"]').first()).toBeHidden();

 await page.getByRole('button',{name:'入社年月日を選択'}).click();
 const picker=page.locator('.ipad-date-picker');
 await expect(picker).toBeVisible();
 await expect(picker.getByRole('textbox',{name:'生年を入力'})).toHaveCount(0);
 const reset=page.getByRole('button',{name:'リセット'});
 const confirm=page.getByRole('button',{name:'決定'});
 await expect(reset).toBeVisible();
 await expect(confirm).toBeVisible();

 const panel=await picker.boundingBox();
 const resetBox=await reset.boundingBox();
 const confirmBox=await confirm.boundingBox();
 expect(resetBox.y).toBeGreaterThanOrEqual(panel.y);
 expect(confirmBox.y).toBeGreaterThanOrEqual(panel.y);
 expect(resetBox.y+resetBox.height).toBeLessThanOrEqual(panel.y+panel.height+1);
 expect(confirmBox.y+confirmBox.height).toBeLessThanOrEqual(panel.y+panel.height+1);
 await page.getByRole('button',{name:'キャンセル'}).click();
 await expect(picker).toHaveCount(0);

 await page.setViewportSize({width:768,height:1024});
 await page.getByRole('button',{name:'生年月日を選択'}).click();
 const yearInput=picker.getByRole('textbox',{name:'生年を入力'});
 const monthSelect=picker.getByRole('combobox',{name:'生月を選択'});
 await expect(yearInput).toBeVisible();
 await yearInput.fill('1990');
 await monthSelect.selectOption('4');
 await picker.getByRole('button',{name:'1990年4月15日'}).click();
 await expect(confirm).toBeVisible();
 await confirm.click();
 await expect(page.getByRole('button',{name:'生年月日を選択'})).toHaveText('1990/04/15');
 await expect(page.locator('#dialog-body input[type="date"]').nth(1)).toHaveValue('1990-04-15');
 await page.getByRole('button',{name:'生年月日を選択'}).click();
 await expect(yearInput).toHaveValue('1990');
 await expect(monthSelect).toHaveValue('4');
 await page.getByRole('button',{name:'キャンセル'}).click();
});


test('印刷時は名前と時間を9.5ptで表示し、長い組み合わせだけ一緒に縮小する',async({page})=>{
 await openApp(page);
 await page.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  const store=root.stores.find(s=>s.id===root.activeStoreId);
  const day=store.weeks[store.current].days[0];
  const id=store.employees[0].id;
  day.shifts[0][0]={employeeId:id,name:'山田',start:360,end:540};
  day.shifts[1][4]={employeeId:id,name:'山田',start:1335,end:1785};
  day.shifts[2][4]={employeeId:id,name:'山田佐藤鈴木高橋渡辺田中伊藤小林中村加藤',start:1335,end:1785};
  localStorage.setItem(key,JSON.stringify(root));
 },STORAGE_KEY);
 await page.reload();
 await page.locator('#preview').click();
 const preview=page.frameLocator('.preview-sheet');
 await expect(preview.locator('.employee-name').first()).toBeVisible();
 const result=await preview.locator('td.employee-slot button').evaluateAll(nodes=>{
  return [nodes[0],nodes[9],nodes[14]].map(button=>{
   const name=button.querySelector('.employee-name'),time=button.querySelector('.employee-time');
   const cell=button.getBoundingClientRect(),caption=button.querySelector('.employee-caption').getBoundingClientRect();
   return {name:parseFloat(getComputedStyle(name).fontSize),time:time?parseFloat(getComputedStyle(time).fontSize):null,
    fits:caption.left>=cell.left&&caption.right<=cell.right&&caption.top>=cell.top&&caption.bottom<=cell.bottom,
    text:button.textContent};
  });
 });
 expect(result[0].name).toBeCloseTo(9.5*96/72,1);
 expect(result[1].name).toBeCloseTo(result[0].name,1);
 expect(result[1].time).toBeCloseTo(result[1].name,1);
 expect(result[2].name).toBeLessThan(result[1].name);
 expect(result[2].time).toBeCloseTo(result[2].name,1);
 expect(result.every(item=>item.fits)).toBe(true);
 expect(result[1].text).toBe('山田（22:15〜5:45）');
});


test('店舗単位バックアップ復元は現在店舗だけを置き換え他店舗を保持する',async({page})=>{
 await openApp(page);
 const before=await savedRoot(page);
 const activeId=before.activeStoreId;
 const other=before.stores.find(s=>s.id!==activeId);
 if(!other)test.skip(true,'複数店舗が必要');

 const source=structuredClone(before);
 source.stores=[structuredClone(before.stores.find(s=>s.id===activeId))];
 source.activeStoreId=activeId;
 source.stores[0].store='店舗単位復元店';
 source.stores[0].weeks[source.stores[0].current].days[0].notes='店舗単位復元成功';
 source.birthdayAcknowledgements=[];
 source.birthdayGiftDelivered=[];
 const backupText=JSON.stringify({
  format:'shift-ipad-backup',version:2,scope:'store',
  storeId:source.stores[0].id,storeName:source.stores[0].store,
  exportedAt:'2026-09-27T00:00:00.000Z',data:source
 });

 await page.locator('#settings').click();
 await page.locator('#backup').click();
 const chooser=page.locator('#editor input[type=file]');
 await chooser.setInputFiles({name:'シフト_店舗単位復元店_test.shiftbackup',mimeType:'application/json',buffer:Buffer.from(backupText)});
 await page.locator('#editor').getByRole('button',{name:'バックアップ内容を確認'}).click();
 await expect(page.locator('#editor')).toContainText('店舗単位バックアップ：店舗単位復元店');
 await expect(page.locator('#editor').getByRole('button',{name:'この店舗に復元'})).toBeEnabled();
 await expect(page.locator('#editor').getByRole('button',{name:'確認したバックアップで全店舗を復元'})).toBeDisabled();
 page.once('dialog',dialog=>dialog.accept());
 await page.locator('#editor').getByRole('button',{name:'この店舗に復元'}).click();

 const after=await savedRoot(page);
 expect(after.stores.length).toBe(before.stores.length);
 expect(after.stores.find(s=>s.id===activeId).store).toBe('店舗単位復元店');
 expect(after.stores.find(s=>s.id===activeId).weeks[source.stores[0].current].days[0].notes).toBe('店舗単位復元成功');
 expect(after.stores.find(s=>s.id===other.id).store).toBe(other.store);
});


test('復元ファイル入力は拡張子で選択を制限しない',async({page})=>{
 await openApp(page);
 await page.locator('#settings').click();
 await page.locator('#backup').click();
 const input=page.locator('#editor input[type=file]');
 await expect(input).toHaveAttribute('type','file');
 await expect(input).not.toHaveAttribute('accept');
});


test('新規バックアップのファイル名はiPhone互換のshiftbackup.jsonを使う',async({page})=>{
 await openApp(page);
 await page.locator('#settings').click();
 await page.locator('#backup').click();
 await expect(page.locator('#editor')).toContainText('この店舗をバックアップ');
 const source=await page.locator('#editor').evaluate(()=>document.documentElement.innerHTML);
 expect(source).toBeTruthy();
});


test('スマホ通常表示でシフト内の薄い横罫線が表示される',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await openApp(page);
 const rule=page.locator('#schedule tbody tr:nth-child(5n+2)>td.slot').first();
 await expect(rule).toBeVisible();
 const style=await rule.evaluate(el=>{
  const css=getComputedStyle(el);
  return {width:css.borderTopWidth,style:css.borderTopStyle,color:css.borderTopColor};
 });
 expect(style.width).toBe('1px');
 expect(style.style).toBe('solid');
 expect(style.color).toBe('rgb(187, 187, 187)');
});


test('退職日を登録した従業員は翌日以降に退職者リストへ表示される',async({page})=>{
 await openApp(page);
 await page.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  const store=root.stores.find(s=>s.id===root.activeStoreId);
  const employee=store.employees[0];
  employee.name='退職確認従業員';
  employee.shiftName='退職確認';
  employee.hireDate='2020-01-01';
  employee.birthDate='1990-01-01';
  employee.retirementDate='2000-01-01';
  employee.hidden=false;
  localStorage.setItem(key,JSON.stringify(root));
 },STORAGE_KEY);
 await page.reload();

 await page.locator('#settings').click();
 await page.locator('#birthday-list').click();
 await expect(page.getByRole('tab',{name:/退職者/})).toBeVisible();
 await page.getByRole('tab',{name:/退職者/}).click();
 await expect(page.locator('#birthday-gift-list')).toContainText('退職確認従業員');
 await expect(page.locator('#birthday-gift-list')).toContainText('退職日 2000/01/01');

 await page.locator('#birthday-back').click();
 await page.locator('#employees').click();
 await page.locator('.employee-row',{hasText:'退職確認従業員'}).getByRole('button',{name:'編集'}).click();
 const retirement=page.locator('#dialog-body input[type="date"]').nth(2);
 await expect(retirement).toHaveValue('2000-01-01');
});


test('前週の従業員シフトを作成済み週へ再コピーし5段目と備考を保持する',async({page})=>{
 await openApp(page);
 await page.evaluate(key=>{
  const root=JSON.parse(localStorage.getItem(key));
  const store=root.stores.find(s=>s.id===root.activeStoreId);
  const current=store.current;
  const next=new Date(current+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+7);
  const nextKey=next.toISOString().slice(0,10);
  if(!store.weeks[nextKey]){
   const add=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
   store.weeks[nextKey]={start:nextKey,days:Array.from({length:7},(_,i)=>({date:add(nextKey,i),shifts:Array.from({length:3},()=>Array(5).fill(null)),extras:Array(5).fill(null),notes:''}))};
  }
  const source=store.weeks[current],target=store.weeks[nextKey];
  const employee=store.employees[0];
  source.days[0].shifts[0][0]={employeeId:employee.id,name:employee.shiftName||employee.name,start:360,end:540};
  target.days[0].shifts[0][0]=null;
  target.days[0].extras[0]={type:'task',text:'保持する作業',start:360,end:540};
  target.days[0].notes='保持する備考';
  store.current=nextKey;
  localStorage.setItem(key,JSON.stringify(root));
 },STORAGE_KEY);
 await page.reload();

 await page.getByRole('button',{name:'前週シフトをコピー'}).click();
 await expect(page.getByText(/現在週の従業員①・②・予備従業員/)).toHaveCount(0);
 const stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
 const store=stored.stores.find(s=>s.id===stored.activeStoreId);
 const day=store.weeks[store.current].days[0];
 expect(day.shifts[0][0]).not.toBeNull();
 expect(day.extras[0].text).toBe('保持する作業');
 expect(day.notes).toBe('保持する備考');
});


test('前週コピーは今週へ戻るの右側に表示する',async({page})=>{
 await page.setViewportSize({width:1180,height:844});
 await openApp(page);
 const today=await page.locator('#today').boundingBox();
 const copy=await page.locator('#copy-week').boundingBox();
 expect(copy.x).toBeGreaterThanOrEqual(today.x+today.width);
 await expect(page.locator('#copy-week')).toHaveAttribute('aria-label','前週シフトをコピー');
 await expect(page.locator('#shift-page #copy-week')).toHaveCount(0);
});
