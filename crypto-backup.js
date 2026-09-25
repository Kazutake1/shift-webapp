const FORMAT='shift-ipad-backup-encrypted';
const VERSION=1;
const ITERATIONS=600000;
const SALT_BYTES=16;
const IV_BYTES=12;
const AAD='shift-ipad-backup-encrypted:v1';
const MAX_FILE_CHARS=15000000;

const encoder=new TextEncoder();
const decoder=new TextDecoder();

function cryptoApi(){
 const api=globalThis.crypto?.subtle;
 if(!api)throw Error('このブラウザーでは暗号化機能を利用できません。');
 return api;
}
function toBase64(bytes){
 let binary='';
 const chunk=0x8000;
 for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
 return btoa(binary);
}
function fromBase64(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('暗号化バックアップの形式を確認できません。');
 let binary;try{binary=atob(value);}catch{throw Error('暗号化バックアップの形式を確認できません。');}
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
}
async function deriveKey(password,salt,iterations){
 const subtle=cryptoApi();
 const material=await subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
 return subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function parseEnvelope(text){
 if(typeof text!=='string'||text.length>MAX_FILE_CHARS)throw Error('15MB以下の暗号化バックアップを選んでください。');
 let data;try{data=JSON.parse(text);}catch{throw Error('暗号化バックアップの形式を確認できません。');}
 const e=data?.encryption;
 if(data?.format!==FORMAT||data.version!==VERSION||typeof data.exportedAt!=='string'||
    e?.algorithm!=='AES-256-GCM'||e?.kdf!=='PBKDF2-HMAC-SHA-256'||
    !Number.isInteger(e.iterations)||e.iterations<100000||e.iterations>2000000||
    typeof e.salt!=='string'||typeof e.iv!=='string'||typeof data.ciphertext!=='string'){
  throw Error('対応していない暗号化バックアップです。');
 }
 const salt=fromBase64(e.salt),iv=fromBase64(e.iv),ciphertext=fromBase64(data.ciphertext);
 if(salt.length!==SALT_BYTES||iv.length!==IV_BYTES||ciphertext.length<16)throw Error('暗号化バックアップの形式を確認できません。');
 return {data,salt,iv,ciphertext};
}
export function encryptedBackupInfo(text){
 const {data}=parseEnvelope(text);
 return {exportedAt:data.exportedAt,algorithm:data.encryption.algorithm,kdf:data.encryption.kdf,iterations:data.encryption.iterations};
}
export async function encryptBackupText(plainText,password,exportedAt=new Date().toISOString()){
 if(typeof plainText!=='string'||!plainText)throw Error('バックアップデータが空です。');
 if(typeof password!=='string'||password.length<12)throw Error('バックアップ用パスワードは12文字以上にしてください。');
 const salt=crypto.getRandomValues(new Uint8Array(SALT_BYTES));
 const iv=crypto.getRandomValues(new Uint8Array(IV_BYTES));
 const key=await deriveKey(password,salt,ITERATIONS);
 const encrypted=await cryptoApi().encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(AAD)},key,encoder.encode(plainText));
 return JSON.stringify({
  format:FORMAT,
  version:VERSION,
  exportedAt,
  encryption:{algorithm:'AES-256-GCM',kdf:'PBKDF2-HMAC-SHA-256',iterations:ITERATIONS,salt:toBase64(salt),iv:toBase64(iv)},
  ciphertext:toBase64(new Uint8Array(encrypted))
 },null,2);
}
export async function decryptBackupText(text,password){
 if(typeof password!=='string'||!password)throw Error('バックアップ用パスワードを入力してください。');
 const {data,salt,iv,ciphertext}=parseEnvelope(text);
 try{
  const key=await deriveKey(password,salt,data.encryption.iterations);
  const plain=await cryptoApi().decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(AAD)},key,ciphertext);
  return decoder.decode(plain);
 }catch{
  throw Error('パスワードが違うか、バックアップファイルが破損しています。');
 }
}
export function isEncryptedBackupText(text){
 try{return JSON.parse(text)?.format===FORMAT;}catch{return false;}
}
