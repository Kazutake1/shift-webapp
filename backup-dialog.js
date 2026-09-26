import {backupText,parseBackup} from './stores.js';
import {
  encryptBackupText,
  decryptBackupText,
  encryptedBackupInfo,
  isEncryptedBackupText
} from './crypto-backup.js';

const el=(tag,attrs={},text='')=>{
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(attrs)){
  if(key==='class')node.className=value;
  else node.setAttribute(key,value);
 }
 node.textContent=text;
 return node;
};

const button=(text,handler,className='')=>{
 const node=el('button',{type:'button',class:className},text);
 node.onclick=handler;
 return node;
};

const field=(labelText,input)=>{
 const wrapper=el('label',{class:'field'},labelText);
 wrapper.append(input);
 return wrapper;
};

const hint=(parent,text)=>parent.append(el('p',{class:'hint'},text));

export function openBackupDialog({
 body,
 getRoot,
 replaceRoot,
 isExternalChangeDetected,
 onBackupCreated,
 onRestoreSuccess
}){
 hint(body,'バックアップには、全店舗のシフト・従業員・固定作業・備考など、このアプリの保存データが入ります。');

 const createSection=el('section',{class:'backup-section'});
 createSection.append(el('h3',{},'1. バックアップを作成'));
 hint(createSection,'バックアップは端末上で暗号化してから保存・共有します。バックアップ用パスワードは保存されないため、忘れると復元できません。');

 const password=el('input',{type:'password',minlength:8,autocomplete:'new-password'});
 const confirmPassword=el('input',{type:'password',minlength:8,autocomplete:'new-password'});
 const exportError=el('p',{class:'error',role:'alert'});
 const exportStatus=el('p',{class:'backup-status',role:'status'});

 const exportButton=button('暗号化バックアップを作成',async()=>{
  exportError.textContent='';
  exportStatus.textContent='';

  if(password.value.length<8){
   exportError.textContent='バックアップ用パスワードは8文字以上にしてください。';
   password.focus();
   return;
  }
  if(password.value!==confirmPassword.value){
   exportError.textContent='確認用パスワードが一致しません。';
   confirmPassword.focus();
   return;
  }

  exportButton.disabled=true;
  try{
   const exportedAt=new Date().toISOString();
   const encrypted=await encryptBackupText(backupText(getRoot()),password.value,exportedAt);
   const filename=`シフト全店舗_${exportedAt.replaceAll(':','-')}.shiftbackup`;
   const file=new File([encrypted],filename,{type:'application/json'});

   if(navigator.share&&navigator.canShare?.({files:[file]})){
    await navigator.share({files:[file],title:'シフト暗号化バックアップ'});
   }else{
    const url=URL.createObjectURL(file);
    const link=el('a',{href:url,download:filename});
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
   }

   onBackupCreated(exportedAt);
   exportStatus.textContent='バックアップファイルを作成しました。保存先にファイルがあることを確認してください。';
   password.value='';
   confirmPassword.value='';
  }catch(error){
   if(error?.name!=='AbortError'){
    exportError.textContent=error.message||'暗号化バックアップを作成できませんでした。';
   }
  }finally{
   exportButton.disabled=false;
  }
 },'primary');

 createSection.append(
  field('バックアップ用パスワード（8文字以上）',password),
  field('パスワードをもう一度入力',confirmPassword),
  exportError,
  exportButton,
  exportStatus,
  el('p',{class:'backup-note'},'※ このアプリは、作成したファイルが保存先に残っているかまでは確認できません。作成後に「ファイル」アプリなどで確認してください。')
 );

 const restoreSection=el('section',{class:'backup-section'});
 restoreSection.append(el('h3',{},'2. バックアップから復元'));
 restoreSection.append(el('p',{class:'backup-warning'},'注意：復元すると、現在の全店舗データをバックアップ内の内容で置き換えます。復元前に現在のバックアップを作成してください。'));
 restoreSection.append(el('p',{class:'backup-steps'},'① ファイルを選択　→　② 内容を確認　→　③ 全店舗を復元'));
 hint(restoreSection,'新しい暗号化バックアップ（.shiftbackup）と、以前の暗号化されていないJSONバックアップに対応しています。');

 const file=el('input',{type:'file',accept:'.shiftbackup,.json,application/json'});
 const restorePassword=el('input',{type:'password',autocomplete:'current-password'});
 const summary=el('p',{class:'backup-summary'});
 const error=el('p',{class:'error',role:'alert'});
 let candidate=null;
 let selectedText='';
 let encrypted=false;

 const restore=button('確認したバックアップで全店舗を復元',()=>{
  if(!candidate)return;

  if(!confirm(`現在の全店舗データを、選択したバックアップの${candidate.stores.length}店舗に置き換えます。現在の内容は先にバックアップしてください。復元しますか？`)){
   return;
  }

  if(!replaceRoot(candidate,{edit:false,allowStorageError:true,success:'全店舗を復元しました'})){
   error.textContent=isExternalChangeDetected()
    ?'別の画面でデータが変更されています。安全のため復元を停止しました。アプリを開き直してから、もう一度復元してください。'
    :'保存できないため復元しませんでした。空き容量を確認してください。';
   return;
  }

  onRestoreSuccess();
 },'danger');
 restore.disabled=true;

 const unlock=button('バックアップ内容を確認',async()=>{
  candidate=null;
  restore.disabled=true;
  error.textContent='';
  summary.textContent='';
  if(!selectedText)return;

  unlock.disabled=true;
  try{
   const plain=encrypted
    ?await decryptBackupText(selectedText,restorePassword.value)
    :selectedText;
   candidate=parseBackup(plain);
   summary.textContent=`復元対象：${candidate.stores.map(store=>store.store).join('、')}（合計${candidate.stores.length}店舗）${encrypted?'／暗号化バックアップ':'／旧形式・暗号化なし'}`;
   restore.disabled=false;
  }catch(caught){
   error.textContent=caught.message;
  }finally{
   unlock.disabled=false;
  }
 },'primary');
 unlock.disabled=true;

 file.onchange=async()=>{
  candidate=null;
  selectedText='';
  encrypted=false;
  restore.disabled=true;
  unlock.disabled=true;
  restorePassword.value='';
  summary.textContent='';
  error.textContent='';

  const selected=file.files[0];
  if(!selected)return;

  try{
   if(selected.size>15000000)throw Error('15MB以下のバックアップを選んでください。');

   selectedText=await selected.text();
   if(file.files[0]!==selected)return;

   encrypted=isEncryptedBackupText(selectedText);
   if(encrypted){
    const info=encryptedBackupInfo(selectedText);
    const date=new Date(info.exportedAt);
    summary.textContent=`選択中：${selected.name}／暗号化バックアップ${!isNaN(date)?`（作成：${date.toLocaleString('ja-JP')}）`:''}。パスワードを入力して内容を確認してください。`;
    unlock.disabled=false;
    restorePassword.disabled=false;
    restorePassword.focus();
   }else{
    restorePassword.disabled=true;
    unlock.disabled=false;
    summary.textContent=`選択中：${selected.name}／旧形式・暗号化なし。「バックアップ内容を確認」を押してください。`;
   }
  }catch(caught){
   error.textContent=caught.message;
  }
 };

 restorePassword.disabled=true;
 restoreSection.append(
  field('復元するバックアップファイル',file),
  field('バックアップ用パスワード',restorePassword),
  unlock,
  summary,
  error,
  restore
 );

 body.append(createSection,restoreSection);
}
