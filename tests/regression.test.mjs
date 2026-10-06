import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
if(!globalThis.btoa)globalThis.btoa=value=>Buffer.from(value,'binary').toString('base64');
if(!globalThis.atob)globalThis.atob=value=>Buffer.from(value,'base64').toString('binary');

import {
  initialState,ensureWeek,addDays,monday,shiftLabel,workingTimes,dayInfo,makeShift,
  employeeShiftName,employeeShiftConflicts,employeeAvailableOn,employeeRetiredBy,copyPreviousWeekEmployeeShifts,fixedSetting,fixedTextAt,timedTextLabel,bands
} from '../model.js';
import {migrate,newStore,validateRoot,backupText,parseBackup,parseBackupInfo,mergeStoreBackup,MAX_BACKUP_PLAIN_BYTES,STORAGE_WARNING_BYTES,utf8Bytes} from '../stores.js';
import {birthdayNotices,japanToday} from '../birthdays.js';
import {birthdayGiftChecklist} from '../birthdays.js';
import {linkEmployees,unlinkEmployee,syncEmployeeProfile,updateBirthdayKeys} from '../employee-identity.js';
import {
  encryptBackupText,decryptBackupText,encryptedBackupInfo,isEncryptedBackupText,MAX_ENCRYPTED_BACKUP_BYTES
} from '../crypto-backup.js';
import {holidays} from '../holidays.js';
import {generateHolidays,parseOfficialCsv,nextCacheVersion} from '../scripts/update-holidays.mjs';

test('勤務時間の差分表示を維持',()=>{
 const base={name:'従業員A',start:540,end:780};
 assert.equal(shiftLabel({...base,end:840},1),'従業員A（〜14:00）');
 assert.equal(shiftLabel({...base,start:600},1),'従業員A（10:00〜）');
 assert.equal(shiftLabel({...base,start:600,end:840},1),'従業員A（10:00〜14:00）');
 assert.equal(shiftLabel({...base,start:1320,end:1500},4),'従業員A（〜1:00）');
 assert.equal(shiftLabel(base,1),'従業員A');
});

test('深夜勤務と不正な時間入力を判定',()=>{
 assert.deepEqual(workingTimes('22:00','01:00'),{start:1320,end:1500});
 assert.deepEqual(workingTimes('22:00','06:00'),{start:1320,end:1800});
 assert.deepEqual(workingTimes('01:00','05:00'),{start:1500,end:1740});
 for(const pair of [['13:00','09:00'],['09:00','09:00'],['','13:00'],['25:00','06:00']])assert.throws(()=>workingTimes(...pair));
});

test('翌週作成では従業員3段だけ複製し、5段目と備考はコピーしない',()=>{
 const s=initialState(),d=s.weeks[s.current].days[0];
 d.shifts[2][1]=makeShift(s.employees[0],1,600,840);
 d.extras[0]={type:'training',employeeId:s.employees[0].id,name:'従業員A',start:360,end:540};
 d.extras[1]={type:'task',text:'棚卸し',start:540,end:780};
 d.notes='前週限定';
 const next=addDays(s.current,7);
 assert.equal(ensureWeek(s,next),true);
 assert.deepEqual(s.weeks[next].days[0].shifts,d.shifts);
 assert.deepEqual(s.weeks[next].days[0].extras,Array(5).fill(null));
 assert.equal(s.weeks[next].days[0].notes,'');
});

test('作成済み週は元週と独立し再訪でも上書きしない',()=>{
 const s=initialState(),next=addDays(s.current,7);
 ensureWeek(s,next);
 s.weeks[s.current].days[0].shifts[0][0].name='変更後';
 assert.equal(s.weeks[next].days[0].shifts[0][0].name,'従業員A');
 s.weeks[next].days[0].notes='残す';
 assert.equal(ensureWeek(s,next),false);
 assert.equal(s.weeks[next].days[0].notes,'残す');
});

test('登録済みシフトは従業員の改名・削除後も名前を保持',()=>{
 const s=initialState();
 s.employees[0].name='変更後';
 s.employees.splice(0,1);
 assert.equal(s.weeks[s.current].days[0].shifts[0][0].name,'従業員A');
});

test('同じ従業員の勤務時間重複だけを検出し、隣接時間と編集中セルは除外する',()=>{
 const s=initialState(),employee=s.employees[0];
 const day={shifts:Array.from({length:3},()=>Array(5).fill(null))};
 day.shifts[0][0]=makeShift(employee,0);
 const overlapping=makeShift(employee,0,480,600);
 assert.equal(employeeShiftConflicts(day,overlapping).length,1);
 const adjacent=makeShift(employee,0,540,600);
 assert.equal(employeeShiftConflicts(day,adjacent).length,0);
 const other=makeShift(s.employees[1],0,480,600);
 assert.equal(employeeShiftConflicts(day,other).length,0);
 const editing=makeShift(employee,0,360,540);
 assert.equal(employeeShiftConflicts(day,editing,{row:0,band:0}).length,0);
});

test('週・月・年境界とうるう年を正しく扱う',()=>{
 assert.equal(monday('2027-01-01'),'2026-12-28');
 assert.equal(addDays('2026-12-28',7),'2027-01-04');
 assert.equal(addDays('2028-02-28',1),'2028-02-29');
});

test('祝日・振替休日・土日・未収録年の色判定を維持',()=>{
 assert.equal(dayInfo('2026-09-21').color,'red');
 assert.equal(dayInfo('2026-09-22').holiday,'国民の休日');
 assert.equal(dayInfo('2026-05-06').holiday,'振替休日');
 assert.equal(dayInfo('2026-09-26').color,'blue');
 assert.equal(dayInfo('2026-09-27').color,'red');
 assert.equal(dayInfo('2028-01-01').supported,false);
});

test('公式CSVの新しい年を取り込み、未公表・欠損データでは更新を止める',()=>{
 const original=Object.entries(holidays).map(([date,name])=>`${date.replaceAll('-','/')},${['振替休日','国民の休日'].includes(name)?'休日':name}`);
 const nextYear=Object.entries(holidays).filter(([date])=>date.startsWith('2027-')).map(([date,name])=>`${date.replace('2027-','2028-').replaceAll('-','/')},${['振替休日','国民の休日'].includes(name)?'休日':name}`);
 const csv=['国民の祝日・休日月日,国民の祝日・休日名称',...original,...nextYear].join('\r\n');
 const {content,years}=generateHolidays(csv);
 assert.deepEqual(years,[2026,2027,2028]);
 assert.match(content,/"2028-01-01": "元日"/);
 assert.equal(parseOfficialCsv(csv).get(2028).size,nextYear.length);
 assert.throws(()=>generateHolidays(['国民の祝日・休日月日,国民の祝日・休日名称',...original,...nextYear.slice(0,3)].join('\n')),/未公表または不完全/);
 assert.throws(()=>generateHolidays(original.filter(row=>!row.startsWith('2026/05/06,')).join('\n')),/既存の祝日と公式データが異なります/);
});

test('祝日更新後はオフライン用キャッシュの版番号を進める',()=>{
 assert.equal(nextCacheVersion("const CACHE=CACHE_PREFIX+'v99';"),"const CACHE=CACHE_PREFIX+'v100';");
 assert.throws(()=>nextCacheVersion("const CACHE='unknown';"),/版が見つかりません/);
});

test('初期データは7日・5帯・従業員3段の構造を維持',()=>{
 const s=initialState();
 assert.equal(s.employees.length,10);
 assert.equal(s.weeks[s.current].days.length,7);
 assert.equal(s.weeks[s.current].days[0].shifts.length,3);
 assert.equal(s.weeks[s.current].days[0].shifts.every(row=>row.length===5),true);
});

