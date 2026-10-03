import {addDays,employeeAvailableOn,employeeRetiredBy} from './model.js';
import {personKey} from './employee-identity.js';
export function japanToday(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const get=type=>parts.find(p=>p.type===type).value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&addDays(value,0)===value;}
function anniversary(date,year){const month=date.slice(5,7),day=date.slice(8),candidate=`${year}-${month}-${day}`;return validDate(candidate)?candidate:`${year}-02-28`;}
export function birthdayNotices(root,today=japanToday()){
 if(!validDate(today))return [];
 const result=[],seen=new Map(),year=Number(today.slice(0,4));
 for(const store of root.stores)for(const e of store.employees){
  if(e.hidden||employeeRetiredBy(e,today)||!validDate(e.birthDate)||!validDate(e.hireDate)||e.birthDate>today)continue;
  if(anniversary(e.hireDate,Number(e.hireDate.slice(0,4))+1)>today)continue;
  for(const y of [year,year+1]){
   const birthday=anniversary(e.birthDate,y);
   if(birthday<today||birthday>addDays(today,7)||!employeeAvailableOn(e,birthday))continue;
   const key=personKey(store,e,birthday);
   if((root.birthdayAcknowledgements||[]).includes(key))continue;
   const days=Math.round((Date.parse(birthday+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/86400000);
   if(seen.has(key)){
    const notice=seen.get(key);
    if(!notice.store.split('・').includes(store.store))notice.store+=`・${store.store}`;
   }else{
    const notice={key,store:store.store,name:e.name,birthday,days};
    seen.set(key,notice);result.push(notice);
   }
  }
 }
 return result.sort((a,b)=>a.birthday.localeCompare(b.birthday)||a.store.localeCompare(b.store));
}


export function birthdayGiftChecklist(root,year=Number(japanToday().slice(0,4)),today=japanToday()){
 if(!Number.isInteger(year)||year<2000||year>9999)return [];
 const delivered=new Set(root.birthdayGiftDelivered||[]);
 const result=[];
 const eligiblePeople=new Set();

 for(const store of root.stores)for(const employee of store.employees){
  if(employeeRetiredBy(employee,today)||!validDate(employee.birthDate)||!validDate(employee.hireDate))continue;
  const birthday=anniversary(employee.birthDate,year);
  const firstAnniversary=anniversary(employee.hireDate,Number(employee.hireDate.slice(0,4))+1);
  if(firstAnniversary<=birthday&&employeeAvailableOn(employee,birthday))eligiblePeople.add(personKey(store,employee,birthday));
 }

 for(const store of root.stores){
  for(const employee of store.employees){
   if(employeeRetiredBy(employee,today))continue;

   const hasBirthDate=validDate(employee.birthDate);
   const birthday=hasBirthDate?anniversary(employee.birthDate,year):'';
   const hasHireDate=validDate(employee.hireDate);
   const key=hasBirthDate?personKey(store,employee,birthday):'';
   const availableOnBirthday=hasBirthDate&&employeeAvailableOn(employee,birthday);
   const eligible=availableOnBirthday&&eligiblePeople.has(key);
   const deliveryStore=key?(root.birthdayGiftDeliveryStores||{})[key]:null;
   const deliveryStoreName=deliveryStore&&(root.stores.find(s=>s.id===deliveryStore.storeId)?.store||deliveryStore.storeName);

   result.push({
    key,
    storeId:store.id,
    store:store.store,
    employeeId:employee.id,
    name:employee.name,
    hidden:Boolean(employee.hidden),
    retirementDate:employee.retirementDate||'',
    birthday,
    eligible,
    eligibilityReason:eligible?'eligible':!hasBirthDate?'birthDateMissing':!availableOnBirthday?'notEmployedOnBirthday':hasHireDate?'underOneYear':'hireDateMissing',
    delivered:eligible&&delivered.has(key),
    deliveredByStoreId:deliveryStore?.storeId||'',
    deliveredByStoreName:deliveryStoreName||''
   });
  }
 }

 return result.sort((a,b)=>
  (a.birthday?a.birthday.slice(5):'99-99').localeCompare(b.birthday?b.birthday.slice(5):'99-99')||
  a.store.localeCompare(b.store)||
  a.name.localeCompare(b.name)
 );
}
