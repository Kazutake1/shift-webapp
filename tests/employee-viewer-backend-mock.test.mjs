import {isIP} from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {initialState} from '../model.js';
import {migrate} from '../stores.js';
import {projectScheduleRoot} from '../schedule-sync.js';
import {projectCloudViewerWeek} from '../supabase/functions/_shared/viewer-projection.mjs';
import * as security from '../supabase/functions/_shared/viewer-security.mjs';
import * as http from '../supabase/functions/_shared/viewer-http.mjs';

// An in-memory adapter exercises the UNMODIFIED Edge handler bodies. No real
// Supabase endpoints, personal data, fees, or server secrets are used.
// This cannot replace live Postgres transaction/RLS/security testing.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const OWNER = '00000000-0000-4000-8000-000000000001';
const WEEK = '2026-09-21';
const ADMIN_ORIGIN = 'https://manager.example.invalid';
const EMPLOYEE_ORIGIN = 'https://employee.example.invalid';
const MANAGER_TOKEN = 'synthetic-manager-jwt-for-tests-only';
const PEPPER = 'synthetic-local-test-pepper-never-use-in-production';

function fakeCloud() {
  const local = migrate(initialState());
  const store = local.stores[0];
  store.store = 'TEST-STORE-A';
  store.employees[0].name = 'PRIVATE-LEGAL-NAME';
  store.employees[0].shiftName = '朝A';
  store.employees[0].employeeNumber = 'PRIVATE-EMPLOYEE-NUMBER';
  store.employees[0].birthDate = '1990-01-01';
  const week = store.weeks[WEEK];
  week.days[0].shifts[0][0] = {
    employeeId: store.employees[0].id,
    name: 'PRIVATE-LEGAL-NAME',
    start: 360,
    end: 540
  };
  week.days[0].notes = 'PRIVATE-MANAGER-NOTE';
  week.confirmation = {
    confirmedAt: '2026-09-14T00:00:00.000Z',
    snapshot: {days: structuredClone(week.days)}
  };
  const cloud = projectScheduleRoot(local);
  const second = structuredClone(cloud.stores[0]);
  second.id = 'synthetic-store-B';
  second.store = 'TEST-STORE-B';
  cloud.stores.push(second);
  return {cloud, storeA: cloud.stores[0].id, storeB: second.id};
}

function memoryDatabase(cloud) {
  const tables = {
    shift_app_admins: [{user_id: OWNER}],
    shift_app_state: [{owner_id: OWNER, payload: cloud, revision:1}],
    employee_viewer_passwords: [],
    employee_viewer_sessions: [],
    employee_viewer_pin_limits: []
  };
  const counters = new Map();
  const rowMatches = (row,filters) => filters.every(([key,value]) => row[key] === value);
  const database = {
    tables,
    auth: {
      async getUser(jwt) {
        if (jwt === MANAGER_TOKEN) return {data:{user:{id:OWNER}}, error:null};
        if (jwt === 'synthetic-outsider-jwt-for-tests') {
          return {data:{user:{id:'00000000-0000-4000-8000-000000000099'}},error:null};
        }
        return {data:{user:null},error:{message:'invalid token'}};
      }
    },
    from(name) {
      assert.ok(Object.hasOwn(tables,name), 'unexpected table: ' + name);
      const filters = [];
      let deleting = false, patch;
      const query = {
        select() {return this;},
        eq(key,value) {filters.push([key,value]);return this;},
        update(row) {patch=row;return this;},
        async maybeSingle() {
          const row=tables[name].find(row => rowMatches(row,filters)) ?? null;
          if(row&&patch)Object.assign(row,structuredClone(patch));
          return {data:row,error:null};
        },
        async insert(row) {
          tables[name].push(structuredClone(row));
          return {error:null};
        },
        async upsert(row) {
          const current = tables[name].findIndex(x =>
            x.owner_id === row.owner_id && x.store_id === row.store_id);
          if (current >= 0) tables[name][current] = structuredClone(row);
          else tables[name].push(structuredClone(row));
          return {error:null};
        },
        delete() {deleting = true;return this;},
        then(resolve,reject) {
          assert.ok(deleting,'only delete query is awaitable in this adapter');
          tables[name] = tables[name].filter(row => !rowMatches(row,filters));
          return Promise.resolve({error:null}).then(resolve,reject);
        }
      };
      return query;
    },
    async rpc(name,args) {
      assert.ok(name === 'reserve_employee_viewer_pin_attempt' ||
        name === 'complete_employee_viewer_pin_attempt');
      const key = args.p_owner_id + ':' + args.p_store_id;
      const now = Date.now();
      if (name === 'reserve_employee_viewer_pin_attempt') {
        const admitted = [];
        for (const [source,max] of [['global',20],[args.p_source_hash,5]]) {
          const id = key + ':' + source;
          let state = counters.get(id);
          if (!state || now - state.since >= 900000 ||
              (state.until && state.until <= now)) {
            state = {since:now,attempts:0,until:0};
            counters.set(id,state);
          }
          if (state.until > now) return {data:false,error:null};
          if (state.attempts >= max) {
            state.until = now + 900000;
            return {data:false,error:null};
          }
          admitted.push(state);
        }
        for (const state of admitted) state.attempts++;
        return {data:true,error:null};
      }
      const state = counters.get(key + ':' + args.p_source_hash);
      if (state) {
        if (args.p_success) {
          state.attempts = 0;state.until = 0;state.since = now;
        } else if (state.attempts >= 5) {
          state.until = now + 900000;
        }
      }
      return {data:null,error:null};
    }
  };
  return database;
}