test('フルネームとシフト表名を分離し旧データも互換',()=>{
 const e={id:'x',name:'山田 太郎',shiftName:'山田'};
 assert.equal(employeeShiftName(e),'山田');
 assert.equal(makeShift(e,1).name,'山田');
 delete e.shiftName;
 assert.equal(employeeShiftName(e),'山田 太郎');
 assert.equal(makeShift(e,1).name,'山田 太郎');
});

test('固定作業・不定期作業の時間差分表記を維持',()=>{
 assert.equal(timedTextLabel('掃除',bands[1].start,bands[1].end,1),'掃除');
 assert.equal(timedTextLabel('掃除',600,bands[1].end,1),'掃除（10:00〜）');
 assert.equal(timedTextLabel('掃除',600,720,1),'掃除（10:00〜12:00）');
 const fixed={text:'売上日報',days:[1,3],start:600,end:720};
 assert.equal(fixedTextAt(fixed,'2026-09-21',1),'売上日報（10:00〜12:00）');
 assert.equal(fixedTextAt(fixed,'2026-09-22',1),'');
});

test('旧形式の固定作業は時間帯全体として互換性を維持',()=>{
 assert.deepEqual(fixedSetting('売上日報',1),{text:'売上日報',days:[1,2,3,4,5,6,0],start:540,end:780});
 assert.equal(fixedTextAt('売上日報','2026-09-21',1),'売上日報');
});

test('固定作業・トレーニング・不定期作業の新旧時間形式を検証',()=>{
 const root=migrate(),s=root.stores[0],day=s.weeks[s.current].days[0];
 s.fixed[0]={text:'掃除',days:[1],start:390,end:480};
 day.extras[0]={type:'training',employeeId:s.employees[0].id,name:'従業員A',start:390,end:480};
 day.extras[1]={type:'task',text:'棚卸し',start:600,end:720};
 assert.equal(validateRoot(root),root);
 delete day.extras[0].start;delete day.extras[0].end;
 delete day.extras[1].start;delete day.extras[1].end;
 assert.equal(validateRoot(root),root);
});

test('不正な作業時刻を拒否',()=>{
 const root=migrate(),s=root.stores[0],day=s.weeks[s.current].days[0];
 s.fixed[0]={text:'掃除',days:[1],start:500,end:400};
 assert.throws(()=>validateRoot(root));
 s.fixed[0]='';
 day.extras[0]={type:'task',text:'棚卸し',start:700,end:600};
 assert.throws(()=>validateRoot(root));
});

test('複数店舗移行後も店舗ごとのデータは独立',()=>{
 const root=migrate(),first=root.stores[0],second=newStore('駅前店',first.current,'second');
 root.stores.push(second);
 second.employees.push({id:'x',name:'別店舗',hidden:false});
 second.fixed[0]={text:'掃除',days:[1],start:360,end:480};
 second.weeks[second.current].days[0].notes='別店舗備考';
 assert.equal(first.employees.length,10);
 assert.equal(first.fixed[0],'');
 assert.equal(first.weeks[first.current].days[0].notes,'');
 assert.equal(validateRoot(root),root);
});

test('バックアップで氏名・追加情報・作業時間・選択店舗を保持',()=>{
 const root=migrate(),s=root.stores[0],e=s.employees[0];
 Object.assign(e,{name:'山田 太郎',shiftName:'山田　太郎',employeeNumber:'0012',hireDate:'2026-09-01',birthDate:'1990-01-01'});
 s.fixed[0]={text:'掃除',days:[1,3],start:390,end:480};
 s.weeks[s.current].days[0].extras[0]={type:'training',employeeId:e.id,name:e.shiftName,start:390,end:480};
 s.weeks[s.current].days[0].extras[1]={type:'task',text:'棚卸し',start:600,end:720};
 root.stores.push(newStore('駅前店',s.current,'second'));root.activeStoreId='second';
 assert.deepEqual(parseBackup(backupText(root)),root);
});

test('破損・未対応・重複店舗・不正日付をバックアップ検証で拒否',()=>{
 const original=migrate();
 for(const mutate of [
  r=>r.version=99,
  r=>r.activeStoreId='missing',
  r=>r.stores.push(structuredClone(r.stores[0])),
  r=>r.stores[0].weeks[r.stores[0].current].days.pop(),
  r=>r.stores[0].current='2026-02-30'
 ]){
  const draft=structuredClone(original);mutate(draft);
  assert.throws(()=>parseBackup(JSON.stringify({format:'shift-ipad-backup',version:1,data:draft})));
 }
 assert.throws(()=>parseBackup('{'));
 assert.throws(()=>parseBackup(JSON.stringify(original)));
});

function birthdayRoot(){
 const r=migrate(),e=r.stores[0].employees[0];
 Object.assign(e,{birthDate:'1990-10-01',hireDate:'2025-09-24'});
 return r;
}

test('誕生日通知は入社1周年・7日前・当日の境界を守る',()=>{
 const r=birthdayRoot();
 assert.equal(birthdayNotices(r,'2026-09-23').length,0);
 assert.equal(birthdayNotices(r,'2026-09-24')[0].days,7);
 assert.equal(birthdayNotices(r,'2026-10-01')[0].days,0);
 assert.equal(birthdayNotices(r,'2026-10-02').length,0);
});

test('誕生日通知は年越し・うるう年・日本時間を扱う',()=>{
 const r=birthdayRoot(),e=r.stores[0].employees[0];
 e.birthDate='1990-01-02';
 assert.equal(birthdayNotices(r,'2026-12-26')[0].days,7);
 e.birthDate='1992-02-29';e.hireDate='2024-02-29';
 assert.equal(birthdayNotices(r,'2025-02-28')[0].days,0);
 assert.equal(japanToday(new Date('2026-09-23T15:00:00Z')),'2026-09-24');
});

test('暗号化バックアップは復号後に元データと一致',async()=>{
 const plain=backupText(migrate());
 const encrypted=await encryptBackupText(plain,'test-pass-123','2026-09-25T00:00:00.000Z');
 assert.equal(await decryptBackupText(encrypted,'test-pass-123'),plain);
 const info=encryptedBackupInfo(encrypted);
 assert.equal(info.algorithm,'AES-256-GCM');
 assert.equal(info.kdf,'PBKDF2-HMAC-SHA-256');
 assert.equal(info.iterations,600000);
 assert.equal(isEncryptedBackupText(encrypted),true);
});

test('暗号化ファイルに元データの従業員名を平文で残さない',async()=>{
 const root=migrate();root.stores[0].employees[0].name='機密テスト氏名';
 const encrypted=await encryptBackupText(backupText(root),'test-pass-123');
 assert.equal(encrypted.includes('機密テスト氏名'),false);
});

test('8文字未満のパスワードを拒否',async()=>{
 await assert.rejects(()=>encryptBackupText('test','1234567'));
});

test('誤ったパスワードと暗号文改ざんを拒否',async()=>{
 const encrypted=await encryptBackupText('secret-data','correct88');
 await assert.rejects(()=>decryptBackupText(encrypted,'wrong888'));
 const data=JSON.parse(encrypted);
 const chars=data.ciphertext.split('');
 chars[10]=chars[10]==='A'?'B':'A';
 data.ciphertext=chars.join('');
 await assert.rejects(()=>decryptBackupText(JSON.stringify(data),'correct88'));
});

test('Service Workerの更新安全策を維持',()=>{
 const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
 assert.match(sw,/skipWaiting\(\)/);
 assert.match(sw,/caches\.keys\(\)/);
 assert.match(sw,/CACHE_PREFIX/);
 assert.match(sw,/clients\.claim\(\)/);
});

