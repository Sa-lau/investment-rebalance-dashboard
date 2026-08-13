/**
 * fetch-data.js — 伺服器端行情 / 新聞抓取器
 *
 * 設計原則：
 *  1. 純 Node（零 npm 依賴），可喺 GitHub Actions 上直接跑。
 *  2. 所有外部 API 只喺伺服器端呼叫，訪客瀏覽器永遠唔會直接 call 任何第三方 API。
 *  3. 輸出單一 live.json，前端只需 fetch 同源靜態檔。
 *
 * 資料源：
 *  行情主力 — Yahoo Finance chart API（全球可達，港美股 + 指數 + 商品 + 匯率 + MPF）
 *  行情補漏 — 騰訊行情 qt.gtimg.cn（恒生科技指數等 Yahoo 冇嘅代碼）
 *  MPF     — Yahoo Finance（etnet / etwealth 基金頁已棄用，滯後一日）
 *  新聞     — RTHK 即時財經 RSS + Yahoo Finance RSS（港版繁中 + 美股英文）
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 兼容兩種擺位：repo 根目錄本身係 site（CI / GitHub Actions）／
// 或者 repo 根目錄下仲有個 site/ 子目錄（本機工作區）。自動偵測。
const SITE_DIR = fs.existsSync(path.join(ROOT, 'index.html')) ? ROOT : path.join(ROOT, 'site');
const OUT_FILE = path.join(SITE_DIR, 'live.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 清單設定                                                             */
/* ------------------------------------------------------------------ */

// 持倉股票：code = 港股代碼（不補零），yahoo = Yahoo 代碼
const STOCKS = [
  { code: '941', name: '中國移動' }, { code: '1038', name: '長江基建' },
  { code: '2800', name: '盈富基金' }, { code: '1378', name: '中國宏橋' },
  { code: '9988', name: '阿里巴巴' }, { code: '3', name: '香港中華煤氣' },
  { code: '12', name: '恒基地產' }, { code: '939', name: '建設銀行' },
  { code: '3690', name: '美團' }, { code: '5', name: '滙豐控股' },
  { code: '2638', name: '港燈-SS' }, { code: '3988', name: '中國銀行' },
  { code: '3110', name: 'GX恒生高股息ETF' }, { code: '700', name: '騰訊控股' },
  { code: '1810', name: '小米集團' }, { code: '981', name: '中芯國際' },
];

const GOLD_ETFS = [
  { code: '3081', name: '價值黃金ETF' },
  { code: '2840', name: 'SPDR金ETF' },
  { code: '3170', name: '中銀黃金ETF' },
];

// key = 前端使用嘅欄位名；yahoo = Yahoo 代碼；tx = 騰訊代碼（Yahoo 冇或失敗時用）
const INDICES = [
  { key: 'hsi', name: '恒生指數', yahoo: '^HSI', tx: 's_hkHSI' },
  { key: 'hsce', name: '國企指數', yahoo: '^HSCE', tx: 's_hkHSCEI' },
  { key: 'hstech', name: '恒生科技', yahoo: null, tx: 's_hkHSTECH' },
  { key: 'dji', name: '道瓊斯', yahoo: '^DJI', tx: 's_usDJI' },
  { key: 'gspc', name: '標普500', yahoo: '^GSPC', tx: 's_usINX' },
  { key: 'ixic', name: '納斯達克', yahoo: '^IXIC', tx: 's_usIXIC' },
  { key: 'n225', name: '日經225', yahoo: '^N225', tx: null },
];

const COMMODITIES = [
  { key: 'gold', name: '現貨黃金', yahoo: 'GC=F', unit: 'USD/oz' },
  { key: 'silver', name: '現貨白銀', yahoo: 'SI=F', unit: 'USD/oz' },
  { key: 'oil', name: '原油', yahoo: 'CL=F', unit: 'USD/bbl' },
  { key: 'cnh', name: '離岸人民幣', yahoo: 'CNH=X', unit: 'CNH/USD' },
];

