import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
if(!globalThis.btoa)globalThis.btoa=value=>Buffer.from(value,'binary').toString('base64');
if(!globalThis.atob)globalThis.atob=value=>Buffer.from(value,'base64').toString('binary');

import {
  initialState,ensureWeek,addDays,monday,shiftLabel,workingTimes,dayInfo,makeShift,
  employeeShiftName,fixedSetting,fixedTextAt,timedTextLabel,bands
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
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(app,/function persistChange\(/);
 assert.match(app,/const before=JSON\.stringify\(root\)/);
 assert.match(app,/root=JSON\.parse\(before\)/);
 assert.match(app,/if\(save\(edit\)\)return true/);
});

test('iPhone印刷後の画面復帰処理を維持',()=>{
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

test('別タブ更新を検知したら保存を停止する',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(app,/addEventListener\('storage'/);
 assert.match(app,/externalChangeDetected/);
 assert.match(app,/安全のため保存を停止しています/);
});
