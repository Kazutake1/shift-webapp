import {addDays} from './model.js';

export const confirmationDate=weekStart=>addDays(weekStart,-7);
export function localToday(now=new Date()){
 return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
const copy=value=>structuredClone(value);
const snapshot=week=>({days:week.days.map(day=>({shifts:copy(day.shifts),extras:copy(day.extras),notes:day.notes}))});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function diffWeekDays(before,after){
 const changes=[];
 if(!before||!after)return changes;
 for(let day=0;day<7;day++){
  for(let row=0;row<3;row++)for(let band=0;band<5;band++){
   const old=before.days[day].shifts[row][band],next=after.days[day].shifts[row][band];
   if(!same(old,next))changes.push({day,kind:'shift',row,band,before:copy(old),after:copy(next)});
  }
  for(let band=0;band<5;band++){
   const old=before.days[day].extras[band],next=after.days[day].extras[band];
   if(!same(old,next))changes.push({day,kind:'extra',band,before:copy(old),after:copy(next)});
  }
  const old=before.days[day].notes,next=after.days[day].notes;
  if(old!==next)changes.push({day,kind:'notes',before:old,after:next});
 }
 return changes;
}
export function changedSinceConfirmation(week){
 return week.confirmation?diffWeekDays(week.confirmation.snapshot,week):[];
}
export function hasDueUnconfirmedWeeks(root,today=localToday()){
 return root.stores.some(store=>Object.values(store.weeks).some(week=>!week.confirmation&&today>=confirmationDate(week.start)));
}
export function prepareWeekFinalizations(root,previous,{today=localToday(),at=new Date().toISOString()}={}){
 let confirmationUpdated=false;
 for(const store of root.stores){
  const oldStore=previous.stores.find(old=>old.id===store.id);
  for(const [key,week] of Object.entries(store.weeks)){
   const oldWeek=oldStore?.weeks[key];
   const oldConfirmation=oldWeek?.confirmation;
   if(oldConfirmation){
    // Undo may restore an older week object. Never roll back its audit trail.
    week.confirmation=copy(oldConfirmation);
   }else if(!week.confirmation&&today>=confirmationDate(key)){
    // When the deadline passed while offline, preserve what was saved before this edit.
    week.confirmation={confirmedAt:at,snapshot:snapshot(oldWeek||week),changes:[]};
   }
   if(!week.confirmation)continue;
   if(oldWeek){
    const changes=diffWeekDays(oldWeek,week);
    for(const change of changes)week.confirmation.changes.push({at,...change});
   }
   if(!same(week.confirmation,oldConfirmation))confirmationUpdated=true;
  }
 }
 return {sync:confirmationUpdated};
}
