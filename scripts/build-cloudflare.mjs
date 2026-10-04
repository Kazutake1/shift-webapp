import {copyFile,mkdir,readdir,rm,stat} from 'node:fs/promises';
import {extname,join} from 'node:path';

const output='dist';
const allowedExtensions=new Set(['.html','.css','.js','.webmanifest','.svg','.png']);
const allowedNames=new Set(['_headers']);
const required=['index.html','style.css','app.js','sw.js','manifest.webmanifest','_headers'];

await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});

for(const entry of await readdir('.',{withFileTypes:true})){
 if(!entry.isFile())continue;
 if(!allowedNames.has(entry.name)&&!allowedExtensions.has(extname(entry.name)))continue;
 await copyFile(entry.name,join(output,entry.name));
}

for(const name of required){
 const info=await stat(join(output,name)).catch(()=>null);
 if(!info?.isFile())throw Error(`Cloudflare Pages build is missing ${name}`);
}

console.log(`Cloudflare Pages build ready: ${output}`);
