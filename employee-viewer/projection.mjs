// ADMIN-SIDE ONLY. This file must never be bundled into the employee site.
// Emits the smallest possible, confirmed-week-only publication payload.
import {validateRoot} from '../stores.js';

const MASK='従業員';
const sameName=(a,b)=>String(a).replace(/[\s\u3000・]/g,'')===String(b).replace(/[\s\u3000・]/g,'');
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);

function safeAlias(shift,employees){
 const person=employees.find(e=>e.id===shift.employeeId);
 if(!person)return MASK;
 const alias=person.shiftName?.trim();
 // Never trust a shift's saved display name; it may contain the legal name.
 if(!alias||sameName(alias,person.name))return MASK;
 return alias;
}
function safeShift(shift,employees,position,band){
 if(!shift)return null;
 return {
  position,band,
  name:safeAlias(shift,employees),
  start:shift.start,
  end:shift.end
 };
}

// Source is the MANAGER'S locally validated root; this must run before any upload.
// No employeeId, roster, birthday, employee number, notes, or arbitrary task text
// is ever allowed into the output, even if present in input data.
// Returns null for unconfirmed weeks, so they cannot accidentally be published.
export function projectEmployeeScheduleWeek(root,{storeId,weekStart}={}){
 validateRoot(root);
 if(typeof storeId!=='string'||!storeId||!validDate(weekStart)){
  throw Error('店舗・週の指定が正しくありません。');
 }
 const store=root.stores.find(s=>s.id===storeId);
 if(!store)throw Error('対象店舗が存在しません。');
 const week=store.weeks[weekStart];
 if(!week?.confirmation?.confirmedAt)return null;
 // Current days, NOT confirmation.snapshot: confirmed-after-change is still current.
 return {
  format:'employee-schedule-only-v1',
  storeName:store.store,
  weekStart:week.start,
  days:week.days.map(day=>({
   date:day.date,
   shifts:day.shifts.flatMap((row,position)=>row.flatMap((shift,band)=>{
    const item=safeShift(shift,store.employees,position,band);
    return item?[item]:[];
   })),
   training:day.extras.flatMap((extra,band)=>{
    if(extra?.type!=='training')return [];
    // No arbitrary training/task comments; only approved alias and band.
    const item=safeShift(extra,store.employees,3,band);
    return item?[item]:[];
   })
  }))
 };
}