function makeFixture({verifiedIpHeader=false, readerRole='shift_viewer_week_reader', authRole='shift_viewer_auth'} = {}) {
  const {cloud,storeA,storeB} = fakeCloud();
  const db = memoryDatabase(cloud);
  // These are independently published copies; changing the manager fixtures
  // afterwards cannot make a week visible to the employee endpoint.
  const copies = new Map(cloud.stores.map(store => [
    store.id,projectCloudViewerWeek(cloud,store.id,WEEK)
  ]));
  const copyRevisions=new Map();
  const env = new Map([
    ['SUPABASE_URL','https://fake-project.supabase.co'],
    ['SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_SYNTHETIC_NOT_A_REAL_KEY'})],
    ['VIEWER_PIN_PEPPER',PEPPER],
    ['VIEWER_AUTH_DB_URL','postgresql://fake.example.invalid/auth'],
    ['VIEWER_WEEK_READER_DB_URL','postgresql://fake.example.invalid/viewer'],
    ['VIEWER_WEEK_PUBLISHER_DB_URL','postgresql://fake.example.invalid/publisher'],
    ['VIEWER_ADMIN_ORIGINS',ADMIN_ORIGIN],
    ['VIEWER_EMPLOYEE_ORIGIN',EMPLOYEE_ORIGIN]
  ]);
  if(verifiedIpHeader)env.set('VIEWER_VERIFIED_IP_HEADER','cf-connecting-ip');
  const deps = {
    isIP,
    createClient: () => db,
    ...security,
    ...http,
    projectCloudViewerWeek,
    postgres: connection => async (query,code,week,revision,sheet,expires) => {
      if(connection.endsWith('/auth')){
        const sql=query.join('?').trim();
        const rows=db.tables;
        if(sql.includes('as auth_role'))return [{auth_role:authRole}];
        if(sql.includes('reserve_employee_viewer_pin_attempt')){
          const {data}=await db.rpc('reserve_employee_viewer_pin_attempt',{p_owner_id:code,p_store_id:week,p_source_hash:revision});
          return [{admitted:data}];
        }
        if(sql.includes('complete_employee_viewer_pin_attempt')){
          await db.rpc('complete_employee_viewer_pin_attempt',{p_owner_id:code,p_store_id:week,p_source_hash:revision,p_success:sheet});
          return [];
        }
        if(sql.startsWith('delete from public.employee_viewer_sessions')){
          rows.employee_viewer_sessions=rows.employee_viewer_sessions.filter(row=>row.token_hash!==code);
          return [];
        }
        if(sql.startsWith('insert into public.employee_viewer_sessions')){
          rows.employee_viewer_sessions.push({token_hash:code,owner_id:week,store_id:revision,session_epoch:sheet,expires_at:expires});
          return [];
        }
        if(sql.includes('from public.employee_viewer_sessions'))return rows.employee_viewer_sessions.filter(row=>row.token_hash===code);
        if(sql.includes('from public.shift_app_admins'))return rows.shift_app_admins.filter(row=>row.user_id===code);
        if(sql.includes('from public.employee_viewer_passwords')){
          return rows.employee_viewer_passwords.filter(row=>week===undefined?row.viewer_code===code:row.owner_id===code&&row.store_id===week);
        }
        assert.fail('unexpected auth query');
      }
      if(connection.endsWith('/publisher')){
        assert.match(query.join(''), /shift_viewer_private\.apply_published_week/);
        const credential = db.tables.employee_viewer_passwords.find(row => row.viewer_code===code);
        assert.ok(credential);
        assert.equal(week,WEEK);
        if(revision<=(copyRevisions.get(code)??0))return [{applied:false}];
        copyRevisions.set(code,revision);
        if(sheet===null)copies.delete(credential.store_id);
        else copies.set(credential.store_id,JSON.parse(sheet));
        return [{applied:true}];
      }
      assert.match(query.join(''), /shift_viewer_private\.published_weeks/);
      const credential = db.tables.employee_viewer_passwords.find(row => row.viewer_code===code);
      return [{reader_role:readerRole,sheet:week===WEEK?copies.get(credential?.store_id)??null:null}];
    }
  };
  function handler(relativePath) {
    const raw = readFileSync(new URL(relativePath, import.meta.url),'utf8');
    // Both entrypoints contain standard JavaScript syntax, despite .ts suffix.
    // Strip *only* import declarations so the original handler body executes.
    const source = raw.replace(/^import[\s\S]*?;\s*\n/gm,'');
    assert.doesNotMatch(source,/^import /m);
    let served;
    const Deno = {env:{get:key => env.get(key)},serve:fn => {served=fn;}};
    const symbols = Object.keys(deps);
    const evaluator = new Function('Deno',...symbols,source);
    evaluator(Deno,...symbols.map(x => deps[x]));
    assert.equal(typeof served,'function');
    return served;
  }
  const admin = handler('../supabase/functions/employee-viewer-admin/index.ts');
  const access = handler('../supabase/functions/employee-viewer-access/index.ts');
  const request = (url,method,origin,body,authorization,ip) => {
    const headers = {'Origin':origin,'Content-Type':'application/json'};
    if (authorization) headers.Authorization = 'Bearer ' + authorization;
    if (ip) headers['cf-connecting-ip'] = ip;
    return new Request(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
  };
  return {
    db,cloud,storeA,storeB,copies,
    adminSet: (storeId,password,jwt=MANAGER_TOKEN) => admin(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-admin',
      'POST',ADMIN_ORIGIN,{storeId,password},jwt)),
    adminGet: (storeId,jwt=MANAGER_TOKEN) => admin(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-admin?storeId='+
       encodeURIComponent(storeId),'GET',ADMIN_ORIGIN,null,jwt)),
    stop: (storeId,jwt=MANAGER_TOKEN) => admin(request(
       'https://fake-project.supabase.co/functions/v1/employee-viewer-admin',
       'POST',ADMIN_ORIGIN,{action:'stopViewer',storeId},jwt)),
    publish: (storeId,extra={},jwt=MANAGER_TOKEN) => admin(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-admin',
      'POST',ADMIN_ORIGIN,{action:'syncPublishedWeek',storeId,weekStart:WEEK,...extra},jwt)),
    login: (viewerCode,password,ip='192.0.2.10',origin=EMPLOYEE_ORIGIN) => access(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-access',
      'POST',origin,{viewerCode,password},null,ip)),
    logout: token => access(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-access',
      'POST',EMPLOYEE_ORIGIN,{action:'logout'},token)),
    view: (token,weekStart=WEEK,extra='') => access(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-access?weekStart='+
       weekStart+extra,'GET',EMPLOYEE_ORIGIN,null,token))
  };
}

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
  assert.deepEqual(Object.keys(await status.json()).sort(),['configured','lastChangedAt']);
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
