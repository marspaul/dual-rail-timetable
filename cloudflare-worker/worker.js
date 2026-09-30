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

// TRA 站牌 module-level 快取（6 小時）
let _traStationMap    = null;
let _traStationExpiry = 0;
const STATION_TTL_MS  = 6 * 60 * 60 * 1000;

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

    // ── 高鐵站牌（hardcoded，直接回傳） ──
    if (pathname === '/stations/thsr') {
      return jsonResp({
        '南港':'0990','台北':'1000','板橋':'1010','桃園':'1020',
        '新竹':'1030','苗栗':'1035','台中':'1040','彰化':'1043',
        '雲林':'1047','嘉義':'1050','台南':'1060','左營':'1070',
      }, 200, 0, null, null, origin);
    }

    // ── 台鐵站牌（module-level 快取 6h） ──
    if (pathname === '/stations/tra') {
      try {
        if (_traStationMap && Date.now() < _traStationExpiry) {
          return jsonResp(_traStationMap, 200, 0, null, null, origin);
        }
        const token = await getToken(env);
        const res   = await tdxFetch(`${TDX_BASE}/TRA/Station?$format=JSON`, token);
        if (!res.ok) return jsonResp({ error: `TDX TRA Station API ${res.status}` }, res.status, 0, null, null, origin);
        const raw  = await res.json();
        const list = Array.isArray(raw) ? raw : (raw.Stations || []);
        const map  = {};
        for (const s of list) {
          const name = (s.StationName?.Zh_tw || '').replace(/臺/g, '台');
          if (name && s.StationID) map[name] = s.StationID;
        }
        _traStationMap    = map;
        _traStationExpiry = Date.now() + STATION_TTL_MS;
        return jsonResp(map, 200, 0, null, null, origin);
      } catch (err) {
        return jsonResp({ error: err.message }, err.status || 500, 0, null, null, origin);
      }
    }

    // ── 【臨時】探測 TDX 整日端點的分頁行為：/_probe/:rail/:date?top=&skip= ──
    // 只量回應大小、不解析 body，避免吃掉免費方案的 10ms CPU。量完即移除。
    const probeM = pathname.match(/^\/_probe\/(tra|thsr)\/(\d{4}-\d{2}-\d{2})$/);
    if (probeM) {
      const [, rail, date] = probeM;
      const top  = url.searchParams.get('top');
      const skip = url.searchParams.get('skip');
      if ((top && !/^\d{1,7}$/.test(top)) || (skip && !/^\d{1,7}$/.test(skip))) {
        return jsonResp({ error: 'top/skip must be digits' }, 400, 0, null, null, origin);
      }
      const base = rail === 'tra'
        ? `${TDX_BASE}/TRA/DailyTrainTimetable/TrainDate/${date}`
        : `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/TrainDate/${date}`;
      const qs = ['$format=JSON'];
      if (top)  qs.push(`$top=${top}`);
      if (skip) qs.push(`$skip=${skip}`);
      try {
        const token = await getToken(env);
        const res   = await tdxFetch(`${base}?${qs.join('&')}`, token);
        const buf   = await res.arrayBuffer();          // 不 parse，只量大小
        return jsonResp({
          rail, date, top: top || null, skip: skip || null,
          status: res.status,
          bytes:  buf.byteLength,
        }, 200, 0, null, null, origin);
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
