import {validateRoot} from './stores.js';
import {employeeShiftName} from './model.js';

const copy=value=>structuredClone(value);
const cloudFixed=value=>typeof value==='string'?value:{text:value.text,days:copy(value.days),start:value.start,end:value.end};
function cloudShift(shift,employees,alreadyProjected=false){
 if(!shift)return null;
 const employee=employees.find(item=>item.id===shift.employeeId);
 const alias=employee?.shiftName?.trim();
 const sameAsFullName=employee&&alias&&alias.replace(/[\s\u3000・]/g,'')===employee.name.replace(/[\s\u3000・]/g,'');
 // Never upload the full-name field as a fallback display name.
 const name=employee?(alias&&!sameAsFullName?alias:'従業員'):alreadyProjected?shift.name:'従業員';
 return {employeeId:shift.employeeId,name,start:shift.start,end:shift.end};
}
function cloudExtra(extra,employees,alreadyProjected=false){
 if(!extra)return null;
 if(extra.type==='training')return {type:'training',...cloudShift(extra,employees,alreadyProjected)};
 if(extra.type==='task')return {type:'task',text:extra.text,...(Number.isInteger(extra.start)?{start:extra.start}:{}),...(Number.isInteger(extra.end)?{end:extra.end}:{})};
 return null;
}
function cloudWeek(week,employees,alreadyProjected=false){
 const result={
  start:week.start,
  days:week.days.map(day=>({
   date:day.date,
   shifts:day.shifts.map(row=>row.map(shift=>cloudShift(shift,employees,alreadyProjected))),
   extras:day.extras.map(extra=>cloudExtra(extra,employees,alreadyProjected)),
   notes:''
  }))
 };
 if(week.confirmation){
  result.confirmation={
   confirmedAt:week.confirmation.confirmedAt,
   snapshot:{days:week.confirmation.snapshot.days.map(day=>({
    shifts:day.shifts.map(row=>row.map(shift=>cloudShift(shift,employees,alreadyProjected))),
    extras:day.extras.map(extra=>cloudExtra(extra,employees,alreadyProjected)),
    notes:''
   }))}
  };
 }
 return result;
}

// Allowlist only shift-sheet data. Employee profiles, birthday/gift records,
// week notes, and legacy change details never enter a cloud request.
export function projectScheduleRoot(root){
 const source=validateRoot(copy(root));
 return validateRoot({
  version:2,
  syncFormat:'shift-sheet-v1',
  activeStoreId:source.activeStoreId,
  stores:source.stores.map(store=>({
   id:store.id,
   version:store.version,
   store:store.store,
   employees:[],
   fixed:store.fixed.map(cloudFixed),
   current:store.current,
   weeks:Object.fromEntries(Object.entries(store.weeks).map(([key,week])=>[key,cloudWeek(week,store.employees,root.syncFormat==='shift-sheet-v1')]))
  }))
 });
}

function mapWeekNamesToLocal(week,employees){
 const byId=new Map(employees.map(employee=>[employee.id,employee]));
 const setName=shift=>{
  if(!shift)return null;
  let employee=byId.get(shift.employeeId);
  if(!employee){
   const matches=employees.filter(item=>employeeShiftName(item)===shift.name);
   if(matches.length===1)employee=matches[0];
  }
  // Restore this device's private display name when a cloud placeholder matches locally.
  return employee?{...shift,employeeId:employee.id,name:shift.name==='従業員'?employeeShiftName(employee):shift.name}:shift;
 };
 for(const day of week.days){
  day.shifts=day.shifts.map(row=>row.map(setName));
  day.extras=day.extras.map(extra=>extra?.type==='training'?{...extra,...setName(extra)}:extra);
 }
 if(week.confirmation?.snapshot?.days)for(const day of week.confirmation.snapshot.days){
  day.shifts=day.shifts.map(row=>row.map(setName));
  day.extras=day.extras.map(extra=>extra?.type==='training'?{...extra,...setName(extra)}:extra);
 }
}

// Merge a schedule-only cloud payload with this device's private employee and
// birthday data. Notes are kept per-device and are never imported from cloud.
export function mergeScheduleRoot(remoteRoot,localRoot){
 const remote=projectScheduleRoot(remoteRoot);
 const local=validateRoot(copy(localRoot));
 const stores=remote.stores.map(remoteStore=>{
  const localStore=local.stores.find(item=>item.id===remoteStore.id);
  const merged=copy(remoteStore);
  merged.employees=copy(localStore?.employees||[]);
  if(localStore?.current&&Object.hasOwn(merged.weeks,localStore.current))merged.current=localStore.current;
  for(const [key,week] of Object.entries(merged.weeks)){
   const localWeek=localStore?.weeks[key];
   if(localWeek){
    week.days.forEach((day,index)=>{day.notes=localWeek.days[index]?.notes||'';});
    if(week.confirmation&&localWeek.confirmation?.confirmedAt===week.confirmation.confirmedAt){
     week.confirmation.snapshot.days.forEach((day,index)=>{day.notes=localWeek.confirmation.snapshot.days[index]?.notes||'';});
    }
   }
   mapWeekNamesToLocal(week,merged.employees);
  }
  return merged;
 });
 const activeStoreId=local.stores.some(store=>store.id===local.activeStoreId)&&stores.some(store=>store.id===local.activeStoreId)?local.activeStoreId:remote.activeStoreId;
 const result={version:2,activeStoreId,stores};
 for(const field of ['birthdayAcknowledgements','birthdayGiftDelivered','birthdayGiftDeliveryStores']){
  if(local[field]!==undefined)result[field]=copy(local[field]);
 }
 if(!result.stores.some(store=>store.id===result.activeStoreId)&&local.stores.some(store=>store.id===local.activeStoreId))result.activeStoreId=local.activeStoreId;
 return validateRoot(result);
}
