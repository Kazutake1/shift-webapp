// Test-only preview: no production requests, credentials, or persistent data.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {makeFixture,WEEK} from '../tests/employee-viewer-backend-fixture.mjs';

const host=process.argv[2]||'127.0.0.1';
if(isIP(host)!==4||!(host==='127.0.0.1'||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))){
 throw Error('Specify 127.0.0.1 or a private Wi-Fi IPv4 address.');
}
const port=Number(process.argv[3]||4180);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid preview port.');
const base='http://'+host+':'+port;
const fixtureOrigin='https://employee.example.invalid';
const apiPath='/functions/v1/employee-viewer-access';
const fixture=makeFixture({verifiedIpHeader:true,employeeOrigin:fixtureOrigin});
for(const [store,pin] of [[fixture.storeA,'583941'],[fixture.storeB,'749281']]){
 if(!(await fixture.adminSet(store,pin)).ok||!(await fixture.publish(store)).ok)throw Error('Fixture initialization failed.');
}
const [a,b]=fixture.db.tables.employee_viewer_passwords;
const links=[[a,'583941'],[b,'749281']];
const source=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const page=(await source('employee-viewer/site/index.html'))
 .replace('connect-src https://employee-viewer.invalid',"connect-src 'self'")
 .replace('<title>従業員用シフト表</title>','<title>架空データのシフト表デモ</title>')
 .replace('<body>','<body><p role="status">架空データのデモ：週 '+WEEK+'</p>');
const script=(await source('employee-viewer/site/app.js'))
 .replace('https://employee-viewer.invalid'+apiPath,apiPath)
 .replaceAll('currentWeek=tokyoWeekStart()','currentWeek='+JSON.stringify(WEEK));
const assets=new Map([
 ['/index.html',['text/html',page]],
 ['/app.js',['text/javascript',script]],
 ['/viewer.css',['text/css',await source('employee-viewer/site/viewer.css')]],
 ['/style.css',['text/css',await source('style.css')]],
 ['/holidays.js',['text/javascript',await source('holidays.js')]],
 ['/',['text/html',`<!doctype html><html lang="ja"><meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1"><title>シフト表デモ</title>
 <h1>架空データのシフト表デモ</h1><ul>${links.map(([record,pin],i)=>
 `<li><a href="/index.html?code=${record.viewer_code}">架空の${i?'B':'A'}店</a>：テストPIN ${pin}</li>`).join('')}</ul></html>`]]
]);

function respond(res,status,type,body){
 res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(body);
}

const server=createServer(async(req,res)=>{
 try{
  if(req.headers.host!==new URL(base).host)return respond(res,403,'text/plain','Forbidden');
  const url=new URL(req.url,base);
  if(url.origin!==base)return respond(res,403,'text/plain','Forbidden');
  if(url.pathname===apiPath&&['GET','POST'].includes(req.method)){
   if(req.headers.origin&&req.headers.origin!==base)return respond(res,403,'text/plain','Forbidden');
   let body='';
   if(req.method==='POST'){
    for await(const chunk of req){
     body+=chunk;
     if(Buffer.byteLength(body)>2048)return respond(res,413,'text/plain','Request too large');
    }
   }
   const headers=new Headers({
    Origin:fixtureOrigin,
    'Content-Type':'application/json',
    'CF-Connecting-IP':req.socket.remoteAddress||host
   });
   if(req.headers.authorization)headers.set('Authorization',req.headers.authorization);
   const response=await fixture.access(new Request(fixtureOrigin+apiPath+url.search,{
    method:req.method,headers,...(req.method==='POST'?{body}:{})
   }));
   return respond(res,response.status,'application/json',await response.text());
  }
  const entry=req.method==='GET'&&assets.get(url.pathname);
  if(!entry)return respond(res,404,'text/plain','Not found');
  respond(res,200,...entry);
 }catch{
  respond(res,500,'text/plain','Preview unavailable');
 }
});
server.listen(port,host,()=>console.log('架空データのデモ: '+base));