const MPF_FUNDS = [
  { code: 'SHK126', yahoo: '0P00008SUZ.HK', name: '宏利MPF香港股票基金', kind: '100% 港股股票／高風險', held: true },
  { code: 'SHK145', yahoo: '0P0000WAH7.HK', name: '宏利MPF恒指ESG基金', kind: '100% 港股股票／高風險', held: true },
  { code: 'SHK127', yahoo: '0P00008VBC.HK', name: '宏利MPF國際股票基金', kind: '環球已發展市場股票（MSCI World）／中風險', held: false },
  { code: 'SHK130', yahoo: '0P00008VBD.HK', name: '宏利MPF北美股票基金', kind: '北美股票／中風險', held: false },
  { code: 'DIS-CAF', yahoo: '0P00019VA5.HK', name: '宏利MPF核心累積基金（DIS）', kind: '約60%環球股票+40%債券／中風險', held: false },
  { code: 'DIS-A65F', yahoo: '0P00019VA4.HK', name: '宏利MPF 65歲後基金（DIS）', kind: '約20%環球股票+80%債券／低風險', held: false },
  { code: 'SHK133', yahoo: '0P00008SV1.HK', name: '宏利MPF國際債券基金', kind: '國際債券／保守資產', held: false },
  { code: 'SHK122', yahoo: '0P00008VBF.HK', name: '宏利MPF穩健基金', kind: '保證基金／保守資產', held: false },
];