test('保存失敗時のロールバック処理を維持',()=>{
 const manager=readFileSync(new URL('../state-manager.js',import.meta.url),'utf8');
 assert.match(manager,/function persistChange\(/);
 assert.match(manager,/const before=JSON\.stringify\(root\)/);
 assert.match(manager,/restoreSnapshot\(before,beforeBaseline,beforeUndo\)/);
 assert.match(manager,/if\(save\(edit,sync\)\)return true/);
});

test('HTML印刷後の画面復帰処理を維持',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(app,/schedulePrintRecovery/);
 assert.match(app,/addEventListener\('afterprint',finishPrint\)/);
 assert.match(app,/addEventListener\('visibilitychange'/);
});

test('シフトデータを外部の実験的ブラウザー機能へ公開しない',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.equal(app.includes('document.modelContext'),false);
 assert.equal(app.includes('read_visible_shift_week'),false);
});

test('シフトデータの書き込み経路をstate-managerへ共通化',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const manager=readFileSync(new URL('../state-manager.js',import.meta.url),'utf8');
 const backup=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 const birthdayUi=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 assert.equal(app.includes('function writeRoot('),false);
 assert.equal(app.includes('function persistChange('),false);
 assert.match(manager,/function writeRoot\(/);
 assert.match(manager,/function replaceRoot\(/);
 assert.equal((manager.match(/storage\.setItem\(storageKey,/g)||[]).length,1);
 assert.match(manager,/function save\(edit=true,sync=edit\)/);
 assert.match(manager,/replaceRoot\(candidate,\{edit:false,sync:true,success:'直前の操作を取り消しました'\}\)/);
 assert.match(birthdayUi,/replaceRoot\(candidate,\{edit:false,sync:true,success:'誕生日の確認済みを保存しました'\}\)/);
 assert.match(backup,/replaceRoot\(candidate,\{edit:false,sync:true,allowStorageError:true,success:'全店舗を復元しました'\}\)/);
});

test('別タブ更新を検知したらstate-managerが保存を停止する',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const manager=readFileSync(new URL('../state-manager.js',import.meta.url),'utf8');
 assert.match(app,/addEventListener\('storage'/);
 assert.match(app,/stateManager\.handleStorageEvent\(event\)/);
 assert.match(manager,/externalChangeDetected/);
 assert.match(manager,/安全のため保存を停止しています/);
});


test('従業員管理UIをapp.jsから分離し、トレーニング1か月判定を維持',async()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const employeeUi=readFileSync(new URL('../employee-dialog.js',import.meta.url),'utf8');
 assert.match(app,/import \{createEmployeeUi,withinFirstMonth\} from '\.\/employee-dialog\.js'/);
 assert.equal(app.includes('function openEmployees(){'),false);
 assert.equal(app.includes('function employeeForm('),false);
 assert.match(employeeUi,/export function createEmployeeUi\(/);
 assert.match(employeeUi,/名前・シフト表名・従業員番号/);

 const {withinFirstMonth}=await import('../employee-dialog.js');
 const employee={hireDate:'2026-09-10'};
 assert.equal(withinFirstMonth(employee,'2026-10-10'),true);
 assert.equal(withinFirstMonth(employee,'2026-10-11'),false);
 assert.equal(withinFirstMonth({},'2026-09-10'),false);
});


test('シフト表下の案内文と通常保存メッセージを表示しない',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const manager=readFileSync(new URL('../state-manager.js',import.meta.url),'utf8');
 assert.equal(html.includes('空欄・名前をタップして編集'),false);
 assert.equal(html.includes('データはこのブラウザーに保存されます。初回表示はサンプルです。'),false);
 assert.equal(html.includes('この端末に保存</span>'),false);
 assert.match(html,/id="save-status"[^>]*hidden/);
 assert.match(manager,/function writeRoot\(candidate,\{edit=true,sync=edit,allowStorageError=false,allowCloudConflict=false,notifySaved=true,success=''\}=\{\}\)/);
 assert.equal(manager.includes("success='この端末に保存しました'"),false);
});


test('state-managerは保存・Undo・競合を一元管理',async()=>{
 const {createStateManager}=await import('../state-manager.js');
 const data=new Map();
 const storage={
  getItem:key=>data.has(key)?data.get(key):null,
  setItem:(key,value)=>data.set(key,value)
 };
 const statuses=[];
 let undoAvailable=false;
 let rollbackCount=0;
 const savedEvents=[];
 const manager=createStateManager({
  storage,
  onStatus:text=>statuses.push(text),
  onUndoChange:value=>{undoAvailable=value;},
  onRollback:()=>{rollbackCount++;},
  onSaved:(_root,meta)=>savedEvents.push(meta)
 });

 const state=manager.getState();
 const originalName=state.store;
 assert.equal(manager.persistChange(()=>{state.store='変更店';}),true);
 assert.equal(manager.getState().store,'変更店');
 assert.equal(undoAvailable,true);
 assert.deepEqual(savedEvents.at(-1),{edit:true,sync:true});

 assert.equal(manager.undoLast().ok,true);
 assert.deepEqual(savedEvents.at(-1),{edit:false,sync:true});
 assert.equal(manager.getState().store,originalName);
 assert.equal(undoAvailable,false);

 manager.handleStorageEvent({key:'shift-ipad-stores-v2'});
 assert.equal(manager.persistChange(()=>{manager.getState().store='競合変更';}),false);
 assert.equal(manager.getState().store,originalName);
 assert.equal(rollbackCount,1);
 assert.match(statuses.at(-1),/安全のため保存を停止/);

 const cloudData=new Map(data);
 const cloudStorage={
  getItem:key=>cloudData.has(key)?cloudData.get(key):null,
  setItem:(key,value)=>cloudData.set(key,value)
 };
 let cloudBlockedMessage='';
 const cloudManager=createStateManager({
  storage:cloudStorage,
  onCloudConflictBlocked:message=>{cloudBlockedMessage=message;}
 });
 const cloudOriginalName=cloudManager.getState().store;
 cloudManager.setCloudConflict();
 assert.equal(cloudManager.persistChange(()=>{cloudManager.getState().store='クラウド競合変更';}),false);
 assert.equal(cloudManager.getState().store,cloudOriginalName);
 assert.match(cloudBlockedMessage,/クラウドの最新データを読み込んでください/);
});

test('state-managerはlocalStorage書き込み失敗時に変更前へ戻す',async()=>{
 const {createStateManager}=await import('../state-manager.js');
 const data=new Map();
 let fail=false;
 const storage={
  getItem:key=>data.has(key)?data.get(key):null,
  setItem:(key,value)=>{if(fail)throw Error('quota');data.set(key,value);}
 };
 let rollbackCount=0;
 const manager=createStateManager({storage,onRollback:()=>{rollbackCount++;}});
 const before=manager.getState().store;
 fail=true;
 assert.equal(manager.persistChange(()=>{manager.getState().store='保存失敗';}),false);
 assert.equal(manager.getState().store,before);
 assert.equal(rollbackCount,1);
});


test('店舗管理UIと店舗切り替えをapp.jsから分離する',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const storeUi=readFileSync(new URL('../store-dialog.js',import.meta.url),'utf8');
 assert.match(app,/import \{createStoreUi\} from '\.\/store-dialog\.js'/);
 assert.equal(app.includes('function openStores(){'),false);
 assert.match(app,/const \{openStores,selectStore\}=createStoreUi\(/);
 assert.match(app,/\$\('#store'\)\.onchange=e=>selectStore\(e\.target\.value\)/);
 assert.match(storeUi,/export function createStoreUi\(/);
 assert.match(storeUi,/function openStores\(\)/);
 assert.match(storeUi,/function selectStore\(id\)/);
 assert.match(storeUi,/同じ店名が登録されています/);
 assert.match(storeUi,/重複しない店名を入力してください/);
});


test('誕生日通知UIをapp.jsから分離する',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const birthdayUi=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 assert.match(app,/import \{createBirthdayUi\} from '\.\/birthday-ui\.js'/);
 assert.equal(app.includes('function renderBirthdays(){'),false);
 assert.match(app,/const \{renderBirthdays\}=createBirthdayUi\(/);
 assert.match(birthdayUi,/export function createBirthdayUi\(/);
 assert.match(birthdayUi,/誕生日のお知らせ/);
 assert.match(birthdayUi,/giftHost\.querySelector\('h2'\)\.textContent='従業員リスト'/);
});

test('従業員リストは生年月日未登録・非表示を含む全在籍者を並べ、入社1年以上だけプレゼント対象にする',async()=>{
 const {birthdayGiftChecklist}=await import('../birthdays.js');
 const root={
  birthdayGiftDelivered:[],
  stores:[{
   id:'s1',store:'店舗A',employees:[
    {id:'e1',name:'対象A',hidden:false,birthDate:'1990-12-01',hireDate:'2025-10-01'},
    {id:'e2',name:'一年未満B',hidden:false,birthDate:'1990-09-01',hireDate:'2025-10-01'},
    {id:'e3',name:'入社日なしC',hidden:false,birthDate:'1990-11-01',hireDate:''},
    {id:'e4',name:'非表示D',hidden:true,birthDate:'1990-08-01',hireDate:'2020-01-01'},
    {id:'e5',name:'生年月日なしE',hidden:false,birthDate:'',hireDate:'2020-01-01'}
   ]
  }]
 };
 const list=birthdayGiftChecklist(root,2026);
 assert.deepEqual(list.map(item=>item.name),['非表示D','一年未満B','入社日なしC','対象A','生年月日なしE']);
 assert.equal(list.find(item=>item.name==='対象A').eligible,true);
 assert.equal(list.find(item=>item.name==='一年未満B').eligible,false);
 assert.equal(list.find(item=>item.name==='入社日なしC').eligibilityReason,'hireDateMissing');
 assert.equal(list.find(item=>item.name==='非表示D').hidden,true);
 assert.equal(list.find(item=>item.name==='非表示D').eligible,true);
 assert.equal(list.find(item=>item.name==='生年月日なしE').eligibilityReason,'birthDateMissing');
 assert.equal(list.find(item=>item.name==='生年月日なしE').birthday,'');

 const target=list.find(item=>item.name==='対象A');
 root.birthdayGiftDelivered=[target.key];
 assert.equal(birthdayGiftChecklist(root,2026).find(item=>item.name==='対象A').delivered,true);
 assert.equal(birthdayGiftChecklist(root,2027).find(item=>item.name==='対象A').delivered,false);
});

test('誕生日プレゼント渡し済み情報を保存データとして検証する',()=>{
 const root=migrate(initialState());
 root.birthdayGiftDelivered=['["first-store","employee-1","2026-12-01"]'];
 root.birthdayGiftDeliveryStores={[root.birthdayGiftDelivered[0]]:{storeId:'first-store',storeName:'A店'}};
 assert.doesNotThrow(()=>validateRoot(root));
 root.birthdayGiftDeliveryStores={[root.birthdayGiftDelivered[0]]:{storeId:123,storeName:'A店'}};
 assert.throws(()=>validateRoot(root));
 root.birthdayGiftDeliveryStores={};
 root.birthdayGiftDelivered=[123];
 assert.throws(()=>validateRoot(root));
});


test('誕生日管理は設定画面へ直接表示せず従業員リストから専用ページを開く',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(html,/<button id="birthday-list">従業員リスト<\/button>/);
 assert.match(html,/<section id="birthday-page"[^>]*hidden/);
 const settingsStart=html.indexOf('<section id="settings-page"');
 const birthdayPageStart=html.indexOf('<section id="birthday-page"');
 const settingsMarkup=html.slice(settingsStart,birthdayPageStart);
 assert.equal(settingsMarkup.includes('id="birthday-gifts"'),false);
 assert.match(app,/\$\('#birthday-list'\)\.onclick=\(\)=>\{location\.hash='birthdays';\}/);
 assert.match(app,/\$\('#birthday-back'\)\.onclick=\(\)=>\{location\.hash='settings';\}/);
});


test('iPad印刷の空白2ページ目を防ぐためA4横1ページ内に固定する',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/@page\{size:A4 landscape;margin:0\}/);
 assert.match(css,/html\{[\s\S]*width:297mm;height:206mm;overflow:hidden/);
 assert.match(css,/body\.print-layout\{[\s\S]*width:297mm;height:206mm[\s\S]*overflow:hidden[\s\S]*padding:8mm/);
 assert.match(css,/page-break-after:avoid/);
 assert.match(css,/page-break-inside:avoid/);
 // シフト表の印刷寸法は維持。
 assert.match(css,/body\.print-layout #schedule tbody tr,body\.print-layout #schedule td\.slot\{height:5\.0mm\}/);
 assert.match(css,/body\.print-layout #schedule td\.employee-slot button\{font-size:9\.5pt!important\}/);
 // 印刷時のセル文字は通常画面と同様に縦中央へ置き、長音・波ダッシュが上寄りにならない。
 assert.match(css,/body\.print-layout #schedule td\.slot button\{[^}]*display:flex[^}]*align-items:center[^}]*justify-content:center/);
 // 印刷プレビューでは用紙の左右に見た目上の余白を確保する。
 assert.match(css,/\.preview-stage\{[^}]*margin:18px 36px 24px/);
});


test('iPad印刷は自動URL・日時用のpage余白をなくしつつv54相当の印刷領域を維持する',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/@page\{size:A4 landscape;margin:0\}/);
 assert.match(css,/body\.print-layout\{[\s\S]*box-sizing:border-box[\s\S]*width:297mm;height:206mm[\s\S]*padding:8mm/);
 assert.doesNotMatch(css,/body\.print-layout\{[^}]*display:flex/);
 assert.match(css,/body\.print-layout main\{[^}]*width:281mm/);
 // シフト表本体の寸法は変更しない。
 assert.match(css,/body\.print-layout #schedule tbody tr,body\.print-layout #schedule td\.slot\{height:5\.0mm\}/);
 assert.match(css,/body\.print-layout #schedule td\.employee-slot button\{font-size:9\.5pt!important\}/);
});


test('印刷時の行高を5.0mmへ広げ、A4横1ページ用の印刷仕様を維持する',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/body\.print-layout #schedule tbody tr,body\.print-layout #schedule td\.slot\{height:5\.0mm\}/);
 assert.match(css,/tbody tr\{height:25px\}/);
});

test('シフト作成ページと設定ページに作業取り消しボタンを表示しない',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/data-undo/);
 assert.doesNotMatch(html,/直前の操作を取り消す/);
 assert.doesNotMatch(html,/取り消しは直前の1回です/);
});

test('印刷出力は左25mm・右15mmの綴じ代を取り、記号位置とヘッダー配置を維持する',()=>{
 const pdf=readFileSync(new URL('../print-pdf.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(pdf,/const PRINT_MARGIN_LEFT_MM=25;/);
 assert.match(pdf,/const PRINT_MARGIN_RIGHT_MM=15;/);
 assert.match(pdf,/const PRINT_WIDTH_MM=PAGE_WIDTH_MM-PRINT_MARGIN_LEFT_MM-PRINT_MARGIN_RIGHT_MM;/);
 assert.match(pdf,/const left=PRINT_MARGIN_LEFT_MM\*canvas\.width\/PAGE_WIDTH_MM;/);
 assert.match(pdf,/const lineMetrics=ctx\.measureText\('国Ag'\)/);
 assert.doesNotMatch(pdf,/ctx\.measureText\(glyph\)/);
 assert.match(css,/@media print\{[\s\S]*body\.print-layout main\{[\s\S]*margin-left:17mm;[\s\S]*transform:scale\(\.9145907473\)/);
 assert.match(css,/body\.print-layout \.paper-header\{[^}]*align-items:flex-end/);
 assert.match(css,/body\.print-layout #store-name\{[^}]*font-size:22pt[^}]*font-weight:700/);
 assert.match(css,/body\.print-layout #paper-period\{[^}]*font-size:10pt/);
 assert.match(app,/margin-left:25mm!important;transform:scale\(\.9145907473\)/);
});


test('週操作と設定の戻る操作を店名右側の共通ヘッダーへ配置する',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const header=html.slice(html.indexOf('<header class="appbar no-print">'),html.indexOf('</header>')+9);
 const shift=html.slice(html.indexOf('<main id="shift-page">'),html.indexOf('</main>')+7);
 const settings=html.slice(html.indexOf('<section id="settings-page"'),html.indexOf('<section id="birthday-page"'));
 assert.match(header,/<select id="store"[^>]*><\/select><\/div><div class="appbar-context">/);
 assert.match(header,/id="header-week-nav"/);
 assert.match(header,/id="prev"/);
 assert.match(header,/id="week-label"/);
 assert.match(header,/id="next"/);
 assert.match(header,/id="today"/);
 assert.match(header,/id="settings-back" hidden/);
 assert.doesNotMatch(shift,/class="controls no-print"/);
 assert.doesNotMatch(settings,/<button id="settings-back"/);
 assert.match(app,/\$\('#header-week-nav'\)\.hidden=subpage/);
 assert.match(app,/\$\('#settings-back'\)\.hidden=!settings/);
});


test('狭い画面でも設定の戻るボタンは店名右側の同じヘッダー行を維持する',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(css,/\.appbar-context\.settings-context\{order:initial;width:auto;overflow:visible/);
 assert.match(app,/classList\.toggle\('settings-context',settings\)/);
});


test('設定ヘッダーの店舗名とシフト表に戻るボタンは同じ44px高で揃える',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/\.appbar \.brand #store\{height:44px;min-height:44px\}/);
 assert.match(css,/\.appbar-context\.settings-context\{height:44px;align-items:center\}/);
 assert.match(css,/\.appbar-context\.settings-context #settings-back\{[\s\S]*height:44px;min-height:44px[\s\S]*display:inline-flex[\s\S]*align-items:center/);
});


test('スマホ版だけ週の日付表示を非表示にする',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/@media\(max-width:700px\)\{[\s\S]*\.appbar-context #week-label\{display:none\}/);
 assert.match(css,/\.appbar-context #week-label\{white-space:nowrap;font-size:14px;color:var\(--ui-ink\)\}/);
});


test('印刷シフト表左上の店舗名を22ptで強調する',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/body\.print-layout #store-name\{[^}]*font-size:22pt[^}]*font-weight:700[^}]*line-height:1/);
 assert.match(css,/body\.print-layout #paper-period\{[^}]*font-size:10pt/);
 assert.match(css,/body\.print-layout \.paper-header\{[^}]*align-items:flex-end/);
});


test('印刷時の従業員名と時間は9.5ptを基準にする',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/body\.print-layout #schedule td\.employee-slot button\{font-size:9\.5pt!important\}/);
 assert.doesNotMatch(css,/\.employee-time\{font-size:/);
 assert.doesNotMatch(css,/body\.print-layout #schedule td\.employee-slot \.long\{font-size:7\.4pt!important\}/);
});

test('従業員リストは選択中の店舗の従業員だけを表示する',()=>{
 const birthdayUi=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 assert.match(birthdayUi,/birthdayGiftChecklist\(root,year\)\.filter\(entry=>entry\.storeId===root\.activeStoreId\)/);
});


test('iPadの従業員日付入力だけ独自カレンダーを使い、PC・iPhoneのtype=dateを維持する',()=>{
 const employee=readFileSync(new URL('../employee-dialog.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(employee,/function isIPadDevice\(\)/);
 assert.match(employee,/\/iPad\/i\.test\(navigator\.userAgent/);
 assert.match(employee,/navigator\.platform\|\|''\)===\'MacIntel\'/);
 assert.match(employee,/const hired=el\('input',\{type:'date'/);
 assert.match(employee,/const birth=el\('input',\{type:'date'/);
 assert.match(employee,/const hiredControl=iPad\?ipadDateControl\(hired,'入社年月日'\):hired/);
 assert.match(employee,/const birthControl=iPad\?ipadDateControl\(birth,'生年月日'\):birth/);
 assert.match(css,/\.ipad-date-picker\{[\s\S]*grid-template-rows:auto minmax\(0,1fr\) auto/);
 assert.match(css,/\.ipad-date-picker-actions\{[\s\S]*border-top/);
});


test('店舗単位バックアップは選択店舗とその誕生日情報だけを含み、全店舗形式と旧形式を区別する',()=>{
 const root=migrate(),first=root.stores[0],second=newStore('駅前店',first.current,'second');
 root.stores.push(second);
 root.birthdayAcknowledgements=[
  JSON.stringify([first.id,first.employees[0].id,'2026-10-01']),
  JSON.stringify([second.id,'x','2026-11-01'])
 ];
 root.birthdayGiftDelivered=[
  JSON.stringify([first.id,first.employees[0].id,'2026-10-01']),
  JSON.stringify([second.id,'x','2026-11-01'])
 ];
 const one=parseBackupInfo(backupText(root,{scope:'store',storeId:first.id,exportedAt:'2026-09-27T00:00:00.000Z'}));
 assert.equal(one.scope,'store');
 assert.equal(one.data.stores.length,1);
 assert.equal(one.data.stores[0].id,first.id);
 assert.equal(one.data.birthdayAcknowledgements.length,1);
 assert.equal(one.data.birthdayGiftDelivered.length,1);
 const all=parseBackupInfo(backupText(root,{scope:'all',exportedAt:'2026-09-27T00:00:00.000Z'}));
 assert.equal(all.scope,'all');
 assert.equal(all.data.stores.length,2);
 const legacy=parseBackupInfo(JSON.stringify({format:'shift-ipad-backup',version:1,data:root}));
 assert.equal(legacy.scope,'all');
});

test('店舗単位復元は選択中店舗だけを置き換え他店舗と他店舗の誕生日情報を保持する',()=>{
 const root=migrate(),first=root.stores[0],second=newStore('駅前店',first.current,'second');
 root.stores.push(second);
 root.activeStoreId=first.id;
 second.weeks[second.current].days[0].notes='他店舗保持';
 root.birthdayAcknowledgements=[JSON.stringify([second.id,'x','2026-11-01'])];
 root.birthdayGiftDelivered=[JSON.stringify([second.id,'x','2026-11-01'])];

 const source=structuredClone(root);
 source.stores=[structuredClone(first)];
 source.activeStoreId=first.id;
 source.stores[0].store='復元店舗名';
 source.stores[0].weeks[source.stores[0].current].days[0].notes='店舗復元成功';
 source.birthdayAcknowledgements=[JSON.stringify([first.id,first.employees[0].id,'2026-10-01'])];
 source.birthdayGiftDelivered=[JSON.stringify([first.id,first.employees[0].id,'2026-10-01'])];

 const merged=mergeStoreBackup(root,source);
 assert.equal(merged.stores.find(s=>s.id===first.id).store,'復元店舗名');
 assert.equal(merged.stores.find(s=>s.id===first.id).weeks[first.current].days[0].notes,'店舗復元成功');
 assert.equal(merged.stores.find(s=>s.id===second.id).weeks[second.current].days[0].notes,'他店舗保持');
 assert.equal(merged.birthdayAcknowledgements.some(k=>JSON.parse(k)[0]===second.id),true);
 assert.equal(merged.birthdayGiftDelivered.some(k=>JSON.parse(k)[0]===second.id),true);
});

test('店舗バックアップのファイル名に店舗名を含め、全店舗ファイル名は従来表記を維持する',()=>{
 const backup=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 assert.match(backup,/シフト_\$\{safeFilenamePart\(currentStore\.store\)\}_\$\{stamp\}\.shiftbackup\.json/);
 assert.match(backup,/シフト全店舗_\$\{stamp\}\.shiftbackup\.json/);
 assert.match(backup,/この店舗をバックアップ/);
 assert.match(backup,/全店舗をバックアップ/);
 assert.match(backup,/この店舗に復元/);
 assert.match(backup,/確認したバックアップで全店舗を復元/);
});


test('復元用ファイル選択はiPadでshiftbackupを選べるようaccept制限を設けない',()=>{
 const backup=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 assert.match(backup,/const file=el\('input',\{type:'file'\}\);/);
 assert.doesNotMatch(backup,/accept:'\.shiftbackup/);
});


test('iPhoneで選択しやすいよう新規バックアップはjson拡張子で保存する',()=>{
 const backup=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 assert.match(backup,/\.shiftbackup\.json/);
 assert.doesNotMatch(backup,/\.shiftbackup`/);
});


test('iPadのトレーニング編集は従業員変更に余白を設け保存と削除を右下横並びにする',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(app,/band=bands\[b\],ipad=isIpad\(\)/);
 assert.match(app,/if\(ipad\)change\.classList\.add\('training-employee-change'\)/);
 assert.match(app,/const actions=el\('div',\{class:'extra-ipad-actions'\}\)/);
 assert.match(app,/actions\.append\(save\)/);
 assert.match(app,/if\(existing\?\.type==='training'&&remove\)actions\.append\(remove\)/);
 assert.match(css,/\.training-employee-change\{margin-top:18px\}/);
 assert.match(css,/\.extra-ipad-actions\{[\s\S]*display:flex;[\s\S]*justify-content:flex-end;[\s\S]*gap:10px;[\s\S]*margin-top:24px/);
});

function sharedEmployeesFixture(){
 const root=migrate();
 const first=root.stores[0];
 first.employees[0].name='山田';
 first.employees[0].birthDate='1990-10-01';
 first.employees[0].hireDate='2020-01-01';
 const second=newStore('二号店',first.current,'second');
 second.employees=[{id:'local-2',name:'山田',birthDate:'1990-10-01',hireDate:'2020-01-01',hidden:false}];
 root.stores.push(second);
 return {root,first,second,employee:first.employees[0],other:second.employees[0]};
}

test('同名の別人は自動連携せず、明示的連携で誕生日とクオカードを共通化する',()=>{
 const {root,first,second,employee,other}=sharedEmployeesFixture();
 const before=birthdayNotices(root,'2026-09-27');
 assert.equal(before.filter(n=>n.name==='山田').length,2);
 const legacy=JSON.stringify([second.id,other.id,'2026-10-01']);
 root.birthdayGiftDelivered=[legacy];
 root.birthdayAcknowledgements=[legacy];
 linkEmployees(root,first.id,employee.id,second.id,other.id);
 validateRoot(root);
 assert.equal(employee.sharedId,other.sharedId);
 assert.equal(birthdayNotices(root,'2026-09-27').filter(n=>n.name==='山田').length,0);
 const gifts=birthdayGiftChecklist(root,2026).filter(n=>n.name==='山田');
 assert.equal(gifts.length,2);
 assert.equal(gifts[0].key,gifts[1].key);
 assert.equal(gifts.every(n=>n.delivered),true);
 assert.equal(first.weeks[first.current].days[0].shifts[0][0].name,'従業員A');
});

test('共通プロフィールの変更と連携解除は店舗固有の番号と過去のシフトを保つ',()=>{
 const {root,first,second,employee,other}=sharedEmployeesFixture();
 employee.employeeNumber='001';other.employeeNumber='002';
 employee.hireDate='2020-02-01';other.hireDate='2026-01-01';
 linkEmployees(root,first.id,employee.id,second.id,other.id);
 assert.equal(employee.hireDate,'2020-02-01');
 assert.equal(other.hireDate,'2026-01-01');
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.employeeId===other.id).eligible,true);
 const oldKey=birthdayGiftChecklist(root,2026).find(n=>n.employeeId===employee.id).key;
 root.birthdayGiftDelivered=[oldKey];
 updateBirthdayKeys(root,employee,'1990-11-01');
 employee.birthDate='1990-11-01';employee.name='山田 改';employee.hireDate='2021-03-01';
 syncEmployeeProfile(root,employee);
 assert.equal(other.birthDate,'1990-11-01');
 assert.equal(other.name,'山田 改');
 assert.equal(other.employeeNumber,'002');
 assert.equal(employee.employeeNumber,'001');
 assert.equal(employee.hireDate,'2021-03-01');
 assert.equal(other.hireDate,'2026-01-01');
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.employeeId===employee.id).delivered,true);
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.employeeId===other.id).delivered,true);
 unlinkEmployee(root,first.id,employee.id);
 assert.equal(employee.sharedId,undefined);
 assert.equal(other.sharedId!==undefined,true);
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.employeeId===employee.id).delivered,true);
 assert.equal(other.hireDate,'2026-01-01');
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.employeeId===other.id).eligible,false);
 assert.equal(first.weeks[first.current].days[0].shifts[0][0].name,'従業員A');
});

test('連携先の一店舗が勤続1年以上なら各店舗でQUOカードをチェックできる',()=>{
 const {root,first,second,employee,other}=sharedEmployeesFixture();
 employee.hireDate='2020-01-01';other.hireDate='2026-01-01';
 linkEmployees(root,first.id,employee.id,second.id,other.id);
 let entries=birthdayGiftChecklist(root,2026).filter(n=>n.name==='山田');
 assert.equal(entries.length,2);
 assert.equal(entries.every(n=>n.eligible),true);
 assert.equal(entries[0].key,entries[1].key);
 root.birthdayGiftDelivered=[entries[0].key];
 entries=birthdayGiftChecklist(root,2026).filter(n=>n.name==='山田');
 assert.equal(entries.every(n=>n.delivered),true);
 other.hireDate='';
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.employeeId===other.id).delivered,true);
 employee.hireDate='2026-01-01';
 assert.equal(birthdayGiftChecklist(root,2026).filter(n=>n.name==='山田').every(n=>!n.eligible&&!n.delivered),true);
});

test('店舗バックアップは連携情報を保ち、無関係な店舗への復元で誤連携しない',()=>{
 const {root,first,second,employee,other}=sharedEmployeesFixture();
 linkEmployees(root,first.id,employee.id,second.id,other.id);
 const key=birthdayGiftChecklist(root,2026).find(n=>n.employeeId===employee.id).key;
 root.birthdayGiftDelivered=[key];
 const backup=parseBackup(backupText(root,{scope:'store',storeId:first.id}));
 assert.deepEqual(backup.birthdayGiftDelivered,[key]);
 const restored=mergeStoreBackup(root,backup);
 assert.equal(restored.stores[0].employees[0].sharedId,other.sharedId);
 assert.equal(restored.birthdayGiftDelivered.includes(key),true);
 const different=structuredClone(root);
 different.stores[0].employees[0].id='unrelated-person';
 const safe=mergeStoreBackup(different,backup);
 assert.notEqual(safe.stores[0].employees[0].sharedId,other.sharedId);
 assert.equal(safe.birthdayGiftDelivered.some(k=>JSON.parse(k)[1]===safe.stores[0].employees[0].sharedId),true);
});

test('QUOカードを渡した店舗を保持し、連携・誕生日変更・解除・店舗復元でも追跡する',()=>{
 const {root,first,second,employee,other}=sharedEmployeesFixture();
 const legacy=JSON.stringify([first.id,employee.id,'2026-10-01']);
 root.birthdayGiftDelivered=[legacy];
 root.birthdayGiftDeliveryStores={[legacy]:{storeId:first.id,storeName:first.store}};
 linkEmployees(root,first.id,employee.id,second.id,other.id);
 let entries=birthdayGiftChecklist(root,2026).filter(n=>n.name==='山田');
 assert.equal(entries.every(n=>n.deliveredByStoreName===first.store),true);
 const backup=parseBackup(backupText(root,{scope:'store',storeId:first.id}));
 assert.equal(backup.birthdayGiftDeliveryStores[entries[0].key].storeId,first.id);
 const restored=mergeStoreBackup(root,backup);
 assert.equal(birthdayGiftChecklist(restored,2026).find(n=>n.storeId===second.id).deliveredByStoreName,first.store);
 updateBirthdayKeys(root,employee,'1990-11-01');
 employee.birthDate='1990-11-01';syncEmployeeProfile(root,employee);
 entries=birthdayGiftChecklist(root,2026).filter(n=>n.name==='山田');
 assert.equal(entries.every(n=>n.delivered&&n.deliveredByStoreId===first.id),true);
 unlinkEmployee(root,first.id,employee.id);
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.storeId===first.id).deliveredByStoreName,first.store);
 assert.equal(birthdayGiftChecklist(root,2026).find(n=>n.storeId===second.id).deliveredByStoreName,first.store);
 const older=structuredClone(root);
 delete older.birthdayGiftDeliveryStores;
 assert.equal(birthdayGiftChecklist(older,2026).find(n=>n.storeId===first.id).deliveredByStoreName,'');
});


test('スマホ通常画面ではシフト内の薄い横罫線を1pxで明示表示する',()=>{
 const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/@media screen and \(max-width:600px\), screen and \(orientation:landscape\) and \(max-height:500px\) and \(max-width:950px\) and \(pointer:coarse\)\{[\s\S]*#schedule tbody tr:nth-child\(5n\+2\)>td\.slot,[\s\S]*#schedule tbody tr:nth-child\(5n\+3\)>td\.slot,[\s\S]*#schedule tbody tr:nth-child\(5n\+4\)>td\.slot\{[\s\S]*border-top:1px solid #bbb/);
});


test('退職日は最終在籍日として扱い翌日から退職者になる',()=>{
 const employee={retirementDate:'2026-10-31'};
 assert.equal(employeeAvailableOn(employee,'2026-10-30'),true);
 assert.equal(employeeAvailableOn(employee,'2026-10-31'),true);
 assert.equal(employeeAvailableOn(employee,'2026-11-01'),false);
 assert.equal(employeeRetiredBy(employee,'2026-10-30'),false);
 assert.equal(employeeRetiredBy(employee,'2026-10-31'),false);
 assert.equal(employeeRetiredBy(employee,'2026-11-01'),true);
});

test('翌週コピーでは退職日を過ぎた従業員だけ除外し既存週は保持する',()=>{
 const root=migrate(),state=root.stores[0],employee=state.employees[0];
 const sourceKey=state.current;
 const source=state.weeks[sourceKey];
 source.days[0].shifts[0][0]=makeShift(employee,0);
 employee.retirementDate=addDays(source.days[0].date,7);
 const nextKey=addDays(sourceKey,7);
 ensureWeek(state,nextKey);
 assert.equal(state.weeks[nextKey].days[0].shifts[0][0]?.employeeId,employee.id);
 assert.equal(source.days[0].shifts[0][0]?.employeeId,employee.id);
 const laterKey=addDays(nextKey,7);
 ensureWeek(state,laterKey);
 assert.equal(state.weeks[laterKey].days[0].shifts[0][0],null);
 assert.equal(state.weeks[nextKey].days[0].shifts[0][0]?.employeeId,employee.id);
});

test('従業員編集は退職日を店舗固有情報として保存し従業員リストに在籍者と退職者タブを持つ',()=>{
 const employeeUi=readFileSync(new URL('../employee-dialog.js',import.meta.url),'utf8');
 const birthdayUi=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(employeeUi,/const retirement=el\('input',\{type:'date',value:employee\?\.retirementDate\|\|''\}\)/);
 assert.match(employeeUi,/field\('退職日',retirementControl\)/);
 assert.match(employeeUi,/従業員番号・入社年月日・退職日は店舗ごとに管理します/);
 assert.match(employeeUi,/retirementDate:retirement\.value/);
 assert.match(birthdayUi,/employeeRetiredBy\(employee,today\)/);
 assert.match(birthdayUi,/entry\.retirementDate>=today/);
 assert.match(html,/id="employee-active-tab"[^>]*>在籍者<\/button>/);
 assert.match(html,/id="employee-retired-tab"[^>]*>退職者<\/button>/);
});


test('作成済み週へ前週の従業員3段だけを明示的に再コピーできる',()=>{
 const s=initialState(),source=s.current,next=addDays(source,7);
 ensureWeek(s,next);
 const target=s.weeks[next];
 target.days[0].shifts[0][0]=null;
 target.days[0].extras[0]={type:'task',text:'残す',start:360,end:540};
 target.days[0].notes='残す備考';
 s.weeks[source].days[0].shifts[0][0]=makeShift(s.employees[2],0);
 assert.equal(copyPreviousWeekEmployeeShifts(s,next),true);
 assert.equal(target.days[0].shifts[0][0].employeeId,s.employees[2].id);
 assert.equal(target.days[0].extras[0].text,'残す');
 assert.equal(target.days[0].notes,'残す備考');
});

test('明示的な前週コピーでも退職日を過ぎた従業員は除外する',()=>{
 const s=initialState(),employee=s.employees[0],next=addDays(s.current,7);
 ensureWeek(s,next);
 employee.retirementDate=addDays(s.current,6);
 assert.equal(copyPreviousWeekEmployeeShifts(s,next),true);
 assert.equal(s.weeks[next].days[0].shifts[0][0],null);
});

test('前週コピー用ボタンと上書き確認を備え、5段目と備考を変更しない説明を表示する',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(html,/id="today"[\s\S]*id="copy-week"[^>]*aria-label="前週シフトをコピー"[\s\S]*前週シフトをコピー/);
 assert.match(app,/現在週の従業員①・②・予備従業員のシフトを、前週の内容で上書きします。不定期作業／トレーニングと備考は変更しません。コピーしますか？/);
 assert.match(app,/copyPreviousWeekEmployeeShifts\(state,state\.current\)/);
});


test('削除済み従業員は前週コピーで新しい週へ引き継がない',()=>{
 const s=initialState(),employee=s.employees[0],next=addDays(s.current,7);
 assert.equal(s.weeks[s.current].days[0].shifts[0][0]?.employeeId,employee.id);
 s.employees=s.employees.filter(item=>item.id!==employee.id);
 assert.equal(ensureWeek(s,next),true);
 assert.equal(s.weeks[next].days[0].shifts[0][0],null);
 assert.equal(s.weeks[s.current].days[0].shifts[0][0]?.employeeId,employee.id);
});


test('通常シフトの在籍判定は入社日から退職日までを対象にする',()=>{
 const employee={hireDate:'2026-10-10',retirementDate:'2026-10-31'};
 assert.equal(employeeAvailableOn(employee,'2026-10-09'),false);
 assert.equal(employeeAvailableOn(employee,'2026-10-10'),true);
 assert.equal(employeeAvailableOn(employee,'2026-10-31'),true);
 assert.equal(employeeAvailableOn(employee,'2026-11-01'),false);
 assert.equal(employeeAvailableOn({hireDate:'',retirementDate:''},'2026-10-01'),true);
});

test('前週コピーでは入社日前の従業員も新しい週から除外する',()=>{
 const s=initialState(),employee=s.employees[0],next=addDays(s.current,7);
 employee.hireDate=addDays(next,1);
 assert.equal(ensureWeek(s,next),true);
 assert.equal(s.weeks[next].days[0].shifts[0][0],null);
 assert.equal(s.weeks[next].days[1].shifts[0][0]?.employeeId,employee.id);
});


test('退職後または入社前の既存勤務は編集画面から再保存できない',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const message='この従業員はこの日には在籍していないため保存できません。';
 assert.equal((app.match(new RegExp(message,'g'))||[]).length,2);
 assert.match(app,/employees\.find\(item=>item\.id===candidate\.employeeId\);if\(!employee\|\|!employeeAvailableOn\(employee,week\(\)\.days\[d\]\.date\)\)/);
 assert.match(app,/employees\.find\(item=>item\.id===draft\.employeeId\);if\(!employee\|\|!employeeAvailableOn\(employee,week\(\)\.days\[d\]\.date\)\)/);
});


test('在籍者UIは生年月日未登録と非表示状態を明示する',()=>{
 const ui=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 assert.match(ui,/entry\.birthday\?[^:]+:'—'/);
 assert.match(ui,/birthDateMissing'\?'生年月日未登録'/);
 assert.match(ui,/if\(entry\.hidden\)statusText\+='／非表示'/);
 assert.match(ui,/'在籍者はいません。'/);
});


test('退職予定者は誕生日当日に在籍する場合だけ通知する',()=>{
 const r=birthdayRoot(),e=r.stores[0].employees[0];
 e.retirementDate='2026-09-30';
 assert.equal(birthdayNotices(r,'2026-09-24').length,0);
 e.retirementDate='2026-10-01';
 assert.equal(birthdayNotices(r,'2026-09-24')[0].birthday,'2026-10-01');
});

test('QUOカード対象は誕生日当日の在籍状態も判定する',()=>{
 const r=birthdayRoot(),e=r.stores[0].employees[0];
 e.retirementDate='2026-09-30';
 let entry=birthdayGiftChecklist(r,2026,'2026-09-24').find(item=>item.employeeId===e.id);
 assert.equal(entry.eligible,false);
 assert.equal(entry.eligibilityReason,'notEmployedOnBirthday');
 e.retirementDate='2026-10-01';
 entry=birthdayGiftChecklist(r,2026,'2026-09-24').find(item=>item.employeeId===e.id);
 assert.equal(entry.eligible,true);
});

test('従業員リストは誕生日当日に在籍しない予定者を明示する',()=>{
 const ui=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 assert.match(ui,/notEmployedOnBirthday'\?'誕生日当日は在籍対象外'/);
});


test('バックアップの平文10MB・暗号化15MB制限を作成と復元で共通化する',()=>{
 assert.equal(MAX_BACKUP_PLAIN_BYTES,10000000);
 assert.equal(MAX_ENCRYPTED_BACKUP_BYTES,15000000);
 assert.throws(()=>parseBackupInfo('x'.repeat(MAX_BACKUP_PLAIN_BYTES+1)),/10MB以下/);
 const backupUi=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 assert.match(backupUi,/selected\.size>MAX_ENCRYPTED_BACKUP_BYTES/);
 const cryptoSource=readFileSync(new URL('../crypto-backup.js',import.meta.url),'utf8');
 assert.match(cryptoSource,/encoder\.encode\(text\)\.byteLength>MAX_ENCRYPTED_BACKUP_BYTES/);
});


test('長期保存容量は4MBから警告し過去週を自動削除しない',()=>{
 assert.equal(STORAGE_WARNING_BYTES,4000000);
 assert.equal(utf8Bytes('あ'),3);
 const manager=readFileSync(new URL('../state-manager.js',import.meta.url),'utf8');
 assert.match(manager,/utf8Bytes\(next\)>=STORAGE_WARNING_BYTES/);
 assert.match(manager,/過去週は自動削除しません/);
 const backupUi=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 assert.match(backupUi,/現在の保存データ：約/);
 assert.match(backupUi,/storageBytes>=STORAGE_WARNING_BYTES/);
});

test('CSPはスクリプトを同一オリジンに制限し既存の動的スタイルを許可する',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/http-equiv="Content-Security-Policy"/);
 assert.match(html,/script-src 'self'/);
 assert.match(html,/style-src 'self' 'unsafe-inline'/);
 assert.match(html,/object-src 'none'/);
 assert.match(html,/worker-src 'self'/);
 assert.match(html,/connect-src 'self' blob:/);
});

test('Cloudflare Pages用のセキュリティヘッダーを維持する',()=>{
 const headers=readFileSync(new URL('../_headers',import.meta.url),'utf8');
 assert.match(headers,/Content-Security-Policy: .*script-src 'self'/);
 assert.match(headers,/connect-src 'self' blob:/);
 assert.match(headers,/frame-ancestors 'none'/);
 assert.match(headers,/X-Frame-Options: DENY/);
 assert.match(headers,/X-Robots-Tag: noindex/);
});

test('Supabase共有設定はpublishable keyのみを公開する',()=>{
 const config=readFileSync(new URL('../supabase-config.js',import.meta.url),'utf8');
 const index=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const headers=readFileSync(new URL('../_headers',import.meta.url),'utf8');
 assert.match(config,/sb_publishable_/);
 assert.doesNotMatch(config,/service_role|sb_secret_/);
 assert.match(index,/connect-src[^"]*wpyhkewwzsdcstypcbmq\.supabase\.co/);
 assert.match(headers,/connect-src[^\n]*wpyhkewwzsdcstypcbmq\.supabase\.co/);
});


test('Undo対象外の共有データ変更と端末UI操作でクラウド同期対象を分離する',async()=>{
 const {createStateManager}=await import('../state-manager.js');
 const data=new Map();
 const events=[];
 const storage={
  getItem:key=>data.has(key)?data.get(key):null,
  setItem:(key,value)=>data.set(key,value)
 };
 const manager=createStateManager({storage,onSaved:(_root,meta)=>events.push(meta)});

 assert.equal(manager.persistChange(()=>{manager.getState().store='同期する変更';},false,true),true);
 assert.deepEqual(events.at(-1),{edit:false,sync:true});

 assert.equal(manager.persistChange(()=>{manager.getState().current=manager.getState().current;},false,false),true);
 assert.deepEqual(events.at(-1),{edit:false,sync:false});

 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const backup=readFileSync(new URL('../backup-dialog.js',import.meta.url),'utf8');
 const birthdays=readFileSync(new URL('../birthday-ui.js',import.meta.url),'utf8');
 const stores=readFileSync(new URL('../store-dialog.js',import.meta.url),'utf8');

 assert.match(app,/onSaved:\(root,\{sync\}\)=>\{if\(sync\)cloudSync\?\.queueSave\(root\);\}/);
 assert.match(app,/persistChange\(\(\)=>\{copied=copyPreviousWeekEmployeeShifts\(state,state\.current\);\}\s*,false,true\)/);
 assert.match(app,/persistChange\(\(\)=>\{copied=ensureWeek\(state,next\);state\.current=next;\},false,!existed\)/);
 assert.match(backup,/edit:false,sync:true,allowStorageError:true/);
 assert.match(birthdays,/edit:false,sync:true,success:'誕生日の確認済みを保存しました'/);
 assert.match(stores,/persistChange\(\(\)=>\{[\s\S]*activeStoreId=id;[\s\S]*\},false\)/);
});


test('複数端末共有は端末を最初の管理者アカウントへ固定する',()=>{
 const cloud=readFileSync(new URL('../cloud-sync.js',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(cloud,/const OWNER_KEY='shift-supabase-owner-v1'/);
 assert.match(cloud,/function bindOrVerifyOwner\(userId\)/);
 assert.match(cloud,/既存のシフトデータ保護のため、別アカウントではログインできません/);
 assert.match(cloud,/await rejectForeignSession\(data\);throw error/);
 assert.match(app,/クラウド同期からログアウト/);
 assert.match(app,/管理者アカウントの紐付けは保持されます/);
});
