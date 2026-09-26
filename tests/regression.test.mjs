import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
if(!globalThis.btoa)globalThis.btoa=value=>Buffer.from(value,'binary').toString('base64');
if(!globalThis.atob)globalThis.atob=value=>Buffer.from(value,'base64').toString('binary');

import {
  initialState,ensureWeek,addDays,monday,shiftLabel,workingTimes,dayInfo,makeShift,
  employeeShiftName,employeeShiftConflicts,fixedSetting,fixedTextAt,timedTextLabel,bands
} from '../model.js';
import {migrate,newStore,validateRoot,backupText,parseBackup} from '../stores.js';
import {birthdayNotices,japanToday} from '../birthdays.js';
import {
  encryptBackupText,decryptBackupText,encryptedBackupInfo,isEncryptedBackupText
} from '../crypto-backup.js';

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
 assert.match(manager,/if\(save\(edit\)\)return true/);
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
 assert.match(manager,/function save\(edit=true\)/);
 assert.match(manager,/replaceRoot\(candidate,\{edit:false,success:'直前の操作を取り消しました'\}\)/);
 assert.match(birthdayUi,/replaceRoot\(candidate,\{edit:false,success:'誕生日の確認済みを保存しました'\}\)/);
 assert.match(backup,/replaceRoot\(candidate,\{edit:false,allowStorageError:true,success:'全店舗を復元しました'\}\)/);
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
 assert.match(manager,/function writeRoot\(candidate,\{edit=true,allowStorageError=false,success=''\}=\{\}\)/);
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
 const manager=createStateManager({
  storage,
  onStatus:text=>statuses.push(text),
  onUndoChange:value=>{undoAvailable=value;},
  onRollback:()=>{rollbackCount++;}
 });

 const state=manager.getState();
 const originalName=state.store;
 assert.equal(manager.persistChange(()=>{state.store='変更店';}),true);
 assert.equal(manager.getState().store,'変更店');
 assert.equal(undoAvailable,true);

 assert.equal(manager.undoLast().ok,true);
 assert.equal(manager.getState().store,originalName);
 assert.equal(undoAvailable,false);

 manager.handleStorageEvent({key:'shift-ipad-stores-v2'});
 assert.equal(manager.persistChange(()=>{manager.getState().store='競合変更';}),false);
 assert.equal(manager.getState().store,originalName);
 assert.equal(rollbackCount,1);
 assert.match(statuses.at(-1),/安全のため保存を停止/);
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

test('誕生日リストは表示中従業員を並べ、入社1年以上だけプレゼント対象にする',async()=>{
 const {birthdayGiftChecklist}=await import('../birthdays.js');
 const root={
  birthdayGiftDelivered:[],
  stores:[{
   id:'s1',store:'店舗A',employees:[
    {id:'e1',name:'対象A',hidden:false,birthDate:'1990-12-01',hireDate:'2025-10-01'},
    {id:'e2',name:'一年未満B',hidden:false,birthDate:'1990-09-01',hireDate:'2025-10-01'},
    {id:'e3',name:'入社日なしC',hidden:false,birthDate:'1990-11-01',hireDate:''},
    {id:'e4',name:'非表示D',hidden:true,birthDate:'1990-08-01',hireDate:'2020-01-01'}
   ]
  }]
 };
 const list=birthdayGiftChecklist(root,2026);
 assert.deepEqual(list.map(item=>item.name),['一年未満B','入社日なしC','対象A']);
 assert.equal(list.find(item=>item.name==='対象A').eligible,true);
 assert.equal(list.find(item=>item.name==='一年未満B').eligible,false);
 assert.equal(list.find(item=>item.name==='入社日なしC').eligibilityReason,'hireDateMissing');

 const target=list.find(item=>item.name==='対象A');
 root.birthdayGiftDelivered=[target.key];
 assert.equal(birthdayGiftChecklist(root,2026).find(item=>item.name==='対象A').delivered,true);
 assert.equal(birthdayGiftChecklist(root,2027).find(item=>item.name==='対象A').delivered,false);
});

test('誕生日プレゼント渡し済み情報を保存データとして検証する',()=>{
 const root=migrate(initialState());
 root.birthdayGiftDelivered=['["first-store","employee-1","2026-12-01"]'];
 assert.doesNotThrow(()=>validateRoot(root));
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
 assert.match(css,/body\.print-layout \.paper-header\{[^}]*align-items:baseline/);
 assert.match(css,/body\.print-layout #store-name\{[^}]*font-size:18pt[^}]*font-weight:700/);
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
