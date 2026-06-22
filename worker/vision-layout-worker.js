// Cloudflare Worker — Gemini Vision 拼版 proxy
//
// 前端把「參考截圖 + 單張切圖」送來，這個 proxy 用你的 Google Gemini API key
// 呼叫 gemini-2.5-flash，請它回傳該切圖在參考圖上的 bounding box，
// 再換算成像素座標回傳給前端。Key 只存在 Worker secret，永遠不會出現在前端。
//
// Gemini 原生用 0–1000 正規化框（ymin,xmin,ymax,xmax），這裡照它的慣例要，
// 再依參考圖尺寸換算成像素 {x,y,width,height}，前端契約跟原本一樣。
//
// 部署（見 worker/README.md）：
//   wrangler secret put GEMINI_API_KEY        # 必填，Google AI Studio 取得
//   wrangler deploy
// 選填環境變數：
//   ALLOWED_ORIGIN  鎖定前端網域（基本防護）
//   PROXY_TOKEN     簡單存取控制；設了之後前端要在 X-Proxy-Token 帶同一字串

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT =
  'You are given two images. The FIRST image is a full webpage screenshot. ' +
  'The SECOND image is a single UI slice asset that appears somewhere inside the first image ' +
  '(it may have been exported at 2x/3x, so on screen it can be smaller). ' +
  'Output the 2D bounding box of where the slice appears in the FIRST image, as ymin, xmin, ymax, xmax ' +
  'normalized to 0-1000 (origin at top-left). If the slice is not visible anywhere in the first image, ' +
  'set found to false.';

// Gemini responseSchema：型別用大寫（OBJECT/INTEGER/...）
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    ymin: { type: 'INTEGER' },
    xmin: { type: 'INTEGER' },
    ymax: { type: 'INTEGER' },
    xmax: { type: 'INTEGER' },
    confidence: { type: 'NUMBER' },
  },
  required: ['found', 'ymin', 'xmin', 'ymax', 'xmax', 'confidence'],
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

    if (env.PROXY_TOKEN && request.headers.get('X-Proxy-Token') !== env.PROXY_TOKEN) {
      return json({ error: 'unauthorized' }, 401, cors);
    }
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'forbidden origin' }, 403, cors);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'server misconfigured: GEMINI_API_KEY not set' }, 500, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid json' }, 400, cors); }

    const { ref, slice, refWidth, refHeight, name } = body || {};
    if (!ref || !ref.data || !slice || !slice.data) {
      return json({ error: 'missing ref/slice image data' }, 400, cors);
    }

    const askText =
      `The slice name is "${name || 'asset'}". Output the bounding box (ymin, xmin, ymax, xmax) ` +
      `normalized to 0-1000 of where this slice appears in the FIRST image, plus a confidence 0-1.`;

    const payload = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: ref.media_type || 'image/png', data: ref.data } },
          { inline_data: { mime_type: slice.media_type || 'image/png', data: slice.data } },
          { text: askText },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        temperature: 0,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 }, // 簡單任務關掉 thinking，省錢省延遲
      },
    };

    let gRes;
    try {
      gRes = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed: ' + e.message }, 502, cors);
    }

    if (!gRes.ok) {
      const t = await gRes.text().catch(() => '');
      return json({ error: 'gemini ' + gRes.status, detail: t.slice(0, 500) }, 502, cors);
    }

    const data = await gRes.json();
    const cand = data.candidates && data.candidates[0];
    if (!cand) {
      // 整個 prompt 被擋（安全等）— 視為找不到，不當錯誤
      return json({ found: false, blocked: true, detail: data.promptFeedback || null }, 200, cors);
    }
    if (cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
      return json({ found: false, finishReason: cand.finishReason }, 200, cors);
    }
    const part = cand.content && cand.content.parts && cand.content.parts.find((p) => p.text);
    if (!part) return json({ error: 'no text part in gemini response' }, 502, cors);

    let g;
    try { g = JSON.parse(part.text); }
    catch { return json({ error: 'gemini returned non-json', text: part.text }, 502, cors); }

    if (!g.found) return json({ found: false }, 200, cors);

    // 0–1000 正規化框 → 參考圖（前端送來的 refWidth×refHeight，即縮圖空間）像素
    const W = refWidth || 1000, H = refHeight || 1000;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const xmin = clamp(g.xmin, 0, 1000), ymin = clamp(g.ymin, 0, 1000);
    const xmax = clamp(g.xmax, 0, 1000), ymax = clamp(g.ymax, 0, 1000);
    const out = {
      found: true,
      x: Math.round((xmin / 1000) * W),
      y: Math.round((ymin / 1000) * H),
      width: Math.round((Math.max(0, xmax - xmin) / 1000) * W),
      height: Math.round((Math.max(0, ymax - ymin) / 1000) * H),
      confidence: g.confidence != null ? g.confidence : 0.5,
    };
    if (data.usageMetadata) out._usage = data.usageMetadata;
    return json(out, 200, cors);
  },
};

function corsHeaders(env) {
  const allowOrigin = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...(cors || {}) },
  });
}
