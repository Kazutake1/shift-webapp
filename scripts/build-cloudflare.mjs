import {copyFile,mkdir,rm,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';

const output='dist';

// GitHub Pages / Cloudflare Pages: publish only explicitly reviewed assets.
// New root-level .js, .html or credential files must never be copied automatically.
const publicAssets=[
  'index.html',
  'style.css',
  'app.js',
  'print-pdf.js',
  'backup-dialog.js',
  'employee-dialog.js',
  'employee-identity.js',
  'store-dialog.js',
  'state-manager.js',
  'week-finalization.js',
  'cloud-sync.js',
  'employee-viewer/rotation-policy.mjs',
  'employee-viewer/password-admin-ui.mjs',
  'schedule-sync.js',
  'supabase-config.js',
  'model.js',
  'stores.js',
  'crypto-backup.js',
  'birthdays.js',
  'birthday-ui.js',
  'holidays.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'sw.js',
  '_headers',
];

await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});

for(const name of publicAssets){
 const info=await stat(name).catch(()=>null);
 if(!info?.isFile())throw Error(`Public build is missing required reviewed asset: ${name}`);
 const destination=join(output,name);
 await mkdir(dirname(destination),{recursive:true});
 await copyFile(name,destination);
}
console.log(`Public build ready: ${output} (${publicAssets.length} reviewed assets)`);
