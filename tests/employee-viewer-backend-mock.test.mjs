import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFixture,WEEK} from './employee-viewer-backend-fixture.mjs';

test('mock backend: administrator permission and store ownership are checked',async () => {
  const f = makeFixture();
  assert.equal((await f.adminSet('not-my-store','583941')).status,403);
  assert.equal((await f.adminSet(f.storeA,'583941',
    'synthetic-outsider-jwt-for-tests')).status,403);
  assert.equal((await f.adminGet(f.storeA,'synthetic-invalid-jwt-token')).status,401);
  assert.equal((await f.adminSet(f.storeA,'123456')).status,400);
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const status = await f.adminGet(f.storeA);
  assert.equal(status.status,200);
  assert.deepEqual(Object.keys(await status.json()).sort(),['configured','lastChangedAt','viewerUrl']);
  assert.equal(f.db.tables.employee_viewer_passwords.length,1);
  assert.equal(f.db.tables.employee_viewer_passwords[0].password_hash.includes('583941'),false);
});

test('mock backend: login and confirmed schedule return only store A data',async () => {
  const f = makeFixture();
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const viewerCode = f.db.tables.employee_viewer_passwords[0].viewer_code;
  assert.equal((await f.login(viewerCode,'583940')).status,401);
  const auth = await f.login(viewerCode,'583941');
  assert.equal(auth.status,200);
  const {token,expiresAt} = await auth.json();
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt)>Date.now());
  const res = await f.view(token);
  assert.equal(res.status,200);
  const json = await res.json();
  assert.equal(json.storeName,'TEST-STORE-A');
  assert.equal(json.days[0].shifts[0][0].name,'朝A');
  const raw = JSON.stringify(json);
  for (const forbidden of ['PRIVATE-LEGAL-NAME','PRIVATE-EMPLOYEE-NUMBER',
    'PRIVATE-MANAGER-NOTE','birthDate','employeeId','employees','owner_id',
    'session_epoch','password_hash','confirmedAt']) {
    assert.equal(raw.includes(forbidden),false,forbidden+' leaked');
  }
  // Client-side storeId query tampering cannot change server-scoped session.
  const attemptedSwap = await f.view(token,WEEK,'&storeId='+f.storeB);
  assert.equal(attemptedSwap.status,200);
  assert.equal((await attemptedSwap.json()).storeName,'TEST-STORE-A');
  assert.equal((await f.view('non-session-token')).status,401);
});

test('mock backend: store passwords are isolated, and rotation revokes old token',async () => {
  const f = makeFixture();
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  assert.equal((await f.adminSet(f.storeB,'749281')).status,200);
  const [a,b] = f.db.tables.employee_viewer_passwords;
  assert.notEqual(a.viewer_code,b.viewer_code);
  assert.equal((await f.login(b.viewer_code,'583941')).status,401);
  const aLogin = await f.login(a.viewer_code,'583941');
  const {token:oldToken} = await aLogin.json();
  assert.equal((await f.view(oldToken)).status,200);
  assert.equal((await f.adminSet(f.storeA,'948215')).status,200);
  assert.equal((await f.view(oldToken)).status,401);
  assert.equal((await f.login(a.viewer_code,'583941')).status,401);
  const newLogin = await f.login(a.viewer_code,'948215');
  assert.equal(newLogin.status,200);
  const bLogin = await f.login(b.viewer_code,'749281');
  assert.equal(bLogin.status,200);
  assert.equal((await f.view((await bLogin.json()).token).then(r=>r.json())).storeName,
    'TEST-STORE-B');
});

test('mock backend: fifth wrong PIN locks this source and prevents correct PIN',async () => {
  const f = makeFixture({verifiedIpHeader:true});
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const code = f.db.tables.employee_viewer_passwords[0].viewer_code;
  for(let i=0;i<5;i++) {
    assert.equal((await f.login(code,'583940','198.51.100.20')).status,401);
  }
  assert.equal((await f.login(code,'583941','198.51.100.20')).status,429);
  // A different source can still log in (the separate store-global budget
  // is not exhausted); the mock does not validate edge IP header integrity.
  assert.equal((await f.login(code,'583941','198.51.100.21')).status,200);
});

test('mock backend: unconfirmed week, expired token, revoked admin, bad origin deny',async () => {
  const f = makeFixture();
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const code = f.db.tables.employee_viewer_passwords[0].viewer_code;
  assert.equal((await f.login(code,'583941','203.0.113.10','https://evil.invalid')).status,403);
  const result = await f.login(code,'583941');
  const {token} = await result.json();
  f.copies.delete(f.storeA);
  assert.equal((await f.view(token)).status,404);

  f.db.tables.employee_viewer_sessions[0].expires_at = '2020-01-01T00:00:00.000Z';
  assert.equal((await f.view(token)).status,401);
  const newResult = await f.login(code,'583941');
  const newToken = (await newResult.json()).token;
  f.db.tables.shift_app_admins = [];
  assert.equal((await f.view(newToken)).status,403);
});

test('mock backend: logout revokes only the current viewing session',async () => {
  const f = makeFixture();
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const code = f.db.tables.employee_viewer_passwords[0].viewer_code;
  const {token:first} = await (await f.login(code,'583941')).json();
  const {token:second} = await (await f.login(code,'583941')).json();
  assert.equal((await f.view(first)).status,200);
  assert.equal((await f.logout()).status,401);
  assert.equal((await f.logout(first)).status,200);
  assert.equal((await f.view(first)).status,401);
  assert.equal((await f.logout(first)).status,200);
  assert.equal((await f.view(second)).status,200);
});

