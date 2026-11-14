// Standalone synthetic iPad test UI. No production imports, network APIs, or telemetry.
import {vault,fakeRoot,nextFakeRoot,verifyFakeRoot} from './vault.js';

const $=id=>document.getElementById(id);
let current=null,revision=null,undo=null,secret=null,busy=false;
const safeError=e=>{
 const code=e?.name==='OperationError'?'DECRYPT_FAILED':String(e?.message||e||'UNKNOWN_ERROR');
 return ({
  REVISION_CONFLICT:'他のタブが先に保存しました。上書きを停止しました。この画面では追加保存しないでください。',
  TRANSACTION_ABORTED:'試験用の保存中断を検出しました。以前のデータを保持しています。',
  QuotaExceededError:'保存容量が不足しています。現在の状態は変更していません。',
  DECRYPT_FAILED:'解除できません。パスフレーズが違うか、暗号化データが破損しています。'
 })[code]||code;
};
const setMessage=(message,kind='info')=>{
 const node=$('message');node.textContent=message;node.dataset.kind=kind;
};
const statusLabel=()=>{
 $('online').textContent=navigator.onLine?'通信状態：オンライン':'通信状態：オフライン';
 $('offline-proof').hidden=navigator.onLine;
};
function draw(){
 const unlocked=current!==null;
 $('details').hidden=!unlocked;
 $('locked-state').hidden=unlocked;
 $('lock').disabled=!unlocked||busy;
 $('initialize').disabled=unlocked||busy;
 $('unlock').disabled=unlocked||busy;
 const actions=['save','abort','conflict','tamper','undo','backup','restore','check-meta'];
 for(const id of actions)$(id).disabled=!unlocked||busy||(id==='undo'&&!undo);
 if(!unlocked){
  $('employee').textContent='';
  $('shift').textContent='';
  $('revision').textContent='';
  $('pending').textContent='';
  $('json-proof').textContent='';
  return;
 }
 verifyFakeRoot(current);
 $('employee').textContent=current.stores[0].employees[0].name+'（架空データ）';
 $('shift').textContent=current.stores[0].weeks['2026-10-26'].shifts[0];
 $('revision').textContent=String(revision);
 $('json-proof').textContent='暗号化保存済み（復号中の表示データはメモリにのみ保持）';
 $('undo').disabled=busy||!undo;
}
async function updateJournal(){
 if(current===null){$('pending').textContent='';return;}
 const meta=await vault.journal();
 $('pending').textContent=meta.pendingRevision===null?'未同期なし':'模擬同期待ち：端末版 '+meta.pendingRevision;
}
async function action(task,{showBusy=true}={}){
 if(busy)return;
 busy=true;if(showBusy)draw();
 try{await task();}catch(e){setMessage(safeError(e),'error');}
 finally{busy=false;draw();if(current)await updateJournal().catch(e=>setMessage(safeError(e),'error'));}
}
async function initialize(){
 await action(async()=>{
  if(await vault.row('active'))throw Error('試験データはすでに存在します。先に解除してください。');
  const password=$('password').value;
  const next=await vault.write(fakeRoot(),password,0,{sync:false});
  $('password').value='';
  $('initialize').hidden=true;$('unlock').hidden=false;
  $('unlock').focus();
  setMessage('架空の台帳を暗号化保存しました（版 '+next+'）。同じパスフレーズで解除してください。','ok');
 });
}
async function unlock(){
 await action(async()=>{
  const password=$('password').value;
  const stored=await vault.read(password);
  if(!stored)throw Error('試験データがありません。「架空データを初期化」を選んでください。');
  verifyFakeRoot(stored.data);
  secret=password;current=stored.data;revision=stored.revision;undo=null;
  $('password').value='';
  setMessage('解除できました。表示中は架空データのみです。','ok');
 });
}
function clearSession(){
 current=null;revision=null;undo=null;secret=null;
 $('password').value='';$('backup-file').value='';
}
function lock(){
 if(busy)return;
 clearSession();
 setMessage('ロックしました。復号済みの表示内容を消去しました。','info');
 draw();
}
async function mutate(next,{abort=false,label='保存'}={}){
 if(!current||!secret)throw Error('ロックを解除してください。');
 const before=structuredClone(current),oldRevision=revision;
 const newRevision=await vault.write(next,secret,revision,{sync:true,abort});
 if(newRevision!==oldRevision+1){
  lock();throw Error('保存結果を確認できません。これ以上保存しないでください。');
 }
 current=next;revision=newRevision;undo=before;
 setMessage(label+'が完了しました。端末版 '+newRevision+'（模擬同期待ち）。','ok');
}
async function save(){
 await action(async()=>mutate(nextFakeRoot(current),{label:'架空シフト変更'}));
}
async function abort(){
 await action(async()=>{
  if(!current)throw Error('ロックを解除してください。');
  const before=JSON.stringify(await vault.read(secret)),journal=JSON.stringify(await vault.journal());
  try{await vault.write(nextFakeRoot(current),secret,revision,{sync:true,abort:true});throw Error('中断を検出できませんでした。');}
  catch(e){if(e.message!=='TRANSACTION_ABORTED')throw e;}
  if(JSON.stringify(await vault.read(secret))!==before||JSON.stringify(await vault.journal())!==journal)throw Error('異常：保存中断後にデータが変更されました。');
  setMessage('合格：故意に保存を中断しましたが、直前の架空データと未同期記録が残りました。','ok');
 });
}
async function conflict(){
 await action(async()=>{
  if(!current)throw Error('ロックを解除してください。');
  const before=JSON.stringify(await vault.read(secret));
  try{await vault.write(nextFakeRoot(current),secret,revision-1,{sync:true});throw Error('競合が拒否されませんでした。');}
  catch(e){if(e.message!=='REVISION_CONFLICT')throw e;}
  if(JSON.stringify(await vault.read(secret))!==before)throw Error('異常：競合発生後にデータが変化しました。');
  setMessage('合格：古い版による上書きを拒否しました。','ok');
 });
}
async function tamper(){
 await action(async()=>{
  if(!current)throw Error('ロックを解除してください。');
  if(!await vault.tamperCheck(secret))throw Error('改ざんを検出できませんでした。');
  setMessage('合格：暗号文のコピーの改ざんを検知しました。保存済みの本体は変更していません。','ok');
 });
}
async function undoLast(){
 await action(async()=>{
  if(!undo)throw Error('直前の操作がありません。');
  const previous=structuredClone(undo);
  const n=await vault.write(previous,secret,revision,{sync:true});
  if(n!==revision+1){lock();throw Error('保存結果不明のためロックしました。');}
  current=previous;revision=n;undo=null;
  setMessage('架空シフトのUndoが完了しました。','ok');
 });
}
async function exportBackup(){
 await action(async()=>{
  if(!current)throw Error('ロックを解除してください。');
  const file=new Blob([JSON.stringify(await vault.backup(),null,2)],{type:'application/json'});
  const address=URL.createObjectURL(file);
  const anchor=document.createElement('a');
  anchor.href=address;anchor.download='step10-fake-encrypted-backup.json';
  document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(address),1000);
  setMessage('架空データ専用の暗号化バックアップを作成しました。','ok');
 });
}
async function restoreBackup(){
 await action(async()=>{
  if(!current)throw Error('ロックを解除してください。');
  const file=$('backup-file').files?.[0];
  if(!file)throw Error('試験用バックアップを選択してください。');
  if(file.size>1024*1024)throw Error('1MB以下の試験用ファイルしか読み込めません。');
  const data=await vault.decodeBackup(JSON.parse(await file.text()),secret);
  verifyFakeRoot(data);
  const next=await vault.write(data,secret,revision,{sync:true});
  if(next!==revision+1){lock();throw Error('保存結果不明のためロックしました。');}
  current=data;revision=next;undo=null;
  $('backup-file').value='';
  setMessage('架空データのバックアップを安全に復元しました。','ok');
 });
}
async function checkMeta(){
 await action(async()=>{
  const meta=await vault.journal(),raw=await vault.row('active');
  const onDisk=JSON.stringify({meta,raw});
  for(const marker of ['架空従業員A','FAKE-0001','1992-04-01','架空の備考だけ']){
   if(onDisk.includes(marker))throw Error('平文漏えいを検知しました：'+marker);
  }
  setMessage('合格：暗号化保存領域と模擬同期記録には架空の個人情報が平文で含まれていません。','ok');
 });
}
async function resetFake(){
 if(!confirm('この検証ページで作成した架空のデータだけを全削除します。続けますか？'))return;
 await action(async()=>{
  await vault.resetOnlyFakeDatabase();
  clearSession();
  $('initialize').hidden=false;$('unlock').hidden=true;
  setMessage('STEP 10の架空データだけを削除しました。','ok');
 });
}
for(const [id,fn] of Object.entries({
 initialize,unlock,lock,save,abort,conflict,tamper,undo:undoLast,
 backup:exportBackup,restore:restoreBackup,'check-meta':checkMeta,'reset-fake':resetFake
 })){
 $(id).addEventListener('click',fn);
}
window.addEventListener('online',statusLabel);
window.addEventListener('offline',statusLabel);
statusLabel();draw();
vault.row('active').then(item=>{
 $('initialize').hidden=!!item;
 $('unlock').hidden=!item;
 if(item)setMessage('暗号化された架空データがあります。解除パスフレーズを入力してください。');
 else setMessage('最初に架空データを初期化してください。パスフレーズは12文字以上です。');
}).catch(error=>setMessage(safeError(error),'error'));
if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='127.0.0.1'||location.hostname==='localhost')){
 navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(()=>{$('sw').textContent='オフライン用キャッシュ：登録済み';},
  ()=>{$('sw').textContent='オフライン用キャッシュ：登録失敗';});
}else{$('sw').textContent='オフライン再起動にはHTTPSが必要です';}
