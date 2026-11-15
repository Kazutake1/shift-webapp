// Defensive allowlist over a server-read, schedule-only cloud payload.
// Never return source objects, employee IDs, notes, confirmation metadata,
// birthdays, employee roster, admin account data, or cloud revision.
import {validWeekStart} from './viewer-security.mjs';

const bands=[
 {start:360,end:540},{start:540,end:780},
 {start:780,end:1020},{start:1020,end:1320},{start:1320,end:1800}
];
const safeText=(text,max)=>typeof text==='string'&&text.length<=max?text:'';
const time=(value,fallback)=>Number.isInteger(value)&&value>=360&&value<=1800?value:fallback;
function safeShift(value,band){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const start=time(value.start,bands[band].start);
 const end=time(value.end,bands[band].end);
 if(end<=start)return null;
 return {name:safeText(value.name,20)||'従業員',start,end};
}
function fixedTask(value,band){
 if(typeof value==='string')return {text:safeText(value,40),days:[0,1,2,3,4,5,6],start:bands[band].start,end:bands[band].end};
 if(!value||typeof value!=='object'||Array.isArray(value))return {text:'',days:[],start:bands[band].start,end:bands[band].end};
 const days=Array.isArray(value.days)?value.days.filter(d=>Number.isInteger(d)&&d>=0&&d<=6).slice(0,7):[];
 const start=time(value.start,bands[band].start),end=time(value.end,bands[band].end);
 return {text:safeText(value.text,40),days,start,end:end>start?end:bands[band].end};
}
function extraRow(value,band){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 if(value.type==='training'){
  const shift=safeShift(value,band);
  return shift?{type:'training',...shift}:null;
 }
 if(value.type==='task'){
  const start=time(value.start,bands[band].start);
  const end=time(value.end,bands[band].end);
  if(end<=start)return null;
  const text=safeText(value.text,40);
  return text?{type:'task',text,start,end}:null;
 }
 return null;
}
export function projectCloudViewerWeek(root,storeId,weekStart){
 if(root?.syncFormat!=='shift-sheet-v1'||!Array.isArray(root.stores)||!validWeekStart(weekStart))return null;
 const store=root.stores.find(item=>item?.id===storeId);
 const week=store?.weeks?.[weekStart];
 if(!week||week.start!==weekStart||!week.confirmation?.confirmedAt||
    !Array.isArray(week.days)||week.days.length!==7||!Array.isArray(store.fixed)||store.fixed.length!==5){
  return null;
 }
 const days=[];
 for(let i=0;i<7;i++){
  const day=week.days[i];
  const expected=new Date(weekStart+'T12:00:00Z');
  expected.setUTCDate(expected.getUTCDate()+i);
  if(day?.date!==expected.toISOString().slice(0,10)||
     !Array.isArray(day.shifts)||day.shifts.length!==3||
     day.shifts.some(row=>!Array.isArray(row)||row.length!==5)||
     !Array.isArray(day.extras)||day.extras.length!==5)return null;
  days.push({
   date:day.date,
   shifts:day.shifts.map(row=>row.map((value,band)=>safeShift(value,band))),
   extras:day.extras.map((value,band)=>extraRow(value,band))
  });
 }
 return {
  format:'employee-schedule-only-v1',
  storeName:safeText(store.store,40),
  weekStart,
  fixed:store.fixed.map((value,band)=>fixedTask(value,band)),
  days
 };
}