// 新聞來源（全部伺服器端抓，訪客唔會 call）
const NEWS_FEEDS = [
  { id: 'rthk-fin', label: 'RTHK 財經', url: 'https://rthk9.rthk.hk/rthk/news/rss/c_expressnews_cfinance.xml', lang: 'zh' },
  { id: 'rthk-local', label: 'RTHK 本地', url: 'https://rthk9.rthk.hk/rthk/news/rss/c_expressnews_clocal.xml', lang: 'zh' },
  { id: 'yh-hsi', label: 'Yahoo 港股', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EHSI&region=HK&lang=zh-Hant-HK', lang: 'zh' },
  { id: 'yh-hk2', label: 'Yahoo 港股', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=0700.HK&region=HK&lang=zh-Hant-HK', lang: 'zh' },
  { id: 'yh-gold', label: 'Yahoo 黃金', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC%3DF&region=US&lang=en-US', lang: 'en' },
  { id: 'yh-us', label: 'Yahoo 美股', url: 'https://finance.yahoo.com/news/rssindex', lang: 'en' },
];

// 標記「同你持倉相關」嘅關鍵字
const NEWS_KW = [
  '港股', '恒指', '恒生', '國企指數', '恒生科技', '港交所', '中資', '藍籌', '大市', '成交',
  '美聯儲', '聯儲', 'Fed', '議息', '減息', '加息', '利率', '通脹', 'CPI', '非農',
  '黃金', '金價', '白銀', '避險', 'gold', '美元', '人民幣', '匯率',
  '中國移動', '長江基建', '盈富', '中國宏橋', '阿里', '煤氣', '恒基', '建設銀行', '建行',
  '美團', '滙豐', '匯豐', '港燈', '中國銀行', '中銀', '騰訊', '小米', '中芯', 'ETF',
  '派息', '股息', '業績', '回購', 'MPF', '強積金', '美股', '納指', '道瓊斯', '標普',
];

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                            */
/* ------------------------------------------------------------------ */

function request(url, opts, depth) {
  opts = opts || {};
  depth = depth || 0;
  return new Promise((resolve) => {
    if (depth > 5) return resolve(null);
    let lib;
    try { lib = url.startsWith('https') ? https : http; } catch (e) { return resolve(null); }
    const req = lib.get(url, {
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-HK,zh-TW,zh,en;q=0.8',
      }, opts.headers || {}),
      timeout: opts.timeout || 20000,
    }, (res) => {
      // 跟隨轉址（RTHK 會由 https 轉去另一 host）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next = res.headers.location;
        if (!/^https?:\/\//i.test(next)) {
          try { next = new URL(next, url).href; } catch (e) { return resolve(null); }
        }
        return request(next, opts, depth + 1).then(resolve);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (opts.raw) return resolve(buf);
        if (opts.gbk) {
          try { return resolve(new TextDecoder('gbk').decode(buf)); }
          catch (e) { return resolve(buf.toString('latin1')); }
        }
        resolve(buf.toString('utf8'));
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getJson(url, opts) {
  const txt = await request(url, opts);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

// 限制同時併發數，避免被來源限流
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await worker(items[i], i); } catch (e) { out[i] = null; }
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------------------------------------------ */
/* 行情：Yahoo Finance                                                  */
/* ------------------------------------------------------------------ */

function hkYahoo(code) {
  // 港股代碼補零成 4 位：941 -> 0941.HK
  return String(code).padStart(4, '0') + '.HK';
}

async function yahooQuote(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?interval=1d&range=1d';
  const d = await getJson(url);
  const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!m || typeof m.regularMarketPrice !== 'number') return null;
  const price = m.regularMarketPrice;
  const prev = (typeof m.chartPreviousClose === 'number' ? m.chartPreviousClose : m.previousClose);
  if (typeof prev !== 'number' || !prev) return { price: price, prev: null, chg: null, pct: null, src: 'yahoo', ts: m.regularMarketTime || null };
  const chg = price - prev;
  return {
    price: round(price, 4),
    prev: round(prev, 4),
    chg: round(chg, 4),
    pct: round((chg / prev) * 100, 2),
    src: 'yahoo',
    ts: m.regularMarketTime || null,
  };
}

function round(n, d) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function tsToHKDate(ts) {
  // Yahoo regularMarketTime 係 Unix seconds（UTC），轉香港日期字串
  if (!ts) return null;
  const d = new Date(ts * 1000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function tsToHKDateSlash(ts) {
  // 轉 yyyy/mm/dd（MPF 截至日期沿用舊格式）
  if (!ts) return null;
  const d = new Date(ts * 1000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate());
}

/* ------------------------------------------------------------------ */
/* 行情：騰訊（補漏用，例如恒生科技指數）                                 */
/* ------------------------------------------------------------------ */

async function tencentQuotes(codes) {
  if (!codes.length) return {};
  const url = 'https://qt.gtimg.cn/q=' + codes.join(',');
  const txt = await request(url, { gbk: true, timeout: 15000 });
  if (!txt) return {};
  const out = {};
  const re = /v_([a-zA-Z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const key = m[1];
    const parts = m[2].split('~');
    if (parts.length < 6) continue;
    // s_ 前綴（簡版）：1=名 2=代碼 3=現價 4=漲跌 5=漲跌幅
    if (/^s_/.test(key)) {
      const price = parseFloat(parts[3]);
      const chg = parseFloat(parts[4]);
      const pct = parseFloat(parts[5]);
      if (isFinite(price) && price > 0) {
        out[key] = { price: round(price, 4), chg: round(chg, 4), pct: round(pct, 2), prev: round(price - chg, 4), src: 'tencent' };
      }
    } else {
      // 完整版：3=現價 4=昨收
      const price = parseFloat(parts[3]);
      const prev = parseFloat(parts[4]);
      if (isFinite(price) && price > 0 && isFinite(prev) && prev > 0) {
        out[key] = { price: round(price, 4), prev: round(prev, 4), chg: round(price - prev, 4), pct: round(((price - prev) / prev) * 100, 2), src: 'tencent' };
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* MPF：Yahoo Finance                                                   */
/* ------------------------------------------------------------------ */

async function yahooMpf(sym) {
  const q = await yahooQuote(sym);
  if (!q) return null;
  return {
    price: q.price,
    prev: q.prev,
    chg: q.chg,
    pct: q.pct,
    asof: tsToHKDateSlash(q.ts),
    src: 'yahoo',
  };
}

/* ------------------------------------------------------------------ */
/* 新聞：RSS 解析                                                       */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (_, d) { try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return ''; } })
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function parseRss(xml, feed) {
  if (!xml) return [];
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = pickTag(b, 'title');
    if (!title) continue;
    let link = pickTag(b, 'link');
    if (!link) {
      const lm = b.match(/<link[^>]*href="([^"]+)"/i);
      link = lm ? lm[1] : '';
    }
    const dateStr = pickTag(b, 'pubDate') || pickTag(b, 'published') || pickTag(b, 'updated') || '';
    let ts = Date.parse(dateStr);
    if (!isFinite(ts)) ts = Date.now();
    let desc = pickTag(b, 'description') || pickTag(b, 'summary') || '';
    if (desc.length > 160) desc = desc.slice(0, 160) + '…';
    items.push({
      title: title,
      link: link,
      desc: desc,
      ts: ts,
      source: feed.label,
      lang: feed.lang,
    });
  }
  return items;
}

async function fetchAllNews() {
  const results = await pool(NEWS_FEEDS, 3, async (feed) => {
    const xml = await request(feed.url, { timeout: 20000 });
    const items = parseRss(xml, feed);
    return { feed: feed, items: items, ok: items.length > 0 };
  });

  let all = [];
  const feedStatus = [];
  for (const r of results) {
    if (!r) continue;
    feedStatus.push({ id: r.feed.id, label: r.feed.label, count: r.items.length, ok: r.ok });
    all = all.concat(r.items);
  }

  // 去重（同標題只留最新）
  const seen = new Map();
  for (const it of all) {
    const k = it.title.replace(/\s+/g, '').slice(0, 40);
    if (!seen.has(k) || seen.get(k).ts < it.ts) seen.set(k, it);
  }
  let list = Array.from(seen.values());

  // 標記相關性
  for (const it of list) {
    const hay = it.title + ' ' + it.desc;
    const hits = NEWS_KW.filter(function (k) { return hay.indexOf(k) >= 0; });
    it.hits = hits.slice(0, 4);
    it.rel = hits.length > 0;
  }

  list.sort(function (a, b) { return b.ts - a.ts; });
  list = list.slice(0, 120);
  return { list: list, feeds: feedStatus };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function hkNow() {
  // 統一用香港時間輸出（Actions 上係 UTC，必須手動轉）
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d;
}

function fmtHK(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

async function main() {
  const started = Date.now();
  console.log('[fetch-data] 開始 @ ' + new Date().toISOString());

  const warnings = [];

  /* ---- 1. 股票 + 黃金 ETF（Yahoo 主力） ---- */
  const allStocks = STOCKS.concat(GOLD_ETFS);
  const stockRes = await pool(allStocks, 6, async (s) => {
    const q = await yahooQuote(hkYahoo(s.code));
    return { code: s.code, name: s.name, q: q };
  });

  const quotes = {};
  const missing = [];
  for (const r of stockRes) {
    if (r && r.q) {
      quotes[r.code] = Object.assign({ name: r.name }, r.q);
    } else if (r) {
      missing.push(r);
    }
  }

  /* ---- 2. Yahoo 抓唔到嘅，用騰訊補 ---- */
  if (missing.length) {
    const txCodes = missing.map((r) => 'r_hk' + String(r.code).padStart(5, '0'));
    const tx = await tencentQuotes(txCodes);
    for (const r of missing) {
      const k = 'r_hk' + String(r.code).padStart(5, '0');
      if (tx[k]) quotes[r.code] = Object.assign({ name: r.name }, tx[k]);
      else warnings.push('股票 ' + r.code + ' ' + r.name + ' 兩個來源都抓唔到');
    }
  }
  console.log('[fetch-data] 股票/ETF: ' + Object.keys(quotes).length + '/' + allStocks.length);

  /* ---- 3. 指數 ---- */
  const indices = {};
  // Yahoo 同騰訊一齊抓，之後按新鮮度揀
  const yahooIdx = {};
  await pool(INDICES.filter((i) => i.yahoo), 4, async (i) => {
    const q = await yahooQuote(i.yahoo);
    if (q) yahooIdx[i.key] = Object.assign({ name: i.name }, q);
  });
  const txIdxCodes = INDICES.filter((i) => i.tx).map((i) => i.tx);
  const txIdx = txIdxCodes.length ? await tencentQuotes(txIdxCodes) : {};
  const todayHK = fmtHK(hkNow()).slice(0, 10);
  for (const i of INDICES) {
    const yq = yahooIdx[i.key];
    const tq = i.tx ? txIdx[i.tx] : null;
    if (yq && tq) {
      // 港股指數：若 Yahoo 時間戳唔係今日，開市初段可能滯後，改用騰訊
      const yahooDate = yq.ts ? tsToHKDate(yq.ts) : null;
      if (i.tx.startsWith('s_hk') && yahooDate !== todayHK) {
        indices[i.key] = Object.assign({ name: i.name }, tq);
      } else {
        indices[i.key] = yq;
      }
    } else if (yq) {
      indices[i.key] = yq;
    } else if (tq) {
      indices[i.key] = Object.assign({ name: i.name }, tq);
    } else {
      warnings.push('指數 ' + i.name + ' 抓唔到');
    }
  }
  console.log('[fetch-data] 指數: ' + Object.keys(indices).length + '/' + INDICES.length);

  /* ---- 4. 商品 / 匯率 ---- */
  const commodities = {};
  await pool(COMMODITIES, 4, async (c) => {
    const q = await yahooQuote(c.yahoo);
    if (q) commodities[c.key] = Object.assign({ name: c.name, unit: c.unit }, q);
    else warnings.push('商品 ' + c.name + ' 抓唔到');
  });
  console.log('[fetch-data] 商品/匯率: ' + Object.keys(commodities).length + '/' + COMMODITIES.length);

  /* ---- 5. MPF（Yahoo Finance） ---- */
  const mpf = {};
  await pool(MPF_FUNDS, 4, async (f) => {
    const q = await yahooMpf(f.yahoo);
    if (q) mpf[f.code] = Object.assign({ name: f.name, kind: f.kind, held: f.held }, q);
    else warnings.push('MPF ' + f.code + ' 抓唔到');
  });
  console.log('[fetch-data] MPF: ' + Object.keys(mpf).length + '/' + MPF_FUNDS.length);

  /* ---- 6. 新聞 ---- */
  const news = await fetchAllNews();
  console.log('[fetch-data] 新聞: ' + news.list.length + ' 條（相關 ' +
    news.list.filter((n) => n.rel).length + ' 條），來源 ' +
    news.feeds.filter((f) => f.ok).length + '/' + news.feeds.length);
  for (const f of news.feeds) if (!f.ok) warnings.push('新聞源 ' + f.label + ' 冇回應');

  /* ---- 7. 輸出 ---- */
  const now = hkNow();
  const payload = {
    updatedAt: new Date().toISOString(),
    updatedHK: fmtHK(now),
    date: fmtHK(now).slice(0, 10),
    generatedBy: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    sources: {
      quotes: 'Yahoo Finance + 騰訊行情',
      mpf: 'Yahoo Finance',
      news: 'RTHK 即時財經 + Yahoo Finance RSS',
    },
    stats: {
      stocks: Object.keys(quotes).length,
      stocksTotal: allStocks.length,
      indices: Object.keys(indices).length,
      commodities: Object.keys(commodities).length,
      mpf: Object.keys(mpf).length,
      news: news.list.length,
      newsRelated: news.list.filter((n) => n.rel).length,
      elapsedMs: Date.now() - started,
    },
    warnings: warnings,
    quotes: quotes,
    indices: indices,
    commodities: commodities,
    mpf: mpf,
    newsFeeds: news.feeds,
    news: news.list,
  };

  // 安全閘：如果核心資料大量失敗，唔好覆蓋舊檔（避免壞資料上線）
  const okCore = Object.keys(quotes).length >= Math.ceil(allStocks.length * 0.5);
  if (!okCore) {
    console.error('[fetch-data] ✗ 核心行情抓取率過低（' + Object.keys(quotes).length + '/' + allStocks.length + '），保留舊檔唔覆蓋');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');
  console.log('[fetch-data] ✓ 已寫入 ' + OUT_FILE + '（' + (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB）');
  if (warnings.length) console.log('[fetch-data] 警告: ' + warnings.join(' / '));
  console.log('[fetch-data] 完成，用時 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
}

main().catch((e) => {
  console.error('[fetch-data] 致命錯誤:', e);
  process.exitCode = 1;
});
