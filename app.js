import {createBirthdayUi} from './birthday-ui.js';
import {monday,bands,addDays,timeLabel,timeValue,workingTimes,shiftLabel,timedTextLabel,dayInfo,ensureWeek,makeShift,employeeShiftName,employeeShiftConflicts,fixedSetting,fixedTextAt} from './model.js';
import {createStoreUi} from './store-dialog.js';
import {openBackupDialog} from './backup-dialog.js';
import {createEmployeeUi,withinFirstMonth} from './employee-dialog.js';
import {createStateManager} from './state-manager.js';
import {createPrintPdf} from './print-pdf.js';
const $=s=>document.querySelector(s);
let preview=false,activeCell=null,backupAt='';
try{backupAt=localStorage.getItem('shift-last-backup')||'';}catch{}

function updateTools(){
 const date=new Date(backupAt);
 $('#backup-date').textContent=backupAt&&!isNaN(date)
  ?`最終バックアップ作成：${date.toLocaleString('ja-JP')}`
  :'バックアップはまだ作成していません';
}

function setSaveStatus(text=''){
 const host=$('#save-status'),saved=$('#saved');
 saved.textContent=text;
 host.hidden=!text;
}

function setUndoAvailable(available){
 document.querySelectorAll('[data-undo]').forEach(button=>button.disabled=!available);
}

const stateManager=createStateManager({
 onStatus:setSaveStatus,
 onUndoChange:setUndoAvailable,
 onRollback:()=>render(),
 onSaveFailure:()=>alert('変更を端末に保存できなかったため、今回の変更は反映していません。空き容量を確認してください。')
});

const persistChange=(change,edit=true)=>stateManager.persistChange(change,edit);
const replaceRoot=(candidate,options)=>stateManager.replaceRoot(candidate,options);

function undo(){
 if(!stateManager.canUndo())return;
 const body=openDialog('直前の操作を取り消しますか？');
 const actions=el('div',{class:'actions'});
 actions.append(button('いいえ',close),button('はい',()=>{
  const result=stateManager.undoLast();
  if(!result.ok){
   if(result.reason==='empty'){close();return;}
   error.textContent=result.message;
   return;
  }
  render();close();
 },'primary'));
 const error=el('p',{class:'error',role:'alert'});
 body.append(error,actions);
 actions.firstElementChild.focus();
}
function el(tag,attrs={},text=''){const n=document.createElement(tag);for(const [k,v]of Object.entries(attrs)){if(k==='class')n.className=v;else n.setAttribute(k,v);}n.textContent=text;return n;}
function button(text,fn,cls=''){const n=el('button',{type:'button',class:cls},text);n.onclick=fn;return n;}
function week(){const state=stateManager.getState();return state.weeks[state.current];}
function period(){const state=stateManager.getState();return `${state.current.replaceAll('-','/')} — ${addDays(state.current,6).replaceAll('-','/')}`;}
function fitText(){
 document.querySelectorAll('td.slot button,td.notes-cell button').forEach(n=>{
  n.style.removeProperty('font-size');
  const name=n.querySelector('.employee-name');
  if(name){
   name.style.removeProperty('font-size');
   if(!n.clientWidth)return;
   const style=getComputedStyle(n),caption=n.querySelector('.employee-caption');
   const available=n.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-2;
   let size=parseFloat(getComputedStyle(name).fontSize);
   // Keep the time size fixed; only reduce the name when the complete label is too wide.
   while(size>1&&caption.offsetWidth>available){
    size=Math.max(1,size-.25);name.style.fontSize=size+'px';
   }
   return;
  }
  if(!n.textContent)return;
  let size=parseFloat(getComputedStyle(n).fontSize);
  while(size>6&&(n.scrollHeight>n.clientHeight+1||n.scrollWidth>n.clientWidth+1)){
   size-=.5;n.style.setProperty('font-size',size+'px','important');
  }
 });
 drawRules();
}
// 用紙幅を先に確定してから文字と罫線を計測する。印刷中の再計測は抑える。
let printLayoutActive=false,printRequested=false,printRecoveryTimer=0;
const printMedia=window.matchMedia('print');
const isAppleMobile=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let lastPrintPdfUrl='',lastPrintPdfFile=null,previewPdfGeneration=0;
function preparePrint(){
 clearTimeout(printRecoveryTimer);
 printLayoutActive=true;
 document.body.classList.add('print-layout');
 fitText();
}
function finishPrint(){
 clearTimeout(printRecoveryTimer);printRecoveryTimer=0;
 if(!printLayoutActive){printRequested=false;return;}
 document.body.classList.remove('print-layout');
 printLayoutActive=false;printRequested=false;
 requestAnimationFrame(fitText);
}
function schedulePrintRecovery(delay=1200){
 clearTimeout(printRecoveryTimer);
 printRecoveryTimer=setTimeout(()=>{
  if(printRequested&&!printMedia.matches&&!document.hidden)finishPrint();
 },delay);
}
async function printSchedule(){
 if(printRequested)return;
 printRequested=true;
 try{
  preparePrint();
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  fitText();
  window.print();
  // iPhone / iPadではafterprintが戻らない場合があるため、通常画面へ戻す保険を入れる。
  schedulePrintRecovery();
 }catch(error){finishPrint();alert(`印刷できませんでした：${error.message}`);}
}
if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{if(!printLayoutActive)drawRules();}).observe($('#schedule'));
printMedia.addEventListener('change',event=>{if(event.matches)preparePrint();else finishPrint();});
window.addEventListener('resize',()=>{if(!printLayoutActive)fitText();});
window.addEventListener('beforeprint',preparePrint);
window.addEventListener('afterprint',finishPrint);
window.addEventListener('focus',()=>{if(printRequested)schedulePrintRecovery(300);});
window.addEventListener('pageshow',()=>{if(printRequested)schedulePrintRecovery(300);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&printRequested)schedulePrintRecovery(300);});
window.addEventListener('storage',event=>{
 if(!stateManager.handleStorageEvent(event))return;
 alert('別のタブまたはウインドウでシフトデータが変更されました。上書きを防ぐため、この画面からの保存を停止しました。アプリを開き直してください。');
});

