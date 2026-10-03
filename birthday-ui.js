import {birthdayNotices,birthdayGiftChecklist,japanToday} from './birthdays.js';
import {employeeRetiredBy} from './model.js';

export function createBirthdayUi({
 getRoot,
 replaceRoot,
 persistChange,
 el,
 button
}){
 const noticeHost=document.querySelector('#birthday-notices');
 const giftHost=document.querySelector('#birthday-gifts');
 const giftList=document.querySelector('#birthday-gift-list');
 const giftSummary=document.querySelector('#birthday-gift-summary');
 const activeTab=document.querySelector('#employee-active-tab');
 const retiredTab=document.querySelector('#employee-retired-tab');
 let employeeListMode='active';

 function renderNotices(){
  const root=getRoot();
  noticeHost.replaceChildren();
  const notices=birthdayNotices(root);
  noticeHost.hidden=!notices.length;
  if(!notices.length)return;

  noticeHost.append(el('h2',{},'誕生日のお知らせ'));
  for(const notice of notices){
   const row=el('div',{class:'birthday-notice'});
   row.append(
    el('span',{},`${notice.store}：${notice.name}さん${notice.days===0?'は今日が誕生日です':`の誕生日まであと${notice.days}日です`}（${Number(notice.birthday.slice(5,7))}月${Number(notice.birthday.slice(8))}日）`),
    button('確認済み',()=>{
     const candidate=structuredClone(getRoot());
     candidate.birthdayAcknowledgements=[
      ...(candidate.birthdayAcknowledgements||[]),
      notice.key
     ];
     if(!replaceRoot(candidate,{edit:false,success:'誕生日の確認済みを保存しました'}))return;
     renderBirthdayUi();
    })
   );
   noticeHost.append(row);
  }
 }

 function renderGiftChecklist(){
  const root=getRoot();
  const today=japanToday();
  const year=Number(today.slice(0,4));
  const store=root.stores.find(item=>item.id===root.activeStoreId);
  const entries=birthdayGiftChecklist(root,year).filter(entry=>entry.storeId===root.activeStoreId);
  const retiredEmployees=(store?.employees||[]).filter(employee=>employeeRetiredBy(employee,today)).sort((a,b)=>(b.retirementDate||'').localeCompare(a.retirementDate||'')||a.name.localeCompare(b.name));

  giftHost.querySelector('h2').textContent='従業員リスト';
  giftList.replaceChildren();
  activeTab.textContent='在籍者 '+entries.length+'人';
  retiredTab.textContent='退職者 '+retiredEmployees.length+'人';
  activeTab.classList.toggle('active',employeeListMode==='active');
  retiredTab.classList.toggle('active',employeeListMode==='retired');
  activeTab.setAttribute('aria-selected',String(employeeListMode==='active'));
  retiredTab.setAttribute('aria-selected',String(employeeListMode==='retired'));

  if(employeeListMode==='retired'){
   giftSummary.textContent=retiredEmployees.length?'退職日の新しい順':'退職者はいません。';
   for(const employee of retiredEmployees){
    const row=el('div',{class:'retired-employee-row'});
    const retiredDate='退職日 '+employee.retirementDate.split('-').join('/');
    const hireDate=employee.hireDate?'入社日 '+employee.hireDate.split('-').join('/'):'入社日未登録';
    row.append(
     el('span',{class:'retired-employee-person'},employee.name),
     el('span',{class:'retired-employee-date'},retiredDate),
     el('span',{class:'retired-employee-meta'},hireDate)
    );
    giftList.append(row);
   }
   return;
  }

  const eligible=entries.filter(entry=>entry.eligible);
  const delivered=eligible.filter(entry=>entry.delivered).length;
  giftSummary.textContent=entries.length
   ?`クオカード渡し済み ${delivered} / ${eligible.length}名（${year}年）`
   :'在籍者はいません。';

  for(const entry of entries){
   const row=el('label',{class:entry.eligible?'birthday-gift-row':'birthday-gift-row birthday-gift-ineligible'});
   const checkbox=el('input',{
    type:'checkbox',
    'aria-label':`${entry.store} ${entry.name} 誕生日クオカード渡し済み`
   });
   checkbox.checked=entry.delivered;
   checkbox.disabled=!entry.eligible;

   const date=el('span',{class:'birthday-gift-date'},entry.birthday?`${Number(entry.birthday.slice(5,7))}/${Number(entry.birthday.slice(8))}`:'—');
   const person=el('span',{class:'birthday-gift-person'},entry.name);
   const store=el('span',{class:'birthday-gift-store'},entry.store);
   let statusText=entry.eligible
    ?entry.delivered
     ?entry.deliveredByStoreName&&entry.deliveredByStoreId!==entry.storeId
      ?`${entry.deliveredByStoreName}で渡し済み`
      :'渡し済み'
     :'未渡し'
    :entry.eligibilityReason==='birthDateMissing'?'生年月日未登録'
     :entry.eligibilityReason==='hireDateMissing'?'入社日未登録':'対象外（1年未満）';
   if(entry.hidden)statusText+='／非表示';
   if(entry.retirementDate&&entry.retirementDate>=today)statusText+='／'+entry.retirementDate.split('-').join('/')+' 退職予定';
   const status=el('span',{class:'birthday-gift-status'},statusText);

   checkbox.onchange=()=>{
    if(!entry.eligible)return;
    const checked=checkbox.checked;
    const ok=persistChange(()=>{
     const current=getRoot();
     const set=new Set(current.birthdayGiftDelivered||[]);
     const deliveryStores={...(current.birthdayGiftDeliveryStores||{})};
     if(checked){
      set.add(entry.key);
      deliveryStores[entry.key]={storeId:current.activeStoreId,storeName:current.stores.find(s=>s.id===current.activeStoreId).store};
     }else{
      set.delete(entry.key);
      delete deliveryStores[entry.key];
     }
     current.birthdayGiftDelivered=[...set];
     current.birthdayGiftDeliveryStores=deliveryStores;
    });
    if(!ok){
     checkbox.checked=!checked;
     return;
    }
    renderGiftChecklist();
   };

   row.append(checkbox,date,person,store,status);
   giftList.append(row);
  }
 }

 activeTab.addEventListener('click',()=>{employeeListMode='active';renderGiftChecklist();});

 retiredTab.addEventListener('click',()=>{employeeListMode='retired';renderGiftChecklist();});

 function renderBirthdayUi(){
  renderNotices();
  renderGiftChecklist();
 }

 const refresh=()=>renderBirthdayUi();
 window.addEventListener('focus',refresh);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 setInterval(()=>{if(!document.hidden)refresh();},60000);

 return {renderBirthdays:renderBirthdayUi};
}
