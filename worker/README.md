# Vision 拼版 proxy（Cloudflare Worker + Gemini）

前端是純靜態 GitHub Pages，沒有後端，所以 API key 不能放在前端。
這個 Worker 當作中間代理：前端送圖過來，它用藏在 secret 的 **Google Gemini** key
呼叫 `gemini-2.5-flash`，回傳每張切圖在參考圖上的位置。

## 流程

```
瀏覽器 (editor.js)  ──POST 參考圖+切圖──▶  Cloudflare Worker  ──x-goog-api-key──▶  Gemini API
                    ◀──{found,x,y,width,height,confidence}──
```

Gemini 原生用 0–1000 正規化的 bounding box，Worker 跟它要這個格式後換算成像素，
所以前端拿到的還是像素 `{x,y,width,height}`，跟用哪個供應商無關。

## 拿 Gemini API key（有免費額度）

到 **[Google AI Studio](https://aistudio.google.com/apikey)** → Get API key → 建立一把 key（`AIza...`）。
Gemini 2.5 Flash 有免費額度（有 RPM/RPD 限制），這個用途一批切圖通常免費或幾分美金。

## 部署

需要 [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)。

```sh
cd worker
wrangler login
wrangler secret put GEMINI_API_KEY        # 貼上你的 Gemini key（必填）
# 選填，建議至少設一個防止別人盜用你的 proxy：
wrangler secret put PROXY_TOKEN           # 隨便一段字串，前端要填同一個
wrangler deploy
```

部署完得到 `https://vision-layout-proxy.你的帳號.workers.dev`，填進編輯器
「自動拼版 → Proxy 設定 → Proxy URL」。

## 本機測試（不用登入 Cloudflare）

```sh
cd worker
cp .dev.vars.example .dev.vars     # 然後編輯 .dev.vars 填入真實 Gemini key
WRANGLER_SEND_METRICS=false npx wrangler dev --port 8787
```
編輯器 Proxy URL 填 `http://localhost:8787`。

## 免費額度的速率限制

Gemini 免費層有每分鐘（RPM）/每日（RPD）請求上限。前端是 3 條併發，
一批幾十張通常沒問題；若看到 `gemini 429`，把切圖分批跑，或之後升級付費層。

## 安全提醒

- 開放的 proxy = 任何人都能用你的網址燒你的 Gemini 額度。**至少設 `PROXY_TOKEN`**，
  並考慮設 `ALLOWED_ORIGIN` 鎖成你的 GitHub Pages 網域。
- key 只存在 Worker secret / `.dev.vars`（本機）。**不要寫進 `wrangler.toml` 或任何 commit 的檔案。**
