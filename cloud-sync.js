import {SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY} from './supabase-config.js';
import {validateRoot} from './stores.js';

const SESSION_KEY='shift-supabase-session-v1';
const SYNC_META_KEY='shift-supabase-sync-v1';
const OWNER_KEY='shift-supabase-owner-v1';
const UNSYNCED_STATUS='複数端末共有：クラウド未同期（端末には保存済み）。通信復旧後に自動再同期します。';
const SESSION_STORE_ERROR='ログイン情報を端末に保存できません。空き容量を確認してください。';
const SESSION_CLEAR_ERROR='ログイン情報を端末から削除できません。再読み込みせず、空き容量を確認してください。';

const readJson=(storage,key)=>{try{return JSON.parse(storage.getItem(key)||'null');}catch{return null;}};
const readStoredSession=storage=>readJson(storage,SESSION_KEY);
const writeStoredSession=(storage,session)=>{
 try{
  if(session){
   const value=JSON.stringify(session);
   storage.setItem(SESSION_KEY,value);
   return storage.getItem(SESSION_KEY)===value;
  }
  storage.removeItem(SESSION_KEY);
  return storage.getItem(SESSION_KEY)===null;
 }catch{return false;}
};
const readStoredSyncMeta=storage=>readJson(storage,SYNC_META_KEY);
const writeStoredSyncMeta=(storage,meta)=>{
 try{
  storage.setItem(SYNC_META_KEY,JSON.stringify(meta));
  return storage.getItem(SYNC_META_KEY)!==null;
 }catch{return false;}
};
const readStoredOwner=storage=>{try{return storage.getItem(OWNER_KEY)||'';}catch{return '';}};
const writeStoredOwner=(storage,userId)=>{
 try{
  storage.setItem(OWNER_KEY,userId);
  if(storage.getItem(OWNER_KEY)!==userId)throw Error('owner binding write failed');
 }catch{
  throw Error('この端末の管理者アカウント情報を保存できません。空き容量を確認してください。');
 }
};

export function preserveLocalView(remoteRoot,localRoot){
 const remote=validateRoot(structuredClone(remoteRoot));
 if(!localRoot||localRoot.version!==2||!Array.isArray(localRoot.stores))return remote;
 if(remote.stores.some(store=>store.id===localRoot.activeStoreId))remote.activeStoreId=localRoot.activeStoreId;
 for(const store of remote.stores){
  const localStore=localRoot.stores.find(item=>item.id===store.id);
  if(localStore?.current&&Object.hasOwn(store.weeks,localStore.current))store.current=localStore.current;
 }
 return remote;
}

async function responseJson(response){
 const text=await response.text();
 let data=null;
 try{data=text?JSON.parse(text):null;}catch{}
 if(!response.ok)throw Error(data?.msg||data?.message||data?.error_description||data?.error||`通信エラー（${response.status}）`);
 return data;
}

