// Employee-only password gateway. NEVER return or expose admin state, user
// profiles, owner identity, password hashes, or raw cloud shift objects.
// Supabase platform verify_jwt=false: all authorization happens here.
import {isIP} from 'node:net';
import postgres from 'npm:postgres@3.4.7';
import {validViewerCode,validWeekStart,verifyPin,createViewerToken,sha256Hex,
 SESSION_DURATION_HOURS} from '../_shared/viewer-security.mjs';
import {allowedOrigins,corsHeaders,reply,readSmallJson} from '../_shared/viewer-http.mjs';

const denied={error:'パスワードまたはアクセス先を確認してください。'};
function clientSource(req){
 // Opt in only after the deployed ingress is verified to replace this
 // header on every path. Without that assurance use one shared bucket.
 if(Deno.env.get('VIEWER_VERIFIED_IP_HEADER')!=='cf-connecting-ip')return 'unavailable';
 const ip=req.headers.get('cf-connecting-ip')?.trim();
 if(!ip)return 'unavailable';
 const family=isIP(ip);
 if(family===4)return ip;
 if(family===6&&!ip.includes('%'))return new URL('http://['+ip+']').hostname;
 return 'unavailable';
}
function tokenFromRequest(req){
 const header=req.headers.get('authorization')||'';
 const token=header.startsWith('Bearer ')?header.slice(7):'';
 return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
}
let viewerAuthClient;
async function viewerAuth(){
 const connection=Deno.env.get('VIEWER_AUTH_DB_URL');
 if(!connection)throw Error('viewer auth not configured');
 viewerAuthClient??=postgres(connection,{
  prepare:false,max:1,connect_timeout:5,idle_timeout:20,ssl:{rejectUnauthorized:true}
 });
 const [role]=await viewerAuthClient`select current_user as auth_role`;
 if(role?.auth_role!=='shift_viewer_auth')throw Error('unexpected viewer auth role');
 return viewerAuthClient;
}

let publishedWeekReader;
async function readPublishedWeek(viewerCode,weekStart){
 const connection=Deno.env.get('VIEWER_WEEK_READER_DB_URL');
 if(!connection)throw Error('viewer week reader not configured');
 publishedWeekReader??=postgres(connection,{
  prepare:false,max:1,connect_timeout:5,idle_timeout:20,ssl:{rejectUnauthorized:true}
 });
 const [result]=await publishedWeekReader`
  select current_user as reader_role, (
   select sheet from shift_viewer_private.published_weeks
   where viewer_code=${viewerCode}::uuid and week_start=${weekStart}::date
     and current_user='shift_viewer_week_reader'
  ) as sheet
 `;
 if(result?.reader_role!=='shift_viewer_week_reader')throw Error('unexpected viewer database role');
 return result.sheet;
}

Deno.serve(async req=>{
 const origins=allowedOrigins(Deno.env.get('VIEWER_EMPLOYEE_ORIGIN'));
 if(!corsHeaders(req,origins))return reply(req,origins,403,{error:'access denied'});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(req,origins)});
 if(req.method!=='POST'&&req.method!=='GET')return reply(req,origins,405,{error:'method not allowed'});
 try{
  const pepper=Deno.env.get('VIEWER_PIN_PEPPER');
  if(!pepper||pepper.length<32)throw Error('viewer pepper not configured');
  const db=await viewerAuth();

  if(req.method==='POST'){
   const input=await readSmallJson(req);
   if(input.action==='logout'){
    const token=tokenFromRequest(req);
    if(!token)return reply(req,origins,401,{error:'ログインしてください。'});
    await db`delete from public.employee_viewer_sessions where token_hash=${await sha256Hex(token)}`;
    return reply(req,origins,200,{ok:true});
   }
   const viewerCode=input.viewerCode;
   const pin=input.password;
   if(!validViewerCode(viewerCode)||!(/^[0-9]{6}$/.test(pin))){
    return reply(req,origins,401,denied);
   }
   const [credential]=await db`
    select owner_id,store_id,password_salt,password_hash,kdf_iterations,session_epoch
    from public.employee_viewer_passwords where viewer_code=${viewerCode}::uuid
   `;
   if(!credential)return reply(req,origins,401,denied);

   const fingerprint=await sha256Hex(pepper+'|'+clientSource(req));
   const [{admitted}]=await db`
    select public.reserve_employee_viewer_pin_attempt(
     ${credential.owner_id}::uuid,${credential.store_id},${fingerprint}
    ) as admitted
   `;
   if(!admitted)return reply(req,origins,429,{error:'入力回数の制限に達しました。15分後にお試しください。'});

   const matched=await verifyPin(pin,pepper,credential);
   await db`
    select public.complete_employee_viewer_pin_attempt(
     ${credential.owner_id}::uuid,${credential.store_id},${fingerprint},${matched}::boolean
    )
   `;
   if(!matched)return reply(req,origins,401,denied);

   const [membership]=await db`select user_id from public.shift_app_admins where user_id=${credential.owner_id}::uuid`;
   if(!membership)return reply(req,origins,403,denied);

   const token=createViewerToken();
   const tokenHash=await sha256Hex(token);
   const expiresAt=new Date(Date.now()+SESSION_DURATION_HOURS*3600000).toISOString();
   await db`
    insert into public.employee_viewer_sessions(token_hash,owner_id,store_id,session_epoch,expires_at)
    values (${tokenHash},${credential.owner_id}::uuid,${credential.store_id},${credential.session_epoch}::uuid,${expiresAt}::timestamptz)
   `;
   return reply(req,origins,200,{token,expiresAt});
  }

  const token=tokenFromRequest(req);
  const weekStart=new URL(req.url).searchParams.get('weekStart');
  if(!token)return reply(req,origins,401,{error:'ログインしてください。'});
  if(!validWeekStart(weekStart))return reply(req,origins,400,{error:'invalid week'});
  const tokenHash=await sha256Hex(token);
  const [session]=await db`
   select owner_id,store_id,session_epoch,expires_at from public.employee_viewer_sessions where token_hash=${tokenHash}
  `;
  if(!session||new Date(session.expires_at).getTime()<=Date.now())return reply(req,origins,401,{error:'ログインし直してください。'});
  const [credential]=await db`
   select session_epoch,viewer_code from public.employee_viewer_passwords
   where owner_id=${session.owner_id}::uuid and store_id=${session.store_id}
  `;
  if(!credential||credential.session_epoch!==session.session_epoch){
   return reply(req,origins,401,{error:'ログインし直してください。'});
  }
  const [membership]=await db`select user_id from public.shift_app_admins where user_id=${session.owner_id}::uuid`;
  if(!membership)return reply(req,origins,403,denied);
  const projection=await readPublishedWeek(credential.viewer_code,weekStart);
  if(!projection)return reply(req,origins,404,{error:'この週のシフト表は表示できません。'});
  return reply(req,origins,200,projection);
 }catch(error){
  // Never include raw error details, input passwords, or session tokens.
  console.error('viewer access handler failed',error instanceof Error?error.name:'error');
  return reply(req,origins,503,{error:'service unavailable'});
 }
});
