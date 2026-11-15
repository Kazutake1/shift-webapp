// Employee-only password gateway. NEVER return or expose admin state, user
// profiles, owner identity, password hashes, or raw cloud shift objects.
// Supabase platform verify_jwt=false: all authorization happens here.
import {createClient} from 'npm:@supabase/supabase-js@2.95.0';
import {validViewerCode,validWeekStart,verifyPin,createViewerToken,sha256Hex,
 SESSION_DURATION_HOURS} from '../_shared/viewer-security.mjs';
import {allowedOrigins,corsHeaders,reply,readSmallJson,secureEnvironment} from '../_shared/viewer-http.mjs';
import {projectCloudViewerWeek} from '../_shared/viewer-projection.mjs';

const denied={error:'パスワードまたはアクセス先を確認してください。'};
function clientSource(req){
 // These headers must be verified against the edge platform in a staging audit.
 // Even if an attacker spoofs them, a second *store-global* SQL limit applies.
 const ip=(req.headers.get('cf-connecting-ip')||
  req.headers.get('x-real-ip')||
  req.headers.get('x-forwarded-for')?.split(',')[0]||'unavailable').trim().slice(0,120);
 return ip;
}
function tokenFromRequest(req){
 const header=req.headers.get('authorization')||'';
 const token=header.startsWith('Bearer ')?header.slice(7):'';
 return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
}
function serverClient(project,secret){
 return createClient(project,secret,{auth:{persistSession:false,autoRefreshToken:false}});
}

Deno.serve(async req=>{
 const origins=allowedOrigins(Deno.env.get('VIEWER_EMPLOYEE_ORIGIN'));
 if(!corsHeaders(req,origins))return reply(req,origins,403,{error:'access denied'});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(req,origins)});
 if(req.method!=='POST'&&req.method!=='GET')return reply(req,origins,405,{error:'method not allowed'});
 try{
  const {project,secret,pepper}=secureEnvironment(Deno.env);
  const db=serverClient(project,secret);

  if(req.method==='POST'){
   const input=await readSmallJson(req);
   if(input.action==='logout'){
    const token=tokenFromRequest(req);
    if(!token)return reply(req,origins,401,{error:'ログインしてください。'});
    const {error}=await db.from('employee_viewer_sessions').delete()
     .eq('token_hash',await sha256Hex(token));
    if(error)return reply(req,origins,503,{error:'service unavailable'});
    return reply(req,origins,200,{ok:true});
   }
   const viewerCode=input.viewerCode;
   const pin=input.password;
   if(!validViewerCode(viewerCode)||!(/^[0-9]{6}$/.test(pin))){
    return reply(req,origins,401,denied);
   }
   const {data:credential,error:credentialError}=await db.from('employee_viewer_passwords')
    .select('owner_id,store_id,password_salt,password_hash,kdf_iterations,session_epoch')
    .eq('viewer_code',viewerCode).maybeSingle();
   if(credentialError)return reply(req,origins,503,{error:'service unavailable'});
   if(!credential)return reply(req,origins,401,denied);

   const fingerprint=await sha256Hex(pepper+'|'+clientSource(req));
   const {data:admitted,error:limitError}=await db.rpc('reserve_employee_viewer_pin_attempt',{
    p_owner_id:credential.owner_id,p_store_id:credential.store_id,p_source_hash:fingerprint
   });
   if(limitError)return reply(req,origins,503,{error:'service unavailable'});
   if(!admitted)return reply(req,origins,429,{error:'入力回数の制限に達しました。15分後にお試しください。'});

   const matched=await verifyPin(pin,pepper,credential);
   const {error:finishError}=await db.rpc('complete_employee_viewer_pin_attempt',{
    p_owner_id:credential.owner_id,p_store_id:credential.store_id,
    p_source_hash:fingerprint,p_success:matched
   });
   if(finishError)return reply(req,origins,503,{error:'service unavailable'});
   if(!matched)return reply(req,origins,401,denied);

   const {data:membership,error:memberError}=await db.from('shift_app_admins')
    .select('user_id').eq('user_id',credential.owner_id).maybeSingle();
   if(memberError||membership?.user_id!==credential.owner_id)return reply(req,origins,403,denied);

   const token=createViewerToken();
   const tokenHash=await sha256Hex(token);
   const expiresAt=new Date(Date.now()+SESSION_DURATION_HOURS*3600000).toISOString();
   const {error:saveError}=await db.from('employee_viewer_sessions').insert({
    token_hash:tokenHash,owner_id:credential.owner_id,store_id:credential.store_id,
    session_epoch:credential.session_epoch,expires_at:expiresAt
   });
   if(saveError)return reply(req,origins,503,{error:'service unavailable'});
   return reply(req,origins,200,{token,expiresAt});
  }

  const token=tokenFromRequest(req);
  const weekStart=new URL(req.url).searchParams.get('weekStart');
  if(!token)return reply(req,origins,401,{error:'ログインしてください。'});
  if(!validWeekStart(weekStart))return reply(req,origins,400,{error:'invalid week'});
  const tokenHash=await sha256Hex(token);
  const {data:session,error:sessionError}=await db.from('employee_viewer_sessions')
   .select('owner_id,store_id,session_epoch,expires_at')
   .eq('token_hash',tokenHash).maybeSingle();
  if(sessionError)return reply(req,origins,503,{error:'service unavailable'});
  if(!session||Date.parse(session.expires_at)<=Date.now())return reply(req,origins,401,{error:'ログインし直してください。'});
  const {data:credential,error:credError}=await db.from('employee_viewer_passwords')
   .select('session_epoch').eq('owner_id',session.owner_id).eq('store_id',session.store_id).maybeSingle();
  if(credError||!credential||credential.session_epoch!==session.session_epoch){
   return reply(req,origins,401,{error:'ログインし直してください。'});
  }
  const {data:membership,error:memberError}=await db.from('shift_app_admins')
   .select('user_id').eq('user_id',session.owner_id).maybeSingle();
  if(memberError||membership?.user_id!==session.owner_id)return reply(req,origins,403,denied);
  // The manager's cloud record is read ONLY within this trusted function.
  const {data:state,error:stateError}=await db.from('shift_app_state').select('payload')
   .eq('owner_id',session.owner_id).maybeSingle();
  if(stateError)return reply(req,origins,503,{error:'service unavailable'});
  const projection=projectCloudViewerWeek(state?.payload,session.store_id,weekStart);
  if(!projection)return reply(req,origins,404,{error:'この週のシフト表は表示できません。'});
  return reply(req,origins,200,projection);
 }catch(error){
  // Never include raw error details, input passwords, or session tokens.
  console.error('viewer access handler failed',error instanceof Error?error.name:'error');
  return reply(req,origins,503,{error:'service unavailable'});
 }
});
