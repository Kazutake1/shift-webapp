import {backupText,parseBackupInfo,mergeStoreBackup} from './stores.js';
import {
  encryptBackupText,
  decryptBackupText,
  encryptedBackupInfo,
  isEncryptedBackupText,
  MAX_ENCRYPTED_BACKUP_BYTES
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

export function openBackupDialog({
 body,
 getRoot,
 replaceRoot,
 isExternalChangeDetected,
 onBackupCreated,
 onRestoreSuccess
}){
 const root=getRoot();
 const activeStore=root.stores.find(store=>store.id===root.activeStoreId);
 const safeFilenamePart=value=>String(value||'店舗').trim().replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,' ').slice(0,40)||'店舗';

 const createSection=el('section',{class:'backup-section'});
 createSection.append(
  el('h3',{},'1. バックアップを作成'),
  el('p',{class:'backup-summary'},`選択中の店舗：${activeStore.store}`)
 );

 const password=el('input',{type:'password',minlength:8,autocomplete:'new-password'});
 const confirmPassword=el('input',{type:'password',minlength:8,autocomplete:'new-password'});
 const exportError=el('p',{class:'error',role:'alert'});
 const exportStatus=el('p',{class:'backup-status',role:'status'});

 async function createBackup(scope){
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

  storeExport.disabled=true;
  allExport.disabled=true;
  try{
   const exportedAt=new Date().toISOString();
   const current=getRoot();
   const currentStore=current.stores.find(store=>store.id===current.activeStoreId);
   const plain=backupText(current,{scope,storeId:current.activeStoreId,exportedAt});
   const encrypted=await encryptBackupText(plain,password.value,exportedAt);
   const stamp=exportedAt.replaceAll(':','-');
   const filename=scope==='store'
    ?`シフト_${safeFilenamePart(currentStore.store)}_${stamp}.shiftbackup.json`
    :`シフト全店舗_${stamp}.shiftbackup.json`;
   const file=new File([encrypted],filename,{type:'application/json'});

   if(navigator.share&&navigator.canShare?.({files:[file]})){
    await navigator.share({
     files:[file],
     title:scope==='store'?`${currentStore.store} シフト暗号化バックアップ`:'シフト全店舗 暗号化バックアップ'
    });
   }else{
    const url=URL.createObjectURL(file);
    const link=el('a',{href:url,download:filename});
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
   }

   onBackupCreated(exportedAt);
   exportStatus.textContent=scope==='store'
    ?`${currentStore.store}のバックアップファイルを作成しました。`
    :'全店舗のバックアップファイルを作成しました。';
   password.value='';
   confirmPassword.value='';
  }catch(error){
   if(error?.name!=='AbortError'){
    exportError.textContent=error.message||'暗号化バックアップを作成できませんでした。';
   }
  }finally{
   storeExport.disabled=false;
   allExport.disabled=false;
  }
 }

 const storeExport=button('この店舗をバックアップ',()=>createBackup('store'),'primary');
 const allExport=button('全店舗をバックアップ',()=>createBackup('all'));
 const exportActions=el('div',{class:'backup-actions'});
 exportActions.append(storeExport,allExport);

 createSection.append(
  field('バックアップ用パスワード（8文字以上）',password),
  field('パスワードをもう一度入力',confirmPassword),
  exportError,
  exportActions,
  exportStatus
 );

 const restoreSection=el('section',{class:'backup-section'});
 restoreSection.append(
  el('h3',{},'2. バックアップから復元'),
  el('p',{class:'backup-warning'},'店舗単位の復元では現在選択中の店舗だけを置き換え、他店舗は変更しません。全店舗バックアップの復元では現在の全店舗データを置き換えます。復元前に現在のバックアップを作成してください。')
 );

 const file=el('input',{type:'file'});
 const restorePassword=el('input',{type:'password',autocomplete:'current-password'});
 const summary=el('p',{class:'backup-summary'});
 const error=el('p',{class:'error',role:'alert'});
 let candidateInfo=null;
 let selectedText='';
 let encrypted=false;

 const storeRestore=button('この店舗に復元',()=>{
  if(!candidateInfo||candidateInfo.scope!=='store')return;
  const current=getRoot();
  const target=current.stores.find(store=>store.id===current.activeStoreId);
  const source=candidateInfo.data.stores[0];
  if(!confirm(`${target.store}の現在のデータを、バックアップ「${source.store}」の内容で置き換えます。他の店舗は変更されません。復元しますか？`))return;
  const merged=mergeStoreBackup(current,candidateInfo.data);
  if(!replaceRoot(merged,{edit:false,allowStorageError:true,success:'選択中の店舗を復元しました'})){
   error.textContent=isExternalChangeDetected()
    ?'別の画面でデータが変更されています。安全のため復元を停止しました。アプリを開き直してから、もう一度復元してください。'
    :'保存できないため復元しませんでした。空き容量を確認してください。';
   return;
  }
  onRestoreSuccess();
 },'danger');
 storeRestore.disabled=true;

 const allRestore=button('確認したバックアップで全店舗を復元',()=>{
  if(!candidateInfo||candidateInfo.scope!=='all')return;
  const candidate=candidateInfo.data;
  if(!confirm(`現在の全店舗データを、選択したバックアップの${candidate.stores.length}店舗に置き換えます。現在の内容は先にバックアップしてください。復元しますか？`))return;
  if(!replaceRoot(candidate,{edit:false,allowStorageError:true,success:'全店舗を復元しました'})){
   error.textContent=isExternalChangeDetected()
    ?'別の画面でデータが変更されています。安全のため復元を停止しました。アプリを開き直してから、もう一度復元してください。'
    :'保存できないため復元しませんでした。空き容量を確認してください。';
   return;
  }
  onRestoreSuccess();
 },'danger');
 allRestore.disabled=true;

 const restoreActions=el('div',{class:'backup-actions'});
 restoreActions.append(storeRestore,allRestore);

 const unlock=button('バックアップ内容を確認',async()=>{
  candidateInfo=null;
  storeRestore.disabled=true;
  allRestore.disabled=true;
  error.textContent='';
  summary.textContent='';
  if(!selectedText)return;

  unlock.disabled=true;
  try{
   const plain=encrypted
    ?await decryptBackupText(selectedText,restorePassword.value)
    :selectedText;
   candidateInfo=parseBackupInfo(plain);
   if(candidateInfo.scope==='store'){
    const source=candidateInfo.data.stores[0];
    summary.textContent=`店舗単位バックアップ：${source.store}（${encrypted?'暗号化バックアップ':'旧形式・暗号化なし'}）／現在選択中の店舗だけに復元します。`;
    storeRestore.disabled=false;
   }else{
    const candidate=candidateInfo.data;
    summary.textContent=`全店舗バックアップ：${candidate.stores.map(store=>store.store).join('、')}（合計${candidate.stores.length}店舗）${encrypted?'／暗号化バックアップ':'／旧形式・暗号化なし'}`;
    allRestore.disabled=false;
   }
  }catch(caught){
   error.textContent=caught.message;
  }finally{
   unlock.disabled=false;
  }
 },'primary');
 unlock.disabled=true;

 file.onchange=async()=>{
  candidateInfo=null;
  selectedText='';
  encrypted=false;
  storeRestore.disabled=true;
  allRestore.disabled=true;
  unlock.disabled=true;
  restorePassword.value='';
  summary.textContent='';
  error.textContent='';

  const selected=file.files[0];
  if(!selected)return;

  try{
   if(selected.size>MAX_ENCRYPTED_BACKUP_BYTES)throw Error('15MB以下のバックアップを選んでください。');
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
  restoreActions
 );

 body.append(createSection,restoreSection);
}
