// Server-side primitives only. Never import this file into the employee UI.
// PIN hashes require BOTH the database record and a server-held VIEWER_PIN_PEPPER.
export const PIN_KDF_ITERATIONS=600000;
export const PIN_REGEX=/^[0-9]{6}$/;
export const MAX_PIN_TRIES=5;
export const PIN_LOCK_MINUTES=15;
export const SESSION_DURATION_HOURS=24;
const encoder=new TextEncoder();

function bytesToBase64Url(bytes){
 let binary='';
 for(const byte of bytes)binary+=String.fromCharCode(byte);
 return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
function base64UrlToBytes(text){
 if(typeof text!=='string'||!/^[A-Za-z0-9_-]+$/.test(text))throw Error('invalid encoding');
 const binary=atob(text.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-text.length%4)%4));
 return Uint8Array.from(binary,character=>character.charCodeAt(0));
}
function randomBytes(count,cryptoApi=globalThis.crypto){
 const bytes=new Uint8Array(count);
 cryptoApi.getRandomValues(bytes);
 return bytes;
}
function equalConstantTime(a,b){
 if(a.length!==b.length)return false;
 let mismatch=0;
 for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
 return mismatch===0;
}
export function assertServerPin(pin){
 if(!PIN_REGEX.test(pin))throw Error('invalid PIN format');
 if(/^([0-9])\1{5}$/.test(pin)||['123456','654321','012345','987654','012012','121212','123123','112233','000001','100000'].includes(pin)){
  throw Error('guessable PIN');
 }
}
async function pepperedPin(pin,pepper,cryptoApi){
 if(typeof pepper!=='string'||pepper.length<32)throw Error('server PIN pepper missing');
 const secret=await cryptoApi.subtle.importKey('raw',encoder.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await cryptoApi.subtle.sign('HMAC',secret,encoder.encode(pin)));
}
async function derive(pin,pepper,salt,iterations,cryptoApi){
 const secret=await pepperedPin(pin,pepper,cryptoApi);
 const material=await cryptoApi.subtle.importKey('raw',secret,'PBKDF2',false,['deriveBits']);
 return new Uint8Array(await cryptoApi.subtle.deriveBits({
  name:'PBKDF2',salt,iterations,hash:'SHA-256'
 },material,256));
}
export async function hashPin(pin,pepper,{cryptoApi=globalThis.crypto}={}){
 assertServerPin(pin);
 const salt=randomBytes(24,cryptoApi);
 const hash=await derive(pin,pepper,salt,PIN_KDF_ITERATIONS,cryptoApi);
 return {password_salt:bytesToBase64Url(salt),
  password_hash:bytesToBase64Url(hash),kdf_iterations:PIN_KDF_ITERATIONS};
}
export async function verifyPin(pin,pepper,record,{cryptoApi=globalThis.crypto}={}){
 if(!PIN_REGEX.test(pin))return false;
 if(!record||record.kdf_iterations!==PIN_KDF_ITERATIONS)return false;
 const salt=base64UrlToBytes(record.password_salt);
 const expected=base64UrlToBytes(record.password_hash);
 if(salt.length!==24||expected.length!==32)return false;
 const actual=await derive(pin,pepper,salt,record.kdf_iterations,cryptoApi);
 return equalConstantTime(expected,actual);
}
export function createViewerToken({cryptoApi=globalThis.crypto}={}){
 return bytesToBase64Url(randomBytes(32,cryptoApi));
}
export async function sha256Hex(value,{cryptoApi=globalThis.crypto}={}){
 const bytes=new Uint8Array(await cryptoApi.subtle.digest('SHA-256',encoder.encode(value)));
 return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export function validViewerCode(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
export function validWeekStart(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T12:00:00Z');
 return !Number.isNaN(date.getTime())&&date.getUTCDay()===1&&date.toISOString().slice(0,10)===value;
}
