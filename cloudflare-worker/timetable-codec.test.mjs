/**
 * timetable-codec 的往返驗證 + 壓縮比量測
 *
 * 用法：
 *   node timetable-codec.test.mjs <樣本目錄>
 *
 * 樣本目錄放 TDX 的原始回應（`/tra-stops/:no/:date` 或 `/thsr-stops/:no/:date`
 * 存下來的 JSON），檔名以 tra- / thsr- 開頭。
 *
 * 往返驗證會比對還原後的 StationID 與時刻是否與原始資料完全一致；
 * 站名不比對，因為那是刻意丟掉、由 StationID 還原的。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeDay, decodeTrain, bucketOf, encodeDayBuckets } from './timetable-codec.js';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node timetable-codec.test.mjs <樣本目錄>');
  process.exit(1);
}

const bytes = s => Buffer.byteLength(s, 'utf8');
const kb    = n => `${(n / 1024).toFixed(1)} KB`;

// 把每個樣本檔裡的班次攤平成一個陣列（模擬整日回應的內容）
function loadTrains(prefix) {
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'))) {
    const raw  = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.TrainTimetables || raw.DailyTimetables || []);
    out.push(...list);
  }
  return out;
}

let failed = 0;

for (const [rail, prefix] of [['台鐵', 'tra-'], ['高鐵', 'thsr-']]) {
  const trains = loadTrains(prefix);
  if (!trains.length) continue;

  // ── 大小 ──
  // 原始大小取每筆班次序列化後的長度總和（整日回應扣掉外層 metadata 後就是這些）
  const rawStr     = trains.map(t => JSON.stringify(t)).join(',');
  const compactStr = encodeDay(trains);

  const raw      = bytes(rawStr);
  const compact  = bytes(compactStr);
  const rawGz    = gzipSync(Buffer.from(rawStr)).length;
  const compactGz = gzipSync(Buffer.from(compactStr)).length;

  const stops = trains.reduce((n, t) => n + (t.StopTimes?.length || 0), 0);

  console.log(`\n══ ${rail} ══  ${trains.length} 班次 / ${stops} 停靠站`);
  console.log(`  原始 JSON        ${kb(raw).padStart(9)}   ${String(Math.round(raw / stops)).padStart(4)} bytes/停靠站`);
  console.log(`  精簡編碼         ${kb(compact).padStart(9)}   ${String(Math.round(compact / stops)).padStart(4)} bytes/停靠站   ← ${(raw / compact).toFixed(1)}x`);
  console.log(`  原始 + gzip      ${kb(rawGz).padStart(9)}                        ← ${(raw / rawGz).toFixed(1)}x`);
  console.log(`  精簡 + gzip      ${kb(compactGz).padStart(9)}                        ← ${(raw / compactGz).toFixed(1)}x`);

  // ── 往返驗證 ──
  const nameOf = () => '';            // 站名不參與比對
  let checked = 0;
  for (const t of trains) {
    const no  = (t.TrainInfo || t.DailyTrainInfo || {}).TrainNo;
    const got = decodeTrain(compactStr, no, nameOf);
    if (!got) { console.error(`  ✘ ${no} 解不回來`); failed++; continue; }

    const want = t.StopTimes || [];
    if (got.StopTimes.length !== want.length) {
      console.error(`  ✘ ${no} 停靠站數 ${got.StopTimes.length} ≠ ${want.length}`);
      failed++; continue;
    }
    for (let i = 0; i < want.length; i++) {
      const a = want[i], b = got.StopTimes[i];
      const hhmm = v => String(v ?? '').slice(0, 5);
      if (String(a.StationID) !== b.StationID ||
          hhmm(a.ArrivalTime)   !== b.ArrivalTime ||
          hhmm(a.DepartureTime) !== b.DepartureTime) {
        console.error(`  ✘ ${no} 第 ${i + 1} 站不符：` +
          `${a.StationID}/${a.ArrivalTime}/${a.DepartureTime} → ` +
          `${b.StationID}/${b.ArrivalTime}/${b.DepartureTime}`);
        failed++; break;
      }
    }
    checked++;
  }
  console.log(`  往返驗證         ${checked} 班次${failed ? ` — ${failed} 筆不符` : ' 全數一致 ✓'}`);

  // ── 分桶 ──
  const buckets = encodeDayBuckets(trains);
  const sizes   = Object.values(buckets).map(bytes);
  if (sizes.length) {
    console.log(`  分桶             ${Object.keys(buckets).length} 桶，` +
      `每桶 ${kb(Math.min(...sizes))} ~ ${kb(Math.max(...sizes))}`);
  }
}

// bucketOf 要穩定且落在 0..15
for (const no of ['1242', '0109', '4051', 'ABC', '']) {
  const b = bucketOf(no);
  if (!(Number.isInteger(b) && b >= 0 && b < 16)) {
    console.error(`  ✘ bucketOf(${JSON.stringify(no)}) = ${b}`);
    failed++;
  }
}

console.log(failed ? `\n✘ ${failed} 項不符` : '\n✓ 全數通過');
process.exit(failed ? 1 : 0);
