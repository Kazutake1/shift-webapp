import {test,expect} from '@playwright/test';
import {makeFixture,WEEK as fixtureWeek} from './employee-viewer-backend-fixture.mjs';

const code='8b4caf62-3fd5-4a2c-8c67-5dca45d68d7f';
const token='A'.repeat(43);
const week='2026-11-09';
const sample=()=>({
 format:'employee-schedule-only-v1',storeName:'テスト店舗',weekStart:week,
 fixed:Array.from({length:5},(_,i)=>({text:i===0?'売上日報':'',days:[0,1,2,3,4,5,6],start:360,end:540})),
 days:Array.from({length:7},(_,day)=>{
  const d=new Date(week+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+day);
  return {date:d.toISOString().slice(0,10),
   shifts:Array.from({length:3},(_,row)=>Array.from({length:5},(_,band)=>row===0&&band===0?{name:'朝A',start:360,end:540}:null)),
   extras:Array.from({length:5},()=>null)
  };
 })
});
function replies(origin){
 return {
  'access-control-allow-origin':origin,
  'access-control-allow-headers':'authorization,content-type',
  'access-control-allow-methods':'GET,POST,OPTIONS',
  'content-type':'application/json'
 };
}

test('従業員用サイト：店舗共通6桁パスワードで既存の週間シフト表だけを閲覧',async({page})=>{
 const requests=[];
 await page.route('https://employee-viewer.invalid/functions/v1/employee-viewer-access**',async route=>{
  const req=route.request();
  requests.push({method:req.method(),url:req.url(),body:req.postData()});
  const headers=replies('http://127.0.0.1:4173');
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(req.method()==='POST'){
   if(req.postDataJSON()?.password!=='583941')return route.fulfill({status:401,headers,body:'{}'});
   return route.fulfill({status:200,headers,body:JSON.stringify({token,expiresAt:'2030-01-01T00:00:00Z'})});
  }
  const requestedWeek=new URL(req.url()).searchParams.get('weekStart');
  if(requestedWeek!==week)return route.fulfill({status:404,headers,body:JSON.stringify({error:'not shown'})});
  return route.fulfill({status:200,headers,body:JSON.stringify(sample())});
 });
 await page.clock.setFixedTime(new Date('2026-11-10T10:00:00+09:00'));
 await page.goto('/dist-viewer/index.html?code='+code);
 await expect(page.locator('#viewer-login')).toBeVisible();
 await page.locator('#viewer-pin').fill('583941');
 await page.locator('#viewer-login-button').click();
 await expect(page.locator('#viewer-sheet-page')).toBeVisible();
 await expect(page.locator('#viewer-store-name')).toHaveText('テスト店舗');
 await expect(page.locator('#schedule tbody tr')).toHaveCount(35);
 await expect(page.locator('#schedule')).toContainText('朝A');
 await expect(page.locator('#schedule')).toContainText('売上日報');
 await expect(page.locator('#schedule')).not.toContainText('従業員番号');
 await expect(page.locator('body')).not.toContainText('確定');
 await expect(page.locator('body')).not.toContainText('未確定');
 await expect(page.locator('#viewer-pin')).toHaveValue('');
 expect(requests.some(item=>item.method==='POST'&&JSON.parse(item.body).viewerCode===code)).toBe(true);
 await page.locator('#viewer-next').click();
 await expect(page.locator('#viewer-sheet-message')).toHaveText('この週のシフト表は表示できません。');
 await expect(page.locator('body')).not.toContainText('未確定');
 await page.locator('#viewer-logout').click();
 await expect(page.locator('#viewer-login')).toBeVisible();
 expect(await page.evaluate(()=>sessionStorage.getItem('shift-employee-viewer-session-v1'))).toBeNull();
});

test('従業員用サイト：QRコードの店舗識別子がなければログイン不可',async({page})=>{
 await page.goto('/dist-viewer/index.html');
 await expect(page.locator('#viewer-login-error')).toContainText('QRコード');
 await page.locator('#viewer-pin').fill('583941');
 await page.locator('#viewer-login-button').click();
 await expect(page.locator('#viewer-sheet-page')).toBeHidden();
});

test('従業員用サイト：連続失敗制限を説明し、間違ったパスワードは残さない',async({page})=>{
 await page.route('https://employee-viewer.invalid/functions/v1/employee-viewer-access**',route=>
  route.fulfill({status:429,headers:replies('http://127.0.0.1:4173'),body:'{}'}));
 await page.goto('/dist-viewer/index.html?code='+code);
 await page.locator('#viewer-pin').fill('583941');
 await page.locator('#viewer-login-button').click();
 await expect(page.locator('#viewer-login-error')).toContainText('15分後');
 await expect(page.locator('#viewer-pin')).toHaveValue('');
 await expect(page.locator('#viewer-sheet-page')).toBeHidden();
});

