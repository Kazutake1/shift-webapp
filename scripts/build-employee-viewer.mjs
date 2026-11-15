import {copyFile,mkdir,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Isolated employee site: NEVER include manager JS, session storage handlers,
// roster, cloud sync, stores or unreviewed files in this output directory.
const output='dist-viewer';
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
 await copyFile(from,join(output,to));
}
// A separate hosting origin is required. The backend only permits the
// configured employee origin (VIEWER_EMPLOYEE_ORIGIN).
await writeFile(join(output,'_headers'),`/*
  Content-Security-Policy: default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src https://wpyhkewwzsdcstypcbmq.supabase.co; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cache-Control: no-store
`);
console.log(`Employee viewer built: ${output} (only ${allowlist.length} approved files)`);
