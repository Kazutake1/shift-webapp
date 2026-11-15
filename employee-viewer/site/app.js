import {holidays} from './holidays.js';

// This is a SEPARATE website. Never import manager app.js, cloud-sync.js,
// stores.js, employee records, or any password/owner data into this bundle.
const ACCESS_URL='https://wpyhkewwzsdcstypcbmq.supabase.co/functions/v1/employee-viewer-access';
const STORAGE_KEY='shift-employee-viewer-session-v1';
const bands=[{start:360,end:540},{start:540,end:780},{start:780,end:1020},{start:1020,end:1320},{start:1320,end:1800}];
const $=id=>document.getElementById(id);
const viewerCode=new URLSearchParams(location.search).get('code')||'';
const validCode=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(viewerCode);
let session=null;
let currentWeek=tokyoWeekStart();
const el=(tag,attrs={},text='')=>{
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attrs)){
  if(key==='class')node.className=value;
  else node.setAttribute(key,value);
 }
 node.textContent=text;
 return node;
};
function two(value){return String(value).padStart(2,'0');}
function isoDate(date){
 return `${date.getUTCFullYear()}-${two(date.getUTCMonth()+1)}-${two(date.getUTCDate())}`;
}
function addDays(iso,days){
 const d=new Date(iso+'T12:00:00Z');
 d.setUTCDate(d.getUTCDate()+days);
 return isoDate(d);
}
function monday(iso){
 const d=new Date(iso+'T12:00:00Z');
 return addDays(iso,-((d.getUTCDay()+6)%7));
}
function tokyoWeekStart(){
 const now=new Intl.DateTimeFormat('en-US',{
  timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(new Date());
 const item=key=>now.find(part=>part.type===key)?.value||'';
 return monday(`${item('year')}-${item('month')}-${item('day')}`);
}
function timeLabel(minutes){return `${Math.floor(minutes/60)%24}:${two(minutes%60)}`;}
function shiftLabel(shift,bandIndex){
 if(!shift)return '';
 const band=bands[bandIndex];
 let tail='';
 if(shift.start!==band.start&&shift.end!==band.end)tail=`${timeLabel(shift.start)}〜${timeLabel(shift.end)}`;
 else if(shift.start!==band.start)tail=`${timeLabel(shift.start)}〜`;
 else if(shift.end!==band.end)tail=`〜${timeLabel(shift.end)}`;
 return shift.name+(tail?`（${tail}）`:'');
}
function taskLabel(text,start,end,bandIndex){
 if(!text)return '';
 return shiftLabel({name:text,start,end},bandIndex);
}
function fixedTextAt(fixed,date,band){
 if(!fixed?.text)return '';
 const weekday=new Date(date+'T12:00:00Z').getUTCDay();
 return fixed.days?.includes(weekday)?taskLabel(fixed.text,fixed.start,fixed.end,band):'';
}
function dayInfo(date){
 const weekday=new Date(date+'T12:00:00Z').getUTCDay();
 return {weekday,holiday:holidays[date]||'',
  color:weekday===0||holidays[date]?'red':weekday===6?'blue':''};
}
function period(){return `${currentWeek.replaceAll('-','/')} — ${addDays(currentWeek,6).replaceAll('-','/')}`;}
function showLogin(error=''){
 $('viewer-sheet-page').hidden=true;
 $('viewer-login').hidden=false;
 $('viewer-logout').hidden=true;
 $('viewer-login-error').textContent=error;
 $('viewer-store-name').textContent='シフト確認';
}
function showSheet(){
 $('viewer-login').hidden=true;
 $('viewer-sheet-page').hidden=false;
 $('viewer-logout').hidden=false;
}
function clearSession(){
 session=null;
 try{sessionStorage.removeItem(STORAGE_KEY);}catch{}
}
function saveSession(data){
 session=data;
 try{sessionStorage.setItem(STORAGE_KEY,JSON.stringify(data));}catch{}
}
function readSession(){
 try{
  const value=JSON.parse(sessionStorage.getItem(STORAGE_KEY)||'null');
  return value?.code===viewerCode&&/^[A-Za-z0-9_-]{43}$/.test(value.token)&&Date.parse(value.expiresAt)>Date.now()?value:null;
 }catch{return null;}
}
function renderEmpty(message){
 $('schedule').replaceChildren();
 $('viewer-sheet-message').textContent=message;
 $('paper').hidden=true;
}
function renderTable(sheet){
 if(!sheet||sheet.format!=='employee-schedule-only-v1'||!Array.isArray(sheet.days)||sheet.days.length!==7){
  renderEmpty('シフト表を表示できません。');return;
 }
 $('viewer-sheet-message').textContent='';
 $('paper').hidden=false;
 $('viewer-store-name').textContent=sheet.storeName;
 $('store-name').textContent=sheet.storeName;
 $('viewer-week-label').textContent=period();
 $('paper-period').textContent=period();
 const table=$('schedule');
 table.replaceChildren();
 const cols=el('colgroup');
 cols.append(el('col',{class:'date'}),el('col',{class:'day'}));
 for(let hour=0;hour<24;hour++)cols.append(el('col'));
 cols.append(el('col',{class:'notes'}));
 table.append(cols);
 const head=el('thead'),hr=el('tr');
 hr.append(el('th',{colspan:'2',class:'month'},`${Number(currentWeek.slice(5,7))}月`));
 for(let hour=0;hour<24;hour++){
  hr.append(el('th',{scope:'col',class:[0,3,7,11,16].includes(hour)?'boundary':''},String((hour+6)%24)));
 }
 hr.append(el('th',{scope:'col',class:'notes-head'},'備考'));
 head.append(hr);table.append(head);
 const body=el('tbody');
 for(const day of sheet.days){
  const info=dayInfo(day.date);
  for(let row=0;row<5;row++){
   const tr=el('tr',{class:row===0?'day-start':row===4?'extra':''});
   if(row===0){
    const date=el('td',{rowspan:'5',class:`date-cell ${info.color} ${day.date.endsWith('-01')?'month-date':''}`,title:info.holiday},
     day.date.endsWith('-01')?`${Number(day.date.slice(5,7))}/${Number(day.date.slice(8))}`:String(Number(day.date.slice(8))));
    date.append(el('small',{},'日'));
    tr.append(date,el('td',{rowspan:'4',class:`day-cell ${info.color}`,title:info.holiday},'日月火水木金土'[info.weekday]));
   }
   if(row===4)tr.append(el('td',{class:'day-blank'}));
   bands.forEach((band,index)=>{
    let label='';
    let shift=null;
    if(row===0)label=fixedTextAt(sheet.fixed[index],day.date,index);
    else if(row===4){
     const extra=day.extras[index];
     if(extra?.type==='training'){
      const timed={...extra,start:Number.isInteger(extra.start)?extra.start:band.start,
       end:Number.isInteger(extra.end)?extra.end:band.end};
      label='トレーニング：'+shiftLabel(timed,index);
     }else if(extra?.type==='task'){
      label=taskLabel(extra.text,extra.start??band.start,extra.end??band.end,index);
     }
    }else{
     shift=day.shifts[row-1][index];
     label=shiftLabel(shift,index);
    }
    const td=el('td',{colspan:String((band.end-band.start)/60),
     class:`slot ${row>=1&&row<=3?'employee-slot':''} ${label?'occupied':''}`});
    const content=el('span',{class:`viewer-cell ${label.length>9?'long':''}`},label);
    if(row>=1&&row<=3&&shift){
     const cap=el('span',{class:'employee-caption'});
     cap.append(el('span',{class:'employee-name'},shift.name));
     const suffix=label.slice(shift.name.length);
     if(suffix)cap.append(el('span',{class:'employee-time'},suffix));
     content.replaceChildren(cap);
    }
    td.append(content);tr.append(td);
   });
   if(row===0)tr.append(el('td',{rowspan:'5',class:'notes-cell'}));
   body.append(tr);
  }
 }
 table.append(body);
}

async function readWeek(){
 if(!session)return;
 $('viewer-week-label').textContent=period();
 $('paper-period').textContent=period();
 $('viewer-sheet-message').textContent='読み込み中…';
 try{
  const response=await fetch(ACCESS_URL+'?weekStart='+encodeURIComponent(currentWeek),{
   method:'GET',headers:{Authorization:'Bearer '+session.token},cache:'no-store'
  });
  if(response.status===401){clearSession();showLogin('ログインし直してください。');return;}
  if(response.status===404){renderEmpty('この週のシフト表は表示できません。');return;}
  if(!response.ok)throw Error('schedule access failed');
  const sheet=await response.json();
  renderTable(sheet);
  showSheet();
 }catch{
  renderEmpty('通信に失敗しました。接続状況を確認してください。');
 }
}
$('viewer-login-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!validCode){showLogin('店舗のQRコードから開いてください。');return;}
 const password=$('viewer-pin').value;
 if(!/^[0-9]{6}$/.test(password)){$('viewer-login-error').textContent='数字6桁で入力してください。';return;}
 const submit=$('viewer-login-button');
 submit.disabled=true;
 $('viewer-login-error').textContent='';
 try{
  const response=await fetch(ACCESS_URL,{
   method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({viewerCode,password})
  });
  if(response.status===429){
   $('viewer-login-error').textContent='入力回数の制限に達しました。15分後にお試しください。';return;
  }
  if(!response.ok){$('viewer-login-error').textContent='パスワードを確認してください。';return;}
  const data=await response.json();
  if(!/^[A-Za-z0-9_-]{43}$/.test(data.token)||Date.parse(data.expiresAt)<=Date.now()){
   throw Error('invalid response');
  }
  saveSession({code:viewerCode,token:data.token,expiresAt:data.expiresAt});
  showSheet();
  await readWeek();
 }catch{
  $('viewer-login-error').textContent='通信に失敗しました。接続状況を確認してください。';
 }finally{
  $('viewer-pin').value='';
  submit.disabled=false;
 }
});
$('viewer-logout').addEventListener('click',()=>{
 clearSession();$('schedule').replaceChildren();showLogin();
});
$('viewer-previous').addEventListener('click',()=>{currentWeek=addDays(currentWeek,-7);readWeek();});
$('viewer-next').addEventListener('click',()=>{currentWeek=addDays(currentWeek,7);readWeek();});
$('viewer-this-week').addEventListener('click',()=>{currentWeek=tokyoWeekStart();readWeek();});
if(!validCode)showLogin('店舗のQRコードから開いてください。');
else{
 session=readSession();
 if(session){showSheet();readWeek();}
 else showLogin();
}
