import {addDays,monday,emptyWeek,initialState} from './model.js';
export const storageKey='shift-ipad-stores-v2';
const check=(ok)=>{if(!ok)throw Error('データの形式を確認できません。対応するバックアップを選んでください。');};
const str=(v,max=100)=>typeof v==='string'&&v.length<=max;
const date=v=>str(v,10)&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&addDays(v,0)===v;
const person=v=>v&&str(v.employeeId)&&str(v.name,20)&&v.name.trim();
export function validateRoot(root){
 check(root?.version===2&&Array.isArray(root.stores)&&root.stores.length>0);
 check(root.birthdayAcknowledgements===undefined||Array.isArray(root.birthdayAcknowledgements)&&root.birthdayAcknowledgements.every(k=>str(k,500)));
 const ids=new Set();
 for(const s of root.stores){
  check(s&&str(s.id)&&s.id&&!ids.has(s.id));ids.add(s.id);
  check(str(s.store,40)&&Array.isArray(s.employees)&&Array.isArray(s.fixed)&&s.fixed.length===5);
  const employeeIds=new Set();
  for(const e of s.employees){check(e&&str(e.id)&&e.id&&!employeeIds.has(e.id)&&str(e.name,20)&&e.name.trim()&&typeof e.hidden==='boolean');check(e.shiftName===undefined||str(e.shiftName,20)&&e.shiftName.trim());check(e.employeeNumber===undefined||str(e.employeeNumber,40));for(const key of ['hireDate','birthDate'])check(e[key]===undefined||e[key]===''||date(e[key]));employeeIds.add(e.id);}
  for(const f of s.fixed)check(typeof f==='string'?str(f,40):f&&str(f.text,40)&&Array.isArray(f.days)&&f.days.every(d=>Number.isInteger(d)&&d>=0&&d<=6));
  check(date(s.current)&&monday(s.current)===s.current&&s.weeks&&typeof s.weeks==='object'&&!Array.isArray(s.weeks)&&Object.hasOwn(s.weeks,s.current));
  for(const [key,w] of Object.entries(s.weeks)){
   check(date(key)&&monday(key)===key&&w?.start===key&&Array.isArray(w.days)&&w.days.length===7);
   w.days.forEach((d,i)=>{
    check(d?.date===addDays(key,i)&&str(d.notes,180)&&Array.isArray(d.shifts)&&d.shifts.length===3&&Array.isArray(d.extras)&&d.extras.length===5);
    for(const row of d.shifts){check(Array.isArray(row)&&row.length===5);for(const shift of row)check(shift===null||person(shift)&&Number.isInteger(shift.start)&&Number.isInteger(shift.end)&&shift.start>=360&&shift.end<=1800&&shift.end>shift.start);}
    for(const e of d.extras)check(e===null||e?.type==='training'&&person(e)&&((e.start===undefined&&e.end===undefined)||(Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=360&&e.end<=1800&&e.end>e.start))||e?.type==='task'&&str(e.text,40));
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
export function backupText(root){return JSON.stringify({format:'shift-ipad-backup',version:1,exportedAt:new Date().toISOString(),data:validateRoot(root)},null,2);}
export function parseBackup(text){
 check(typeof text==='string'&&text.length<=10000000);
 let backup;try{backup=JSON.parse(text);}catch{check(false);}
 check(backup?.format==='shift-ipad-backup'&&backup.version===1);
 return validateRoot(backup.data);
}
