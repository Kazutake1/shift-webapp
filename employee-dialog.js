import {employeeShiftName} from './model.js';

function normalizeEmployeeSearch(value){
 return String(value||'')
  .normalize('NFKC')
  .toLocaleLowerCase('ja-JP')
  .replace(/\s+/g,'');
}

function isIPadDevice(){
 if(typeof navigator==='undefined')return false;
 return /iPad/i.test(navigator.userAgent||'')||
  ((navigator.platform||'')==='MacIntel'&&Number(navigator.maxTouchPoints)>1);
}

function displayDate(value){
 return /^\d{4}-\d{2}-\d{2}$/.test(value||'')?value.replaceAll('-','/'):'日付を選択';
}

function dateParts(value){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value||'');
 if(!match)return null;
 return {year:Number(match[1]),month:Number(match[2])-1,day:Number(match[3])};
}

function isoDate(year,month,day){
 return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

export function withinFirstMonth(employee,date){
 if(!employee?.hireDate)return false;
 const hire=new Date(employee.hireDate+'T12:00:00Z');
 const target=new Date(date+'T12:00:00Z');
 if(Number.isNaN(hire.getTime())||Number.isNaN(target.getTime())||target<hire)return false;
 const year=hire.getUTCFullYear();
 const month=hire.getUTCMonth()+1;
 const day=hire.getUTCDate();
 const last=new Date(Date.UTC(year,month+1,0,12)).getUTCDate();
 const limit=new Date(Date.UTC(year,month,Math.min(day,last),12));
 return target<=limit;
}

export function createEmployeeUi({
 getState,
 openDialog,
 el,
 button,
 field,
 hint,
 confirmChange,
 persistChange,
 renderBirthdays
}){
 function openIPadDatePicker(input,trigger,label){
  const editor=document.querySelector('#editor');
  if(!editor)return;
  editor.querySelector('.ipad-date-picker-overlay')?.remove();
  editor.classList.add('ipad-date-picker-open');

  let selected=input.value;
  const initial=dateParts(selected);
  const today=new Date();
  let year=initial?.year??today.getFullYear();
  let month=initial?.month??today.getMonth();

  const overlay=el('div',{class:'ipad-date-picker-overlay'});
  const picker=el('section',{
   class:'ipad-date-picker',
   role:'dialog',
   'aria-modal':'true',
   'aria-label':`${label}を選択`
  });
  const header=el('div',{class:'ipad-date-picker-header'});
  const previous=button('‹',()=>changeMonth(-1));
  previous.setAttribute('aria-label','前月');
  const title=el('strong',{class:'ipad-date-picker-title'});
  const next=button('›',()=>changeMonth(1));
  next.setAttribute('aria-label','次月');
  header.append(previous,title,next);

  const body=el('div',{class:'ipad-date-picker-body'});
  const weekdays=el('div',{class:'ipad-date-picker-weekdays'});
  for(const day of ['日','月','火','水','木','金','土'])weekdays.append(el('span',{},day));
  const grid=el('div',{class:'ipad-date-picker-grid'});
  body.append(weekdays,grid);

  const actions=el('div',{class:'ipad-date-picker-actions'});
  const reset=button('リセット',()=>{selected='';renderCalendar();});
  const cancel=button('キャンセル',closePicker);
  const confirm=button('✓',()=>{
   input.value=selected;
   trigger.textContent=displayDate(selected);
   trigger.classList.toggle('empty',!selected);
   input.dispatchEvent(new Event('input',{bubbles:true}));
   input.dispatchEvent(new Event('change',{bubbles:true}));
   closePicker();
  },'primary');
  confirm.setAttribute('aria-label','決定');
  actions.append(reset,cancel,confirm);
  picker.append(header,body,actions);
  overlay.append(picker);
  editor.append(overlay);

  function closePicker(){
   overlay.remove();
   editor.classList.remove('ipad-date-picker-open');
   trigger.focus();
  }

  function changeMonth(delta){
   const changed=new Date(year,month+delta,1);
   year=changed.getFullYear();
   month=changed.getMonth();
   renderCalendar();
  }

  function renderCalendar(){
   title.textContent=`${year}年${month+1}月`;
   grid.replaceChildren();
   const firstDay=new Date(year,month,1).getDay();
   const lastDay=new Date(year,month+1,0).getDate();
   for(let i=0;i<firstDay;i++)grid.append(el('span',{class:'ipad-date-picker-blank'}));
   const todayIso=isoDate(today.getFullYear(),today.getMonth(),today.getDate());
   for(let day=1;day<=lastDay;day++){
    const value=isoDate(year,month,day);
    const dayButton=button(String(day),()=>{selected=value;renderCalendar();});
    dayButton.classList.add('ipad-date-picker-day');
    if(value===selected)dayButton.classList.add('selected');
    if(value===todayIso)dayButton.classList.add('today');
    dayButton.setAttribute('aria-label',`${year}年${month+1}月${day}日`);
    grid.append(dayButton);
   }
  }

  overlay.onclick=event=>{if(event.target===overlay)closePicker();};
  editor.addEventListener('close',()=>{
   overlay.remove();
   editor.classList.remove('ipad-date-picker-open');
  },{once:true});
  renderCalendar();
  confirm.focus();
 }

 function ipadDateControl(input,label){
  input.hidden=true;
  const trigger=button(displayDate(input.value),()=>openIPadDatePicker(input,trigger,label));
  trigger.classList.add('ipad-date-trigger');
  trigger.classList.toggle('empty',!input.value);
  trigger.setAttribute('aria-label',`${label}を選択`);
  trigger.setAttribute('aria-haspopup','dialog');
  const wrapper=el('div',{class:'ipad-date-control'});
  wrapper.append(input,trigger);
  return wrapper;
 }

 function employeesList(parent,choose,currentId,filter){
  const state=getState();
  const available=state.employees.filter(
   employee=>(!filter||filter(employee))&&(!employee.hidden||employee.id===currentId)
  );
  const search=el('input',{
   type:'search',
   placeholder:'名前・シフト表名・従業員番号',
   'aria-label':'従業員を検索'
  });
  const choices=el('div',{class:'choices'});
  const empty=el('p',{class:'hint'});

  const draw=()=>{
   const query=normalizeEmployeeSearch(search.value);
   choices.replaceChildren();
   const matched=available.filter(employee=>
    !query||normalizeEmployeeSearch([
     employee.name,
     employeeShiftName(employee),
     employee.employeeNumber||''
    ].join(' ')).includes(query)
   );

   matched.forEach(employee=>{
    const shiftName=employeeShiftName(employee);
    const label=employee.name===shiftName
     ?employee.name
     :`${employee.name}（シフト：${shiftName}）`;
    choices.append(
     button(label+(employee.hidden?'（非表示）':''),()=>choose(employee))
    );
   });

   empty.textContent=matched.length
    ?''
    :available.length
     ?'検索条件に一致する従業員がいません。'
     :'選択できる従業員がいません。従業員管理から追加してください。';
  };

  search.oninput=draw;
  parent.append(field('従業員を検索',search),choices,empty);
  draw();
 }

 function openEmployees(){
  const state=getState();
  const body=openDialog('従業員管理');
  hint(body,'≡をドラッグして並べ替え。非表示の従業員は選択一覧から除外され、登録済みの名前は残ります。');
  const list=el('div');
  body.append(list);

  state.employees.forEach((employee,index)=>{
   const row=el('div',{class:'employee-row','data-employee':employee.id});
   const handle=button('≡',()=>{},'handle');
   handle.setAttribute('aria-label',`${employee.name}をドラッグして並べ替え`);
   let target=null;

   handle.onpointerdown=event=>{
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    row.classList.add('dragging');
   };
   handle.onpointermove=event=>{
    if(!handle.hasPointerCapture(event.pointerId))return;
    const hit=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-employee]');
    list.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));
    target=hit?.dataset.employee||null;
    if(hit&&hit!==row)hit.classList.add('drop-target');
   };
   handle.onpointerup=event=>{
    if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
    if(target&&target!==employee.id){
     const current=getState();
     const to=current.employees.findIndex(item=>item.id===target);
     moveEmployee(index,to);
    }else{
     row.classList.remove('dragging');
     list.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));
    }
   };
   handle.onpointercancel=()=>openEmployees();

   const name=el('span',{class:'name'},employee.name);
   const shiftName=employeeShiftName(employee);
   if(shiftName!==employee.name){
    name.append(el('span',{class:'muted'},`　シフト：${shiftName}`));
   }
   if(employee.hidden){
    name.append(el('span',{class:'muted'},'　非表示'));
   }

   row.append(
    handle,
    name,
    button('編集',()=>employeeForm(employee)),
    button(employee.hidden?'表示':'非表示',()=>{
     persistChange(()=>employee.hidden=!employee.hidden);
     renderBirthdays();
     openEmployees();
    }),
    button('削除',()=>{
     if(confirm(`${employee.name}を削除しますか？既存シフト・トレーニングの名前は保持されます。`)){
      persistChange(()=>{
       const current=getState();
       current.employees=current.employees.filter(item=>item.id!==employee.id);
      });
      renderBirthdays();
      openEmployees();
     }
    },'danger')
   );
   list.append(row);
  });

  body.append(button('＋ 従業員を追加',()=>employeeForm(null),'primary'));
 }

 function moveEmployee(from,to){
  persistChange(()=>{
   const state=getState();
   const [employee]=state.employees.splice(from,1);
   state.employees.splice(to,0,employee);
  });
  renderBirthdays();
  openEmployees();
 }

 function employeeForm(employee){
  const body=openDialog(employee?'従業員を編集':'従業員を追加');
  const fullName=el('input',{
   maxlength:20,
   value:employee?.name||'',
   placeholder:'例：山田 太郎',
   autocomplete:'name'
  });
  const shiftName=el('input',{
   maxlength:20,
   value:employee?.shiftName||employee?.name||'',
   placeholder:'例：山田'
  });
  const number=el('input',{
   maxlength:40,
   value:employee?.employeeNumber||'',
   placeholder:'例：0012'
  });
  const hired=el('input',{type:'date',value:employee?.hireDate||''});
  const birth=el('input',{type:'date',value:employee?.birthDate||''});
  const iPad=isIPadDevice();
  const hiredControl=iPad?ipadDateControl(hired,'入社年月日'):hired;
  const birthControl=iPad?ipadDateControl(birth,'生年月日'):birth;

  hint(body,'フルネームでは半角・全角スペースを使用できます。登録済みシフトには登録時のシフト表用の名前を保持します。追加情報は未入力でも保存できます。');
  body.append(
   field('フルネーム（20文字まで）',fullName),
   field('シフト表で使う名前（20文字まで）',shiftName),
   field('従業員番号',number),
   field('入社年月日',hiredControl),
   field('生年月日',birthControl)
  );

  const error=el('p',{class:'error',role:'alert'});
  body.append(
   error,
   button('保存',()=>{
    const name=fullName.value.trim();
    if(!name){
     error.textContent='フルネームを入力してください。';
     return;
    }

    const displayName=shiftName.value.trim();
    if(!displayName){
     error.textContent='シフト表で使う名前を入力してください。';
     return;
    }

    if(!hired.checkValidity()||!birth.checkValidity()){
     error.textContent='年月日を確認してください。';
     return;
    }

    const details={
     name,
     shiftName:displayName,
     employeeNumber:number.value.trim(),
     hireDate:hired.value,
     birthDate:birth.value
    };
    const now=new Date();
    const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    if(details.birthDate&&details.birthDate>today){
     error.textContent='生年月日は今日以前の日付を入力してください。';
     return;
    }
    if(details.birthDate&&details.hireDate&&details.birthDate>details.hireDate){
     error.textContent='入社年月日は生年月日以降の日付を入力してください。';
     return;
    }

    const state=getState();
    if(details.employeeNumber&&state.employees.some(
     item=>item.id!==employee?.id&&item.employeeNumber===details.employeeNumber
    )){
     error.textContent='この店舗では同じ従業員番号が使われています。';
     return;
    }

    if(employee&&!confirmChange(
     Object.entries(details).some(([key,value])=>(employee[key]||'')!==value)
    )){
     return;
    }

    const employeeId=employee?.id||null;
    if(persistChange(()=>{
     const current=getState();
     if(employee){
      Object.assign(employee,details);
     }else{
      current.employees.push({
       id:crypto.randomUUID(),
       ...details,
       hidden:false
      });
     }
    })){
     renderBirthdays();
     openEmployees();
    }else if(employeeId){
     const current=getState();
     employeeForm(current.employees.find(item=>item.id===employeeId));
    }
   },'primary'),
   button('戻る',openEmployees)
  );
 }

 return {employeesList,openEmployees};
}
