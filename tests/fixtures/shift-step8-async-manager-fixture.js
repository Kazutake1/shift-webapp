/* STEP8 research fixture ONLY. Synthetic data; never ship or import in production. */
(()=>{
 'use strict';

 function createAsyncStateManager({
  vault,
  validate=()=>{},
  onBeforeSave=()=>({sync:false}),
  onSaved=()=>{},
  onStatus=()=>{},
  onRollback=()=>{}
 }){
  let phase='locked',root=null,revision=null,undoData=null,passphrase=null;
  const clone=value=>structuredClone(value);
  const result=(ok,reason='',extra={})=>({ok,reason,...extra});
  const status=()=>({phase,revision,canUndo:undoData!==null});

  async function unlock(secret){
   if(phase!=='locked')return result(false,'NOT_LOCKED');
   phase='opening';
   try{
    const saved=await vault.read(secret);
    if(!saved||!Number.isInteger(saved.revision)||saved.revision<1)throw Error('NO_VALID_VAULT');
    validate(saved.data);
    root=clone(saved.data);
    revision=saved.revision;
    passphrase=secret;
    undoData=null;
    phase='ready';
    return result(true,'',{revision});
   }catch(error){
    root=null;revision=null;undoData=null;passphrase=null;phase='locked';
    return result(false,error.message||'UNLOCK_FAILED');
   }
  }
  function lock(){
   if(phase==='busy'||phase==='opening')return false;
   root=null;revision=null;undoData=null;passphrase=null;phase='locked';
   return true;
  }
  async function commit(candidate,{edit=true,sync=edit,trackConfirmation=true,abort=false}={}){
   if(phase!=='ready')return result(false,phase==='conflict'?'REVISION_CONFLICT':phase==='busy'?'BUSY':'LOCKED');
   phase='busy';
   const before=clone(root),oldRevision=revision,oldUndo=undoData;
   try{
    validate(candidate);
    const confirmation=trackConfirmation?onBeforeSave(candidate,clone(before)):null;
    if(confirmation&&typeof confirmation.then==='function')throw Error('ASYNC_BEFORE_SAVE_NOT_ALLOWED');
    validate(candidate);
    const changed=JSON.stringify(candidate)!==JSON.stringify(before);
    const next=await vault.write(candidate,passphrase,oldRevision,abort);
    if(next!==oldRevision+1)throw Error('UNEXPECTED_COMMITTED_REVISION');
    root=clone(candidate);
    revision=next;
    undoData=edit&&changed?before:null;
    phase='ready';

    // Cloud and UI notifications must run only after the vault reports a commit.
    // A failed notification is not a failed disk write. Surface its failure.
    const mustSync=Boolean(sync||confirmation?.sync);
    let warning='';
    try{if(mustSync)onSaved(clone(root),{sync:true,revision});}
    catch{warning='POST_COMMIT_NOTIFICATION_FAILED';onStatus(warning);}
    return result(true,'',{revision,warning});
   }catch(error){
    // In-memory data/Undo remain unchanged after a failed disk write.
    root=before;revision=oldRevision;undoData=oldUndo;
    phase=error.message==='REVISION_CONFLICT'?'conflict':'ready';
    onRollback(error.message||'SAVE_FAILED');
    return result(false,error.message||'SAVE_FAILED',{revision});
   }
  }
  async function persistChange(change,options={}){
   if(phase!=='ready')return result(false,phase==='conflict'?'REVISION_CONFLICT':phase==='busy'?'BUSY':'LOCKED');
   const candidate=clone(root);
   try{
    const value=change(candidate);
    if(value&&typeof value.then==='function')throw Error('ASYNC_MUTATION_NOT_ALLOWED');
   }catch(error){
    onRollback(error.message||'MUTATION_FAILED');
    return result(false,error.message||'MUTATION_FAILED',{revision});
   }
   return commit(candidate,options);
  }
  async function replaceRoot(candidate,options={}){
   return commit(clone(candidate),{edit:false,...options});
  }
  async function undoLast(options={}){
   if(phase!=='ready')return result(false,phase==='conflict'?'REVISION_CONFLICT':phase==='busy'?'BUSY':'LOCKED');
   if(!undoData)return result(false,'EMPTY_UNDO');
   return commit(clone(undoData),{edit:false,sync:true,...options});
  }
  return {
   unlock,lock,persistChange,replaceRoot,undoLast,
   getRoot:()=>root===null?null:clone(root),
   getStatus:status
  };
 }
 window.__shiftStep8AsyncManager=createAsyncStateManager;
})();
