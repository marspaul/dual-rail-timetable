# 雙鐵查詢

台灣高鐵 × 台鐵跨乘時刻表與票價查詢 PWA，部署於 GitHub Pages。

**線上使用** → [marspaul.github.io/dual-rail-timetable](https://marspaul.github.io/dual-rail-timetable)

---

## 功能

- 選擇出發站／目的地，查詢指定日期的班次
- 顯示高鐵、台鐵各班次的出發時間、抵達時間、行駛時間、票價
- 點開班次可展開**完整停靠站清單**（台鐵依實際班次路線，正確區分山線與海線）
- PWA：iOS Safari「加入主畫面」後以全螢幕 App 模式執行

## 技術架構

```
GitHub Pages (靜態前端)
    ↓ HTTPS + X-App-Id
Cloudflare Worker (API Proxy)
    ↓ OAuth Bearer Token
TDX 運輸資料流通服務 API
```

### 前端 (`index.html`)

- 純 HTML / CSS / JavaScript，無框架依賴
- PWA meta tags（`apple-mobile-web-app-capable`、`mobile-web-app-capable`）
- 停靠站前端快取（`_stopsCache`），同一班次同一天只查一次
- 停靠站一律取 API 實際資料；取不到就顯示「無法取得停靠站資訊」，不用估算值頂替

### Cloudflare Worker (`cloudflare-worker/worker.js`)

負責代理 TDX API，解決 CORS 限制並在 server 端管理 OAuth Token。

| 路由 | 說明 | Cache TTL |
|------|------|-----------|
| `GET /stations/thsr` | 高鐵站名 → ID 對照表（hardcoded） | — |
| `GET /stations/tra` | 台鐵站名 → ID 對照表 | module-level 6h |
| `GET /tra-fare/:from/:to` | 台鐵票價 | CF Cache 24h |
| `GET /thsr-fare/:from/:to` | 高鐵票價 | CF Cache 24h |
| `GET /tra/:from/:to/:date` | 台鐵 OD 時刻表 | CF Cache 2h |
| `GET /thsr/:from/:to/:date` | 高鐵 OD 時刻表 | CF Cache 2h |
| `GET /tra-stops/:trainNo/:date` | 台鐵單一班次完整停靠站 | CF Cache 24h |
| `GET /thsr-stops/:trainNo/:date` | 高鐵單一班次完整停靠站 | CF Cache 24h |

**安全機制：**

1. **精確 Origin 比對**：只允許 `https://marspaul.github.io`
2. **X-App-Id 暗號標頭**：前端每次請求帶上自訂 header
3. **TDX 憑證保密**：`TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` 以 Wrangler Secrets 管理，不寫入程式碼

**TDX 限流（429）處理：**

TDX 的限制是每來源 IP 每秒 50 次，但 Worker 走 Cloudflare 共用 egress IP，配額跟其他人一起算，實測低流量也會整波被擋，連 OAuth token 端點都會 429。

- 所有 TDX 呼叫（含 token）都經 `retry429()`，退避重試 300 / 800 / 2000ms
- access token 存在 KV（`TOKEN_KV`）跨 isolate 共用。Workers 冷啟動時 module-level 變數是空的，低流量下 isolate 常被回收，不共用的話會一直重抓 token
- 重試後仍失敗會回 429，前端顯示「TDX 流量限制，請稍後再試」

重試只是止血，根因（共用 egress IP）治不了。要根治得改成排程預抓時刻表進 KV，
設計草案見 [docs/prefetch-architecture.md](docs/prefetch-architecture.md)。

---

## 部署說明

### 前端

直接放置於 GitHub Pages 根目錄，`index.html` 即主頁面。

### Cloudflare Worker

```bash
cd cloudflare-worker

# 1. 設定 TDX API 憑證（前往 https://tdx.transportdata.tw 申請）
wrangler secret put TDX_CLIENT_ID
wrangler secret put TDX_CLIENT_SECRET

# 2. 建立存放 access token 的 KV namespace
#    把印出來的 id 填進 wrangler.toml 的 [[kv_namespaces]]
wrangler kv namespace create TOKEN_KV

# 3. 部署
wrangler deploy
```

本地測試：

```bash
# 建立 .dev.vars（不要 commit 此檔案）
echo 'TDX_CLIENT_ID=你的ID'       >> .dev.vars
echo 'TDX_CLIENT_SECRET=你的密鑰' >> .dev.vars
wrangler dev
```

---

## 資料來源

[TDX 運輸資料流通服務](https://tdx.transportdata.tw)（交通部）

## 檔案說明

`index.html` 是目前部署在 GitHub Pages 上的正式版本。資料夾裡其他幾個 `dual-rail-app*.html`（`-v2`、`-v2_1`、`-v2_2`、`_1` 等）是開發過程的草稿版本，內容跟 `index.html` 高度相似，僅供開發歷程參考，沒有部署。`utilities.html` 是另一個沿用同套視覺風格、但跟雙鐵時刻表無關的小工具（水電瓦斯費用計算）。

## 知識圖譜

已收進 LifeOS 的 Graphify 知識圖譜（含 Cloudflare Worker 認證機制、HTML 草稿演進關係）：
- Obsidian：PaulVault → `04-Resources/Graphify-LifeOS`，搜尋 `雙鐵查詢_` 開頭的文章
- 終端機：`graphify query "雙鐵查詢的 Cloudflare Worker 怎麼做安全驗證"`（在 `/Users/maverick/claude` 下執行）
