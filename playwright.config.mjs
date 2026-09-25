import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir:'./tests',
  testMatch:'operations.e2e.spec.mjs',
  timeout:20000,
  expect:{timeout:5000},
  fullyParallel:false,
  workers:1,
  reporter:'line',
  use:{
    baseURL:'http://127.0.0.1:4173',
    serviceWorkers:'block',
    viewport:{width:1180,height:820}
  },
  projects:[
    {name:'chromium',use:{browserName:'chromium'}},
    {name:'webkit',use:{browserName:'webkit'}}
  ],
  webServer:{
    command:'python3 -m http.server 4173 --bind 127.0.0.1',
    url:'http://127.0.0.1:4173/',
    reuseExistingServer:false,
    timeout:10000
  }
});
