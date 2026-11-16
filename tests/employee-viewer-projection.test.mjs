import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../model.js';
import {migrate} from '../stores.js';
import {projectEmployeeScheduleWeek} from '../employee-viewer/projection.mjs';

const WEEK='2026-09-21';
function synthetic(){
 const root=migrate(initialState());
 const store=root.stores[0],week=store.weeks[WEEK],employee=store.employees[0];
 employee.id='private-employee-id';
 employee.name='秘密フルネーム';
 employee.shiftName='朝A';
 employee.employeeNumber='EMP-PRIVATE-812';
 employee.birthDate='1990-01-01';
 employee.hireDate='2020-01-01';
 week.days[0].shifts[0][0]={
  employeeId:employee.id,name:employee.name,start:360,end:540
 };
 week.days[0].notes='SECRET-NOTES-NEVER-PUBLISH';
 week.days[0].extras[0]={
  type:'task',text:'TASK-SECRET-TEXT',start:360,end:540
 };
 week.days[0].extras[1]={
  type:'training',employeeId:employee.id,name:employee.name,start:540,end:780
 };
 return root;
}
function confirm(root,storeId=root.activeStoreId){
 const store=root.stores.find(s=>s.id===storeId),week=store.weeks[WEEK];
 week.confirmation={confirmedAt:'2026-09-20T03:00:00.000Z',snapshot:{days:structuredClone(week.days)}};
}

test('employee viewer: never returns an unconfirmed store week',()=>{
 const root=synthetic();
 assert.equal(projectEmployeeScheduleWeek(root,{storeId:root.activeStoreId,weekStart:WEEK}),null);
 assert.throws(()=>projectEmployeeScheduleWeek(root,{storeId:'other-store',weekStart:WEEK}),/店舗/);
});

test('employee viewer: excludes all roster fields, personal IDs, notes, task free text',()=>{
 const root=synthetic();confirm(root);
 const out=projectEmployeeScheduleWeek(root,{storeId:root.activeStoreId,weekStart:WEEK});
 const data=JSON.stringify(out);
 for(const key of ['employeeId','employeeNumber','birthDate','hireDate','retirementDate','employees','confirmation','snapshot','notes','sharedId','activeStoreId','owner_id','TASK-SECRET-TEXT','SECRET-NOTES-NEVER-PUBLISH','秘密フルネーム','private-employee-id','EMP-PRIVATE-812','1990-01-01']){
  assert.equal(data.includes(key),false,`unexpected personal field in publication: ${key}`);
 }
 assert.equal(out.format,'employee-schedule-only-v1');
 assert.equal(out.days.length,7);
 assert.deepEqual(out.days[0].shifts[0],{position:0,band:0,name:'朝A',start:360,end:540});
 assert.deepEqual(out.days[0].training[0],{position:3,band:1,name:'朝A',start:540,end:780});
});

test('employee viewer: full legal name aliases are never published',()=>{
 const root=synthetic(),store=root.stores[0];
 store.employees[0].shiftName='秘密 フルネーム';
 confirm(root);
 const pub=projectEmployeeScheduleWeek(root,{storeId:store.id,weekStart:WEEK});
 assert.equal(pub.days[0].shifts[0].name,'従業員');
 assert.equal(pub.days[0].training[0].name,'従業員');
});

test('employee viewer: reflect confirmed-after-edit schedule, never confirmation snapshot',()=>{
 const root=synthetic();confirm(root);
 const week=root.stores[0].weeks[WEEK];
 week.days[0].shifts[0][0].start=390;
 assert.equal(projectEmployeeScheduleWeek(root,{storeId:root.activeStoreId,weekStart:WEEK}).days[0].shifts[0].start,390);
 assert.equal(week.confirmation.snapshot.days[0].shifts[0][0].start,360);
});

test('employee viewer: a store request never includes another store',()=>{
 const root=synthetic();
 const second=structuredClone(root.stores[0]);
 second.id='other-store-id';
 second.store='OTHER-STORE-NAME';
 second.employees[0].name='ANOTHER-PRIVATE-NAME';
 second.weeks[WEEK].days[0].notes='OTHER-SECRET-NOTES';
 root.stores.push(second);
 confirm(root,root.activeStoreId);
 confirm(root,second.id);
 const first=projectEmployeeScheduleWeek(root,{storeId:root.activeStoreId,weekStart:WEEK});
 assert.equal(JSON.stringify(first).includes('OTHER-STORE-NAME'),false);
 assert.equal(JSON.stringify(first).includes('ANOTHER-PRIVATE-NAME'),false);
 assert.equal(JSON.stringify(first).includes('other-store-id'),false);
 assert.equal(first.storeName,root.stores[0].store);
});

test('employee viewer: rejects an invalid source instead of exposing it',()=>{
 const root=synthetic();
 root.stores[0].employees[0].birthDate='NOT-A-DATE';
 assert.throws(()=>projectEmployeeScheduleWeek(root,{storeId:root.activeStoreId,weekStart:WEEK}),/バックアップ/);
});
