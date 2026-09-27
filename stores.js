import {addDays,monday,emptyWeek,initialState} from './model.js';
export const storageKey='shift-ipad-stores-v2';
const check=(ok)=>{if(!ok)throw Error('データの形式を確認できません。対応するバックアップを選んでください。');};
const str=(v,max=100)=>typeof v==='string'&&v.length<=max;
const date=v=>str(v,10)&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&addDays(v,0)===v;
const person=v=>v&&str(v.employeeId)&&str(v.name,20)&&v.name.trim();
export function validateRoot(root){
 check(root?.version===2&&Array.isArray(root.stores)&&root.stores.length>0);
 check(root.birthdayAcknowledgements===undefined||Array.isArray(root.birthdayAcknowledgements)&&root.birthdayAcknowledgements.every(k=>str(k,500)));
 check(root.birthdayGiftDelivered===undefined||Array.isArray(root.birthdayGiftDelivered)&&root.birthdayGiftDelivered.every(k=>str(k,500)));
 const ids=new Set();
 for(const s of root.stores){
  check(s&&str(s.id)&&s.id&&!ids.has(s.id));ids.add(s.id);
  check(str(s.store,40)&&Array.isArray(s.employees)&&Array.isArray(s.fixed)&&s.fixed.length===5);
  const employeeIds=new Set();
  for(const e of s.employees){check(e&&str(e.id)&&e.id&&!employeeIds.has(e.id)&&str(e.name,20)&&e.name.trim()&&typeof e.hidden==='boolean');check(e.shiftName===undefined||str(e.shiftName,20)&&e.shiftName.trim());check(e.employeeNumber===undefined||str(e.employeeNumber,40));for(const key of ['hireDate','birthDate'])check(e[key]===undefined||e[key]===''||date(e[key]));employeeIds.add(e.id);}
  for(const f of s.fixed)check(typeof f==='string'?str(f,40):f&&str(f.text,40)&&Array.isArray(f.days)&&f.days.every(d=>Number.isInteger(d)&&d>=0&&d<=6)&&((f.start===undefined&&f.end===undefined)||(Number.isInteger(f.start)&&Number.isInteger(f.end)&&f.start>=360&&f.end<=1800&&f.end>f.start)));
  check(date(s.current)&&monday(s.current)===s.current&&s.weeks&&typeof s.weeks==='object'&&!Array.isArray(s.weeks)&&Object.hasOwn(s.weeks,s.current));
  for(const [key,w] of Object.entries(s.weeks)){
   check(date(key)&&monday(key)===key&&w?.start===key&&Array.isArray(w.days)&&w.days.length===7);
   w.days.forEach((d,i)=>{
    check(d?.date===addDays(key,i)&&str(d.notes,180)&&Array.isArray(d.shifts)&&d.shifts.length===3&&Array.isArray(d.extras)&&d.extras.length===5);
    for(const row of d.shifts){check(Array.isArray(row)&&row.length===5);for(const shift of row)check(shift===null||person(shift)&&Number.isInteger(shift.start)&&Number.isInteger(shift.end)&&shift.start>=360&&shift.end<=1800&&shift.end>shift.start);}
    for(const e of d.extras)check(e===null||e?.type==='training'&&person(e)&&((e.start===undefined&&e.end===undefined)||(Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=360&&e.end<=1800&&e.end>e.start))||e?.type==='task'&&str(e.text,40)&&((e.start===undefined&&e.end===undefined)||(Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=360&&e.end<=1800&&e.end>e.start)));
   });
  }
 }
 check(ids.has(root.activeStoreId));return root;
}
export function migrate(old=initialState()){
 check(old?.version===1);
 const store={...structuredClone(old),id:'first-store'};
 return validateRoot({version:2,activeStoreId:store.id,stores:[store]});
}
export function newStore(name,current,id){
 const title=name.trim();check(title&&str(title,40)&&date(current)&&monday(current)===current&&str(id)&&id);
 return {id,version:1,store:title,employees:[],fixed:Array(5).fill(''),current,weeks:{[current]:emptyWeek(current)}};
}
function backupKeyBelongsToStore(key,storeId){
 try{
  const parsed=JSON.parse(key);
  return Array.isArray(parsed)&&parsed[0]===storeId;
 }catch{return false;}
}
function remapBackupKey(key,sourceStoreId,targetStoreId){
 try{
  const parsed=JSON.parse(key);
  if(!Array.isArray(parsed)||parsed[0]!==sourceStoreId)return null;
  parsed[0]=targetStoreId;
  return JSON.stringify(parsed);
 }catch{return null;}
}
export function storeBackupRoot(root,storeId=root.activeStoreId){
 validateRoot(root);
 const store=root.stores.find(item=>item.id===storeId);
 check(store);
 return validateRoot({
  version:2,
  activeStoreId:store.id,
  stores:[structuredClone(store)],
  birthdayAcknowledgements:(root.birthdayAcknowledgements||[]).filter(key=>backupKeyBelongsToStore(key,store.id)),
  birthdayGiftDelivered:(root.birthdayGiftDelivered||[]).filter(key=>backupKeyBelongsToStore(key,store.id))
 });
}
export function backupText(root,{scope='all',storeId=root.activeStoreId,exportedAt=new Date().toISOString()}={}){
 const validated=validateRoot(root);
 check(scope==='all'||scope==='store');
 const data=scope==='store'?storeBackupRoot(validated,storeId):validated;
 const store=data.stores.find(item=>item.id===data.activeStoreId);
 return JSON.stringify({
  format:'shift-ipad-backup',
  version:2,
  scope,
  storeId:scope==='store'?store.id:null,
  storeName:scope==='store'?store.store:null,
  exportedAt,
  data
 },null,2);
}
export function parseBackupInfo(text){
 check(typeof text==='string'&&text.length<=10000000);
 let backup;try{backup=JSON.parse(text);}catch{check(false);}
 check(backup?.format==='shift-ipad-backup');
 if(backup.version===1){
  return {scope:'all',exportedAt:backup.exportedAt||'',data:validateRoot(backup.data),legacy:true};
 }
 check(backup.version===2&&(backup.scope==='all'||backup.scope==='store'));
 const data=validateRoot(backup.data);
 if(backup.scope==='store'){
  check(data.stores.length===1&&data.activeStoreId===data.stores[0].id);
  check(backup.storeId===data.stores[0].id&&backup.storeName===data.stores[0].store);
 }
 return {
  scope:backup.scope,
  exportedAt:backup.exportedAt||'',
  storeId:backup.scope==='store'?backup.storeId:null,
  storeName:backup.scope==='store'?backup.storeName:null,
  data,
  legacy:false
 };
}
export function parseBackup(text){return parseBackupInfo(text).data;}
export function mergeStoreBackup(currentRoot,storeBackup){
 const current=structuredClone(validateRoot(currentRoot));
 const source=validateRoot(storeBackup);
 check(source.stores.length===1);
 const sourceStore=structuredClone(source.stores[0]);
 const sourceStoreId=sourceStore.id;
 const targetStoreId=current.activeStoreId;
 const index=current.stores.findIndex(item=>item.id===targetStoreId);
 check(index>=0);
 sourceStore.id=targetStoreId;
 current.stores[index]=sourceStore;

 const mergeKeys=(currentKeys=[],sourceKeys=[])=>[
  ...currentKeys.filter(key=>!backupKeyBelongsToStore(key,targetStoreId)),
  ...sourceKeys.map(key=>remapBackupKey(key,sourceStoreId,targetStoreId)).filter(Boolean)
 ];
 current.birthdayAcknowledgements=mergeKeys(current.birthdayAcknowledgements,source.birthdayAcknowledgements);
 current.birthdayGiftDelivered=mergeKeys(current.birthdayGiftDelivered,source.birthdayGiftDelivered);
 return validateRoot(current);
}
