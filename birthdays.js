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


export function birthdayGiftChecklist(root,year=Number(japanToday().slice(0,4))){
 if(!Number.isInteger(year)||year<2000||year>9999)return [];
 const delivered=new Set(root.birthdayGiftDelivered||[]);
 const result=[];

 for(const store of root.stores){
  for(const employee of store.employees){
   if(employee.hidden||!validDate(employee.birthDate))continue;

   const birthday=anniversary(employee.birthDate,year);
   const hasHireDate=validDate(employee.hireDate);
   const firstAnniversary=hasHireDate
    ?anniversary(employee.hireDate,Number(employee.hireDate.slice(0,4))+1)
    :'';
   const eligible=hasHireDate&&firstAnniversary<=birthday;
   const key=JSON.stringify([store.id,employee.id,birthday]);

   result.push({
    key,
    storeId:store.id,
    store:store.store,
    employeeId:employee.id,
    name:employee.name,
    birthday,
    eligible,
    eligibilityReason:eligible?'eligible':hasHireDate?'underOneYear':'hireDateMissing',
    delivered:eligible&&delivered.has(key)
   });
  }
 }

 return result.sort((a,b)=>
  a.birthday.slice(5).localeCompare(b.birthday.slice(5))||
  a.store.localeCompare(b.store)||
  a.name.localeCompare(b.name)
 );
}
