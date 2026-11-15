// Admin-only: store PIN maintenance and publishing sanitized schedule copies.
// The platform JWT check MUST stay enabled for this function.
import {createClient} from 'npm:@supabase/supabase-js@2.95.0';
import postgres from 'npm:postgres@3.4.7';
import {projectCloudViewerWeek} from '../_shared/viewer-projection.mjs';
import {assertServerPin,hashPin,verifyPin,validWeekStart} from '../_shared/viewer-security.mjs';
import {allowedOrigins,corsHeaders,reply,readSmallJson,secureEnvironment} from '../_shared/viewer-http.mjs';

let publisher;
async function writeWeekCopy(viewerCode,weekStart,revision,sheet){
 const connection=Deno.env.get('VIEWER_WEEK_PUBLISHER_DB_URL');
 if(!connection)throw Error('viewer week publisher not configured');
 publisher??=postgres(connection,{
  prepare:false,max:1,connect_timeout:5,idle_timeout:20,ssl:{rejectUnauthorized:true}
 });
 const [result]=await publisher`
  select shift_viewer_private.apply_published_week(
   ${viewerCode}::uuid,${weekStart}::date,${revision}::bigint,${sheet===null?null:JSON.stringify(sheet)}::jsonb
  ) as applied where current_user='shift_viewer_week_publisher'
 `;
 if(typeof result?.applied!=='boolean')throw Error('unexpected viewer publisher result');
 return result.applied;
}

Deno.serve(async req=>{
 const origins=allowedOrigins(Deno.env.get('VIEWER_ADMIN_ORIGINS')||'https://kazutake1.github.io');
 if(!corsHeaders(req,origins))return reply(req,origins,403,{error:'access denied'});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(req,origins)});
 if(req.method!=='GET'&&req.method!=='POST')return reply(req,origins,405,{error:'method not allowed'});
 const authorization=req.headers.get('authorization')||'';
 const token=authorization.startsWith('Bearer ')?authorization.slice(7):'';
 if(token.length<20||token.length>4096)return reply(req,origins,401,{error:'admin login required'});
 try{
  const {project,secret,pepper}=secureEnvironment(Deno.env);
  const db=createClient(project,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  const identity=await db.auth.getUser(token);
  const owner=identity.data.user?.id;
  if(identity.error||!owner)return reply(req,origins,401,{error:'admin login required'});
  // Do not trust a JWT merely because it is valid; membership can be revoked.
  const {data:membership,error:membershipError}=await db.from('shift_app_admins')
   .select('user_id').eq('user_id',owner).maybeSingle();
  if(membershipError||membership?.user_id!==owner)return reply(req,origins,403,{error:'admin permission required'});

  let storeId,pin,weekStart,publish=false;
  if(req.method==='GET'){
   storeId=new URL(req.url).searchParams.get('storeId');
  }else{
   const input=await readSmallJson(req);
   storeId=input.storeId;
   publish=input.action==='syncPublishedWeek';
   if(publish){
    weekStart=input.weekStart;
    if(!validWeekStart(weekStart))return reply(req,origins,400,{error:'invalid week'});
   }else{
    pin=input.password;
    try{assertServerPin(pin);}catch{return reply(req,origins,400,{error:'invalid six-digit password'});}
   }
  }
  if(typeof storeId!=='string'||storeId.length<1||storeId.length>100){
   return reply(req,origins,400,{error:'invalid store'});
  }

  // Authorize membership of this STORE, not only administrator of the app.
  // A forged store ID can never create credentials for another owner's store.
  const {data:state,error:stateError}=await db.from('shift_app_state').select('payload,revision')
   .eq('owner_id',owner).maybeSingle();
  if(stateError)return reply(req,origins,503,{error:'store verification unavailable'});
  if(!state?.payload?.stores?.some(s=>s?.id===storeId)){
   return reply(req,origins,403,{error:'store access denied'});
  }
  const {data:current,error:readError}=await db.from('employee_viewer_passwords')
   .select('viewer_code,password_hash,password_salt,kdf_iterations,changed_at')
   .eq('owner_id',owner).eq('store_id',storeId).maybeSingle();
  if(readError)return reply(req,origins,503,{error:'password service unavailable'});
  if(publish){
   if(!current)return reply(req,origins,409,{error:'viewer is not configured'});
   const revision=Number(state.revision);
   if(!Number.isSafeInteger(revision)||revision<1||state.payload.syncFormat!=='shift-sheet-v1'){
    return reply(req,origins,503,{error:'invalid saved schedule'});
   }
   const sheet=projectCloudViewerWeek(state.payload,storeId,weekStart);
   const applied=await writeWeekCopy(current.viewer_code,weekStart,revision,sheet);
   return reply(req,origins,200,{applied});
  }
  const publishingReady=Deno.env.get('VIEWER_AUTO_PUBLISH_ENABLED')==='true'&&
   Boolean(Deno.env.get('VIEWER_WEEK_PUBLISHER_DB_URL'));
  if(req.method==='GET'){
   return reply(req,origins,200,{configured:Boolean(current),lastChangedAt:current?.changed_at||null,
    ...(publishingReady?{publishingReady:true}:{})});
  }

  if(current&&await verifyPin(pin,pepper,current)){
   return reply(req,origins,400,{error:'set a different password'});
  }
  const credential=await hashPin(pin,pepper);
  const changedAt=new Date().toISOString();
  const {error:saveError}=await db.from('employee_viewer_passwords').upsert({
   owner_id:owner,store_id:storeId,
   viewer_code:current?.viewer_code||crypto.randomUUID(),
   ...credential,session_epoch:crypto.randomUUID(),changed_at:changedAt
  },{onConflict:'owner_id,store_id'});
  if(saveError)return reply(req,origins,503,{error:'password was not saved'});
  // Session epoch rotation already invalidates every token even if cleanup fails.
  const {error:sessionError}=await db.from('employee_viewer_sessions')
   .delete().eq('owner_id',owner).eq('store_id',storeId);
  if(sessionError)console.error('viewer session cleanup failed');
  const {error:limitError}=await db.from('employee_viewer_pin_limits')
   .delete().eq('owner_id',owner).eq('store_id',storeId);
  if(limitError)console.error('viewer login-limit cleanup failed');
  return reply(req,origins,200,{configured:true,lastChangedAt:changedAt,...(publishingReady?{publishingReady:true}:{})});
 }catch(error){
  // No details to clients, especially never include passwords, keys, or payloads.
  console.error('viewer admin handler failed',error instanceof Error?error.name:'error');
  return reply(req,origins,503,{error:'service unavailable'});
 }
});
