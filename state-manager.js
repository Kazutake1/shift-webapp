import {initialState} from './model.js';
import {storageKey,validateRoot,migrate,STORAGE_WARNING_BYTES,utf8Bytes} from './stores.js';

const LOAD_ERROR='保存データを読み込めません。既存データを上書きせず一時表示しています。';
const CONFLICT_STATUS='別の画面でデータが変更されました。安全のため保存を停止しています。アプリを開き直してください。';
const SAVE_ERROR='保存できません。今回の変更は反映していません。空き容量を確認してください。';
const STORAGE_CAPACITY_WARNING='保存データが4MBを超えています。容量上限に備えてバックアップを作成し、今後の保存容量に注意してください。過去週は自動削除しません。';

export function createStateManager({
 storage=globalThis.localStorage,
 onStatus=()=>{},
 onUndoChange=()=>{},
 onRollback=()=>{},
 onSaveFailure=()=>{},
 onSaved=()=>{},
 onCloudConflictBlocked=()=>{}
}={}){
 let root;
 let state;
 let storageError='';
 let externalChangeDetected=false;
 let cloudConflictDetected=false;
 let undoData=null;

 try{
  const raw=storage.getItem(storageKey);
  const legacy=storage.getItem('shift-ipad-step1-v1');
  root=raw
   ?validateRoot(JSON.parse(raw))
   :migrate(legacy?JSON.parse(legacy):initialState());
 }catch{
  storageError=LOAD_ERROR;
  root=migrate();
 }

 const syncState=()=>{
  state=root.stores.find(store=>store.id===root.activeStoreId);
 };
 syncState();

 let baseline=JSON.stringify(root);
 const notifyUndo=()=>onUndoChange(Boolean(undoData));

 const restoreSnapshot=(serialized,previousBaseline,previousUndo)=>{
  root=JSON.parse(serialized);
  syncState();
  baseline=previousBaseline;
  undoData=previousUndo;
  notifyUndo();
  onRollback();
 };

 function writeRoot(candidate,{edit=true,sync=edit,allowStorageError=false,allowCloudConflict=false,notifySaved=true,success=''}={}){
  if(storageError&&!allowStorageError){
   onStatus(storageError);
   return false;
  }
  if(externalChangeDetected){
   onStatus(CONFLICT_STATUS);
   return false;
  }
  if(cloudConflictDetected&&!allowCloudConflict){
   const message='別の端末でクラウドデータが更新されています。設定の「複数端末共有」からクラウドの最新データを読み込んでください。';
   onStatus(message);
   onCloudConflictBlocked(message);
   return false;
  }

  try{
   const next=JSON.stringify(candidate);
   storage.setItem(storageKey,next);
   if(edit&&next!==baseline)undoData=baseline;
   if(!edit)undoData=null;
   baseline=next;
   notifyUndo();
   const capacityWarning=utf8Bytes(next)>=STORAGE_WARNING_BYTES?STORAGE_CAPACITY_WARNING:'';
   onStatus([success,capacityWarning].filter(Boolean).join(' '));
   if(notifySaved)onSaved(candidate,{edit,sync});
   return true;
  }catch{
   onStatus(SAVE_ERROR);
   onSaveFailure();
   return false;
  }
 }

 function replaceRoot(candidate,options){
  if(!writeRoot(candidate,options))return false;
  root=candidate;
  syncState();
  return true;
 }

 function save(edit=true,sync=edit){
  return writeRoot(root,{edit,sync});
 }

 function persistChange(change,edit=true,sync=edit){
  const before=JSON.stringify(root);
  const beforeBaseline=baseline;
  const beforeUndo=undoData;

  try{
   change();
   syncState();
  }catch(error){
   restoreSnapshot(before,beforeBaseline,beforeUndo);
   throw error;
  }

  if(save(edit,sync))return true;
  restoreSnapshot(before,beforeBaseline,beforeUndo);
  return false;
 }

 function undoLast(){
  if(!undoData)return {ok:false,reason:'empty',message:''};

  try{
   const candidate=JSON.parse(undoData);
   if(!replaceRoot(candidate,{edit:false,sync:true,success:'直前の操作を取り消しました'})){
    return {
     ok:false,
     reason:externalChangeDetected?'external':storageError?'storage':'save',
     message:externalChangeDetected
      ?'別の画面でデータが変更されています。アプリを開き直してください。'
      :storageError||'保存できないため取り消しませんでした。'
    };
   }
   return {ok:true,reason:'',message:''};
  }catch{
   return {ok:false,reason:'invalid',message:'保存できないため取り消しませんでした。'};
  }
 }

 function handleStorageEvent(event){
  if(event.key!==storageKey)return false;
  externalChangeDetected=true;
  onStatus(CONFLICT_STATUS);
  return true;
 }

 notifyUndo();

 return {
  getRoot:()=>root,
  getState:()=>state,
  getStorageError:()=>storageError,
  isExternalChangeDetected:()=>externalChangeDetected,
  isCloudConflictDetected:()=>cloudConflictDetected,
  setCloudConflict:()=>{cloudConflictDetected=true;},
  clearCloudConflict:()=>{cloudConflictDetected=false;},
  canUndo:()=>Boolean(undoData),
  save,
  persistChange,
  replaceRoot,
  undoLast,
  handleStorageEvent,
  clearStorageError:()=>{storageError='';}
 };
}
