/**
 * TDX API Proxy — Cloudflare Worker
 * 解決 CORS 問題，並在 server 端處理 OAuth token
 *
 * 部署步驟：
 *   1. wrangler secret put TDX_CLIENT_ID
 *   2. wrangler secret put TDX_CLIENT_SECRET
 *   3. wrangler deploy
 *
 * Routes:
 *   GET /stations/tra              → TRA 站牌 ID map
 *   GET /stations/thsr             → THSR 站牌 ID map
 *   GET /tra-fare/:from/:to        → TRA 票價
 *   GET /thsr-fare/:from/:to       → THSR 票價
 *   GET /tra/:fromId/:toId/:date   → TRA DailyTrainTimetable OD
 *   GET /thsr/:fromId/:toId/:date  → THSR DailyTimetable OD
 *   GET /tra-stops/:trainNo/:date  → TRA 單一班次完整停靠站
 *   GET /thsr-stops/:trainNo/:date → THSR 單一班次完整停靠站
 */

import { decodeTrain, bucketOf } from './timetable-codec.js';

const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_BASE      = 'https://tdx.transportdata.tw/api/basic/v3/Rail';

// 允許的來源（精確匹配，防止 subdomain 偽造）
const ALLOWED_ORIGINS = ['https://marspaul.github.io'];

// 前端暗號（防止無 origin 的工具直接呼叫）
const APP_SECRET_ID = 'dual-rail-timetable-v2';

// 基本 CORS（Origin 動態決定）
const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Id',
};

// Token 快取：module-level（同一個 isolate 內）+ KV（跨 isolate 共用）
const TOKEN_KV_KEY = 'tdx_access_token';
let _token = null;
let _tokenExpiry = 0;

// 高鐵站牌（固定 12 站）
const THSR_STATIONS = {
  '南港':'0990','台北':'1000','板橋':'1010','桃園':'1020',
  '新竹':'1030','苗栗':'1035','台中':'1040','彰化':'1043',
  '雲林':'1047','嘉義':'1050','台南':'1060','左營':'1070',
};

// TRA 站牌快取：module-level（6 小時）+ KV（跨 isolate，避免冷啟動又去打 TDX）
const STATIONS_KV_KEY = 'tra_station_map';
let _traStationMap    = null;
let _traStationExpiry = 0;
const STATION_TTL_MS  = 6 * 60 * 60 * 1000;

// StationID → 站名（解碼 KV 時刻表時用）
const NAMES_KV_KEY = rail => `names:${rail}`;
let _idToName = { tra: null, thsr: null };
let _idToNameExpiry = { tra: 0, thsr: 0 };
const invert = map => Object.fromEntries(Object.entries(map).map(([n, i]) => [i, n]));

// Cloudflare Cache TTL（秒）
const TTL_FARE      = 24 * 60 * 60; // 票價：24 小時
const TTL_TIMETABLE =  2 * 60 * 60; // 時刻表：2 小時

async function getToken(env) {
  if (_token && Date.now() < _tokenExpiry) return _token;

  // Workers 每次冷啟動 module-level 變數都是空的，低流量時 isolate 常被回收，
  // 結果每隔一陣子就重抓一次 token，而 TDX 的 token 端點同樣會回 429。
  // 放進 KV 讓所有 isolate 共用同一顆 token。
  if (env.TOKEN_KV) {
    try {
      const hit = await env.TOKEN_KV.get(TOKEN_KV_KEY, { type: 'json' });
      if (hit?.token && Date.now() < hit.expiry) {
        _token       = hit.token;
        _tokenExpiry = hit.expiry;
        return _token;
      }
    } catch { /* KV 讀取失敗就照常重抓 */ }
  }

  const res = await retry429(() => fetch(TDX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  }));
  if (!res.ok) {
    const err = new Error(`Token fetch failed: ${res.status}`);
    err.status = res.status === 429 ? 429 : 502;   // 讓前端能辨識限流
    throw err;
  }
  const { access_token, expires_in } = await res.json();
  _token       = access_token;
  _tokenExpiry = Date.now() + (expires_in - 60) * 1000;

  if (env.TOKEN_KV) {
    try {
      await env.TOKEN_KV.put(
        TOKEN_KV_KEY,
        JSON.stringify({ token: _token, expiry: _tokenExpiry }),
        { expirationTtl: Math.max(expires_in - 60, 60) },  // KV 下限 60 秒
      );
    } catch { /* 寫入失敗不影響這次請求 */ }
  }
  return _token;
}

