/* STEP6 standalone TEST FIXTURE. Synthetic records ONLY. Never deploy or import in the app. */
(()=>{
 'use strict';
 const DB_NAME='shift-step6-synthetic-idb-v1', STORE='vault', ACTIVE='active', PREVIOUS='previous';
 const encoder=new TextEncoder(), decoder=new TextDecoder(), AAD='step6-synthetic-only-v1', ITERATIONS=600000;
 const to64=bytes=>btoa(Array.from(bytes,v=>String.fromCharCode(v)).join(''));
 const from64=text=>Uint8Array.from(atob(text),char=>char.charCodeAt(0));
 const done=transaction=>new Promise((resolve,reject)=>{
  transaction.oncomplete=resolve;
  transaction.onabort=()=>reject(transaction.error||Error('TRANSACTION_ABORTED'));
  transaction.onerror=()=>reject(transaction.error||Error('TRANSACTION_FAILED'));
 });
 const request=request=>new Promise((resolve,reject)=>{
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
 const open=()=>new Promise((resolve,reject)=>{
  const action=indexedDB.open(DB_NAME,1);
  action.onupgradeneeded=()=>action.result.createObjectStore(STORE);
  action.onsuccess=()=>resolve(action.result);
  action.onerror=()=>reject(action.error);
 });
 async function key(password,salt){
  if(typeof password!=='string'||password.length<12)throw Error('SHORT_PASSPHRASE');
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,hash:'SHA-256',iterations:ITERATIONS},
   material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function seal(value,password){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const derived=await key(password,salt);
  const buffer=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(AAD)},derived,encoder.encode(JSON.stringify(value)));
  return {testOnly:true,format:'step6-vault-synthetic',salt:to64(salt),iv:to64(iv),iterations:ITERATIONS,ciphertext:to64(new Uint8Array(buffer))};
 }
 async function unseal(envelope,password){
  if(envelope?.format!=='step6-vault-synthetic'||envelope?.iterations!==ITERATIONS)throw Error('INVALID_ENVELOPE');
  const salt=from64(envelope.salt),iv=from64(envelope.iv);
  if(salt.length!==16||iv.length!==12)throw Error('INVALID_ENVELOPE');
  const derived=await key(password,salt);
  const data=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(AAD)},derived,from64(envelope.ciphertext));
  return JSON.parse(decoder.decode(data));
 }
 async function row(which=ACTIVE){
  const db=await open();
  try{return (await request(db.transaction(STORE,'readonly').objectStore(STORE).get(which)))||null;}
  finally{db.close();}
 }
 async function read(password,which=ACTIVE){
  const found=await row(which);
  return found?{revision:found.revision,data:await unseal(found.envelope,password)}:null;
 }
 async function write(data,password,expected,abort=false){
  const envelope=await seal(data,password);
  const db=await open();
  try{
   const tx=db.transaction(STORE,'readwrite'),committed=done(tx),store=tx.objectStore(STORE);
   const current=await request(store.get(ACTIVE));
   const revision=current?.revision??0;
   if(revision!==expected){tx.abort();await committed.catch(()=>{});throw Error('REVISION_CONFLICT');}
   if(current)store.put(current,PREVIOUS);
   store.put({revision:revision+1,envelope},ACTIVE);
   if(abort)tx.abort();
   try{await committed;}catch{throw Error('TRANSACTION_ABORTED');}
   return revision+1;
  }finally{db.close();}
 }
 async function tamper(){
  const db=await open();
  try{
   const tx=db.transaction(STORE,'readwrite'),finished=done(tx),store=tx.objectStore(STORE);
   const current=await request(store.get(ACTIVE));
   if(!current)throw Error('EMPTY');
   const bytes=from64(current.envelope.ciphertext);bytes[0]^=1;
   current.envelope.ciphertext=to64(bytes);store.put(current,ACTIVE);await finished;
  }finally{db.close();}
 }
 async function reset(){
  const db=await open();db.close();
  await new Promise((resolve,reject)=>{
   const op=indexedDB.deleteDatabase(DB_NAME);
   op.onsuccess=resolve;op.onerror=()=>reject(op.error);op.onblocked=()=>reject(Error('BLOCKED'));
  });
 }
 window.__shiftStep6Vault={row,read,write,tamper,reset,name:DB_NAME};
})();
