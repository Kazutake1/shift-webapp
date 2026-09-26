import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {holidays,holidayYears} from '../holidays.js';

const officialUrl='https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const requiredNames=['元日','成人の日','建国記念の日','天皇誕生日','春分の日','昭和の日','憲法記念日','みどりの日','こどもの日','海の日','山の日','敬老の日','秋分の日','スポーツの日','文化の日','勤労感謝の日'];

function columns(line){
 const cells=[];let cell='',quoted=false;
 for(let i=0;i<line.length;i++){
  const char=line[i];
  if(char==='"'&&quoted&&line[i+1]==='"'){cell+='"';i++;}
  else if(char==='"')quoted=!quoted;
  else if(char===','&&!quoted){cells.push(cell);cell='';}
  else cell+=char;
 }
 if(quoted)throw new Error('祝日CSVの引用符が閉じていません');
 cells.push(cell);
 return cells.map(value=>value.trim());
}

export function parseOfficialCsv(csv){
 const years=new Map();
 for(const line of csv.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!line.trim())continue;
  const [rawDate,name]=columns(line),match=/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(rawDate);
  if(!match)continue; // 見出し
  const [,rawYear,rawMonth,rawDay]=match,year=Number(rawYear),month=Number(rawMonth),day=Number(rawDay);
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||!name)throw new Error(`祝日CSVの不正な日付: ${rawDate}`);
  if(year<2026)continue;
  const key=`${rawYear}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if(!years.has(year))years.set(year,new Map());
  if(years.get(year).has(key))throw new Error(`祝日CSVの日付が重複: ${key}`);
  years.get(year).set(key,name);
 }
 return years;
}

function normalized(name){return ['振替休日','国民の休日'].includes(name)?'休日':name;}

export function generateHolidays(csv){
 const official=parseOfficialCsv(csv),lastYear=Math.max(...holidayYears);
 if(!official.has(lastYear))throw new Error(`収録済みの${lastYear}年が公式CSVにありません`);
 const years=[...official.keys()].filter(year=>year>=holidayYears[0]).sort((a,b)=>a-b);
 for(let year=holidayYears[0];year<=Math.max(...years);year++){
  const entries=official.get(year);
  if(!entries)throw new Error(`${year}年の祝日データがありません`);
  const names=new Set(entries.values());
  if(requiredNames.some(name=>!names.has(name)))throw new Error(`${year}年の公式祝日が未公表または不完全です`);
 }
 for(const [date,name] of Object.entries(holidays)){
  const officialName=official.get(Number(date.slice(0,4)))?.get(date);
  if(!officialName||normalized(name)!==normalized(officialName))throw new Error(`既存の祝日と公式データが異なります: ${date}（${name} → ${officialName||'削除'}）`);
 }
 const result={};
 for(const year of years){
  for(const [date,name] of [...official.get(year)].sort(([a],[b])=>a.localeCompare(b))){
   // 既存の振替休日・国民の休日の名称は維持する。新規日付は公式の「休日」を用いる。
   result[date]=holidays[date]||name;
  }
 }
 const content=`// 出典: 内閣府「国民の祝日について」 ${officialUrl}\n// 公式CSVに公表済みの年だけを収録。scripts/update-holidays.mjs で更新。\nexport const holidayYears = ${JSON.stringify(years)};\nexport const holidays = Object.freeze(${JSON.stringify(result,null,2)});\n`;
 return {content,years};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const input=process.argv[2];
 if(!input)throw new Error('使い方: node scripts/update-holidays.mjs /tmp/syukujitsu.csv');
 const csv=new TextDecoder('shift_jis',{fatal:true}).decode(readFileSync(input));
 const {content,years}=generateHolidays(csv);
 const filename=fileURLToPath(new URL('../holidays.js',import.meta.url));
 const old=readFileSync(filename,'utf8');
 // 初回は生成形式に揃える。以後、公式CSVに変更がない月はファイルを触らない。
 if(content!==old){
  writeFileSync(filename,content);
  const sw=fileURLToPath(new URL('../sw.js',import.meta.url));
  const cache=readFileSync(sw,'utf8');
  const updated=cache.replace(/(const CACHE=CACHE_PREFIX+'v)(\d+)(')/,(_,head,version,tail)=>head+(Number(version)+1)+tail);
  if(updated===cache)throw new Error('オフライン用キャッシュの版が見つかりません');
  writeFileSync(sw,updated);
 }
 console.log(`内閣府祝日CSVを確認: ${years.join('、')}年${content===old?'（変更なし）':'（更新あり）'}`);
}
