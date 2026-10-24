// Independent STEP 10 iPad laboratory. Fictional data only. No production imports.
const DB='shift-step10-fake-vault-20261025', STORE='records';
const ACTIVE='active', PREVIOUS='previous', OUTBOX='outbox';
const AAD='shift-step10-fake-vault-v1', ITERATIONS=600000;
const enc=new TextEncoder(),dec=new TextDecoder();
const copy=value=>structuredClone(value);
const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error||Error('READ_FAILED'));});
const finished=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('TRANSACTION_ABORTED'));tx.onerror=()=>reject(tx.error||Error('TRANSACTION_FAILED'));});
const to64=u=>btoa(Array.from(u,c=>String.fromCharCode(c)).join(''));
const from64=str=>Uint8Array.from(atob(str),c=>c.charCodeAt(0));
async function openDb(){
 return new Promise((resolve,reject)=>{
  const action=indexedDB.open(DB,1);
  action.onupgradeneeded=()=>action.result.createObjectStore(STORE);
  action.onsuccess=()=>resolve(action.result);
  action.onerror=()=>reject(action.error);
  action.onblocked=()=>reject(Error('DATABASE_BLOCKED'));
 });
}
async function key(password,salt){
 if(typeof password!=='string'||password.length<12)throw Error('パスフレーズは12文字以上にしてください。');
 const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function seal(value,password){
 verifyFakeRoot(value);
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const material=await key(password,salt);
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(AAD)},material,enc.encode(JSON.stringify(value)));
 return {kind:'SHIFT-STEP10-FAKE-ONLY',version:1,salt:to64(salt),iv:to64(iv),ciphertext:to64(new Uint8Array(encrypted))};
}
async function unseal(envelope,password){
 if(envelope?.kind!=='SHIFT-STEP10-FAKE-ONLY'||envelope.version!==1)throw Error('試験用暗号化データではありません。');
 const salt=from64(envelope.salt),iv=from64(envelope.iv);
 if(salt.length!==16||iv.length!==12)throw Error('暗号化データの形式が不正です。');
 const material=await key(password,salt);
 const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:enc.encode(AAD)},material,from64(envelope.ciphertext));
 const result=JSON.parse(dec.decode(bytes));
 verifyFakeRoot(result);
 return result;
}
const SHIFT_VALUES=['架空勤務 09:00–13:00','架空勤務 13:00–17:00','架空勤務 17:00–20:00'];
const fakeRoot=()=>({
 syntheticOnly:true,version:1,
 stores:[{id:'FAKE-STORE-01',store:'架空店舗A',
  employees:[{id:'FAKE-EMP-01',name:'架空従業員A',employeeNumber:'FAKE-0001',birthDate:'1992-04-01'}],
  weeks:{'2026-10-26':{shifts:[SHIFT_VALUES[0]],notes:'架空の備考だけ'}}}],
 birthdayGiftDelivered:['FAKE-QUO-01']
});
function verifyFakeRoot(root){
 const ref=fakeRoot();
 const store=root?.stores?.[0],e=store?.employees?.[0],week=store?.weeks?.['2026-10-26'];
 if(root?.syntheticOnly!==true||root.version!==1||
   !Array.isArray(root.stores)||root.stores.length!==1||
   store.id!==ref.stores[0].id||store.store!==ref.stores[0].store||
   !Array.isArray(store.employees)||store.employees.length!==1||
   JSON.stringify(e)!==JSON.stringify(ref.stores[0].employees[0])||
   Object.keys(store.weeks||{}).length!==1||
   week?.notes!=='架空の備考だけ'||
   !Array.isArray(week.shifts)||week.shifts.length!==1||
   !SHIFT_VALUES.includes(week.shifts[0])||
   JSON.stringify(root.birthdayGiftDelivered)!==JSON.stringify(ref.birthdayGiftDelivered)||
   Object.keys(root).sort().join('|')!=='birthdayGiftDelivered|stores|syntheticOnly|version'||
   Object.keys(store).sort().join('|')!=='employees|id|store|weeks'||
   Object.keys(week).sort().join('|')!=='notes|shifts'
 )throw Error('架空の固定データ以外は扱えません。');
 return true;
}
function nextFakeRoot(root){
 verifyFakeRoot(root);
 const next=copy(root),week=next.stores[0].weeks['2026-10-26'];
 week.shifts[0]=SHIFT_VALUES[(SHIFT_VALUES.indexOf(week.shifts[0])+1)%SHIFT_VALUES.length];
 return next;
}
async function row(which){
 const db=await openDb();
 try{return (await req(db.transaction(STORE,'readonly').objectStore(STORE).get(which)))??null;}
 finally{db.close();}
}
async function read(password,which=ACTIVE){
 const stored=await row(which);
 if(!stored)return null;
 return {revision:stored.revision,data:await unseal(stored.envelope,password)};
}
async function write(root,password,expected,{sync=false,abort=false}={}){
 const envelope=await seal(root,password);
 const db=await openDb();
 try{
  const tx=db.transaction(STORE,'readwrite'),done=finished(tx),os=tx.objectStore(STORE);
  const current=await req(os.get(ACTIVE));
  const currentMeta=(await req(os.get(OUTBOX)))||{testOnly:true,pendingRevision:null};
  if((current?.revision??0)!==expected){
   tx.abort();await done.catch(()=>{});throw Error('REVISION_CONFLICT');
  }
  if(currentMeta.testOnly!==true){tx.abort();await done.catch(()=>{});throw Error('INVALID_JOURNAL');}
  const nextRevision=expected+1;
  if(current)os.put(current,PREVIOUS);
  os.put({revision:nextRevision,envelope},ACTIVE);
  if(sync||currentMeta.pendingRevision!==null)currentMeta.pendingRevision=nextRevision;
  os.put(currentMeta,OUTBOX);
  if(abort)tx.abort();
  try{await done;}catch{throw Error('TRANSACTION_ABORTED');}
  return nextRevision;
 }finally{db.close();}
}
async function journal(){return (await row(OUTBOX))||{testOnly:true,pendingRevision:null};}
async function backup(){
 const r=await row(ACTIVE);
 if(!r)throw Error('試験データがありません。');
 return {format:'SHIFT-STEP10-FAKE-BACKUP',revision:r.revision,envelope:r.envelope};
}
async function decodeBackup(data,password){
 if(data?.format!=='SHIFT-STEP10-FAKE-BACKUP')throw Error('この試験用バックアップではありません。');
 return unseal(data.envelope,password);
}
async function tamperCheck(password){
 const item=await row(ACTIVE);
 if(!item)throw Error('暗号化データがありません。');
 const altered=copy(item.envelope),bytes=from64(altered.ciphertext);
 bytes[0]^=1;altered.ciphertext=to64(bytes);
 try{await unseal(altered,password);return false;}catch{return true;}
}
async function resetOnlyFakeDatabase(){
 // Deletes only the uniquely named STEP 10 fixture database. No localStorage is touched.
 const db=await openDb();db.close();
 await new Promise((resolve,reject)=>{
  const action=indexedDB.deleteDatabase(DB);
  action.onsuccess=resolve;action.onerror=()=>reject(action.error);action.onblocked=()=>reject(Error('他のテスト画面を閉じてください。'));
 });
}
export const vault={row,read,write,journal,backup,decodeBackup,tamperCheck,resetOnlyFakeDatabase};
export {fakeRoot,nextFakeRoot,verifyFakeRoot};
