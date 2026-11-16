import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {initialState} from '../model.js';
import {migrate} from '../stores.js';
import {projectScheduleRoot} from '../schedule-sync.js';
import {projectCloudViewerWeek} from '../supabase/functions/_shared/viewer-projection.mjs';
import {hashPin,verifyPin,sha256Hex,validWeekStart,validViewerCode,
 createViewerToken,assertServerPin,PIN_KDF_ITERATIONS} from '../supabase/functions/_shared/viewer-security.mjs';
import {allowedOrigins,corsHeaders,secureEnvironment,readSmallJson} from '../supabase/functions/_shared/viewer-http.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const WEEK='2026-09-21';
const pepper='synthetic-pepper-for-test-only-abcdef-1234567890';
const file=path=>readFileSync(new URL(path,import.meta.url),'utf8');
function sample(){
 const root=migrate(initialState());
 const store=root.stores[0],week=store.weeks[WEEK];
 store.store='TEST-STORE';
 store.fixed[0]='売上日報';
 store.employees[0].name='SecretRealName';
 store.employees[0].shiftName='朝A';
 store.employees[0].employeeNumber='SENSITIVE-NUMBER';
 store.employees[0].birthDate='1990-01-02';
 week.days[0].shifts[0][0]={
  employeeId:store.employees[0].id,name:'SecretRealName',start:360,end:540
 };
 week.days[0].notes='PRIVATE-DAILY-NOTE';
 week.days[0].extras[0]={type:'task',text:'補充',start:360,end:540};
 week.days[0].extras[1]={type:'training',employeeId:store.employees[0].id,name:'SecretRealName',start:540,end:780};
 week.confirmation={confirmedAt:'2026-09-14T08:00:00.000Z',snapshot:{days:structuredClone(week.days)}};
 return root;
}

test('gateway projected week has the existing 7-day, 3-row, 5-band fixed/extra layout but no personal records',()=>{
 const local=sample(),cloud=projectScheduleRoot(local);
 const pub=projectCloudViewerWeek(cloud,local.activeStoreId,WEEK);
 assert.ok(pub);
 assert.equal(pub.format,'employee-schedule-only-v1');
 assert.equal(pub.weekStart,WEEK);
 assert.equal(pub.storeName,'TEST-STORE');
 assert.equal(pub.days.length,7);
 assert.equal(pub.fixed.length,5);
 assert.equal(pub.fixed[0].text,'売上日報');
 assert.equal(pub.days[0].shifts.length,3);
 assert.equal(pub.days[0].shifts[0].length,5);
 assert.equal(pub.days[0].shifts[0][0].name,'朝A');
 assert.equal(pub.days[0].extras.length,5);
 assert.deepEqual(pub.days[0].extras[0],{type:'task',text:'補充',start:360,end:540});
 assert.deepEqual(pub.days[0].extras[1],{type:'training',name:'朝A',start:540,end:780});
 const json=JSON.stringify(pub);
 for(const secret of ['employeeId','employees','sharedId','employeeNumber','birthDate',
  'retirementDate','confirmation','confirmedAt','snapshot','notes','owner_id','activeStoreId',
  'SecretRealName','SENSITIVE-NUMBER','PRIVATE-DAILY-NOTE',storeSecret(cloud)]){
  assert.equal(json.includes(secret),false,'unexpected data: '+secret);
 }
});
function storeSecret(cloud){return cloud.stores[0].weeks[WEEK].days[0].shifts[0][0].employeeId;}
test('gateway refuses any unconfirmed week, unknown store, non Monday, or malformed cloud data',()=>{
 const local=sample();const store=local.stores[0];
 let cloud=projectScheduleRoot(local);
 assert.equal(projectCloudViewerWeek(cloud,'unknown-store',WEEK),null);
 assert.equal(projectCloudViewerWeek(cloud,local.activeStoreId,'2026-09-22'),null);
 assert.equal(projectCloudViewerWeek({...cloud,syncFormat:'not-approved'},local.activeStoreId,WEEK),null);
 delete cloud.stores[0].weeks[WEEK].confirmation;
 assert.equal(projectCloudViewerWeek(cloud,local.activeStoreId,WEEK),null);
 cloud=projectScheduleRoot(local);
 cloud.stores[0].weeks[WEEK].days[0].shifts[0].pop();
 assert.equal(projectCloudViewerWeek(cloud,store.id,WEEK),null);
});

test('gateway includes changes after confirmation, not the old snapshot',()=>{
 const root=sample(),week=root.stores[0].weeks[WEEK];
 week.days[0].shifts[0][0].start=390;
 const pub=projectCloudViewerWeek(projectScheduleRoot(root),root.activeStoreId,WEEK);
 assert.equal(pub.days[0].shifts[0][0].start,390);
 assert.equal(week.confirmation.snapshot.days[0].shifts[0][0].start,360);
});

