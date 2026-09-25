import {addDays} from './model.js';
export function japanToday(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const get=type=>parts.find(p=>p.type===type).value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&addDays(value,0)===value;}
function anniversary(date,year){const month=date.slice(5,7),day=date.slice(8),candidate=`${year}-${month}-${day}`;return validDate(candidate)?candidate:`${year}-02-28`;}
export function birthdayNotices(root,today=japanToday()){
 if(!validDate(today))return [];
 const result=[],year=Number(today.slice(0,4));
 for(const store of root.stores)for(const e of store.employees){
  if(e.hidden||!validDate(e.birthDate)||!validDate(e.hireDate)||e.birthDate>today)continue;
  if(anniversary(e.hireDate,Number(e.hireDate.slice(0,4))+1)>today)continue;
  for(const y of [year,year+1]){
   const birthday=anniversary(e.birthDate,y);
   if(birthday<today||birthday>addDays(today,7))continue;
   const key=JSON.stringify([store.id,e.id,birthday]);
   if((root.birthdayAcknowledgements||[]).includes(key))continue;
   const days=Math.round((Date.parse(birthday+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/86400000);
   result.push({key,store:store.store,name:e.name,birthday,days});
  }
 }
 return result.sort((a,b)=>a.birthday.localeCompare(b.birthday)||a.store.localeCompare(b.store));
}
