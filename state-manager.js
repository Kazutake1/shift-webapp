import {initialState} from './model.js';
import {storageKey,validateRoot,migrate} from './stores.js';

const LOAD_ERROR='保存データを読み込めません。既存データを上書きせず一時表示しています。';
const CONFLICT_STATUS='別の画面でデータが変更されました。安全のため保存を停止しています。アプリを開き直してください。';
const SAVE_ERROR='保存できません。今回の変更は反映していません。空き容量を確認してください。';

export function createStateManager({
 storage=globalThis.localStorage,
 onStatus=()=>{},
 onUndoChange=()=>{},
 onRollback=()=>{},
 onSaveFailure=()=>{}
}={}){
 let root;
 let state;
 let storageError='';
 let externalChangeDetected=false;
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

 function writeRoot(candidate,{edit=true,allowStorageError=false,success=''}={}){
  if(storageError&&!allowStorageError){
   onStatus(storageError);
   return false;
  }
  if(externalChangeDetected){
   onStatus(CONFLICT_STATUS);
   return false;
  }

  try{
   const next=JSON.stringify(candidate);
   storage.setItem(storageKey,next);
   if(edit&&next!==baseline)undoData=baseline;
   if(!edit)undoData=null;
   baseline=next;
   notifyUndo();
   onStatus(success);
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

 function save(edit=true){
  return writeRoot(root,{edit});
 }

 function persistChange(change,edit=true){
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

  if(save(edit))return true;
  restoreSnapshot(before,beforeBaseline,beforeUndo);
  return false;
 }

 function undoLast(){
  if(!undoData)return {ok:false,reason:'empty',message:''};

  try{
   const candidate=JSON.parse(undoData);
   if(!replaceRoot(candidate,{edit:false,success:'直前の操作を取り消しました'})){
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
  canUndo:()=>Boolean(undoData),
  save,
  persistChange,
  replaceRoot,
  undoLast,
  handleStorageEvent,
  clearStorageError:()=>{storageError='';}
 };
}