test('PIN verification: salted, peppered, irreversible and wrong PIN rejected',async()=>{
 const pin='583941';
 assert.doesNotThrow(()=>assertServerPin(pin));
 for(const value of ['12345','1234567','000000','123456','１２３４５６']){
  assert.throws(()=>assertServerPin(value));
 }
 const first=await hashPin(pin,pepper);
 assert.equal(first.kdf_iterations,PIN_KDF_ITERATIONS);
 assert.equal(first.password_hash.includes(pin),false);
 assert.equal(first.password_salt.includes(pin),false);
 assert.equal(await verifyPin(pin,pepper,first),true);
 assert.equal(await verifyPin('583942',pepper,first),false);
 assert.equal(await verifyPin(pin,pepper+'z',first),false);
 const second=await hashPin(pin,pepper);
 assert.notEqual(first.password_salt,second.password_salt);
 assert.notEqual(first.password_hash,second.password_hash);
});

test('opaque viewer session has no owner/store identifier and is hashed before DB lookup',async()=>{
 const token=createViewerToken();
 const other=createViewerToken();
 assert.match(token,/^[A-Za-z0-9_-]{43}$/);
 assert.notEqual(token,other);
 const digest=await sha256Hex(token);
 assert.match(digest,/^[0-9a-f]{64}$/);
 assert.equal(digest.includes(token),false);
});

test('week and viewer link identifiers validated before data lookup',()=>{
 assert.equal(validWeekStart('2026-09-21'),true);
 for(const value of ['2026-09-22','2026-09-31','2026-9-21','2026-02-30']){
  assert.equal(validWeekStart(value),false);
 }
 assert.equal(validViewerCode('8b4caf62-3fd5-4a2c-8c67-5dca45d68d7f'),true);
 assert.equal(validViewerCode('first-store'),false);
});

test('Edge HTTP security: only configured origins, no incomplete server config',async()=>{
 const req=new Request('https://test.invalid/',{headers:{Origin:'https://employee.example.com'}});
 assert.equal(corsHeaders(req,['https://employee.example.com'])['Access-Control-Allow-Origin'],'https://employee.example.com');
 assert.equal(corsHeaders(req,['https://random.example.com']),null);
 assert.deepEqual(allowedOrigins('http://unsafe.local,https://employee.example.com'),['https://employee.example.com']);
 assert.throws(()=>secureEnvironment({get:()=>undefined}),/not configured/);
 const json=await readSmallJson(new Request('https://test.invalid/',{method:'POST',body:JSON.stringify({code:1})}));
 assert.deepEqual(json,{code:1});
});

test('SQL draft denies direct public/employee credential and session access, and has an atomic reservation',()=>{
 const sql=file('../employee-viewer/backend/credential-schema-draft.sql');
 for(const name of ['employee_viewer_passwords','employee_viewer_sessions','employee_viewer_pin_limits']){
  assert.ok(sql.includes('alter table public.'+name+' enable row level security'));
  assert.ok(sql.includes('revoke all on table public.'+name+' from public,anon,authenticated'));
 }
 assert.match(sql,/for update/);
 assert.match(sql,/reserve_employee_viewer_pin_attempt/);
 assert.match(sql,/complete_employee_viewer_pin_attempt/);
 assert.match(sql,/revoke all on function public.reserve_employee_viewer_pin_attempt/);
 assert.match(sql,/grant execute on function public.reserve_employee_viewer_pin_attempt/);
 assert.match(sql,/v_limit/);
});

test('Edge handlers have no direct client route to admin state or password hashes',()=>{
 const viewer=file('../supabase/functions/employee-viewer-access/index.ts');
 const admin=file('../supabase/functions/employee-viewer-admin/index.ts');
 assert.match(viewer,/shift_viewer_private\.read_viewer_week/);
 assert.doesNotMatch(viewer,/shift_app_state/);
 assert.match(viewer,/verifyPin/);
 assert.match(viewer,/reserve_employee_viewer_pin_attempt/);
 assert.match(viewer,/session_epoch/);
 assert.match(viewer,/where owner_id=\$\{session\.owner_id\}::uuid and store_id=\$\{session\.store_id\}/);
 assert.doesNotMatch(viewer,/secureEnvironment|SUPABASE_SECRET_KEYS|createClient/);
 assert.doesNotMatch(viewer,/reply\(req,origins,200,state/);
 assert.match(admin,/db\.auth\.getUser\(token\)/);
 assert.match(admin,/shift_app_admins/);
 assert.match(admin,/session_epoch:crypto\.randomUUID\(\)/);
});
