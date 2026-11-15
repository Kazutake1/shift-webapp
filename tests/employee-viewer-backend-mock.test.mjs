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
    shift_app_state: [{owner_id: OWNER, payload: cloud}],
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
      let deleting = false;
      const query = {
        select() {return this;},
        eq(key,value) {filters.push([key,value]);return this;},
        async maybeSingle() {
          return {data:tables[name].find(row => rowMatches(row,filters)) ?? null,error:null};
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

function makeFixture() {
  const {cloud,storeA,storeB} = fakeCloud();
  const db = memoryDatabase(cloud);
  const env = new Map([
    ['SUPABASE_URL','https://fake-project.supabase.co'],
    ['SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_SYNTHETIC_NOT_A_REAL_KEY'})],
    ['VIEWER_PIN_PEPPER',PEPPER],
    ['VIEWER_ADMIN_ORIGINS',ADMIN_ORIGIN],
    ['VIEWER_EMPLOYEE_ORIGIN',EMPLOYEE_ORIGIN]
  ]);
  const deps = {
    createClient: () => db,
    ...security,
    ...http,
    projectCloudViewerWeek
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
    if (ip) headers['x-real-ip'] = ip;
    return new Request(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
  };
  return {
    db,cloud,storeA,storeB,
    adminSet: (storeId,password,jwt=MANAGER_TOKEN) => admin(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-admin',
      'POST',ADMIN_ORIGIN,{storeId,password},jwt)),
    adminGet: (storeId,jwt=MANAGER_TOKEN) => admin(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-admin?storeId='+
       encodeURIComponent(storeId),'GET',ADMIN_ORIGIN,null,jwt)),
    login: (viewerCode,password,ip='192.0.2.10',origin=EMPLOYEE_ORIGIN) => access(request(
      'https://fake-project.supabase.co/functions/v1/employee-viewer-access',
      'POST',origin,{viewerCode,password},null,ip)),
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
  const f = makeFixture();
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
  const state = f.db.tables.shift_app_state[0].payload.stores[0];
  delete state.weeks[WEEK].confirmation;
  assert.equal((await f.view(token)).status,404);
  state.weeks[WEEK].confirmation = {confirmedAt:'2026-09-14T00:00:00.000Z'};
  f.db.tables.employee_viewer_sessions[0].expires_at = '2020-01-01T00:00:00.000Z';
  assert.equal((await f.view(token)).status,401);
  const newResult = await f.login(code,'583941');
  const newToken = (await newResult.json()).token;
  f.db.tables.shift_app_admins = [];
  assert.equal((await f.view(newToken)).status,403);
});
