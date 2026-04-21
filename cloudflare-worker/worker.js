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
 */

const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_BASE      = 'https://tdx.transportdata.tw/api/basic/v3/Rail';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 允許的來源（Referer 或 Origin）
const ALLOWED_HOSTS = ['marspaul.github.io', 'localhost', '127.0.0.1'];

// Module-level token cache
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
  const res = await fetch(TDX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const { access_token, expires_in } = await res.json();
  _token       = access_token;
  _tokenExpiry = Date.now() + (expires_in - 60) * 1000;
  return _token;
}

function jsonResp(data, status = 200, ttl = 0, cacheKey = null, ctx = null) {
  const headers = {
    ...CORS,
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
    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── Referer / Origin 防盜用 ──
    // file:// 時瀏覽器送 Origin: "null"，視同無 origin 放行
    const referer = request.headers.get('referer') || '';
    const origin  = request.headers.get('origin')  || '';
    const hasOrigin = origin && origin !== 'null';
    if (hasOrigin && !ALLOWED_HOSTS.some(h => origin.includes(h))) {
      return new Response('Forbidden', { status: 403, headers: CORS });
    }
    if (!hasOrigin && referer && !ALLOWED_HOSTS.some(h => referer.includes(h))) {
      return new Response('Forbidden', { status: 403, headers: CORS });
    }

    const url      = new URL(request.url);
    const { pathname } = url;

    // ── Cloudflare Cache helper ──
    const cacheKey = new Request(request.url);
    async function getCache()        { return caches.default.match(cacheKey); }

    // ── 高鐵站牌（hardcoded，直接回傳） ──
    if (pathname === '/stations/thsr') {
      return jsonResp({
        '南港':'0990','台北':'1000','板橋':'1010','桃園':'1020',
        '新竹':'1030','苗栗':'1035','台中':'1040','彰化':'1043',
        '雲林':'1047','嘉義':'1050','台南':'1060','左營':'1070',
      });
    }

    // ── 台鐵站牌（module-level 快取 6h） ──
    if (pathname === '/stations/tra') {
      try {
        if (_traStationMap && Date.now() < _traStationExpiry) {
          return jsonResp(_traStationMap);
        }
        const token = await getToken(env);
        const res   = await fetch(`${TDX_BASE}/TRA/Station?$format=JSON`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return jsonResp({ error: `TDX TRA Station API ${res.status}` }, res.status);
        const raw  = await res.json();
        const list = Array.isArray(raw) ? raw : (raw.Stations || []);
        const map  = {};
        for (const s of list) {
          const name = (s.StationName?.Zh_tw || '').replace(/臺/g, '台');
          if (name && s.StationID) map[name] = s.StationID;
        }
        _traStationMap    = map;
        _traStationExpiry = Date.now() + STATION_TTL_MS;
        return jsonResp(map);
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
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
        const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return jsonResp({ error: `ODFare API ${res.status}` }, res.status);
        return jsonResp(await res.json(), 200, TTL_FARE, cacheKey, ctx);
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // ── 時刻表：/tra/:from/:to/:date 或 /thsr/:from/:to/:date（CF Cache 2h） ──
    const m = pathname.match(/^\/(tra|thsr)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m) {
      return jsonResp({ error: 'Invalid route' }, 404);
    }

    const [, rail, fromId, toId, date] = m;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResp({ error: 'Date must be YYYY-MM-DD' }, 400);
    }

    const cached = await getCache();
    if (cached) return cached;

    try {
      const token = await getToken(env);
      const apiUrl = rail === 'tra'
        ? `${TDX_BASE}/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`
        : `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`;

      const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text();
        return jsonResp({ error: `TDX API error ${res.status}`, detail: text }, res.status);
      }
      return jsonResp(await res.json(), 200, TTL_TIMETABLE, cacheKey, ctx);
    } catch (err) {
      return jsonResp({ error: err.message }, 500);
    }
  },
};
