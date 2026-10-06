import {SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY} from './supabase-config.js';
import {validateRoot} from './stores.js';
const SESSION_KEY='shift-supabase-session-v1';
const readStoredSession=storage=>{try{return JSON.parse(storage.getItem(SESSION_KEY)||'null');}catch{return null;}};
const writeStoredSession=(storage,session)=>{try{if(session)storage.setItem(SESSION_KEY,JSON.stringify(session));else storage.removeItem(SESSION_KEY);}catch{}};
async function responseJson(response){
 const text=await response.text();let data=null;try{data=text?JSON.parse(text):null;}catch{}
 if(!response.ok)throw Error(data?.msg||data?.message||data?.error_description||data?.error||`通信エラー（${response.status}）`);
 return data;
}
export function createCloudSync({getRoot,replaceRoot,storage=globalThis.localStorage,fetchImpl=globalThis.fetch,onStatus=()=>{},onConflict=()=>{},onRemoteLoaded=()=>{},canAutoApply=()=>true}={}){
 let session=readStoredSession(storage),enabled=false,revision=null,conflicted=false,saveQueue=Promise.resolve();
 let pendingSaves=0,lastRemoteCheckAt=0,checkPromise=null;
 const status=message=>onStatus(message);
 const authHeaders=token=>({apikey:SUPABASE_PUBLISHABLE_KEY,...(token?{Authorization:`Bearer ${token}`}:{})});
 async function refreshSession(){
  if(!session?.refresh_token)throw Error('ログイン情報の有効期限が切れています。再ログインしてください。');
  const data=await responseJson(await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})}));
  session={...data,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};writeStoredSession(storage,session);return session;
 }
 async function ensureSession(){if(!session?.access_token)return null;if((session.expires_at||0)*1000>Date.now()+60000)return session;return refreshSession();}
 async function dataRequest(path,{method='GET',body,prefer}={}){
  const current=await ensureSession();if(!current)throw Error('ログインしてください。');
  return responseJson(await fetchImpl(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...authHeaders(current.access_token),...(body?{'Content-Type':'application/json'}:{}),...(prefer?{Prefer:prefer}:{})},...(body?{body:JSON.stringify(body)}:{})}));
 }
 async function readCloud(){
  const userId=session?.user?.id;if(!userId)throw Error('ログイン情報を確認できません。');
  const rows=await dataRequest(`shift_app_state?select=payload,revision,updated_at&owner_id=eq.${encodeURIComponent(userId)}`);
  return Array.isArray(rows)&&rows.length?rows[0]:null;
 }
 async function createCloud(){
  const payload=validateRoot(structuredClone(getRoot()));
  const rows=await dataRequest('shift_app_state',{method:'POST',prefer:'return=representation',body:{owner_id:session.user.id,payload,revision:1}});
  revision=Number(rows?.[0]?.revision||1);enabled=true;conflicted=false;status(`複数端末共有：同期済み（rev.${revision}）`);
 }
 async function loadRemote(row){
  const payload=validateRoot(structuredClone(row.payload));if(!replaceRoot(payload))throw Error('クラウドのデータを端末へ保存できませんでした。');
  revision=Number(row.revision);enabled=true;conflicted=false;onRemoteLoaded();status(`複数端末共有：同期済み（rev.${revision}）`);
 }
 async function bootstrap(){await ensureSession();if(!session?.access_token)return false;status('複数端末共有：同期中…');const row=await readCloud();if(row)await loadRemote(row);else await createCloud();return true;}
 async function saveSnapshot(snapshot){
  if(!enabled||conflicted||!session?.user?.id||revision===null)return false;
  const expected=revision,next=expected+1;
  const rows=await dataRequest(`shift_app_state?owner_id=eq.${encodeURIComponent(session.user.id)}&revision=eq.${expected}`,{method:'PATCH',prefer:'return=representation',body:{payload:validateRoot(structuredClone(snapshot)),revision:next,updated_at:new Date().toISOString()}});
  if(!Array.isArray(rows)||rows.length===0){conflicted=true;enabled=false;onConflict();status('複数端末共有：別の端末で更新されています。クラウドから最新データを読み込んでください。');return false;}
  revision=Number(rows[0].revision||next);status(`複数端末共有：同期済み（rev.${revision}）`);return true;
 }
 function queueSave(root){
  if(!enabled||conflicted)return;
  const snapshot=structuredClone(root);pendingSaves++;status('複数端末共有：保存中…');
  saveQueue=saveQueue.then(()=>saveSnapshot(snapshot))
   .catch(error=>status(`複数端末共有：保存できませんでした（${error.message}）`))
   .finally(()=>{pendingSaves=Math.max(0,pendingSaves-1);});
 }
 async function signIn(email,password){
  const data=await responseJson(await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({email,password})}));
  session={...data,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};writeStoredSession(storage,session);await bootstrap();return true;
 }
 async function signUp(email,password){
  const data=await responseJson(await fetchImpl(`${SUPABASE_URL}/auth/v1/signup`,{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({email,password})}));
  if(data?.access_token){session={...data,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};writeStoredSession(storage,session);await bootstrap();return {signedIn:true,message:''};}
  return {signedIn:false,message:'確認メールを送信しました。メール確認後にログインしてください。'};
 }
 async function signOut(){try{if(session?.access_token)await fetchImpl(`${SUPABASE_URL}/auth/v1/logout`,{method:'POST',headers:authHeaders(session.access_token)});}catch{}session=null;enabled=false;revision=null;conflicted=false;writeStoredSession(storage,null);status('複数端末共有：未接続');}
 async function reloadFromCloud(){await ensureSession();const row=await readCloud();if(!row)throw Error('クラウドに共有データがありません。');await loadRemote(row);return true;}

 async function checkForRemoteUpdate({force=false}={}){
  if(!session?.access_token||!enabled||conflicted||revision===null)return {checked:false,updated:false};
  const now=Date.now();
  if(!force&&now-lastRemoteCheckAt<5000)return {checked:false,updated:false};
  if(checkPromise)return checkPromise;
  checkPromise=(async()=>{
   lastRemoteCheckAt=Date.now();
   try{
    const row=await readCloud();
    if(!row)return {checked:true,updated:false};
    const remoteRevision=Number(row.revision);
    if(!Number.isFinite(remoteRevision)||remoteRevision<=revision)return {checked:true,updated:false};
    if(pendingSaves===0&&canAutoApply()){
     await loadRemote(row);
     status(`複数端末共有：別端末の更新を反映しました（rev.${revision}）`);
     return {checked:true,updated:true,autoApplied:true};
    }
    conflicted=true;enabled=false;onConflict();
    status('複数端末共有：別の端末で更新されています。クラウドから最新データを読み込んでください。');
    return {checked:true,updated:true,autoApplied:false,conflicted:true};
   }catch(error){
    status(`複数端末共有：更新確認に失敗しました（${error.message}）`);
    return {checked:false,updated:false,error:error.message};
   }finally{
    checkPromise=null;
   }
  })();
  return checkPromise;
 }
 async function initialize(){if(!session?.access_token){status('複数端末共有：未接続');return false;}try{return await bootstrap();}catch(error){enabled=false;status(`複数端末共有：接続できませんでした（${error.message}）`);return false;}}
 return {initialize,signIn,signUp,signOut,reloadFromCloud,queueSave,checkForRemoteUpdate,getStatus:()=>({signedIn:Boolean(session?.access_token),email:session?.user?.email||'',enabled,revision,conflicted,pendingSaves})};
}
