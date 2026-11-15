// Manager-only policy helpers. No passwords or authentication state are persisted here.
export const MIN_VIEWER_PASSWORD_LENGTH=15;
export const MAX_VIEWER_PASSWORD_LENGTH=128;
export const VIEWER_ROTATION_DAYS=30;
const DAY_MS=86400000;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;

export function validateViewerPassword(password){
 if(typeof password!=='string')return 'パスワードを入力してください。';
 const length=Array.from(password).length;
 if(length<MIN_VIEWER_PASSWORD_LENGTH)return 'パスワードは15文字以上で設定してください。';
 if(length>MAX_VIEWER_PASSWORD_LENGTH)return 'パスワードは128文字以内で設定してください。';
 if(!password.trim()||/[\u0000-\u001f\u007f]/.test(password))return '制御文字や改行を含まないパスワードを使用してください。';
 return '';
}

function japanDate(value){
 const date=value instanceof Date?value:new Date(value);
 if(!Number.isFinite(date.getTime()))return null;
 const parts=new Intl.DateTimeFormat('en-US',{
  timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(date);
 const get=key=>parts.find(part=>part.type===key)?.value;
 const y=get('year'),m=get('month'),d=get('day');
 const iso=`${y}-${m}-${d}`;
 return datePattern.test(iso)?iso:null;
}

export function viewerRotationState({configured=false,lastChangedAt=null,now=new Date()}={}){
 if(!configured)return {kind:'unconfigured',due:true,elapsedDays:null};
 const today=japanDate(now);
 const changed=japanDate(lastChangedAt);
 if(!today||!changed)return {kind:'unknown',due:false,elapsedDays:null};
 const day=value=>Date.UTC(...value.split('-').map((part,i)=>i===1?Number(part)-1:Number(part)))/DAY_MS;
 const elapsedDays=day(today)-day(changed);
 if(elapsedDays<0)return {kind:'unknown',due:false,elapsedDays:null};
 // 30 days elapsed, or the first monthly review after at least ~one month.
 // Do not nag the next day when the password was rotated at month-end.
 const monthlyDue=today.slice(0,7)!==changed.slice(0,7)&&elapsedDays>=25;
 return {kind:elapsedDays>=VIEWER_ROTATION_DAYS?'overdue':monthlyDue?'monthly':'ok',
  due:elapsedDays>=VIEWER_ROTATION_DAYS||monthlyDue,elapsedDays};
}

export function viewerRotationMessage(status,{now=new Date()}={}){
 const result=viewerRotationState({...status,now});
 if(result.kind==='unconfigured')return '従業員用シフト閲覧パスワードが未設定です。';
 if(result.kind==='unknown')return '従業員用パスワードの変更日時を確認できません。';
 if(result.kind==='overdue')return `従業員用シフト閲覧パスワードの前回変更から${result.elapsedDays}日経過しています。変更をご確認ください。`;
 if(result.kind==='monthly')return '今月の従業員用シフト閲覧パスワードの変更をご確認ください。';
 return '';
}
