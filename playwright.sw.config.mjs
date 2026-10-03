import {defineConfig} from '@playwright/test';

export default defineConfig({
 testDir:'./tests',
 testMatch:'sw.e2e.spec.mjs',
 timeout:30000,
 expect:{timeout:8000},
 fullyParallel:false,
 workers:1,
 reporter:'line',
 use:{
  baseURL:'http://127.0.0.1:4174',
  serviceWorkers:'allow',
  viewport:{width:1180,height:820}
 },
 projects:[
  {name:'chromium-sw',use:{browserName:'chromium'}}
 ],
 webServer:{
  command:'python3 -m http.server 4174 --bind 127.0.0.1',
  url:'http://127.0.0.1:4174/',
  reuseExistingServer:false,
  timeout:10000
 }
});