export function createCloudSync({
 getRoot,replaceRoot,storage=globalThis.localStorage,fetchImpl=globalThis.fetch,
 onStatus=()=>{},onConflict=()=>{},onRemoteLoaded=()=>{},canAutoApply=()=>true
}={}){
 let session=readStoredSession(storage);
 let storedMeta=readStoredSyncMeta(storage);
 let ownerUserId=readStoredOwner(storage);
 let ownerMismatchDetected=false;
 let sessionStorageWriteFailed=false;
 if(!ownerUserId&&storedMeta?.userId)ownerUserId=storedMeta.userId;
 if(ownerUserId&&session?.user?.id&&ownerUserId!==session.user.id){
  ownerMismatchDetected=true;
  session=null;
  sessionStorageWriteFailed=!writeStoredSession(storage,null);
 }
 if(storedMeta?.userId!==session?.user?.id)storedMeta=null;

 let revision=Number.isFinite(Number(storedMeta?.revision))?Number(storedMeta.revision):null;
 let unsynced=Boolean(storedMeta?.unsynced);
 let enabled=Boolean(session?.access_token&&revision!==null);
 let conflicted=false;
 let syncMetaWriteFailed=false;
 let saveQueue=Promise.resolve(),pendingSaves=0,lastRemoteCheckAt=0,checkPromise=null,deferredRemoteCheck=false;

 const status=message=>onStatus([
  message,
  sessionStorageWriteFailed?'端末のログイン情報を保存・削除できません。再読み込みせず、空き容量を確認してください。':'',
  syncMetaWriteFailed?'端末の同期状態を保存できません。再読み込みせず、空き容量を確認してください。':''
 ].filter(Boolean).join(' '));
 const authHeaders=token=>({apikey:SUPABASE_PUBLISHABLE_KEY,...(token?{Authorization:`Bearer ${token}`}:{})});

 function verifyOwnerBinding(userId){
  if(!userId)throw Error('管理者アカウントを確認できません。');
  const metaOwner=readStoredSyncMeta(storage)?.userId||'';
  const bound=ownerUserId||readStoredOwner(storage)||metaOwner;
  if(bound&&bound!==userId){
   throw Error('この端末は別の管理者アカウントに紐づいています。既存のシフトデータ保護のため、別アカウントではログインできません。');
  }
  return bound||userId;
 }
 function bindOrVerifyOwner(userId){
  const owner=verifyOwnerBinding(userId);
  if(!readStoredOwner(storage))writeStoredOwner(storage,owner);
  ownerUserId=owner;
  ownerMismatchDetected=false;
 }
 async function verifyAdminMembership(data){
  const userId=data?.user?.id,token=data?.access_token;
  if(!userId||!token)throw Error('管理者アカウントを確認できません。');
  const rows=await responseJson(await fetchImpl(`${SUPABASE_URL}/rest/v1/shift_app_admins?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`,{
   headers:authHeaders(token)
  }));
  return Array.isArray(rows)&&rows.some(row=>row?.user_id===userId);
 }
 async function rejectForeignSession(data){
  try{
   if(data?.access_token)await fetchImpl(`${SUPABASE_URL}/auth/v1/logout`,{method:'POST',headers:authHeaders(data.access_token)});
  }catch{}
 }

 function persistSyncMeta(){
  if(!session?.user?.id)return true;
  const ok=writeStoredSyncMeta(storage,{userId:session.user.id,revision,unsynced,updatedAt:new Date().toISOString()});
  syncMetaWriteFailed=!ok;
  return ok;
 }
 function setUnsynced(message=UNSYNCED_STATUS){
  unsynced=true;persistSyncMeta();status(message);
 }
 function setConflict(){
  conflicted=true;enabled=false;unsynced=true;persistSyncMeta();onConflict();
  status('複数端末共有：別の端末で更新されています。クラウドから最新データを読み込んでください。');
 }

 async function refreshSession(){
  if(!session?.refresh_token)throw Error('ログイン情報の有効期限が切れています。再ログインしてください。');
  const data=await responseJson(await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{
   method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},
   body:JSON.stringify({refresh_token:session.refresh_token})
  }));
  const nextSession={...data,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};
  if(!writeStoredSession(storage,nextSession)){
   sessionStorageWriteFailed=true;
   throw Error(SESSION_STORE_ERROR);
  }
  sessionStorageWriteFailed=false;
  session=nextSession;
  return session;
 }
 async function ensureSession(){
  if(!session?.access_token)return null;
  if((session.expires_at||0)*1000>Date.now()+60000)return session;
  return refreshSession();
 }
 async function dataRequest(path,{method='GET',body,prefer}={}){
  const current=await ensureSession();
  if(!current)throw Error('ログインしてください。');
  return responseJson(await fetchImpl(`${SUPABASE_URL}/rest/v1/${path}`,{
   method,
   headers:{...authHeaders(current.access_token),...(body?{'Content-Type':'application/json'}:{}),...(prefer?{Prefer:prefer}:{})},
   ...(body?{body:JSON.stringify(body)}:{})
  }));
 }
 async function readCloud(){
  const userId=session?.user?.id;
  if(!userId)throw Error('ログイン情報を確認できません。');
  const rows=await dataRequest(`shift_app_state?select=payload,revision,updated_at&owner_id=eq.${encodeURIComponent(userId)}`);
  return Array.isArray(rows)&&rows.length?rows[0]:null;
 }
 async function readCloudRevision(){
  const userId=session?.user?.id;
  if(!userId)throw Error('ログイン情報を確認できません。');
  const rows=await dataRequest(`shift_app_state?select=revision&owner_id=eq.${encodeURIComponent(userId)}`);
  return Array.isArray(rows)&&rows.length?Number(rows[0].revision):null;
 }
 async function createCloud(){
  const payload=validateRoot(structuredClone(getRoot()));
  const rows=await dataRequest('shift_app_state',{
   method:'POST',prefer:'return=representation',
   body:{owner_id:session.user.id,payload,revision:1}
  });
  revision=Number(rows?.[0]?.revision||1);
  enabled=true;conflicted=false;unsynced=false;persistSyncMeta();
  status(`複数端末共有：同期済み（rev.${revision}）`);
 }
 async function loadRemote(row){
  const remote=validateRoot(structuredClone(row.payload));
  const payload=revision===null?remote:preserveLocalView(remote,getRoot());
  if(!replaceRoot(payload))throw Error('クラウドのデータを端末へ保存できませんでした。');
  revision=Number(row.revision);
  enabled=true;conflicted=false;unsynced=false;persistSyncMeta();
  onRemoteLoaded();
  status(`複数端末共有：同期済み（rev.${revision}）`);
 }
 async function bootstrap(){
  await ensureSession();
  if(!session?.access_token)return false;
  status('複数端末共有：同期中…');
  const row=await readCloud();
  if(row)await loadRemote(row);else await createCloud();
  return true;
 }
 async function saveSnapshot(snapshot){
  if(!enabled||conflicted||!session?.user?.id||revision===null)return false;
  const expected=revision,next=expected+1;
  const rows=await dataRequest(`shift_app_state?owner_id=eq.${encodeURIComponent(session.user.id)}&revision=eq.${expected}`,{
   method:'PATCH',prefer:'return=representation',
   body:{payload:validateRoot(structuredClone(snapshot)),revision:next,updated_at:new Date().toISOString()}
  });
  if(!Array.isArray(rows)||rows.length===0){setConflict();return false;}
  revision=Number(rows[0].revision||next);persistSyncMeta();
  return true;
 }
 function queueSave(root){
  if(!session?.access_token||conflicted)return;
  const snapshot=structuredClone(root);
  setUnsynced();
  if(revision===null){
   status('複数端末共有：クラウド未同期（端末には保存済み）。初期同期の確認後に再同期します。');
   return;
  }
  enabled=true;pendingSaves++;
  let saved=false;
  saveQueue=saveQueue.then(async()=>{
   saved=await saveSnapshot(snapshot);
   return saved;
  }).catch(error=>{
   status(`${UNSYNCED_STATUS}（${error.message}）`);
   return false;
  }).finally(()=>{
   pendingSaves=Math.max(0,pendingSaves-1);
   if(saved&&pendingSaves===0&&!conflicted){
    unsynced=false;persistSyncMeta();
    status(`複数端末共有：同期済み（rev.${revision}）`);
   }
   if(pendingSaves===0&&deferredRemoteCheck&&!conflicted){
    deferredRemoteCheck=false;
    queueMicrotask(()=>checkForRemoteUpdate({force:true}));
   }
  });
 }

 async function resumePendingSync(){
  if(!unsynced||revision===null||pendingSaves>0||conflicted)return {checked:false,synced:false};
  enabled=true;
  const remoteRevision=await readCloudRevision();
  if(!Number.isFinite(remoteRevision)||remoteRevision!==revision){
   setConflict();
   return {checked:true,synced:false,conflicted:true};
  }
  const saved=await saveSnapshot(getRoot());
  if(!saved)return {checked:true,synced:false,conflicted};
  unsynced=false;persistSyncMeta();
  status(`複数端末共有：再同期しました（rev.${revision}）`);
  return {checked:true,synced:true};
 }

 async function signIn(email,password){
  const data=await responseJson(await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{
   method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({email,password})
  }));
  try{
   if(!await verifyAdminMembership(data))throw Error('このアカウントは管理者として登録されていません。');
   verifyOwnerBinding(data?.user?.id);
  }catch(error){await rejectForeignSession(data);throw error;}
  const previousUserId=session?.user?.id;
  const nextSession={...data,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};
  if(!writeStoredSession(storage,nextSession)){
   sessionStorageWriteFailed=true;
   writeStoredSession(storage,null);
   await rejectForeignSession(data);
   throw Error(SESSION_STORE_ERROR);
  }
  try{bindOrVerifyOwner(data?.user?.id);}
  catch(error){
   sessionStorageWriteFailed=!writeStoredSession(storage,null);
   await rejectForeignSession(data);
   throw error;
  }
  sessionStorageWriteFailed=false;
  session=nextSession;
  if(previousUserId!==session.user?.id){
   const meta=readStoredSyncMeta(storage);
   if(meta?.userId===session.user?.id){
    revision=Number.isFinite(Number(meta.revision))?Number(meta.revision):null;
    unsynced=Boolean(meta.unsynced);
   }else{
    revision=null;unsynced=false;
   }
   conflicted=false;enabled=revision!==null;
  }
  if(unsynced&&revision!==null){
   try{await resumePendingSync();return true;}
   catch(error){enabled=true;status(`${UNSYNCED_STATUS}（${error.message}）`);return true;}
  }
  await bootstrap();
  return true;
 }
 async function signOut(){
  try{if(session?.access_token)await fetchImpl(`${SUPABASE_URL}/auth/v1/logout`,{method:'POST',headers:authHeaders(session.access_token)});}catch{}
  const cleared=writeStoredSession(storage,null);
  session=null;enabled=false;revision=null;conflicted=false;unsynced=false;
  sessionStorageWriteFailed=!cleared;
  status('複数端末共有：未接続');
  if(!cleared)throw Error(SESSION_CLEAR_ERROR);
  return true;
 }
 async function reloadFromCloud(){
  await ensureSession();
  const row=await readCloud();
  if(!row)throw Error('クラウドに共有データがありません。');
  await loadRemote(row);
  return true;
 }

 async function checkForRemoteUpdate({force=false}={}){
  if(!session?.access_token||conflicted)return {checked:false,updated:false};
  if(pendingSaves>0){
   deferredRemoteCheck=true;
   return {checked:false,updated:false,deferred:true};
  }
  const now=Date.now();
  if(!force&&now-lastRemoteCheckAt<5000)return {checked:false,updated:false};
  if(checkPromise)return checkPromise;

  checkPromise=(async()=>{
   lastRemoteCheckAt=Date.now();
   try{
    if(unsynced){
     const result=await resumePendingSync();
     return {...result,updated:false};
    }
    if(!enabled||revision===null)return {checked:false,updated:false};
    const remoteRevision=await readCloudRevision();
    if(!Number.isFinite(remoteRevision)||remoteRevision<=revision)return {checked:true,updated:false};
    if(pendingSaves===0&&canAutoApply()){
     const row=await readCloud();
     if(!row){setConflict();return {checked:true,updated:true,autoApplied:false,conflicted:true};}
     await loadRemote(row);
     status(`複数端末共有：別端末の更新を反映しました（rev.${revision}）`);
     return {checked:true,updated:true,autoApplied:true};
    }
    setConflict();
    return {checked:true,updated:true,autoApplied:false,conflicted:true};
   }catch(error){
    if(unsynced)status(`${UNSYNCED_STATUS}（${error.message}）`);
    else status(`複数端末共有：更新確認に失敗しました（${error.message}）`);
    return {checked:false,updated:false,error:error.message};
   }finally{
    checkPromise=null;
   }
  })();
  return checkPromise;
 }

 async function initialize(){
  if(ownerMismatchDetected){
   status('複数端末共有：この端末は別の管理者アカウントに紐づいているため、保存済みセッションを解除しました。');
   return false;
  }
  if(!session?.access_token){status('複数端末共有：未接続');return false;}
  try{
   await ensureSession();
   if(!await verifyAdminMembership(session)){
    await rejectForeignSession(session);
    session=null;enabled=false;revision=null;conflicted=false;unsynced=false;
    sessionStorageWriteFailed=!writeStoredSession(storage,null);
    status('複数端末共有：このアカウントは管理者として登録されていないため、保存済みセッションを解除しました。');
    return false;
   }
   bindOrVerifyOwner(session.user?.id);
   if(unsynced&&revision!==null){enabled=true;await resumePendingSync();return true;}
   return await bootstrap();
  }catch(error){
   enabled=revision!==null;
   if(unsynced)status(`${UNSYNCED_STATUS}（${error.message}）`);
   else if(revision!==null)status(`複数端末共有：接続できません（${error.message}）。端末で編集した変更は未同期として保持します。`);
   else status(`複数端末共有：接続できませんでした（${error.message}）`);
   return false;
  }
 }

 return {
  initialize,signIn,signOut,reloadFromCloud,queueSave,checkForRemoteUpdate,
  getStatus:()=>({
   signedIn:Boolean(session?.access_token),email:session?.user?.email||'',
   enabled,revision,conflicted,pendingSaves,unsynced,ownerBound:Boolean(ownerUserId),syncMetaWriteFailed,sessionStorageWriteFailed
  })
 };
}
