import {isIP} from 'node:net';
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
export const WEEK = '2026-09-21';
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

export function makeFixture({verifiedIpHeader=false, readerRole='shift_viewer_week_reader', authRole='shift_viewer_auth', viewerHost='https://viewer-fixture.supabase.co', carryPublisherSecret=false, employeeOrigin=EMPLOYEE_ORIGIN} = {}) {
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
    ['VIEWER_EMPLOYEE_ORIGIN',employeeOrigin]
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
      assert.match(query.join(''), /shift_viewer_private\.read_viewer_week/);
      const session=db.tables.employee_viewer_sessions.find(row=>row.token_hash===code&&Date.parse(row.expires_at)>Date.now());
      const credential=session&&db.tables.employee_viewer_passwords.find(row=>
        row.store_id===session.store_id&&row.owner_id===session.owner_id&&row.session_epoch===session.session_epoch);
      const member=session&&db.tables.shift_app_admins.some(row=>row.user_id===session.owner_id);
      return [{reader_role:readerRole,sheet:member&&credential&&week===WEEK?copies.get(credential.store_id)??null:null}];
    }
  };
  function handler(relativePath) {
    const raw = readFileSync(new URL(relativePath, import.meta.url),'utf8');
    // Both entrypoints contain standard JavaScript syntax, despite .ts suffix.
    // Strip *only* import declarations so the original handler body executes.
    const source = raw.replace(/^import[\s\S]*?;\s*\n/gm,'');
    assert.doesNotMatch(source,/^import /m);
    let served;
    const runtimeEnv=new Map(env);
    if(relativePath.includes('employee-viewer-access')){
      runtimeEnv.set('VIEWER_MANAGER_PROJECT_URL',env.get('SUPABASE_URL'));
      runtimeEnv.set('SUPABASE_URL',viewerHost);
      if(!carryPublisherSecret)runtimeEnv.delete('VIEWER_WEEK_PUBLISHER_DB_URL');
    }
    const Deno = {env:{get:key => runtimeEnv.get(key)},serve:fn => {served=fn;}};
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
    db,cloud,storeA,storeB,copies,access,
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
