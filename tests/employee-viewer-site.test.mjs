import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const read=path=>readFileSync(resolve(root,path),'utf8');

test('viewer site contains only an isolated six-digit PIN login and read-only schedule actions',()=>{
 const html=read('employee-viewer/site/index.html');
 const js=read('employee-viewer/site/app.js');
 assert.match(html,/inputmode="numeric"/);
 assert.match(html,/pattern="\[0-9\]\{6\}"/);
 assert.match(js,/^[\s\S]*fetch\(ACCESS_URL/);
 assert.match(js,/sessionStorage/);
 assert.doesNotMatch(js,/localStorage/);
 assert.deepEqual(js.split('\n').filter(line=>line.startsWith('import ')),["import {holidays} from './holidays.js';"]);
 assert.doesNotMatch(html,/cloud-sync\.js|app\.js"[^>]*data-admin|employee-dialog/);
 assert.doesNotMatch(html+js,/確定|未確定|自分のシフト/);
 assert.doesNotMatch(html+js, /innerHTML|outerHTML|insertAdjacentHTML/);
 assert.match(js,/textContent/);
 assert.match(js,/td.*notes-cell/);
});

test('isolated viewer output contains only explicitly reviewed assets, not manager sources',()=>{
 execFileSync(process.execPath,['scripts/build-employee-viewer.mjs'],{cwd:root,timeout:20000,stdio:'pipe'});
 const out=resolve(root,'dist-viewer');
 assert.equal(statSync(out).isDirectory(),true);
 assert.deepEqual(readdirSync(out).sort(),['_headers','app.js','holidays.js','index.html','style.css','viewer.css'].sort());
 assert.equal(readFileSync(resolve(out,'style.css'),'utf8'),read('style.css'));
 const distJS=readFileSync(resolve(out,'app.js'),'utf8');
 for(const keyword of ['employeeId','employeeNumber','birthdayAcknowledgements','shift_app_state',
  'owner_id','session_epoch','password_salt','password_hash']){
  assert.equal(distJS.includes(keyword),false,'unexpected credential/manager field in viewer static JS: '+keyword);
 }
 const headers=readFileSync(resolve(out,'_headers'),'utf8');
 const apiOrigin=new URL(distJS.match(/ACCESS_URL='([^']+)'/)[1]).origin;
 const html=readFileSync(resolve(out,'index.html'),'utf8');
 assert.ok(html.includes('connect-src '+apiOrigin+';'),'HTML must allow the built viewer API origin');
 assert.ok(headers.includes('connect-src '+apiOrigin+';'),'hosting CSP must allow the same API origin');
 assert.match(headers,/Cache-Control: no-store/);
 assert.match(headers,/X-Frame-Options: DENY/);
 assert.match(headers,/frame-ancestors 'none'/);
});

test('employee view is a separate artifact, never copied into manager deployment',()=>{
 const manager=read('scripts/build-cloudflare.mjs');
 assert.doesNotMatch(manager,/employee-viewer\/site\/app\.js|employee-viewer\/site\/index\.html/);
 const viewer=read('scripts/build-employee-viewer.mjs');
 assert.doesNotMatch(viewer,/copyFile\(.+cloud-sync/);
 assert.doesNotMatch(viewer,/\bdist\b[^-]/);
});


test('viewer build refuses to target the manager backend',async()=>{
 const {SUPABASE_URL}=await import('../supabase-config.js');
 assert.throws(()=>execFileSync(process.execPath,['scripts/build-employee-viewer.mjs'],{
  cwd:root,stdio:'pipe',env:{...process.env,VIEWER_ACCESS_ORIGIN:SUPABASE_URL}
 }),/separate HTTPS Supabase project/);
});
