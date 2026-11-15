import {copyFile,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SUPABASE_URL} from '../supabase-config.js';

// Isolated employee site: NEVER include manager JS, session storage handlers,
// roster, cloud sync, stores or unreviewed files in this output directory.
const output='dist-viewer';
const placeholder='https://employee-viewer.invalid';
const accessOrigin=process.env.VIEWER_ACCESS_ORIGIN??placeholder;
if(accessOrigin!==placeholder&&(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(accessOrigin)||
 accessOrigin===SUPABASE_URL)){
 throw Error('Viewer API must use a separate HTTPS Supabase project origin.');
}
const allowlist=[
 ['employee-viewer/site/index.html','index.html'],
 ['employee-viewer/site/app.js','app.js'],
 ['employee-viewer/site/viewer.css','viewer.css'],
 ['style.css','style.css'],
 ['holidays.js','holidays.js']
];
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for(const [from,to] of allowlist){
 const data=await stat(from).catch(()=>null);
 if(!data?.isFile())throw Error(`Employee viewer missing reviewed asset: ${from}`);
 if(to==='app.js'){
  const app=await readFile(from,'utf8');
  if(!app.includes(placeholder+'/functions/v1/employee-viewer-access'))throw Error('Viewer API placeholder missing.');
  await writeFile(join(output,to),app.replace(placeholder,accessOrigin));
 }else await copyFile(from,join(output,to));
}
// A separate hosting origin is required. The backend only permits the
// configured employee origin (VIEWER_EMPLOYEE_ORIGIN).
await writeFile(join(output,'_headers'),`/*
  Content-Security-Policy: default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src ${accessOrigin}; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cache-Control: no-store
`);
console.log(`Employee viewer built: ${output} (only ${allowlist.length} approved files)`);
