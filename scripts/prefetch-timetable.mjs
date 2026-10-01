#!/usr/bin/env node
/**
 * 預抓台鐵／高鐵整日時刻表，精簡編碼後產出 `wrangler kv bulk put` 用的 JSON。
 *
 *   TDX_CLIENT_ID=... TDX_CLIENT_SECRET=... node scripts/prefetch-timetable.mjs
 *
 * 環境變數：
 *   TDX_CLIENT_ID / TDX_CLIENT_SECRET   必填，TDX 會員憑證
 *   DAYS                                預抓天數，含今天，預設 8
 *   OUT                                 輸出檔，預設 kv-bulk.json
 *
 * 為什麼排程放在 GitHub Actions 而不是 Cloudflare Cron Trigger：
 * Workers 免費方案的 Cron Trigger 只有 10 ms CPU，而光是 JSON.parse 一份
 * 3.7 MB 的台鐵整日時刻表就遠遠超過。詳見 docs/prefetch-architecture.md。
 */

import { writeFileSync } from 'node:fs';
import { encodeDayBuckets } from '../cloudflare-worker/timetable-codec.js';

const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const DAY_URL = {
  tra:  date => `https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}?$format=JSON`,
  thsr: date => `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/TrainDate/${date}?$format=JSON`,
};

const DAYS = Number(process.env.DAYS || 8);
const OUT  = process.env.OUT || 'kv-bulk.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb    = n => `${(n / 1024).toFixed(1)} KB`;

/**
 * TDX 的限制是每來源 IP 每秒 50 次，但實測會整波被擋（GitHub runner 的 IP
 * 也是共用的），所以退避要比 Worker 裡的更有耐心 —— 這裡是排程，等得起。
 */
const BACKOFF_MS = [1000, 3000, 8000, 20000];
async function fetch429(url, init) {
  let res;
  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    res = await fetch(url, init);
    if (res.status !== 429) return res;
    if (i < BACKOFF_MS.length) {
      console.log(`    429，${BACKOFF_MS[i] / 1000}s 後重試…`);
      await sleep(BACKOFF_MS[i]);
    }
  }
  return res;
}

async function getToken() {
  const { TDX_CLIENT_ID: id, TDX_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) {
    console.error('缺少 TDX_CLIENT_ID / TDX_CLIENT_SECRET');
    process.exit(1);
  }
  const res = await fetch429(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`取 token 失敗：${res.status}`);
  return (await res.json()).access_token;
}

// 以台北時間為準，TDX 的 TrainDate 是台灣當地日期
const taipeiToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 該日期過完的兩天後自然過期，不必另外清理舊 key
function ttlFor(ymd) {
  const expireAt = Date.parse(`${ymd}T00:00:00+08:00`) + 2 * 86400_000;
  return Math.max(Math.round((expireAt - Date.now()) / 1000), 60);
}

async function main() {
  const token   = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  const today   = taipeiToday();
  const dates   = Array.from({ length: DAYS }, (_, i) => addDays(today, i));

  console.log(`預抓 ${DAYS} 天：${dates[0]} ~ ${dates.at(-1)}（台北時間）\n`);

  const entries = [];
  let okDays = 0, failDays = 0;

  for (const date of dates) {
    for (const rail of ['tra', 'thsr']) {
      const label = `${date} ${rail}`;
      try {
        const res = await fetch429(DAY_URL[rail](date), { headers });
        if (!res.ok) {
          console.log(`  ✘ ${label}：HTTP ${res.status}`);
          failDays++;
          continue;
        }
        const raw     = await res.json();
        const rawSize = JSON.stringify(raw).length;
        const buckets = encodeDayBuckets(raw);
        const keys    = Object.keys(buckets);

        if (!keys.length) {
          console.log(`  – ${label}：無班次資料，略過`);
          continue;
        }

        let encoded = 0;
        for (const [b, value] of Object.entries(buckets)) {
          encoded += Buffer.byteLength(value, 'utf8');
          entries.push({ key: `tn:${rail}:${date}:${b}`, value, expiration_ttl: ttlFor(date) });
        }
        const trains = Object.values(buckets).reduce((n, v) => n + v.split('\n').length, 0);
        console.log(`  ✓ ${label}：${trains} 班次，${keys.length} 桶，` +
                    `${kb(rawSize)} → ${kb(encoded)}（${(rawSize / encoded).toFixed(1)}x）`);
        okDays++;
      } catch (err) {
        console.log(`  ✘ ${label}：${err.message}`);
        failDays++;
      }
      await sleep(500);   // 對 TDX 客氣一點
    }
  }

  if (!entries.length) {
    console.error('\n沒有任何資料可寫入');
    process.exit(1);
  }

  writeFileSync(OUT, JSON.stringify(entries));
  const total = entries.reduce((n, e) => n + Buffer.byteLength(e.value, 'utf8'), 0);
  console.log(`\n寫出 ${OUT}：${entries.length} 筆 key，共 ${kb(total)}`);
  console.log(`成功 ${okDays} / 失敗 ${failDays}`);

  // 全軍覆沒才算失敗；部分失敗讓既有的 KV 資料與即時查詢頂著
  if (okDays === 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