test('mock backend: unverified ingress uses one shared source limit',async () => {
  const f = makeFixture();
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const code = f.db.tables.employee_viewer_passwords[0].viewer_code;
  for(let i=1;i<=5;i++) {
    assert.equal((await f.login(code,'583940','198.51.100.'+i)).status,401);
  }
  assert.equal((await f.login(code,'583941','198.51.100.6')).status,429);
});

test('mock backend: shared IPv6 blocks the same network without blocking another network or store',async () => {
  const f = makeFixture({verifiedIpHeader:true});
  for(const store of [f.storeA,f.storeB]) {
    assert.equal((await f.adminSet(store,'583941')).status,200);
  }
  const [a,b] = f.db.tables.employee_viewer_passwords;
  for(let i=0;i<5;i++) {
    assert.equal((await f.login(a.viewer_code,'583940','2001:db8::1')).status,401);
  }
  assert.equal((await f.login(a.viewer_code,'583941','2001:0DB8:0:0:0:0:0:1')).status,429);
  assert.equal((await f.login(a.viewer_code,'583941','2001:db8::2')).status,200);
  assert.equal((await f.login(b.viewer_code,'583941','2001:db8::1')).status,200);
});

test('mock backend: requests with no ingress address use the shared fallback limit',async () => {
  const f = makeFixture({verifiedIpHeader:true});
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const [{viewer_code}] = f.db.tables.employee_viewer_passwords;
  for(let i=0;i<5;i++) {
    assert.equal((await f.login(viewer_code,'583940',null)).status,401);
  }
  assert.equal((await f.login(viewer_code,'583941',null)).status,429);
  assert.equal((await f.login(viewer_code,'583941','198.51.100.1')).status,200);
});

test('mock backend: a connection with the wrong reader role does not serve a schedule',async () => {
  const f = makeFixture({readerRole:'postgres'});
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const [{viewer_code}] = f.db.tables.employee_viewer_passwords;
  const {token} = await (await f.login(viewer_code,'583941')).json();
  assert.equal((await f.view(token)).status,503);
});


test('mock backend: publishing uses committed data, checks store ownership and withdraws an unconfirmed week',async () => {
  const f = makeFixture();
  assert.equal((await f.publish(f.storeA)).status,409);
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const [{viewer_code}] = f.db.tables.employee_viewer_passwords;
  const {token} = await (await f.login(viewer_code,'583941')).json();
  assert.equal((await f.publish(f.storeA,{},token)).status,401);
  assert.equal((await f.publish('unowned-store')).status,403);
  const row=f.db.tables.shift_app_state[0];
  row.payload.stores[0].store='保存済み店舗名';
  assert.deepEqual(await (await f.publish(f.storeA,{sheet:{storeName:'UNTRUSTED'},revision:100})).json(),{applied:true});
  assert.equal((await (await f.view(token)).json()).storeName,'保存済み店舗名');
  row.revision=2;
  delete row.payload.stores[0].weeks[WEEK].confirmation;
  assert.deepEqual(await (await f.publish(f.storeA)).json(),{applied:true});
  assert.equal((await f.view(token)).status,404);
  assert.equal(f.copies.get(f.storeB).storeName,'TEST-STORE-B');
});


test('mock backend: a manager can stop one store without stopping another',async () => {
  const f=makeFixture();
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  assert.equal((await f.adminSet(f.storeB,'749281')).status,200);
  const [a,b]=f.db.tables.employee_viewer_passwords;
  const {token:aToken}=await (await f.login(a.viewer_code,'583941')).json();
  const {token:bToken}=await (await f.login(b.viewer_code,'749281')).json();
  assert.equal((await f.stop(f.storeA,aToken)).status,401);
  assert.equal((await f.stop('unowned-store')).status,403);
  assert.equal((await f.stop(f.storeA)).status,200);
  assert.equal((await f.view(aToken)).status,401);
  assert.equal((await f.login(a.viewer_code,'583941')).status,401);
  assert.equal((await f.view(bToken)).status,200);
  assert.equal((await f.stop(f.storeA)).status,200);
});


test('mock backend: the viewer refuses a connection with the wrong auth role',async () => {
  const f=makeFixture({authRole:'postgres'});
  assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
  const [{viewer_code}]=f.db.tables.employee_viewer_passwords;
  assert.equal((await f.login(viewer_code,'583941')).status,503);
  assert.equal(f.db.tables.employee_viewer_sessions.length,0);
});


test('mock backend: the viewer will not run on the manager host or beside publishing credentials',async () => {
  for(const flags of [
    {viewerHost:'https://fake-project.supabase.co'},
    {viewerHost:'https://wpyhkewwzsdcstypcbmq.supabase.co'},
    {carryPublisherSecret:true}
  ]){
    const f=makeFixture(flags);
    assert.equal((await f.adminSet(f.storeA,'583941')).status,200);
    const [{viewer_code}]=f.db.tables.employee_viewer_passwords;
    assert.equal((await f.login(viewer_code,'583941')).status,503);
    assert.equal(f.db.tables.employee_viewer_sessions.length,0);
  }
});

test('mock backend: manager gets a store-specific viewer link without the PIN',async()=>{
 const f=makeFixture();
 const initial=await (await f.adminGet(f.storeA)).json();
 assert.equal(initial.viewerUrl,undefined);
 const configured=await (await f.adminSet(f.storeA,'583941')).json();
 const url=new URL(configured.viewerUrl);
 assert.equal(url.origin,'https://employee.example.invalid');
 assert.deepEqual([...url.searchParams],[['code',f.db.tables.employee_viewer_passwords[0].viewer_code]]);
 assert.equal(JSON.stringify(configured).includes('583941'),false);
 assert.equal((await (await f.adminGet(f.storeA)).json()).viewerUrl,url.href);
 await f.stop(f.storeA);
 assert.equal((await (await f.adminGet(f.storeA)).json()).viewerUrl,undefined);
});
