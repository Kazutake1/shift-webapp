import test from 'node:test';
import assert from 'node:assert/strict';
import {VIEWER_PASSWORD_LENGTH,validateViewerPassword,viewerRotationState,viewerRotationMessage} from '../employee-viewer/rotation-policy.mjs';

test('viewer PIN: exactly six ASCII digits and not an obvious sequence',()=>{
 assert.equal(VIEWER_PASSWORD_LENGTH,6);
 assert.equal(validateViewerPassword('583941'),'');
 for(const bad of ['12345','1234567','A83941','１２３４５６','583 41','58394\n','']){
  assert.notEqual(validateViewerPassword(bad),'');
 }
 for(const guessable of ['000000','111111','123456','654321','012345','987654','121212','123123']){
  assert.match(validateViewerPassword(guessable),/推測されやすい/);
 }
});

test('viewer password: no secret is written or returned by the reminder policy',()=>{
 const source=JSON.stringify(viewerRotationState({configured:true,lastChangedAt:'2026-11-01T00:00:00+09:00',now:new Date('2026-11-15T03:00:00Z')}));
 assert.equal(source.includes('583941'),false);
 assert.deepEqual(viewerRotationState({configured:false}),{kind:'unconfigured',due:true,elapsedDays:null});
 assert.deepEqual(viewerRotationState({configured:true,lastChangedAt:null}),{kind:'unknown',due:false,elapsedDays:null});
});

test('viewer rotation: first day of new month warns if last rotation is 25 days ago',()=>{
 const r=viewerRotationState({configured:true,lastChangedAt:'2026-10-05T01:00:00+09:00',now:new Date('2026-11-01T03:00:00+09:00')});
 assert.equal(r.kind,'monthly');assert.equal(r.elapsedDays,27);assert.equal(r.due,true);
 assert.match(viewerRotationMessage({configured:true,lastChangedAt:'2026-10-05T01:00:00+09:00'},{now:new Date('2026-11-01T03:00:00+09:00')}),/今月/);
});

test('viewer rotation: changing password the day before month start does not cause a new-day warning',()=>{
 const r=viewerRotationState({configured:true,lastChangedAt:'2026-10-31T21:00:00+09:00',now:new Date('2026-11-01T09:00:00+09:00')});
 assert.deepEqual(r,{kind:'ok',due:false,elapsedDays:1});
});

test('viewer rotation: day 30 warns, day 29 does not; calculations use Tokyo calendar days',()=>{
 const prior='2026-10-15T17:00:00+09:00';
 const before=viewerRotationState({configured:true,lastChangedAt:prior,now:new Date('2026-11-13T10:00:00+09:00')});
 const after=viewerRotationState({configured:true,lastChangedAt:prior,now:new Date('2026-11-14T00:01:00+09:00')});
 assert.equal(before.kind,'monthly');assert.equal(before.elapsedDays,29);
 assert.equal(after.kind,'overdue');assert.equal(after.elapsedDays,30);
 assert.match(viewerRotationMessage({configured:true,lastChangedAt:prior},{now:new Date('2026-11-14T00:01:00+09:00')}),/30日/);
});

test('viewer rotation: invalid and future dates do not incorrectly indicate success',()=>{
 assert.equal(viewerRotationState({configured:true,lastChangedAt:'invalid'}).kind,'unknown');
 assert.equal(viewerRotationState({configured:true,lastChangedAt:'2027-01-01T00:00:00+09:00',now:new Date('2026-11-15T08:00:00+09:00')}).kind,'unknown');
});

test('viewer admin API: reject unsigned users and foreign-store requests before network',async()=>{
 const {createCloudSync}=await import('../cloud-sync.js');
 const {migrate}=await import('../stores.js');
 const {initialState}=await import('../model.js');
 const root=migrate(initialState());
 let calls=0;
 const cloud=createCloudSync({
  getRoot:()=>root,replaceRoot:()=>true,
  storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  fetchImpl:async()=>{calls++;throw Error('not expected');}
 });
 await assert.rejects(()=>cloud.getViewerPasswordStatus('other-store'),/店舗/);
 await assert.rejects(()=>cloud.getViewerPasswordStatus(root.activeStoreId),/ログイン/);
 await assert.rejects(()=>cloud.changeViewerPassword(root.activeStoreId,'weak'),/数字6桁/);
 assert.equal(calls,0);
});

test('viewer admin API: only manager-authorized requests send a password and never cache it',async()=>{
 const {createCloudSync}=await import('../cloud-sync.js');
 const {migrate}=await import('../stores.js');
 const {initialState}=await import('../model.js');
 const root=migrate(initialState());
 const user={id:'manager-id',email:'manager@example.invalid'};
 const session={access_token:'manager-token',refresh_token:'refresh-token',expires_at:4102444800,user};
 const map=new Map([['shift-supabase-session-v1',JSON.stringify(session)]]);
 const storage={
  getItem:key=>map.get(key)||null,
  setItem:(key,value)=>map.set(key,value),
  removeItem:key=>map.delete(key)
 };
 const requests=[];
 const response=(value,status=200)=>({ok:status<400,status,text:async()=>JSON.stringify(value)});
 const fetchImpl=async(url,options={})=>{
  requests.push({url,options});
  if(url.includes('/rest/v1/shift_app_admins?'))return response([{user_id:user.id}]);
  if(url.includes('/functions/v1/employee-viewer-admin')){
   if(options.method==='POST')return response({configured:true,lastChangedAt:'2026-11-15T04:00:00.000Z'});
   return response({configured:false,lastChangedAt:null});
  }
  throw Error('unexpected');
 };
 const cloud=createCloudSync({getRoot:()=>root,replaceRoot:()=>true,storage,fetchImpl});
 assert.deepEqual(await cloud.getViewerPasswordStatus(root.activeStoreId),{configured:false,lastChangedAt:null});
 const secret='583941';
 const result=await cloud.changeViewerPassword(root.activeStoreId,secret);
 assert.equal(result.configured,true);
 assert.equal(requests.some(r=>r.url.includes('/functions/v1/employee-viewer-admin')),true);
 const post=requests.find(r=>r.options.method==='POST');
 assert.equal(post.options.headers.Authorization,'Bearer manager-token');
 assert.equal(JSON.parse(post.options.body).storeId,root.activeStoreId);
 assert.equal(JSON.parse(post.options.body).password,secret);
 assert.equal(JSON.stringify([...map.values()]).includes(secret),false);
});

test('viewer admin API: a manager without a current allowlist entry cannot access password settings',async()=>{
 const {createCloudSync}=await import('../cloud-sync.js');
 const {migrate}=await import('../stores.js');
 const {initialState}=await import('../model.js');
 const root=migrate(initialState()),user={id:'revoked-manager'};
 const session={access_token:'revoked-token',refresh_token:'refresh',expires_at:4102444800,user};
 const storage={getItem:key=>key==='shift-supabase-session-v1'?JSON.stringify(session):null,setItem:()=>{},removeItem:()=>{}};
 let calledViewer=false;
 const cloud=createCloudSync({
  getRoot:()=>root,replaceRoot:()=>true,storage,
  fetchImpl:async url=>{
   if(url.includes('/rest/v1/shift_app_admins?'))return {ok:true,status:200,text:async()=>JSON.stringify([])};
   if(url.includes('/functions/v1/employee-viewer-admin')){calledViewer=true;throw Error('unexpected');}
   throw Error('unexpected');
  }
 });
 await assert.rejects(()=>cloud.getViewerPasswordStatus(root.activeStoreId),/管理者権限/);
 assert.equal(calledViewer,false);
});