test('従業員用サイト：スマホ幅で制限を案内し、解除後に同じ画面からログインできる',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.clock.setFixedTime(new Date('2026-11-10T10:00:00+09:00'));
 let locked=true;
 await page.route('https://employee-viewer.invalid/functions/v1/employee-viewer-access**',async route=>{
  const headers=replies('http://127.0.0.1:4173');
  const method=route.request().method();
  if(method==='OPTIONS')return route.fulfill({status:204,headers});
  if(method==='POST'){
   if(locked)return route.fulfill({status:429,headers,body:'{}'});
   return route.fulfill({status:200,headers,body:JSON.stringify({token,expiresAt:'2030-01-01T00:00:00Z'})});
  }
  return route.fulfill({status:200,headers,body:JSON.stringify(sample())});
 });
 await page.goto('/dist-viewer/index.html?code='+code);
 const pin=page.locator('#viewer-pin');
 const login=page.locator('#viewer-login-button');
 await pin.fill('583941');
 await login.click();
 await expect(page.locator('#viewer-login-error')).toContainText('15分後');
 await expect(pin).toHaveValue('');
 await expect(page.locator('#viewer-sheet-page')).toBeHidden();

 locked=false;
 await pin.fill('583941');
 await login.click();
 await expect(page.locator('#viewer-sheet-page')).toBeVisible();
 await expect(page.locator('#viewer-store-name')).toHaveText('テスト店舗');
});


test('スマホ幅：2店舗のPIN・閲覧制限・更新・停止を実際のハンドラーで確認',async({page})=>{
 test.setTimeout(35000);
 const origin='http://127.0.0.1:4173';
 const fixtureOrigin='https://employee.example.invalid';
 const f=makeFixture({verifiedIpHeader:true,employeeOrigin:fixtureOrigin});
 for(const [store,pin] of [[f.storeA,'583941'],[f.storeB,'749281']]){
  expect((await f.adminSet(store,pin)).status).toBe(200);
  expect((await f.publish(store)).status).toBe(200);
 }
 const [a,b]=f.db.tables.employee_viewer_passwords;
 let ip='192.0.2.10';
 await page.setViewportSize({width:390,height:844});
 await page.clock.setFixedTime(new Date(fixtureWeek+'T12:00:00+09:00'));
 await page.route('https://employee-viewer.invalid/functions/v1/employee-viewer-access**',async route=>{
  const req=route.request();
  const headers=new Headers(await req.allHeaders());
  // The handler only trusts HTTPS origins. The intercepted browser is
  // served over local HTTP; bridge the approved fixture origin at this boundary.
  headers.set('origin',fixtureOrigin);
  headers.set('cf-connecting-ip',ip);
  const body=req.postData();
  const result=await f.access(new Request(req.url(),{
   method:req.method(),headers,...(body===null?{}:{body})
  }));
  const responseHeaders=new Headers(result.headers);
  if(responseHeaders.get('access-control-allow-origin')===fixtureOrigin){
   responseHeaders.set('access-control-allow-origin',origin);
  }
  await route.fulfill({status:result.status,headers:Object.fromEntries(responseHeaders),body:await result.text()});
 });
 const open=record=>page.goto('/dist-viewer/index.html?code='+record.viewer_code);
 const pinField=page.locator('#viewer-pin');
 const loginButton=page.locator('#viewer-login-button');
 const login=async(pin,expectedStatus)=>{
  // A repeated validation message can still be from the previous attempt.
  // Wait for this request and the form's cleanup before sending another PIN.
  await expect(loginButton).toBeEnabled();
  await expect(pinField).toHaveValue('');
  await pinField.fill(pin);
  const [response]=await Promise.all([
   page.waitForResponse(resp=>resp.url().endsWith('/employee-viewer-access')&&resp.request().method()==='POST'),
   loginButton.click()
  ]);
  expect(response.status()).toBe(expectedStatus);
  await expect(loginButton).toBeEnabled();
  await expect(pinField).toHaveValue('');
 };
 const error=page.locator('#viewer-login-error');
 await open(a);
 for(let i=0;i<5;i++){
  await login('583940',401);
  await expect(error).toContainText('パスワードを確認');
 }
 await login('583941',429);
 await expect(error).toContainText('15分後');

 await open(b);
 await login('749281',200);
 await expect(page.locator('#viewer-store-name')).toHaveText('TEST-STORE-B');
 ip='192.0.2.11';
 await open(a);
 await login('583941',200);
 await expect(page.locator('#viewer-store-name')).toHaveText('TEST-STORE-A');
 await expect(page.locator('#schedule')).not.toContainText('PRIVATE-');

 const row=f.db.tables.shift_app_state[0];
 row.revision++;
 row.payload.stores[0].store='更新後のテスト店舗';
 expect((await f.publish(f.storeA)).status).toBe(200);
 await page.reload();
 await expect(page.locator('#viewer-store-name')).toHaveText('更新後のテスト店舗');

 expect((await f.stop(f.storeA)).status).toBe(200);
 await page.reload();
 await expect(page.locator('#viewer-login')).toBeVisible();
 await expect(page.locator('#viewer-sheet-page')).toBeHidden();
 await login('583941',401);
 await expect(error).toContainText('パスワードを確認');
});
