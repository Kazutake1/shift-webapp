import {birthdayNotices,birthdayGiftChecklist,japanToday} from './birthdays.js';

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
  const year=Number(japanToday().slice(0,4));
  const entries=birthdayGiftChecklist(root,year);

  giftHost.querySelector('h2').textContent=`従業員誕生日・プレゼント管理（${year}年）`;
  giftList.replaceChildren();

  const eligible=entries.filter(entry=>entry.eligible);
  const delivered=eligible.filter(entry=>entry.delivered).length;
  giftSummary.textContent=entries.length
   ?`プレゼント渡し済み ${delivered} / ${eligible.length}名`
   :'誕生日が登録されている従業員はいません。';

  for(const entry of entries){
   const row=el('label',{class:'birthday-gift-row'});
   const checkbox=el('input',{
    type:'checkbox',
    'aria-label':`${entry.store} ${entry.name}さん 誕生日プレゼント渡し済み`
   });
   checkbox.checked=entry.delivered;
   checkbox.disabled=!entry.eligible;

   const date=el('span',{class:'birthday-gift-date'},`${Number(entry.birthday.slice(5,7))}/${Number(entry.birthday.slice(8))}`);
   const person=el('span',{class:'birthday-gift-person'},`${entry.name}さん`);
   const store=el('span',{class:'birthday-gift-store'},entry.store);
   const statusText=entry.eligible
    ?entry.delivered?'渡し済み':'未渡し'
    :entry.eligibilityReason==='hireDateMissing'?'入社日未登録':'対象外（1年未満）';
   const status=el('span',{class:'birthday-gift-status'},statusText);

   checkbox.onchange=()=>{
    if(!entry.eligible)return;
    const checked=checkbox.checked;
    const ok=persistChange(()=>{
     const current=getRoot();
     const set=new Set(current.birthdayGiftDelivered||[]);
     if(checked)set.add(entry.key);
     else set.delete(entry.key);
     current.birthdayGiftDelivered=[...set];
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