function drawRules(){
  const table=$('#schedule'),host=table.parentElement;
  host.querySelector('.table-rules')?.remove();
  const rect=table.getBoundingClientRect();if(!rect.width)return;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('preserveAspectRatio','none');
  svg.setAttribute('class','table-rules');svg.setAttribute('aria-hidden','true');
  svg.setAttribute('width',rect.width);svg.setAttribute('height',rect.height);
  svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);
  const hostRect=host.getBoundingClientRect();
  svg.style.left=(rect.left-hostRect.left+host.scrollLeft)+'px';svg.style.top=(rect.top-hostRect.top+host.scrollTop)+'px';
  const line=(x1,y1,x2,y2,width=2,color='#111')=>{const n=document.createElementNS(ns,'line');for(const [key,value] of Object.entries({x1,y1,x2,y2,stroke:color,'stroke-width':width}))n.setAttribute(key,value);svg.append(n);};
  const bounds=n=>{const r=n.getBoundingClientRect();return {left:r.left-rect.left,right:r.right-rect.left,top:r.top-rect.top,bottom:r.bottom-rect.top};};
  const first=table.querySelector('tbody tr'),date=bounds(first.querySelector('.date-cell')),notes=bounds(first.querySelector('.notes-cell'));
  // Every vertical rule uses the measured hourly header boundaries.
  const hours=[...table.querySelectorAll('thead th')].slice(1,-1);
  const ticks=hours.map(n=>bounds(n).left);
  ticks.push(bounds(table.querySelector('.notes-head')).left);
  const major=new Set([0,3,7,11,16,24]);
  const header=bounds(table.querySelector('thead'));
  for(let i=1;i<24;i++)if(!major.has(i))line(ticks[i],0,ticks[i],header.bottom,1,'#bbb');
  table.querySelectorAll('tbody tr').forEach(row=>{
    let offset=0;
    row.querySelectorAll('.slot').forEach(cell=>{
      const span=cell.colSpan,r=bounds(cell);
      if(!cell.classList.contains('occupied')){
        for(let i=offset+1;i<offset+span;i++)line(ticks[i],r.top,ticks[i],r.bottom,1,'#bbb');
      }
      offset+=span;
    });
  });
  const outer=parseFloat(getComputedStyle(table).borderTopWidth);
  line(outer/2,0,outer/2,rect.height,outer);line(rect.width-outer/2,0,rect.width-outer/2,rect.height,outer);
  line(0,outer/2,rect.width,outer/2,outer);line(0,rect.height-outer/2,rect.width,rect.height-outer/2,outer);
  line(0,header.bottom-1,rect.width,header.bottom-1,1);line(0,header.bottom+1,rect.width,header.bottom+1,1);
  line(date.right,header.bottom,date.right,rect.height);
  major.forEach(i=>line(ticks[i],0,ticks[i],rect.height));
  table.querySelectorAll('tr.extra').forEach((row,i)=>{const r=bounds(row);line(date.right,r.top,notes.left,r.top);if(i<6)line(0,r.bottom,rect.width,r.bottom);});
  host.append(svg);
}

