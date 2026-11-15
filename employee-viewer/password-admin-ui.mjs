// Manager-only settings UI. Secret material remains in password inputs only until submitted.
import {validateViewerPassword,viewerRotationMessage,viewerRotationState} from './rotation-policy.mjs';

const displayDate=value=>{
 const date=new Date(value);
 return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'medium'}).format(date):'確認できません';
};

export function createViewerPasswordAdminUi({
 cloudSync,getStore,openDialog,close,el,field,button,hint,
 noticeHost,confirmChange=globalThis.confirm,now=()=>new Date()
}){
 const statusByStore=new Map();

 function renderNotice(){
  const store=getStore(),status=store&&statusByStore.get(store.id);
  const pending=store&&cloudSync.hasPendingViewerCopies?.(store.id);
  const message=pending?'従業員向けシフト表への反映待ちです。設定から再試行できます。':
   cloudSync.getStatus().signedIn&&status?viewerRotationMessage(status,{now:now()}):'';
  noticeHost.textContent=message?`${store.name}：${message}`:'';
  noticeHost.hidden=!message;
 }

 async function refresh(){
  const store=getStore();
  if(!store||!cloudSync.getStatus().signedIn){
   statusByStore.clear();renderNotice();return null;
  }
  try{
   const status=await cloudSync.getViewerPasswordStatus(store.id);
   statusByStore.set(store.id,status);
   renderNotice();
   return status;
  }catch{
   statusByStore.delete(store.id);
   renderNotice();
   return null;
  }
 }

 function clear(){
  statusByStore.clear();
  renderNotice();
 }

 async function open(){
  const store=getStore();
  if(!store)return;
  const body=openDialog('従業員用シフト閲覧パスワード');
  hint(body,`選択中の店舗：${store.name}。店舗ごとに別のパスワードを設定します。`);
  const last=el('p',{role:'status',class:'hint'},'サーバーの設定を確認しています。');
  const password=el('input',{type:'password',autocomplete:'new-password',inputmode:'numeric',pattern:'[0-9]{6}',minlength:'6',maxlength:'6',placeholder:'数字6桁'});
  const repeat=el('input',{type:'password',autocomplete:'new-password',inputmode:'numeric',pattern:'[0-9]{6}',minlength:'6',maxlength:'6',placeholder:'数字6桁を再入力'});
  const error=el('p',{role:'alert',class:'error'});
  const save=button('パスワードを設定・変更',async()=>{
   error.textContent='';
   if(getStore()?.id!==store.id){error.textContent='店舗が切り替わっています。開き直してください。';return;}
   const problem=validateViewerPassword(password.value);
   if(problem){error.textContent=problem;return;}
   if(password.value!==repeat.value){error.textContent='確認用のパスワードが一致しません。';return;}
   if(!confirmChange(`${store.name}の従業員用パスワードを変更しますか？旧パスワードとログイン済み端末を無効にします。`))return;
   save.disabled=true;
   try{
    const status=await cloudSync.changeViewerPassword(store.id,password.value);
    // The server, not the browser, must verify credentials and revoke all sessions.
    statusByStore.set(store.id,status);
    last.textContent=`最終変更日：${displayDate(status.lastChangedAt)}`;
    renderNotice();
    hint(body,'変更を保存しました。バックルームの掲示パスワードを差し替えてください。');
   }catch{
    error.textContent='パスワードを変更できませんでした。サーバー設定や通信状況を確認してください。';
   }finally{
    password.value='';repeat.value='';
    if(cloudSync.getStatus().signedIn)save.disabled=false;
   }
  },'primary');
  save.disabled=true;
  hint(body,'店舗の従業員専用バックルームに掲示してください。QRコードにパスワードは含めません。');
  hint(body,'毎月1日を目安に変更し、退職・漏えい時には直ちに変更します。変更時は以前のログインも無効にします。');
  body.append(last,field('新しい共通パスワード',password),field('確認用パスワード',repeat),error,save);

  if(!cloudSync.getStatus().signedIn){
   last.textContent='管理者用の「複数端末共有」にログインしてください。';
   return;
  }
  const status=await refresh();
  if(getStore()?.id!==store.id)return;
  if(!status){
   last.textContent='管理サーバーの機能がまだ利用できません。パスワードは保存されません。';
   return;
  }
  const reminder=viewerRotationState({...status,now:now()});
  last.textContent=status.configured
   ?`最終変更日：${displayDate(status.lastChangedAt)}${reminder.due?'　変更時期です。':''}`
   :'まだパスワードが設定されていません。';
  save.disabled=false;
  if(status.publishingReady&&store.weekStart){
   const result=el('p',{role:'status',class:'hint'});
   const retry=button('従業員向けシフト表への反映を再試行',async()=>{
    retry.disabled=true;
    const ok=await cloudSync.retryViewerCopies(store.id,store.weekStart);
    result.textContent=ok?'反映の確認が完了しました。':
     '反映できませんでした。複数端末共有の保存状況と通信を確認してください。';
    retry.disabled=false;
    renderNotice();
   });
   body.append(retry,result);
  }
 }
 return {open,refresh,renderNotice,clear};
}
