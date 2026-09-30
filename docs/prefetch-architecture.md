# 排程預抓時刻表進 KV — 架構設計

> 狀態：**設計草案，尚未實作**
> 撰寫日期：2026-09-30

現行架構每次查詢都即時代打 TDX API，會撞上 TDX 的限流（429）。這份文件說明改成「排程預抓進 KV」的做法、實測資料量、以及會卡住的地方。

---

## 1. 為什麼要改

TDX 的限制是**每來源 IP 每秒 50 次**，但 Cloudflare Worker 走的是共用 egress IP，配額跟其他人一起算。實測（2026-09-30，全新車次、必定 cache miss）：

| 測試 | 結果 |
|------|------|
| 15 次請求，間隔 2 秒 | 成功 10 / 失敗 5 |
| 失敗分布 | `·····AAAAA·····` — **整波連續出現**，不是隨機散落 |

失敗是一波一波來的，那波大約持續 10 秒。現行的退避重試總共只等 3.1 秒（300 / 800 / 2000 ms），撐不過去；要撐過得等 10 秒，但點一下轉十秒圈圈更難用。

**這不是重試能解決的問題**，根因是共用 IP。唯一的解法是不要在使用者查詢的當下打 TDX。

> 註：OAuth token 端點的 429 已經解決了 —— access token 存進 KV 跨 isolate 共用後，失敗率從 2/10 降到 0/15。詳見 `cloudflare-worker/worker.js` 的 `getToken()`。

---

## 2. 核心想法

現在是「客人點餐才去市場買菜」，改成「每天凌晨進貨」：

```
現行：使用者查詢 ──► Worker ──► TDX API        ← 每次都打，會被限流
改後：排程       ──► TDX API ──► KV
      使用者查詢 ──► Worker  ──► KV            ← 完全不碰 TDX
```

---

## 3. 資料量（實測值）

| 項目 | 實測 | 全日推估 |
|------|------|----------|
| 台鐵單一班次 JSON | 5,582 bytes（32 停靠站）| ~1,100 班次 → **約 6 MB** |
| 高鐵單一班次 JSON | 1,149 bytes | ~170 班次 → 約 200 KB |
| 台鐵站牌總數 | 245 | — |

6 MB 在 KV 單值上限（25 MiB）之內，但**重新編碼能砍掉九成**，這是整個設計可行的關鍵。

TDX 原始 JSON 每個停靠站都塞了四種語言的站名，而 Worker 已經有站牌 ID → 站名對照表（`/stations/tra`），完全不需要重複存：

```jsonc
// 原始（約 170 bytes/停靠站）
{"StopSequence":2,"StationID":"1000",
 "StationName":{"Zh_tw":"台北","En":"Taipei","Ja":"台北","Ko":"타이페이"},
 "ArrivalTime":"07:28","DepartureTime":"07:31"}

// 精簡（14 bytes/停靠站）
"1000,0728,0731"
```

**6 MB → 約 500 KB。**

---

## 4. KV key 設計：分桶

直覺會想「一個班次一筆 key」，但那是約 1,100 writes/day，**超過免費方案的 1,000 writes/day**。

改成用車次號分桶：

```
tn:tra:2026-10-01:0     ← 車次號 % 16 == 0 的所有班次
tn:tra:2026-10-01:1
  ⋮
tn:tra:2026-10-01:15
tn:thsr:2026-10-01:0
  ⋮
```

| 指標 | 值 |
|------|-----|
| 寫入量 | 16 桶 × 2 鐵路 = **32 writes/day** |
| 單桶大小 | 約 30 KB |
| 查詢成本 | 讀 1 桶 + parse 30 KB — CPU 壓得住 |

### 預抓幾天

TDX 大約提供未來 60 天。全抓會變成 1,920 writes/day，太多。

建議抓 **今天 + 未來 7 天 = 256 writes/day**，其餘日期走即時查詢。

---

## 5. 排程實作

### 方案 A：Cloudflare Cron Trigger

`wrangler.toml`：

```toml
[triggers]
crons = ["30 18 * * *"]   # UTC 18:30 = 台北 02:30
```

`worker.js` 增加 `scheduled` handler：

```js
export default {
  async scheduled(event, env, ctx) {
    for (const rail of ['tra', 'thsr']) {
      for (const date of nextDays(8)) {
        const raw     = await fetchWholeDay(rail, date, env);  // 1 次 TDX 呼叫
        const buckets = compact(raw);                          // 重新編碼 + 分桶
        for (const [i, data] of buckets.entries()) {
          await env.TOKEN_KV.put(`tn:${rail}:${date}:${i}`, data,
            { expirationTtl: 10 * 86400 });
        }
      }
    }
  },
  async fetch(request, env, ctx) { /* 現有的 */ },
};
```

