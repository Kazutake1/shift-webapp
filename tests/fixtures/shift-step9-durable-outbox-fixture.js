/* STEP9 TEST-ONLY durable encrypted root + non-PII sync marker. NEVER deploy. */
(()=>{
 'use strict';
 const DB_NAME='shift-step9-synthetic-outbox-v1', STORE='records', ACTIVE='active', PREVIOUS='previous', OUTBOX='outbox';
 const AAD='shift-step9-synthetic:v1', ITERATIONS=600000;
 const enc=new TextEncoder(),dec=new TextDecoder();
 const b64=bytes=>btoa(Array.from(bytes,v=>String.fromCharCode(v)).join(''));
 const un64=text=>Uint8Array.from(atob(text),letter=>letter.charCodeAt(0));
 const request=handle=>new Promise((resolve,reject)=>{
  handle.onsuccess=()=>resolve(handle.result);
  handle.onerror=()=>reject(handle.error||Error('IDB_REQUEST_FAILED'));
 });
 const finished=tx=>new Promise((resolve,reject)=>{
  tx.oncomplete=()=>resolve();
  tx.onabort=()=>reject(tx.error||Error('TRANSACTION_ABORTED'));
  tx.onerror=()=>reject(tx.error||Error('TRANSACTION_FAILED'));
 });
 async function dbOpen(){
  return new Promise((resolve,reject)=>{
   const request=indexedDB.open(DB_NAME,1);
   request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error);
  });
 }
 async function derive(password,salt){
  if(typeof password!=='string'||password.length<12)throw Error('SHORT_PASSPHRASE');
  const base=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function encrypt(data,password){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await derive(password,salt);
  const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(AAD)},key,enc.encode(JSON.stringify(data)));
  return {type:'STEP9-FAKE-ENCRYPTED',salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(bytes))};
 }
 async function decrypt(envelope,password){
  if(envelope?.type!=='STEP9-FAKE-ENCRYPTED')throw Error('INVALID_ENVELOPE');
  const salt=un64(envelope.salt),iv=un64(envelope.iv);
  if(salt.length!==16||iv.length!==12)throw Error('INVALID_ENVELOPE');
  const key=await derive(password,salt);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:enc.encode(AAD)},key,un64(envelope.ciphertext))));
 }
 const freshJournal=ownerId=>({ownerId,pendingRevision:null,cloudBaseRevision:0});
 function createVault({ownerId='FAKE-OWNER-A'}={}){
  if(!/^FAKE-OWNER-[A-Z]$/.test(ownerId))throw Error('TEST_OWNER_ONLY');
  async function row(which=ACTIVE){
   const db=await dbOpen();
   try{return (await request(db.transaction(STORE,'readonly').objectStore(STORE).get(which)))??null;}
   finally{db.close();}
  }
  async function read(password,which=ACTIVE){
   const stored=await row(which);
   return stored?{revision:stored.revision,data:await decrypt(stored.envelope,password)}:null;
  }
  async function outbox(){return await row(OUTBOX)||freshJournal(ownerId);}
  async function write(data,password,expected,abort=false,{sync=false}={}){
   // Cryptography takes place before opening the IndexedDB transaction.
   const envelope=await encrypt(data,password),db=await dbOpen();
   try{
    const tx=db.transaction(STORE,'readwrite'),complete=finished(tx),store=tx.objectStore(STORE);
    const active=await request(store.get(ACTIVE));
    const journal=await request(store.get(OUTBOX))||freshJournal(ownerId);
    const actual=active?.revision??0;
    if(journal.ownerId!==ownerId){tx.abort();await complete.catch(()=>{});throw Error('OWNER_MISMATCH');}
    if(actual!==expected){tx.abort();await complete.catch(()=>{});throw Error('REVISION_CONFLICT');}
    const next=actual+1;
    if(active)store.put(active,PREVIOUS);
    store.put({revision:next,envelope},ACTIVE);
    if(sync||journal.pendingRevision!==null)journal.pendingRevision=next;
    store.put(journal,OUTBOX);
    if(abort)tx.abort();
    try{await complete;}catch{throw Error('TRANSACTION_ABORTED');}
    return next;
   }finally{db.close();}
  }
  async function acknowledge(localRevision,remoteBase,newRemoteRevision,abort=false){
   const db=await dbOpen();
   try{
    const tx=db.transaction(STORE,'readwrite'),complete=finished(tx),store=tx.objectStore(STORE);
    const journal=await request(store.get(OUTBOX));
    if(!journal||journal.ownerId!==ownerId||journal.pendingRevision===null||
       journal.cloudBaseRevision!==remoteBase||
       !Number.isInteger(newRemoteRevision)||newRemoteRevision!==remoteBase+1){
     tx.abort();await complete.catch(()=>{});throw Error('ACK_CONFLICT');
    }
    journal.cloudBaseRevision=newRemoteRevision;
    if(journal.pendingRevision===localRevision)journal.pendingRevision=null;
    store.put(journal,OUTBOX);
    if(abort)tx.abort();
    try{await complete;}catch{throw Error('ACK_ABORTED');}
    return {acknowledged:true,pendingRevision:journal.pendingRevision,cloudBaseRevision:journal.cloudBaseRevision};
   }finally{db.close();}
  }
  async function reset(){
   const db=await dbOpen();db.close();
   return new Promise((resolve,reject)=>{
    const action=indexedDB.deleteDatabase(DB_NAME);
    action.onsuccess=()=>resolve();
    action.onerror=()=>reject(action.error);
    action.onblocked=()=>reject(Error('IDB_BLOCKED'));
   });
  }
  return {name:DB_NAME,read,row,outbox,write,acknowledge,reset};
 }
 function projectSyntheticSchedule(root){
  // Deliberately never copies store name, employee roster, gift details or notes.
  return {type:'TEST_ONLY_SCHEDULE',stores:root.stores.map(store=>({
   id:store.id,
   weeks:Object.fromEntries(Object.entries(store.weeks||{}).map(([week,w])=>[week,{shifts:structuredClone(w.shifts||[])}]))
  }))};
 }
 async function syncOnce(vault,password,cloud,{ownerId='FAKE-OWNER-A',abortAcknowledge=false}={}){
  const meta=await vault.outbox();
  if(meta.ownerId!==ownerId)return {status:'owner_mismatch'};
  if(meta.pendingRevision===null)return {status:'idle'};
  const saved=await vault.read(password);
  if(!saved||saved.revision<meta.pendingRevision)return {status:'invalid_local_revision'};
  let actualRemote;
  try{actualRemote=await cloud.readRevision();}
  catch{return {status:'offline',pendingRevision:meta.pendingRevision};}
  if(actualRemote!==meta.cloudBaseRevision)return {status:'remote_conflict_or_unconfirmed',pendingRevision:meta.pendingRevision};
  let response;
  try{
   response=await cloud.patch(meta.cloudBaseRevision,projectSyntheticSchedule(saved.data));
  }catch{return {status:'send_unconfirmed',pendingRevision:meta.pendingRevision};}
  if(response?.revision!==meta.cloudBaseRevision+1)return {status:'unexpected_remote_ack'};
  try{
   const ack=await vault.acknowledge(saved.revision,meta.cloudBaseRevision,response.revision,abortAcknowledge);
   return {status:'synced',...ack};
  }catch{return {status:'ack_failed',pendingRevision:meta.pendingRevision};}
 }
 function cloudFake(){
  let revision=0,payload=null,patches=0,failRead=false,failBefore=false,failAfter=false;
  return {
   readRevision:async()=>{if(failRead)throw Error('OFFLINE');return revision;},
   patch:async(expected,next)=>{
    if(failBefore)throw Error('OFFLINE');
    if(revision!==expected)throw Error('REMOTE_CONFLICT');
    revision++;patches++;payload=structuredClone(next);
    if(failAfter)throw Error('ACK_LOST');
    return {revision};
   },
   configure:flags=>{failRead=!!flags.read;failBefore=!!flags.before;failAfter=!!flags.after;},
   externalChange:()=>{revision++;payload={type:'OTHER_DEVICE_CHANGE'};},
   get:()=>({revision,payload:structuredClone(payload),patches})
  };
 }
 window.__shiftStep9={createVault,syncOnce,projectSyntheticSchedule,cloudFake};
})();