// TDX 限流：每來源 IP 每秒 50 次。Worker 走 Cloudflare 共用 egress IP，配額跟
// 其他人共享，實測低流量也常被擋成一整波，連 OAuth token 端點也會 429。
const RETRY_BACKOFF_MS = [300, 800, 2000];
async function retry429(doFetch) {
  let res;
  for (let i = 0; i <= RETRY_BACKOFF_MS.length; i++) {
    res = await doFetch();
    if (res.status !== 429) return res;
    if (i < RETRY_BACKOFF_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[i]));
    }
  }
  return res;
}

const tdxFetch = (url, token) =>
  retry429(() => fetch(url, { headers: { Authorization: `Bearer ${token}` } }));

// null origin (file://) 要用 * 才能讓瀏覽器接受
function corsOrigin(origin) {
  return (!origin || origin === 'null') ? '*' : origin;
}

/**
 * 台鐵站牌對照表（站名 → ID）。
 * 三層：module 變數 → KV → TDX。放進 KV 是為了讓冷啟動的 isolate 不必再打
 * 一次 TDX（那樣就失去預抓的意義，而且 Station API 一樣會被限流）。
 */
async function getTraStationMap(env) {
  if (_traStationMap && Date.now() < _traStationExpiry) return _traStationMap;

  if (env.TOKEN_KV) {
    try {
      const hit = await env.TOKEN_KV.get(STATIONS_KV_KEY, { type: 'json' });
      if (hit && Object.keys(hit).length) {
        _traStationMap    = hit;
        _traStationExpiry = Date.now() + STATION_TTL_MS;
        return hit;
      }
    } catch { /* KV 讀失敗就往下走 TDX */ }
  }

  const token = await getToken(env);
  const res   = await tdxFetch(`${TDX_BASE}/TRA/Station?$format=JSON`, token);
  if (!res.ok) {
    const err = new Error(`TDX TRA Station API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const raw  = await res.json();
  const list = Array.isArray(raw) ? raw : (raw.Stations || []);
  const map  = {};
  for (const st of list) {
    const name = (st.StationName?.Zh_tw || '').replace(/臺/g, '台');
    if (name && st.StationID) map[name] = st.StationID;
  }
  _traStationMap    = map;
  _traStationExpiry = Date.now() + STATION_TTL_MS;

  if (env.TOKEN_KV) {
    try {
      await env.TOKEN_KV.put(STATIONS_KV_KEY, JSON.stringify(map),
        { expirationTtl: 7 * 24 * 60 * 60 });
    } catch { /* 寫入失敗不影響這次請求 */ }
  }
  return map;
}

/**
 * StationID → 站名 的查詢函式，給 decodeTrain() 用。
 *
 * 以排程寫入的 names:{rail} 為優先，站牌表只當後備：TDX 的 Station API 只列
 * 現役車站，會落後時刻表（實測站牌 1105 從 2026-10-05 起出現在時刻表，但
 * Station API 當時仍查不到，導致解碼出來的站名是空的）。
 */
async function idToName(env, rail) {
  if (!_idToName[rail] || Date.now() >= _idToNameExpiry[rail]) {
    const base = invert(rail === 'thsr' ? THSR_STATIONS : await getTraStationMap(env));
    let prefetched = null;
    try {
      prefetched = await env.TOKEN_KV?.get(NAMES_KV_KEY(rail), { type: 'json' });
    } catch { /* 沒有就只用站牌表 */ }
    _idToName[rail]       = { ...base, ...prefetched };
    _idToNameExpiry[rail] = Date.now() + STATION_TTL_MS;
  }
  const table = _idToName[rail];
  return id => table[id] || '';
}

/**
 * 從預抓進 KV 的整日時刻表取單一班次，還原成與 TDX 相同的回應形狀。
 * 沒有預抓資料（或任何一步失敗）就回 null，交給呼叫端走即時查詢。
 */
async function stopsFromKv(env, rail, trainNo, date) {
  if (!env.TOKEN_KV) return null;
  try {
    // 不設 cacheTtl：KV 預設 60 秒，連「查不到」也會被快取，設長了排程剛寫完
    // 的資料會有更長的空窗。重複請求本來就被外層的 Cloudflare Cache 擋掉了。
    const bucket = await env.TOKEN_KV.get(`tn:${rail}:${date}:${bucketOf(trainNo)}`);
    if (!bucket) return null;

    const train = decodeTrain(bucket, trainNo, await idToName(env, rail));
    if (!train?.StopTimes?.length) return null;

    // 任何一站還原不出站名就不要用這份資料 —— 寧可多花一次 TDX 往返，
    // 也不要在畫面上顯示空白站名。
    if (train.StopTimes.some(s => !s.StationName.Zh_tw)) return null;

    const info = { TrainNo: train.TrainNo, Direction: train.Direction };
    return rail === 'tra'
      ? { TrainDate: date, TrainTimetables: [{ TrainInfo: { ...info, TrainTypeCode: train.TrainTypeCode }, StopTimes: train.StopTimes }] }
      : [{ TrainDate: date, DailyTrainInfo: info, StopTimes: train.StopTimes }];
  } catch {
    return null;
  }
}

function jsonResp(data, status = 200, ttl = 0, cacheKey = null, ctx = null, origin = null) {
  const headers = {
    ...CORS_BASE,
    'Access-Control-Allow-Origin': corsOrigin(origin),
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (ttl > 0) headers['Cache-Control'] = `public, max-age=${ttl}`;
  const resp = new Response(JSON.stringify(data), { status, headers });
  if (ttl > 0 && cacheKey && ctx) {
    ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  }
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('origin') || '';
    const appId  = request.headers.get('x-app-id') || '';

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...CORS_BASE, 'Access-Control-Allow-Origin': corsOrigin(origin) },
      });
    }

    // ── 安全性檢查：精確 origin + 暗號 ──
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin);
    const isAllowedApp    = appId === APP_SECRET_ID;
    if (!isAllowedOrigin || !isAllowedApp) {
      return new Response('Forbidden', {
        status: 403,
        headers: { ...CORS_BASE, 'Access-Control-Allow-Origin': corsOrigin(origin) },
      });
    }

    const url      = new URL(request.url);
    const { pathname } = url;

    // ── Cloudflare Cache helper ──
    const cacheKey = new Request(request.url);
    // 快取命中時動態替換 ACAO，避免舊 origin 的快取回傳錯誤 header
    async function getCache() {
      const cached = await caches.default.match(cacheKey);
      if (!cached) return null;
      const headers = new Headers(cached.headers);
      headers.set('Access-Control-Allow-Origin', corsOrigin(origin));
      return new Response(cached.body, { status: cached.status, headers });
    }

    // ── 高鐵站牌（固定，直接回傳） ──
    if (pathname === '/stations/thsr') {
      return jsonResp(THSR_STATIONS, 200, 0, null, null, origin);
    }

    // ── 台鐵站牌（module 快取 6h → KV → TDX） ──
    if (pathname === '/stations/tra') {
      try {
        return jsonResp(await getTraStationMap(env), 200, 0, null, null, origin);
      } catch (err) {
        return jsonResp({ error: err.message }, err.status || 500, 0, null, null, origin);
      }
    }

    // ── 單一班次完整停靠站：/tra-stops|/thsr-stops/:trainNo/:date（CF Cache 24h） ──
    const stopsM = pathname.match(/^\/(tra|thsr)-stops\/([^/]+)\/([^/]+)$/);
    if (stopsM) {
      const [, rail, trainNo, date] = stopsM;
      // trainNo 會拼進 OData $filter，限制字元避免注入
      if (!/^[A-Za-z0-9]{1,8}$/.test(trainNo)) {
        return jsonResp({ error: 'Invalid train number' }, 400, 0, null, null, origin);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonResp({ error: 'Date must be YYYY-MM-DD' }, 400, 0, null, null, origin);
      }

      const cached = await getCache();
      if (cached) return cached;

      // 預抓進 KV 的整日時刻表（若排程已寫入）。拿不到就往下走即時查詢，
      // 所以排程漏跑、KV 還沒寫入、或臨時加開的班次都不會壞掉。
      const prefetched = await stopsFromKv(env, rail, trainNo, date);
      if (prefetched) return jsonResp(prefetched, 200, TTL_FARE, cacheKey, ctx, origin);

      try {
        const token  = await getToken(env);
        const apiUrl = rail === 'tra'
          ? `${TDX_BASE}/TRA/DailyTrainTimetable/TrainDate/${date}?$filter=TrainInfo/TrainNo eq '${trainNo}'&$format=JSON`
          : `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/TrainDate/${date}?$filter=DailyTrainInfo/TrainNo eq '${trainNo}'&$format=JSON`;
        const res = await tdxFetch(apiUrl, token);
        if (!res.ok) return jsonResp({ error: `${rail.toUpperCase()} stops API ${res.status}` }, res.status, 0, null, null, origin);
        return jsonResp(await res.json(), 200, TTL_FARE, cacheKey, ctx, origin);
      } catch (err) {
        return jsonResp({ error: err.message }, err.status || 500, 0, null, null, origin);
      }
    }

    // ── 票價：/tra-fare/:from/:to 或 /thsr-fare/:from/:to（CF Cache 24h） ──
    const fareM = pathname.match(/^\/(tra|thsr)-fare\/([^/]+)\/([^/]+)$/);
    if (fareM) {
      const cached = await getCache();
      if (cached) return cached;

      const [, rail, fromId, toId] = fareM;
      try {
        const token  = await getToken(env);
        const apiUrl = rail === 'tra'
          ? `${TDX_BASE}/TRA/ODFare/${fromId}/to/${toId}?$format=JSON`
          : `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/ODFare/${fromId}/to/${toId}?$format=JSON`;
        const res = await tdxFetch(apiUrl, token);
        if (!res.ok) return jsonResp({ error: `ODFare API ${res.status}` }, res.status, 0, null, null, origin);
        return jsonResp(await res.json(), 200, TTL_FARE, cacheKey, ctx, origin);
      } catch (err) {
        return jsonResp({ error: err.message }, err.status || 500, 0, null, null, origin);
      }
    }

    // ── 時刻表：/tra/:from/:to/:date 或 /thsr/:from/:to/:date（CF Cache 2h） ──
    const m = pathname.match(/^\/(tra|thsr)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m) {
      return jsonResp({ error: 'Invalid route' }, 404, 0, null, null, origin);
    }

    const [, rail, fromId, toId, date] = m;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResp({ error: 'Date must be YYYY-MM-DD' }, 400, 0, null, null, origin);
    }

    const cached = await getCache();
    if (cached) return cached;

    try {
      const token = await getToken(env);
      const apiUrl = rail === 'tra'
        ? `${TDX_BASE}/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`
        : `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`;

      const res = await tdxFetch(apiUrl, token);
      if (!res.ok) {
        const text = await res.text();
        return jsonResp({ error: `TDX API error ${res.status}`, detail: text }, res.status, 0, null, null, origin);
      }
      return jsonResp(await res.json(), 200, TTL_TIMETABLE, cacheKey, ctx, origin);
    } catch (err) {
      return jsonResp({ error: err.message }, err.status || 500, 0, null, null, origin);
    }
  },
};