function render(){const root=stateManager.getRoot(),state=stateManager.getState(),storageError=stateManager.getStorageError();renderBirthdays();const table=$('#schedule');table.replaceChildren();const cols=el('colgroup');cols.append(el('col',{class:'date'}),el('col',{class:'day'}));for(let i=0;i<24;i++)cols.append(el('col'));cols.append(el('col',{class:'notes'}));table.append(cols);const head=el('thead'),hr=el('tr');hr.append(el('th',{colspan:2,class:'month'},`${Number(state.current.slice(5,7))}月`));for(let i=0;i<24;i++)hr.append(el('th',{scope:'col',class:[0,3,7,11,16].includes(i)?'boundary':''},String((i+6)%24)));hr.append(el('th',{scope:'col',class:'notes-head'},'備考'));head.append(hr);table.append(head);const body=el('tbody');week().days.forEach((day,d)=>{const info=dayInfo(day.date);for(let row=0;row<5;row++){const tr=el('tr',{class:row===0?'day-start':row===4?'extra':''});if(row===0){const date=el('td',{rowspan:5,class:`date-cell ${info.color} ${day.date.endsWith("-01")?"month-date":""}`,title:info.holiday},day.date.endsWith('-01')?`${Number(day.date.slice(5,7))}/${Number(day.date.slice(8))}`:String(Number(day.date.slice(8))));date.append(el('small',{},'日'));tr.append(date,el('td',{rowspan:4,class:`day-cell ${info.color}`,title:info.holiday},'日月火水木金土'[info.weekday]));}if(row===4)tr.append(el('td',{class:'day-blank'}));bands.forEach((band,b)=>{let label='';if(row===0)label=fixedTextAt(state.fixed[b],day.date,b);else if(row===4){const extra=day.extras[b];if(extra?.type==='training'){const timed={...extra,start:Number.isInteger(extra.start)?extra.start:band.start,end:Number.isInteger(extra.end)?extra.end:band.end};label=`トレーニング：${shiftLabel(timed,b)}`;}else if(extra?.type==='task'){const start=Number.isInteger(extra.start)?extra.start:band.start,end=Number.isInteger(extra.end)?extra.end:band.end;label=timedTextLabel(extra.text,start,end,b);}}else label=shiftLabel(day.shifts[row-1][b],b);const td=el('td',{colspan:(band.end-band.start)/60,class:`slot ${row>=1&&row<=3?'employee-slot':''} ${label?'occupied':''}`,style:`--hours:${(band.end-band.start)/60}`});const btn=button(label,()=>openCell(d,row,b));btn.setAttribute('aria-label',`${day.date} ${['固定作業','従業員①','従業員②','予備従業員','不定期作業／トレーニング'][row]} ${timeLabel(band.start)}〜${timeLabel(band.end)} ${label||'空欄'}`);if(row>=1&&row<=3&&label){const shift=day.shifts[row-1][b];const caption=el('span',{class:'employee-caption'});caption.append(el('span',{class:'employee-name'},shift.name));const suffix=label.slice(shift.name.length);if(suffix)caption.append(el('span',{class:'employee-time'},suffix));btn.replaceChildren(caption);}else if(label.length>9)btn.classList.add('long');td.append(btn);tr.append(td);});if(row===0){const td=el('td',{rowspan:5,class:'notes-cell'}),btn=button(day.notes,()=>openNotes(d));btn.setAttribute('aria-label',`${day.date} 備考 ${day.notes||'空欄'}`);td.append(btn);tr.append(td);}body.append(tr);}});table.append(body);$('#week-label').textContent=period();$('#paper-period').textContent=period();$('#store-name').textContent=state.store;$('#settings-store').textContent=`選択中の店舗：${state.store}`;$('#store').replaceChildren(...root.stores.map(s=>el('option',{value:s.id},s.store||'名称未設定')));$('#store').value=state.id;const unsupported=week().days.some(d=>!dayInfo(d.date).supported);$('#notice').textContent=storageError||(unsupported?'この週には祝日データ未収録の年が含まれます。祝日の赤表示は未判定です（対応：2026・2027年）。':'');requestAnimationFrame(fitText);}
function openDialog(title){$('#dialog-title').textContent=title;$('#dialog-body').replaceChildren();if(!$('#editor').open)$('#editor').showModal();return $('#dialog-body');}
function close(){ $('#editor').close();activeCell=null;}
$('#close').onclick=close;
function field(label,input){const wrapper=el('label',{class:'field'},label);wrapper.append(input);return wrapper;}
function hint(parent,text){parent.append(el('p',{class:'hint'},text));}
function confirmChange(existing){return !existing||confirm('登録済みの内容を変更しますか？');}
function commit(fn){if(!persistChange(fn))return false;render();close();return true;}
const {renderBirthdays}=createBirthdayUi({
 getRoot:()=>stateManager.getRoot(),
 replaceRoot,
 persistChange,
 el,
 button
});
const {employeesList,openEmployees}=createEmployeeUi({
 getState:()=>stateManager.getState(),
 openDialog,
 el,
 button,
 field,
 hint,
 confirmChange,
 persistChange,
 renderBirthdays
});
const {openStores,selectStore}=createStoreUi({
 getRoot:()=>stateManager.getRoot(),
 getState:()=>stateManager.getState(),
 persistChange,
 openDialog,
 el,
 button,
 field,
 hint,
 commit,
 render
});
function confirmShiftOverlap(d,candidate,exclude=null){
 const conflicts=employeeShiftConflicts(week().days[d],candidate,exclude);
 if(!conflicts.length)return true;
 const state=stateManager.getState();
 const employee=state.employees.find(e=>e.id===candidate.employeeId),name=employee?.name||candidate.name;
 const registered=[...new Set(conflicts.map(({shift})=>`${timeLabel(shift.start)}〜${timeLabel(shift.end)}`))].join('、');
 return confirm(`勤務時間が重複しています。\n従業員：${name}\n登録済み：${registered}\n今回：${timeLabel(candidate.start)}〜${timeLabel(candidate.end)}\n\nこのまま保存しますか？`);
}
function openCell(d,row,b){activeCell={d,row,b};if(row===0)return openFixed();if(row===4)return openExtra(d,b);const existing=week().days[d].shifts[row-1][b];if(existing)return editShift(d,row,b,structuredClone(existing));const body=openDialog('従業員を選択');hint(body,`${week().days[d].date}　${timeLabel(bands[b].start)}〜${timeLabel(bands[b].end)} ／ 時間帯に関係なく全従業員を表示`);employeesList(body,e=>{const candidate=makeShift(e,b);if(confirmShiftOverlap(d,candidate))commit(()=>week().days[d].shifts[row-1][b]=candidate);});}
function editShift(d,row,b,draft){const body=openDialog('勤務を編集');const name=button(`${draft.name}　変更`,()=>{try{Object.assign(draft,workingTimes(start.value,end.value));}catch{}const picker=openDialog('従業員を変更');employeesList(picker,e=>editShift(d,row,b,{...draft,employeeId:e.id,name:employeeShiftName(e)}),draft.employeeId);picker.append(button('戻る',()=>editShift(d,row,b,draft)));});body.append(name);const start=el('input',{type:'time',required:'',value:timeValue(draft.start)}),end=el('input',{type:'time',required:'',value:timeValue(draft.end)});const rowEl=el('div',{class:'row'});rowEl.append(field('開始時刻',start),field('終了時刻',end));body.append(rowEl);hint(body,'6:00から翌朝6:00までの勤務を入力。0:00〜5:59は翌日として扱います。');if(b===4){body.append(button('22:00〜翌1:00',()=>{start.value='22:00';end.value='01:00';}),button('22:00〜翌6:00',()=>{start.value='22:00';end.value='06:00';}));}const err=el('p',{class:'error',role:'alert'});body.append(err);const actions=el('div',{class:'actions'});actions.append(button('削除',()=>{if(confirm('この勤務を削除しますか？'))commit(()=>week().days[d].shifts[row-1][b]=null);},'danger'),button('保存',()=>{try{const times=workingTimes(start.value,end.value);const candidate={...draft,...times};if(confirmChange(true)&&confirmShiftOverlap(d,candidate,{row:row-1,band:b}))commit(()=>week().days[d].shifts[row-1][b]=candidate);}catch(e){err.textContent=e.message;}},'primary'));body.append(actions);}
function openNotes(d){const body=openDialog('備考');const input=el('textarea',{rows:6,maxlength:180});input.value=week().days[d].notes;body.append(field('自由入力（180文字まで）',input),button('保存',()=>{if(confirmChange(week().days[d].notes&&week().days[d].notes!==input.value))commit(()=>week().days[d].notes=input.value);},'primary'));}
function openExtra(d,b){
 const existing=week().days[d].extras[b],band=bands[b];
 const body=openDialog('不定期作業／トレーニング');
 hint(body,'この枠は翌週へコピーされません。各時間帯につき1件です。');
 const tabs=el('div',{class:'row'}),content=el('div');body.append(tabs,content);
 const trainingEditor=(draft)=>{
  content.replaceChildren();
  const start=el('input',{type:'time',required:'',value:timeValue(Number.isInteger(draft.start)?draft.start:band.start)});
  const end=el('input',{type:'time',required:'',value:timeValue(Number.isInteger(draft.end)?draft.end:band.end)});
  const change=button(`${draft.name}　変更`,()=>{
   let times={};try{times=workingTimes(start.value,end.value);}catch{}
   content.replaceChildren();
   employeesList(content,e=>trainingEditor({...draft,...times,employeeId:e.id,name:employeeShiftName(e)}),draft.employeeId,e=>withinFirstMonth(e,week().days[d].date));
   content.append(button('戻る',()=>trainingEditor({...draft,...times})));
  });
  const rowEl=el('div',{class:'row'});rowEl.append(field('開始時刻',start),field('終了時刻',end));
  const error=el('p',{class:'error',role:'alert'});
  content.append(change,rowEl);
  hint(content,'6:00から翌朝6:00までの時間を入力できます。0:00〜5:59は翌日として扱います。');
  content.append(error,button('保存',()=>{try{const times=workingTimes(start.value,end.value);if(confirmChange(existing))commit(()=>week().days[d].extras[b]={type:'training',employeeId:draft.employeeId,name:draft.name,...times});}catch(e){error.textContent=e.message;}},'primary'));
 };
 const training=()=>{
  if(existing?.type==='training')return trainingEditor({...existing,start:Number.isInteger(existing.start)?existing.start:band.start,end:Number.isInteger(existing.end)?existing.end:band.end});
  content.replaceChildren();
  hint(content,'入社年月日から1か月以内の従業員だけを表示します。');
  employeesList(content,e=>trainingEditor({type:'training',employeeId:e.id,name:employeeShiftName(e),start:band.start,end:band.end}),null,e=>withinFirstMonth(e,week().days[d].date));
 };
 const task=()=>{
  content.replaceChildren();
  const input=el('input',{maxlength:40,placeholder:'作業内容'});input.value=existing?.type==='task'?existing.text:'';
  const start=el('input',{type:'time',required:'',value:timeValue(existing?.type==='task'&&Number.isInteger(existing.start)?existing.start:band.start)});
  const end=el('input',{type:'time',required:'',value:timeValue(existing?.type==='task'&&Number.isInteger(existing.end)?existing.end:band.end)});
  const rowEl=el('div',{class:'row'});rowEl.append(field('開始時刻',start),field('終了時刻',end));
  const error=el('p',{class:'error',role:'alert'});
  content.append(field('不定期作業',input),rowEl);
  hint(content,'6:00から翌朝6:00までの時間を入力できます。0:00〜5:59は翌日として扱います。');
  content.append(error,button('登録',()=>{if(!input.value.trim()){input.focus();return;}try{const times=workingTimes(start.value,end.value);if(confirmChange(existing))commit(()=>week().days[d].extras[b]={type:'task',text:input.value.trim(),...times});}catch(e){error.textContent=e.message;}},'primary'));
 };
 tabs.append(button('トレーニング',training),button('不定期作業',task));
 if(existing?.type==='task')task();else training();
 if(existing)body.append(button('削除',()=>{if(confirm('この登録を削除しますか？'))commit(()=>week().days[d].extras[b]=null);},'danger'));
}
function openFixed(){
  const state=stateManager.getState();
  const body=openDialog('固定作業設定');
  hint(body,'各時間帯に1件。表示する曜日と開始・終了時刻を設定できます。設定は毎週自動で反映されます。');
  const grid=el('div',{class:'fixed-settings'}),inputs=[];
  bands.forEach((band,b)=>{
    const setting=fixedSetting(state.fixed[b],b);
    const group=el('fieldset',{class:'fixed-setting'});
    group.append(el('legend',{},`${timeLabel(band.start)}〜${timeLabel(band.end)}`));
    const input=el('input',{maxlength:40,value:setting.text});
    group.append(field('作業名',input));
    const timeRow=el('div',{class:'row'});
    const start=el('input',{type:'time',required:'',value:timeValue(setting.start)});
    const end=el('input',{type:'time',required:'',value:timeValue(setting.end)});
    timeRow.append(field('開始時刻',start),field('終了時刻',end));group.append(timeRow);
    const days=el('div',{class:'weekday-options'}),checks=[];
    [1,2,3,4,5,6,0].forEach(day=>{
      const check=el('input',{type:'checkbox',value:day});check.checked=setting.days.includes(day);
      const label=el('label');label.append(check,el('span',{},'日月火水木金土'[day]));
      check.setAttribute('aria-label',`${timeLabel(band.start)}〜${timeLabel(band.end)} ${'日月火水木金土'[day]}曜日`);
      days.append(label);checks.push(check);
    });
    group.append(days);grid.append(group);inputs.push({input,start,end,checks});
  });
  const error=el('p',{class:'error',role:'alert'});
  body.append(grid,error,button('設定を保存',()=>{
    let values;
    try{values=inputs.map(({input,start,end,checks})=>({text:input.value.trim(),days:checks.filter(c=>c.checked).map(c=>Number(c.value)),...workingTimes(start.value,end.value)}));}
    catch(e){error.textContent=e.message;return;}
    if(values.some(v=>v.text&&!v.days.length)){error.textContent='作業名を入力した時間帯には、曜日を1つ以上選んでください。';return;}
    if(confirm('固定作業の設定を変更しますか？選択した曜日に、過去を含む全週で反映します。'))commit(()=>state.fixed=values);
  },'primary'));
}
function navigate(delta,target){const state=stateManager.getState(),next=target||addDays(state.current,delta),existed=!!state.weeks[next];let copied=false;if(!persistChange(()=>{copied=ensureWeek(state,next);state.current=next;},false))return;render();if(!existed)$('#notice').textContent+=(copied?' 前週の従業員①・②・予備従業員だけをコピーしました。':' 空の週を作成しました。');}
function openBackup(){
 const body=openDialog('バックアップ・復元');
 openBackupDialog({
  body,
  getRoot:()=>stateManager.getRoot(),
  replaceRoot,
  isExternalChangeDetected:()=>stateManager.isExternalChangeDetected(),
  onBackupCreated:exportedAt=>{
   backupAt=exportedAt;
   try{localStorage.setItem('shift-last-backup',backupAt);}catch{}
   updateTools();
  },
  onRestoreSuccess:()=>{
   stateManager.clearStorageError();
   render();
   close();
  }
 });
}
function showSettings(){
 const settings=location.hash==='#settings',birthdays=location.hash==='#birthdays',subpage=settings||birthdays;
 $('#shift-page').hidden=subpage;
 $('#settings-page').hidden=!settings;
 $('#birthday-page').hidden=!birthdays;
 $('#preview').hidden=subpage;
 $('#settings').hidden=subpage;
 $('#header-week-nav').hidden=subpage;
 $('#settings-back').hidden=!settings;
 $('.appbar-context').classList.toggle('settings-context',settings);
 if(settings)$('#settings-back').focus();
 else if(birthdays)$('#birthday-back').focus();
 else requestAnimationFrame(fitText);
}
$('#settings').onclick=()=>{location.hash='settings';};
$('#settings-back').onclick=()=>{location.hash='';};
$('#birthday-list').onclick=()=>{location.hash='birthdays';};
$('#birthday-back').onclick=()=>{location.hash='settings';};
window.addEventListener('hashchange',showSettings);
$('#employees').onclick=openEmployees;$('#fixed').onclick=openFixed;$('#prev').onclick=()=>navigate(-7);$('#next').onclick=()=>navigate(7);
$('#today').onclick=()=>{const d=new Date();const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;navigate(0,monday(key));};
document.querySelectorAll('[data-undo]').forEach(b=>b.onclick=undo);
$('#stores').onclick=openStores;$('#backup').onclick=openBackup;
$('#store').onchange=e=>selectStore(e.target.value);
let previewObserver=null;
function closePreview(){
 previewPdfGeneration++;
 previewObserver?.disconnect();previewObserver=null;
 preview=false;document.body.classList.remove('print-mode');
 $('#print-actions')?.remove();
 requestAnimationFrame(()=>{fitText();$('#preview').focus();});
}
async function preparePreviewPdf(generation,shareButton,openLink,saveLink,status){
 try{
  preparePrint();
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  fitText();
  const pdf=await createPrintPdf($('#paper'));
  finishPrint();
  if(generation!==previewPdfGeneration||!preview)return;
  if(lastPrintPdfUrl)URL.revokeObjectURL(lastPrintPdfUrl);
  lastPrintPdfUrl=URL.createObjectURL(pdf);
  lastPrintPdfFile=new File([pdf],'シフト表.pdf',{type:'application/pdf'});
  openLink.href=lastPrintPdfUrl;
  saveLink.href=lastPrintPdfUrl;
  openLink.hidden=false;
  saveLink.hidden=false;
  if(typeof navigator.share==='function'&&navigator.canShare?.({files:[lastPrintPdfFile]})){
   shareButton.disabled=false;
   status.textContent='準備できました。「PDFを共有して印刷」を押し、共有メニューから「プリント」を選んでください。';
  }else{
   shareButton.hidden=true;
   openLink.classList.add('primary');
   status.textContent='準備できました。「PDFを開く」を押し、PDFの共有メニューから印刷してください。';
  }
 }catch(error){
  finishPrint();
  if(generation===previewPdfGeneration&&preview)status.textContent=`PDFを作成できませんでした：${error.message}`;
 }
}
function sharePreviewPdf(status){
 if(!lastPrintPdfFile)return;
 try{
  // Share must start inside this tap; preparing the PDF here would lose user activation.
  const result=navigator.share({files:[lastPrintPdfFile]});
  Promise.resolve(result).catch(error=>{
   if(error.name!=='AbortError')status.textContent='共有を開けませんでした。「PDFを開く」か「PDFを保存」をお試しください。';
  });
 }catch(error){status.textContent='共有を開けませんでした。「PDFを開く」か「PDFを保存」をお試しください。';}
}
function openPreview(){
 if(preview)return;
 // v25と同じ組版を複製する。表示専用の用紙は印刷対象に含めない。
 let paper,css;
 try{
  preparePrint();
  paper=$('#paper').cloneNode(true);
  css=[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules].map(rule=>rule.cssText)).join('\n');
 }finally{finishPrint();}
 const doc=document.implementation.createHTMLDocument('週間シフト表の印刷プレビュー');
 const style=doc.createElement('style');
 style.textContent=css+'\nhtml{width:297mm;height:210mm;padding:0;overflow:hidden;background:white}body.print-layout{width:297mm;height:210mm;display:flex;align-items:center}body.print-layout main{width:281mm;margin-left:25mm!important;transform:scale(.9145907473);transform-origin:left center}';
 doc.head.append(style);doc.body.className='print-layout';
 const main=doc.createElement('main');main.append(paper);doc.body.append(main);
 paper.querySelectorAll('button').forEach(n=>n.tabIndex=-1);
 const bar=el('section',{class:'preview-bar no-print',id:'print-actions','aria-label':'印刷プレビュー'});
 const toolbar=el('div',{class:'preview-toolbar'});
 const meta=el('div',{class:'preview-meta'});
 toolbar.append(button('← シフト表に戻る',closePreview),el('h1',{},'印刷プレビュー'));
 meta.append(el('div',{},`${stateManager.getState().store} ｜ ${period()}`));
 if(isAppleMobile()){
  const status=el('small',{role:'status','aria-live':'polite'},'印刷用PDFを準備しています…');
  const actions=el('div',{class:'preview-actions'});
  const shareButton=button('PDFを共有して印刷',()=>sharePreviewPdf(status),'primary');
  shareButton.disabled=true;
  const openLink=el('a',{class:'preview-pdf-link',target:'_blank',rel:'noopener',hidden:''},'PDFを開く');
  const saveLink=el('a',{class:'preview-save-link',download:'シフト表.pdf',hidden:''},'PDFを保存');
  actions.append(shareButton,openLink);
  toolbar.append(actions);
  meta.append(status,saveLink);
  const generation=++previewPdfGeneration;
  requestAnimationFrame(()=>{if(preview&&generation===previewPdfGeneration)preparePreviewPdf(generation,shareButton,openLink,saveLink,status);});
 }else{
  toolbar.append(button('印刷する',printSchedule,'primary'));
  meta.append(el('small',{},'A4横・1週間1枚'));
 }
 const stage=el('div',{class:'preview-stage'});
 const frame=el('iframe',{class:'preview-sheet',title:'週間シフト表の印刷イメージ',tabindex:'-1'});
 frame.srcdoc='<!doctype html>'+doc.documentElement.outerHTML;
 stage.append(frame);bar.append(toolbar,meta,stage);
 preview=true;document.body.classList.add('print-mode');$('#paper').before(bar);
 const fitPreview=()=>{
  const scale=Math.min(stage.clientWidth/frame.offsetWidth,stage.clientHeight/frame.offsetHeight,1);
  frame.style.setProperty('--preview-scale',Math.max(.1,scale));
 };
 frame.addEventListener('load',fitPreview,{once:true});
 previewObserver=new ResizeObserver(fitPreview);previewObserver.observe(stage);
 fitPreview();toolbar.firstElementChild.focus();
}
$('#preview').onclick=openPreview;
render();stateManager.save(false);showSettings();
if('serviceWorker' in navigator&&location.protocol!=='file:'){
 const hadController=!!navigator.serviceWorker.controller;
 let reloadingForUpdate=false;
 navigator.serviceWorker.addEventListener('controllerchange',()=>{
  if(!hadController||reloadingForUpdate)return;
  if($('#editor')?.open){
   $('#offline-status').textContent='新しい版の準備ができました。入力中の内容を保存または閉じたあと、アプリを開き直してください。';
   return;
  }
  reloadingForUpdate=true;
  location.reload();
 });
 navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
  const update=()=>{
   if(reg.waiting)$('#offline-status').textContent='新しい版の準備ができています。まもなく最新版へ切り替わります。';
  };
  update();
  reg.addEventListener('updatefound',()=>reg.installing?.addEventListener('statechange',update));
  navigator.serviceWorker.ready.then(()=>{$('#offline-status').textContent='通信がないときの起動準備ができています。';});
  reg.update().catch(()=>{});
 }).catch(()=>{$('#offline-status').textContent='通信がないときの起動準備に失敗しました。接続中に開き直してください。';});
}else $('#offline-status').textContent='この接続ではホーム画面・通信なし起動の準備を利用できません。';
