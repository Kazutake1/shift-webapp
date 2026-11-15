// Shared HTTP helpers for Edge handlers. No secret or user data logging.
export function corsHeaders(req,origins){
 const origin=req.headers.get('origin');
 if(origin&&!origins.includes(origin))return null;
 return {
  ...(origin?{'Access-Control-Allow-Origin':origin}:{}),
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,cache-control',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  'Access-Control-Max-Age':'300',
  'Vary':'Origin'
 };
}
export function allowedOrigins(value){
 return typeof value==='string'?value.split(',').map(x=>x.trim()).filter(x=>/^https:\/\/[^/]+$/.test(x)):[];
}
export function reply(req,origins,status,body){
 const cors=corsHeaders(req,origins)||{};
 return new Response(JSON.stringify(body),{
  status,
  headers:{...cors,'Content-Type':'application/json; charset=utf-8',
   'Cache-Control':'no-store, max-age=0','Pragma':'no-cache',
   'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}
 });
}
export async function readSmallJson(req,maxBytes=2048){
 const declared=Number(req.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>maxBytes)throw Error('request too large');
 const text=await req.text();
 if(new TextEncoder().encode(text).length>maxBytes)throw Error('request too large');
 const data=JSON.parse(text);
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('bad body');
 return data;
}
export function secureEnvironment(env){
 const project=env.get('SUPABASE_URL');
 const keys=JSON.parse(env.get('SUPABASE_SECRET_KEYS')||'{}');
 const secret=keys.default;
 const pepper=env.get('VIEWER_PIN_PEPPER');
 if(!project||!/^https:\/\/[^/]+\.supabase\.co$/.test(project)||
  typeof secret!=='string'||!secret.startsWith('sb_secret_')||
  typeof pepper!=='string'||pepper.length<32)throw Error('viewer backend not configured');
 return {project,secret,pepper};
}
