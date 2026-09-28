export function personKey(store,employee,birthday){
 return JSON.stringify(employee.sharedId?['person',employee.sharedId,birthday]:[store.id,employee.id,birthday]);
}

export function linkEmployees(root,storeId,employeeId,otherStoreId,otherEmployeeId){
 const store=root.stores.find(s=>s.id===storeId);
 const other=root.stores.find(s=>s.id===otherStoreId);
 const employee=store?.employees.find(e=>e.id===employeeId);
 const target=other?.employees.find(e=>e.id===otherEmployeeId);
 if(!employee||!target||storeId===otherStoreId)throw Error('連携する従業員を確認してください。');
 const members=root.stores.flatMap(s=>s.employees.filter(e=>e.sharedId===target.sharedId&&e.sharedId).map(e=>({store:s,employee:e})));
 if(members.some(item=>item.store.id===storeId&&item.employee.id!==employeeId))throw Error('同じ店舗にすでに連携済みの従業員がいます。');
 const id=target.sharedId||crypto.randomUUID();
 const birthDate=employee.birthDate||target.birthDate||'';
 const oldIds=new Set([employee.sharedId,target.sharedId].filter(Boolean));
 const affected=root.stores.flatMap(s=>s.employees.filter(e=>e===employee||e===target||e.sharedId&&oldIds.has(e.sharedId)).map(e=>({store:s,employee:e})));
 const seenStores=new Set();
 for(const item of affected){
  if(seenStores.has(item.store.id))throw Error('同じ店舗の従業員を二人以上連携できません。');
  seenStores.add(item.store.id);
 }
 const migrate=field=>{
  const keys=new Set(root[field]||[]);
  const years=new Set();
  for(const key of keys){
   try{
    const parts=JSON.parse(key);
    if(Array.isArray(parts)&&/^\d{4}-\d{2}-\d{2}$/.test(parts[2]))years.add(Number(parts[2].slice(0,4)));
   }catch{}
  }
  for(const year of years){
   const birthday=anniversary(birthDate,year);
   if(!birthday)continue;
   let marked=false;
   for(const {store:s,employee:e} of affected){
    const legacy=JSON.stringify([s.id,e.id,anniversary(e.birthDate,year)]);
    const shared=e.sharedId&&JSON.stringify(['person',e.sharedId,anniversary(e.birthDate,year)]);
    if(keys.delete(legacy))marked=true;
    if(shared&&keys.delete(shared))marked=true;
   }
   if(marked)keys.add(JSON.stringify(['person',id,birthday]));
  }
  root[field]=[...keys];
 };
 migrate('birthdayAcknowledgements');
 migrate('birthdayGiftDelivered');
 for(const {employee:e} of affected){
  e.sharedId=id;
  e.name=employee.name;
  e.birthDate=birthDate;
 }
}

function anniversary(date,year){
 if(!date)return '';
 const suffix=date.slice(5);
 const value=`${year}-${suffix}`;
 return suffix==='02-29'&&!isLeap(year)?`${year}-02-28`:value;
}
function isLeap(year){return year%4===0&&(year%100!==0||year%400===0);}

export function unlinkEmployee(root,storeId,employeeId){
 const store=root.stores.find(s=>s.id===storeId);
 const employee=store?.employees.find(e=>e.id===employeeId);
 if(!employee?.sharedId)return;
 const id=employee.sharedId;
 const remaining=root.stores.flatMap(s=>s.employees.filter(e=>e.sharedId===id&&e!==employee).map(e=>({store:s,employee:e})));
 for(const field of ['birthdayAcknowledgements','birthdayGiftDelivered']){
  const keys=new Set(root[field]||[]);
  for(const key of [...keys]){
   let parts;try{parts=JSON.parse(key);}catch{continue;}
   if(!Array.isArray(parts)||parts[0]!=='person'||parts[1]!==id)continue;
   keys.delete(key);
   keys.add(JSON.stringify([storeId,employeeId,parts[2]]));
   if(remaining.length)keys.add(key);
  }
  root[field]=[...keys];
 }
 delete employee.sharedId;
}

export function syncEmployeeProfile(root,employee){
 if(!employee.sharedId)return;
 for(const store of root.stores)for(const other of store.employees){
  if(other!==employee&&other.sharedId===employee.sharedId){
   other.name=employee.name;
   other.birthDate=employee.birthDate;
  }
 }
}

export function updateBirthdayKeys(root,employee,newBirthDate){
 if(!employee.sharedId||!employee.birthDate||!newBirthDate||employee.birthDate===newBirthDate)return;
 for(const field of ['birthdayAcknowledgements','birthdayGiftDelivered']){
  root[field]=(root[field]||[]).map(key=>{
   let parts;try{parts=JSON.parse(key);}catch{return key;}
   if(!Array.isArray(parts)||parts[0]!=='person'||parts[1]!==employee.sharedId)return key;
   const year=Number(String(parts[2]).slice(0,4));
   return JSON.stringify(['person',employee.sharedId,anniversary(newBirthDate,year)]);
  });
  root[field]=[...new Set(root[field])];
 }
}
