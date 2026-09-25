import {holidays,holidayYears} from './holidays.js';
export const bands = [{start:360,end:540},{start:540,end:780},{start:780,end:1020},{start:1020,end:1320},{start:1320,end:1800}];
export function dateKey(d){return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
export function addDays(key,n){const d=new Date(key+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return dateKey(d);}
export function monday(key){const d=new Date(key+'T12:00:00Z');return addDays(key,-((d.getUTCDay()+6)%7));}
export function timeLabel(n){return `${Math.floor(n/60)%24}:${String(n%60).padStart(2,'0')}`;}
export function timeValue(n){return timeLabel(n).padStart(5,'0');}
export function toMinutes(value){const [h,m]=value.split(':').map(Number);if(!Number.isInteger(h)||!Number.isInteger(m)||h<0||h>23||m<0||m>59)throw Error('時刻を確認してください。');return h*60+m+(h<6?1440:0);}
export function workingTimes(start,end){let s=toMinutes(start),e=toMinutes(end);if(e===360)e=1800;if(e<=s)throw Error('終了は開始より後にしてください（翌朝6:00まで）。');return {start:s,end:e};}
export function shiftLabel(shift,b){if(!shift)return '';const band=bands[b];let suffix='';if(shift.start!==band.start&&shift.end!==band.end)suffix=`${timeLabel(shift.start)}〜${timeLabel(shift.end)}`;else if(shift.start!==band.start)suffix=`${timeLabel(shift.start)}〜`;else if(shift.end!==band.end)suffix=`〜${timeLabel(shift.end)}`;return shift.name+(suffix?`（${suffix}）`:'');}
export function dayInfo(key){const weekday=new Date(key+'T12:00:00Z').getUTCDay();return {weekday,holiday:holidays[key]||'',supported:holidayYears.includes(Number(key.slice(0,4))),color:holidays[key]||weekday===0?'red':weekday===6?'blue':''};}
export function emptyWeek(key){return {start:key,days:Array.from({length:7},(_,i)=>({date:addDays(key,i),shifts:Array.from({length:3},()=>Array(5).fill(null)),extras:Array(5).fill(null),notes:''}))};}
export function ensureWeek(state,key){if(state.weeks[key])return false;const w=emptyWeek(key),prev=state.weeks[addDays(key,-7)];if(prev)w.days.forEach((d,i)=>d.shifts=structuredClone(prev.days[i].shifts));state.weeks[key]=w;return !!prev;}
export function employeeShiftName(employee){return employee?.shiftName?.trim()||employee?.name||'';}
export function makeShift(employee,b,start=bands[b].start,end=bands[b].end){return {employeeId:employee.id,name:employeeShiftName(employee),start,end};}
export function employeeShiftConflicts(day,candidate,exclude=null){
 const conflicts=[];
 if(!day?.shifts||!candidate?.employeeId||!Number.isInteger(candidate.start)||!Number.isInteger(candidate.end))return conflicts;
 day.shifts.forEach((row,rowIndex)=>row.forEach((shift,bandIndex)=>{
  if(!shift||shift.employeeId!==candidate.employeeId)return;
  if(exclude&&exclude.row===rowIndex&&exclude.band===bandIndex)return;
  if(candidate.start<shift.end&&shift.start<candidate.end)conflicts.push({row:rowIndex,band:bandIndex,shift});
 }));
 return conflicts;
}
export function initialState(){const employees=Array.from({length:10},(_,i)=>({id:`sample-${i}`,name:`従業員${String.fromCharCode(65+i)}`,hidden:false}));const key='2026-09-21',w=emptyWeek(key);w.days.forEach(d=>bands.forEach((_,b)=>{d.shifts[0][b]=makeShift(employees[b*2],b);d.shifts[1][b]=makeShift(employees[b*2+1],b);}));return {version:1,store:'サンプル店',employees,fixed:['','売上日報','','',''],current:key,weeks:{[key]:w}};}

export function timedTextLabel(text,start,end,b){if(!text)return '';const band=bands[b];let suffix='';if(start!==band.start&&end!==band.end)suffix=`${timeLabel(start)}〜${timeLabel(end)}`;else if(start!==band.start)suffix=`${timeLabel(start)}〜`;else if(end!==band.end)suffix=`〜${timeLabel(end)}`;return text+(suffix?`（${suffix}）`:'');}
export function fixedSetting(value,b){const band=Number.isInteger(b)?bands[b]:null;if(typeof value==='string')return {text:value,days:[1,2,3,4,5,6,0],start:band?.start,end:band?.end};return {text:value?.text||'',days:Array.isArray(value?.days)?value.days:[],start:Number.isInteger(value?.start)?value.start:band?.start,end:Number.isInteger(value?.end)?value.end:band?.end};}
export function fixedTextAt(value,date,b){const setting=fixedSetting(value,b);return setting.days.includes(new Date(date+'T12:00:00Z').getUTCDay())?timedTextLabel(setting.text,setting.start,setting.end,b):'';}