**⚠️ 這個方案需要 Workers 付費方案（$5/月）。** 免費方案的 Cron Trigger 只有 **10 ms CPU**，抓 6 MB JSON、parse、重新編碼一定遠遠超過。付費方案的 cron 有 30 秒，綽綽有餘。

### 方案 B：GitHub Actions 當排程器（建議）

本 repo 是公開的，GitHub Actions 對公開 repo 免費無上限。讓 Action 去抓 TDX、做完編碼，再用 Cloudflare REST API 寫進 KV，Worker 只負責讀。

| | 方案 A（CF Cron） | 方案 B（GitHub Actions） |
|---|---|---|
| 費用 | $5/月 | 免費 |
| 重活在哪 | Worker | GitHub Runner |
| Worker 每次請求 | 讀 1 個 30 KB 桶 | 同左 |
| 排程邏輯維護 | 混在 Worker 裡 | 獨立在 repo 裡 |

方案 B 把重活移出 Cloudflare，Worker 的請求路徑只剩「讀一個 30 KB 的桶」，穩穩在免費方案的 10 ms CPU 內。

---

## 6. 讀取路徑改動

改成兩層，**KV 沒有就退回現有的即時查詢**：

```js
const hit = await env.TOKEN_KV.get(`tn:${rail}:${date}:${no % 16}`);
if (hit) return pickTrain(hit, no);     // 命中，不碰 TDX
return await liveTdxFetch(no, date);    // 沒命中，走現有路徑
```

這個 fallback **不是防呆，是必要的**，原因見下一節。

---

## 7. KV 運作方式與注意事項

KV 是「中央儲存 + 全球邊緣快取」的架構：寫入只寫進少數幾個中央機房，讀取則就近從邊緣快取拿。為「寫很少、讀很多」最佳化 —— 正好符合這個用途（一天寫 32 筆，讀無數次）。

```
put()  ──► 中央儲存                    ← 寫入「不會」自動推到各節點

get()  ──► 邊緣節點 [ miss ] ──► 區域層 ──► 中央儲存    ← 冷讀，慢
       ──► 邊緣節點 [ hit ]                             ← 熱讀，個位數 ms
```

### 三個會咬人的點

1. **寫入後最多 60 秒才在其他節點看得到。** 寫入的那個節點通常立刻可見，但官方明說不保證，不要依賴。

2. **「查不到」也會被快取。** 如果某節點在寫入之前查過該 key，它會把「不存在」這個結論也快取 60 秒。

   > 套到這個設計：cron 在 02:30 寫入 `tn:tra:2026-10-01:5`，若有人 02:29 剛好查過，那個節點會有一分鐘繼續回「沒有」。**這就是為什麼第 6 節的即時查詢 fallback 是必要的。**

3. **同一個 key 每秒只能寫 1 次。** 所以要把寫入打散到多個 key —— 這也是分桶設計的另一個理由。

預設 `cacheTtl` 是 60 秒，可調高。時刻表一天才更新一次，可以設得很長。

### 開發時的坑

`wrangler kv key list --binding TOKEN_KV` 預設查的是**本地模擬狀態**（給 `wrangler dev` 用），會回 `[]`。要看線上 namespace 必須加 `--remote`。這跟最終一致性無關。

---

## 8. 尚未驗證的項目

- [ ] **TDX 整日時刻表端點的分頁上限。** 不加 `$filter` 直接抓 `DailyTrainTimetable/TrainDate/{date}`，TDX 可能有預設筆數上限，需要用 `$top` / `$skip` 分頁。這個要實際打一次才知道 —— **實作的第一步應該先驗這個**。
- [ ] 每日班次數的實際值（本文用的 ~1,100 是推估，不是實測）。
- [ ] 精簡編碼後的實際大小。

---

## 9. 現況建議

**如果只是自己用，目前這樣就夠了。** 快取有效（實測重複請求 0.43s ≈ 硬編碼基準 0.41s，全新請求 0.56–0.97s，差的就是 TDX 往返），429 只在查全新班次時偶爾出現，而且會誠實顯示「TDX 流量限制，請稍後再試」，不會拿估算值魚目混珠。

真要做的話建議走**方案 B（GitHub Actions 排程 + Worker 只讀 KV）**：不用付 Cloudflare 的錢，排程邏輯放在 repo 裡也比塞在 Worker 裡好維護。

---

## 相關檔案

- [`cloudflare-worker/worker.js`](../cloudflare-worker/worker.js) — 現行 Worker，含 `retry429()` 與 KV token 快取
- [`cloudflare-worker/wrangler.toml`](../cloudflare-worker/wrangler.toml) — KV binding 設定
- [`README.md`](../README.md) — 專案總覽與現行架構
