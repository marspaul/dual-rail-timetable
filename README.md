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
- 台鐵停靠站前端快取（`_stopsCache`），同一班次同一天只查一次

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
| `GET /tra-stops/:trainNo/:date` | 台鐵完整停靠站（依班次號） | CF Cache 24h |

**安全機制：**

1. **精確 Origin 比對**：只允許 `https://marspaul.github.io`
2. **X-App-Id 暗號標頭**：前端每次請求帶上自訂 header
3. **TDX 憑證保密**：`TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` 以 Wrangler Secrets 管理，不寫入程式碼

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

# 2. 部署
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
