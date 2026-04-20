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

// Module-level token cache（per isolate，Worker 冷啟動後重置）
let _token = null;
let _tokenExpiry = 0;

// TRA 站牌快取（6 小時），多個裝置共用同一份 API 呼叫
let _traStationMap = null;
let _traStationExpiry = 0;
const STATION_TTL = 6 * 60 * 60 * 1000;

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
  _tokenExpiry = Date.now() + (expires_in - 60) * 1000; // 提前 60s 過期
  return _token;
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const { pathname } = new URL(request.url);

    // 高鐵站牌（THSR v2 API 4 位數 ID）
    if (pathname === '/stations/thsr') {
      return jsonResp({
        '南港':'0990','台北':'1000','板橋':'1010','桃園':'1020',
        '新竹':'1030','苗栗':'1035','台中':'1040','彰化':'1043',
        '雲林':'1047','嘉義':'1050','台南':'1060','左營':'1070',
      });
    }

    // 台鐵站牌（從 TDX 動態取得，Worker 端快取 6 小時）
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
        const raw = await res.json();
        const list = Array.isArray(raw) ? raw : (raw.Stations || []);
        const map  = {};
        for (const s of list) {
          const name = (s.StationName?.Zh_tw || '').replace(/臺/g, '台');
          if (name && s.StationID) map[name] = s.StationID;
        }
        _traStationMap    = map;
        _traStationExpiry = Date.now() + STATION_TTL;
        return jsonResp(map);
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 票價：/tra-fare/:fromId/:toId 或 /thsr-fare/:fromId/:toId
    const fareM = pathname.match(/^\/(tra|thsr)-fare\/([^/]+)\/([^/]+)$/);
    if (fareM) {
      const [, rail, fromId, toId] = fareM;
      try {
        const token  = await getToken(env);
        const apiUrl = rail === 'tra'
          ? `${TDX_BASE}/TRA/ODFare/${fromId}/to/${toId}?$format=JSON`
          : `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/ODFare/${fromId}/to/${toId}?$format=JSON`;
        const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return jsonResp({ error: `ODFare API ${res.status}` }, res.status);
        return jsonResp(await res.json());
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 路由解析：/tra/:fromId/:toId/:date 或 /thsr/:fromId/:toId/:date
    const m = pathname.match(/^\/(tra|thsr)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m) {
      return jsonResp({ error: 'Invalid route. Use /tra/:from/:to/:date or /thsr/:from/:to/:date' }, 404);
    }

    const [, rail, fromId, toId, date] = m;

    // 驗證日期格式 YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResp({ error: 'Date must be YYYY-MM-DD' }, 400);
    }

    try {
      const token = await getToken(env);

      let apiUrl;
      if (rail === 'tra') {
        apiUrl = `${TDX_BASE}/TRA/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`;
      } else {
        // THSR 使用 v2 API，站 ID 為 1-12
        apiUrl = `https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/DailyTimetable/OD/${fromId}/to/${toId}/${date}?$format=JSON`;
      }

      const res = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text();
        return jsonResp({ error: `TDX API error ${res.status}`, url: apiUrl, detail: text }, res.status);
      }

      const data = await res.json();
      return jsonResp(data);

    } catch (err) {
      return jsonResp({ error: err.message }, 500);
    }
  },
};
