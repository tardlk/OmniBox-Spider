// @name 4kav影院
// @author 梦
// @description 站点 4k-av.com（4K 高清影视，画质优先、条目少而精）：支持首页、分类、搜索、详情与直链播放；CF 风控下用「节流+缓存+浏览器兜底（Playwright）」三层策略，/s 被拦时自动用真浏览器过挑战；封面可用 KMP_IMG_PROXY=server/wsrv 加速
// @dependencies cheerio
// @version 1.2.1
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/4kav影院.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BASE_URL = "https://4k-av.com";
// 参考 GitHub 上能跑通的 4K-AV TVBox 爬虫（default7869/jaychouqq 的 4K影视_2.py）：
// 它用的是 macOS 上的 Chrome 134 + sec-ch-ua 系列头，而不是 Safari。
// Cloudflare 会看 UA 与 sec-ch-ua 是否自洽，Safari UA 配不上这些头反而更容易被判 bot。
const UA = process.env.KMP_UA || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
// 可选：浏览器里过掉 CF 挑战后复制整串 Cookie（关键是 cf_clearance），
// /s 搜索对无 cookie 的请求基本必 403。
const COOKIE = String(process.env.KMP_COOKIE || "").trim();
const REQUEST_TIMEOUT = Number(process.env.KMP_TIMEOUT || 20000);
// 站点在 Cloudflare 后面，短时间内多次请求会直接 403（风控）。
// 连续点击详情页 3~4 次就可能触发，触发后整个域名在一段时间内全返 403。
// 默认值按"慢速真人"调：700ms 实测仍会在连点几部片后被拦，拉到 1.2s 更稳
const REQUEST_MIN_GAP = Number(process.env.KMP_MIN_GAP || 1200);      // 两次请求的最小间隔 ms
const PAGE_CACHE_TTL = Number(process.env.KMP_CACHE_TTL || 60000);    // 页面缓存秒数
const BLOCK_COOLDOWN = Number(process.env.KMP_BLOCK_COOLDOWN || 600000); // 403 后主动冷静 ms（10 分钟）
const MAX_CACHE_ENTRIES = 40;

let lastRequestAt = 0;
let blockedUntil = 0;
// /s 搜索接口在 Cloudflare 上是单独加严的（首页/详情 200，/s 直接 403），
// 不能让它把整个源一起冻住，所以搜索单独记冷却。
let searchBlockedUntil = 0;
const pageCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============ 浏览器兜底（OmniBox 自带 Playwright/Chromium） ============
// SDK 没暴露「渲染页面」的方法，但脚本能 require('child_process')，
// 容器里就有 python3 + playwright，所以可以自己起一个真浏览器：
//   - /s 搜索被 Cloudflare 拦时，用浏览器过 JS 挑战再取 HTML
//   - 顺手把 cf_clearance 存下来，之后普通 HTTP 请求带着它走同一出口/同一 UA
// 代价是每次调用 3~6 秒（浏览器冷启动），所以只在普通请求失败时才用。
const BROWSER_HELPER = path.join(os.tmpdir(), "ob_kmp_browser.py");
const BROWSER_PROFILE = path.join(os.tmpdir(), "ob_kmp_profile");
const CF_CACHE_KEY = "kmp:cf:v1";

const BROWSER_HELPER_SRC = `# -*- coding: utf-8 -*-
import asyncio, json, sys
from playwright.async_api import async_playwright

PROFILE = ${JSON.stringify(BROWSER_PROFILE)}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

async def main():
    cfg = json.loads(sys.argv[1])
    url = cfg["url"]
    wait_ms = int(cfg.get("wait_ms", 4000))
    timeout_ms = int(cfg.get("timeout_ms", 45000))
    warmup = cfg.get("warmup") or ""
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE, headless=True, user_agent=UA,
            viewport={"width": 1440, "height": 900}, locale="zh-CN",
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        out = {"status": 0, "html": "", "title": "", "cookies": {}}
        try:
            # 先访问一下首页再进目标页：CF 的评分常按会话累计，
            # 直接冷启打开 /s 更容易被判成爬虫
            if warmup:
                try:
                    await page.goto(warmup, wait_until="domcontentloaded", timeout=timeout_ms)
                    await asyncio.sleep(1.5)
                except Exception:
                    pass
            resp = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            out["status"] = resp.status if resp else 0
            await asyncio.sleep(wait_ms / 1000.0)
            out["title"] = (await page.title())[:120]
            out["html"] = await page.content()
            for c in await ctx.cookies():
                if c.get("name"):
                    out["cookies"][c["name"]] = c["value"]
        except Exception as e:
            out["error"] = str(e)[:200]
        finally:
            await ctx.close()
        print(json.dumps(out, ensure_ascii=False))

asyncio.run(main())
`;

function ensureBrowserHelper() {
  try {
    if (!fs.existsSync(BROWSER_HELPER)) fs.writeFileSync(BROWSER_HELPER, BROWSER_HELPER_SRC, "utf8");
    return true;
  } catch (error) {
    return false;
  }
}

let cfCookieMem = "";

async function getCfCookie() {
  if (cfCookieMem) return cfCookieMem;
  try {
    const raw = await OmniBox.getCache(CF_CACHE_KEY);
    if (raw) cfCookieMem = String(raw);
  } catch (_) {
    /* 忽略缓存异常 */
  }
  return cfCookieMem;
}

async function rememberCfCookie(cookies) {
  const parts = [];
  const cf = cookies && cookies.cf_clearance;
  if (cf) parts.push(`cf_clearance=${cf}`);
  if (cookies && cookies.langID) parts.push(`langID=${cookies.langID}`);
  if (!parts.length) return;
  cfCookieMem = parts.join("; ");
  try {
    await OmniBox.setCache(CF_CACHE_KEY, cfCookieMem, 1800);
  } catch (_) {
    /* 写缓存失败不影响 */
  }
}

// 真浏览器取页面，返回 { status, title, html, cookies }
async function browserFetch(url, { waitMs = 4000, timeoutMs = 45000, warmup = "" } = {}) {
  const started = Date.now();
  try {
    // 浏览器冷启动 6~10 秒，本机 IP 被 CF 硬封时它也一样 403；
    // 失败过一次就静默 15 分钟，别让每次搜索/播放都白等
    try {
      if (await OmniBox.getCache("kmp:boff:v2")) return null;
    } catch (_) {
      /* 缓存不可用就继续 */
    }
    if (!ensureBrowserHelper()) {
      await OmniBox.log("warn", "[4KMP][browser] 写不了 helper 脚本，跳过浏览器兜底");
      return null;
    }
    const stdout = execFileSync(
      "python3",
      [BROWSER_HELPER, JSON.stringify({ url, wait_ms: waitMs, timeout_ms: timeoutMs, warmup })],
      { encoding: "utf8", timeout: timeoutMs + 20000, maxBuffer: 32 * 1024 * 1024 }
    );
    const line = String(stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
    const data = JSON.parse(line);
    if (data.error) {
      await OmniBox.log("warn", `[4KMP][browser] ${data.error} 耗时=${Date.now() - started}ms`);
      return null;
    }
    await rememberCfCookie(data.cookies || {});
    const blocked = /Attention Required|you have been blocked/i.test(String(data.html || ""));
    await OmniBox.log(
      "info",
      `[4KMP][browser] status=${data.status} blocked=${blocked} len=${String(data.html || "").length} 耗时=${Date.now() - started}ms`
    );
    if (!data.status || data.status >= 400 || blocked) {
      try {
        await OmniBox.setCache("kmp:boff:v2", "1", 900);
      } catch (_) {
        /* 忽略 */
      }
    }
    return data;
  } catch (error) {
    await OmniBox.log("warn", `[4KMP][browser] 失败: ${error.message}`);
    try {
      await OmniBox.setCache("kmp:boff:v2", "1", 900);
    } catch (_) {
      /* 忽略 */
    }
    return null;
  }
}

async function throttle() {
  const wait = REQUEST_MIN_GAP - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function readCache(url) {
  const hit = pageCache.get(url);
  if (!hit) return "";
  if (Date.now() - hit.at > PAGE_CACHE_TTL * 1000) {
    pageCache.delete(url);
    return "";
  }
  return hit.text;
}

function writeCache(url, text) {
  if (PAGE_CACHE_TTL <= 0) return;
  if (pageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = pageCache.keys().next().value;
    if (oldest) pageCache.delete(oldest);
  }
  pageCache.set(url, { at: Date.now(), text });
}

const CLASS_LIST = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv", type_name: "电视剧" },
];

const YEAR_VALUES = [
  { name: "全部", value: "" },
  { name: "2026", value: "2026" },
  { name: "2025", value: "2025" },
  { name: "2024", value: "2024" },
  { name: "2023", value: "2023" },
  { name: "2022", value: "2022" },
  { name: "2021", value: "2021" },
  { name: "2020", value: "2020" },
  { name: "2019", value: "2019" },
];

const TAG_VALUES = [
  { name: "全部", value: "" },
  { name: "动作", value: "动作" },
  { name: "剧情", value: "剧情" },
  { name: "冒险", value: "冒险" },
  { name: "喜剧", value: "喜剧" },
  { name: "科幻", value: "科幻" },
  { name: "悬疑", value: "悬疑" },
  { name: "惊悚", value: "惊悚" },
  { name: "恐怖", value: "恐怖" },
  { name: "战争", value: "战争" },
  { name: "犯罪", value: "犯罪" },
  { name: "动画", value: "动画" },
  { name: "纪录片", value: "纪录片" },
  { name: "国产剧", value: "国产剧" },
  { name: "美剧", value: "美剧" },
  { name: "韩剧", value: "韩剧" },
];

const FILTERS = {
  movie: [
    { key: "year", name: "年份", init: "", value: YEAR_VALUES },
    { key: "tag", name: "标签", init: "", value: TAG_VALUES },
  ],
  tv: [
    { key: "year", name: "年份", init: "", value: YEAR_VALUES },
    { key: "tag", name: "标签", init: "", value: TAG_VALUES },
  ],
};

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function getBodyText(res) {
  const body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body || "");
}

function cleanText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#183;/g, "·")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${BASE_URL}${value}`;
  return `${BASE_URL}/${value.replace(/^\.\//, "")}`;
}

// ==================== 封面加速（可选）====================
// KMP_IMG_PROXY:
//   0 / off / direct（默认）：直接用站点的图片直链，行为不变
//   server：走 OmniBox 图片代理 /api/proxy/image（服务端拉一次 + 浏览器缓存一年，可绕防盗链）
//   wsrv：走 wsrv.nl 压缩成 webp 并限宽（体积通常降到 1/10，取决于该服务在你网络的可达性）
const IMG_MODE = String(process.env.KMP_IMG_PROXY || "0").trim().toLowerCase();
const IMG_WIDTH = Number(process.env.KMP_IMG_WIDTH || 320) || 320;

function wrapImage(url, context) {
  const u = String(url || "").trim();
  if (!u || !/^https?:\/\//i.test(u)) return u;
  if (!IMG_MODE || IMG_MODE === "0" || IMG_MODE === "off" || IMG_MODE === "direct") return u;

  if (IMG_MODE === "wsrv") {
    return `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=${IMG_WIDTH}&output=webp&q=75&we`;
  }

  // server：拼 OmniBox 图片代理，附带 Referer 以通过防盗链
  const base = String((context && context.baseURL) || "").replace(/\/+$/, "");
  if (!base) return u;
  const target = `${u}@Referer=${encodeURIComponent(`${BASE_URL}/`)}`;
  return `${base}/api/proxy/image?url=${encodeURIComponent(target)}`;
}

function buildHeaders(referer = `${BASE_URL}/`, extra = {}) {
  const ref = referer || `${BASE_URL}/`;
  // 站点在 Cloudflare 后面，只有 UA + Accept 的请求很容易被判成 bot。
  // 补上真实 Safari 会带的 Sec-Fetch-* / Upgrade-Insecure-Requests，
  // 能明显降低被风控的概率（拿不到 cf_clearance cookie，只能靠这些特征）。
  const sameSite = ref.startsWith(BASE_URL);
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "Sec-CH-UA": '"Not/A)Brand";v="8", "Chromium";v="134", "Google Chrome";v="134"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": sameSite ? "same-origin" : "none",
    Referer: ref,
    ...extra,
  };
  if (COOKIE) headers.Cookie = COOKIE;
  return headers;
}

function buildPlayHeaders(referer = `${BASE_URL}/`) {
  const headers = {
    "User-Agent": UA,
    Referer: referer || `${BASE_URL}/`,
    Origin: BASE_URL,
  };
  if (COOKIE) headers.Cookie = COOKIE;
  return headers;
}

async function fetchText(url, options = {}) {
  const finalUrl = absUrl(url);

  const cached = readCache(finalUrl);
  if (cached) {
    await OmniBox.log("info", `[4KMP][cache] hit ${finalUrl}`);
    return cached;
  }

  if (!options.soft403 && blockedUntil > Date.now()) {
    const left = Math.ceil((blockedUntil - Date.now()) / 1000);
    throw new Error(`站点风控冷却中，约 ${left} 秒后自动恢复（别连续点）`);
  }

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1200 * attempt);
    await throttle();
    await OmniBox.log("info", `[4KMP][request] ${finalUrl}`);
    const cf = await getCfCookie();
    const extraHeaders = { ...(options.headers || {}) };
    if (cf && !extraHeaders.Cookie && !COOKIE) extraHeaders.Cookie = cf;
    const res = await OmniBox.request(finalUrl, {
      method: options.method || "GET",
      headers: buildHeaders(options.referer, extraHeaders),
      body: options.body,
      timeout: options.timeout || REQUEST_TIMEOUT,
    });
    const statusCode = Number(res?.statusCode || 0);
    if (res && statusCode === 200) {
      const text = getBodyText(res);
      writeCache(finalUrl, text);
      return text;
    }

    lastError = String(statusCode || "unknown");
    await OmniBox.log("warn", `[4KMP][request] attempt ${attempt + 1} HTTP ${lastError} @ ${finalUrl}`);

    // 403 / 429 / 503 是 Cloudflare 风控，继续重试等于反复敲同一扇门，
    // 只会把封禁时间拉长；这里直接放弃并进入冷静期。
    if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
      if (options.soft403) {
        searchBlockedUntil = Date.now() + BLOCK_COOLDOWN;
        throw new Error(`搜索接口返回 ${statusCode}（站点对 /s 单独拦了）`);
      }
      blockedUntil = Date.now() + BLOCK_COOLDOWN;
      throw new Error(
        `站点返回 ${statusCode}（Cloudflare 风控）。已暂停 ${Math.round(BLOCK_COOLDOWN / 1000)} 秒，` +
        `期间请勿反复点击；恢复后仍 403 说明该出口 IP 被临时封了，过 10~30 分钟再试`
      );
    }
  }
  throw new Error(`HTTP ${lastError} @ ${finalUrl}`);
}

function dedupeById(list) {
  const seen = new Set();
  return (list || []).filter((item) => {
    const key = item?.vod_id || item?.playId || item?.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectTypeId(href) {
  const value = String(href || "");
  if (/\/tv\//i.test(value)) return "tv";
  if (/\/movie\//i.test(value)) return "movie";
  return "";
}

function pickLabels($, $box) {
  const map = {};
  $box.find(".resyear label, #MainContent_videodetail label, #MainContent_videodetail span").each((_, el) => {
    const $el = $(el);
    const title = cleanText($el.attr("title") || "");
    const text = cleanText($el.text());
    if (title) map[title] = text.replace(new RegExp(`^${title}[:：]\\s*`), "");
    else if (/分辨率/.test(text)) map["分辨率"] = text.replace(/^分辨率[:：]\s*/, "");
    else if (/片长/.test(text)) map["片长"] = text.replace(/^片长[:：]\s*/, "");
    else if (/年份/.test(text)) map["年份"] = text.replace(/^年份[:：]\s*/, "");
  });
  return map;
}

function mapVodCard($, el, context) {
  const $box = $(el);
  const $titleLink = $box.find(".title a[href*='/movie/'], .title a[href*='/tv/'], a[href*='/movie/'], a[href*='/tv/']").first();
  const href = $titleLink.attr("href") || "";
  const name = cleanText($titleLink.attr("title") || $titleLink.find("h2").text() || $titleLink.text());
  if (!href || !name) return null;

  const labels = pickLabels($, $box);
  const tags = [];
  $box.find(".tags span").each((_, tag) => {
    const text = cleanText($(tag).text());
    if (text && text !== "标签:") tags.push(text);
  });

  const subtitle = cleanText($box.find(".info h3").first().text());
  const content = cleanText($box.find(".videodesc").first().text());
  const pic = absUrl(
    $box.find(".poster img").first().attr("src") ||
    $box.find(".poster img").first().attr("data-src") ||
    $box.find(".screenshot img").first().attr("src") ||
    $box.find("img").first().attr("src") ||
    ""
  );

  return {
    vod_id: absUrl(href),
    vod_name: name,
    vod_pic: wrapImage(pic, context),
    vod_url: absUrl(href),
    vod_remarks: labels["分辨率"] || "",
    vod_year: labels["年份"] || "",
    vod_subtitle: subtitle,
    vod_content: content,
    type_id: detectTypeId(href),
    type_name: tags.join(" / "),
  };
}

function parseVodList(html, selector = "#MainContent_newestlist .NTMitem", context = null) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  const list = [];
  $(selector).each((_, el) => {
    const item = mapVodCard($, el, context);
    if (item) list.push(item);
  });

  if (!list.length) {
    $("#recommlist .RTMitem").each((_, el) => {
      const item = mapVodCard($, el, context);
      if (item) list.push(item);
    });
  }

  return dedupeById(list);
}

function parsePageCount(html) {
  const textMatch = String(html || "").match(/页次\s*\d+\s*\/\s*(\d+)/);
  if (textMatch) {
    const count = Number(textMatch[1]);
    if (Number.isFinite(count) && count > 0) return count;
  }

  let maxPage = 1;
  const regex = /page-(\d+)\.html/gi;
  let match;
  while ((match = regex.exec(String(html || "")))) {
    const page = Number(match[1]);
    if (Number.isFinite(page) && page > maxPage) maxPage = page;
  }
  return maxPage;
}

function normalizeExtend(params) {
  return params?.extend || params?.filters || {};
}

function buildCategoryBasePath(typeId, extend = {}) {
  const year = String(extend.year || "").trim();
  const tag = String(extend.tag || "").trim();
  if (tag) return `/tag/${encodeURIComponent(tag)}/`;
  if (year) return `/${encodeURIComponent(year)}/`;

  const id = String(typeId || "movie").trim();
  if (id === "tv" || id === "movie") return `/${id}/`;
  if (/^\/.+\/$/.test(id)) return id;
  if (/^tag[:/]/i.test(id)) {
    const tagName = id.replace(/^tag[:/]/i, "").replace(/^\/|\/$/g, "");
    return `/tag/${encodeURIComponent(tagName)}/`;
  }
  if (/^(19|20)\d{2}$/.test(id)) return `/${id}/`;
  return "/movie/";
}

function buildPagedPath(basePath, sourcePage, pageCount) {
  const path = basePath.endsWith("/") ? basePath : `${basePath}/`;
  if (!sourcePage || sourcePage <= 1) return path;
  return `${path}page-${sourcePage}.html`;
}

function buildPlayId(meta) {
  return JSON.stringify(meta || {});
}

function parseMediaSources($, pageUrl) {
  const list = [];
  $("video source[src], source[src]").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src") || "";
    if (!src) return;
    const url = absUrl(src);
    const quality = cleanText($el.attr("label") || $el.attr("title") || "");
    list.push({
      name: quality || "直链",
      url,
      header: buildPlayHeaders(pageUrl),
    });
  });
  return dedupeById(list);
}

function extractDetailInfo(html, pageUrl, context = null) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  const labels = pickLabels($, $.root());
  const vodName = cleanText(
    $("#MainContent_titleh12 > div").first().attr("title") ||
    $("#MainContent_titleh12 > div").first().text() ||
    $("#tophead h1").first().attr("title") ||
    $("#tophead h1").first().text() ||
    $("title").first().text().split(" - ")[0]
  );
  const vodPic = absUrl(
    $("#MainContent_poster img").first().attr("src") ||
    $("#MainContent_poster a").first().attr("href") ||
    $("meta[property='og:image']").attr("content") ||
    ""
  );
  const vodSubtitle = cleanText($("#MainContent_titleh12 h2").first().text());
  const vodContent = cleanText($("#MainContent_videodesc .videodesc").first().text() || $("meta[name='description']").attr("content"));
  const tags = [];
  $("#MainContent_tags a").each((_, el) => {
    const text = cleanText($(el).text());
    if (text) tags.push(text);
  });

  const mediaSources = parseMediaSources($, pageUrl);
  const episodes = [];

  $("#rtlist li").each((_, el) => {
    const $li = $(el);
    const $a = $li.find("a[href*='/tv/'], a[href*='/movie/']").first();
    const href = $a.attr("href") || pageUrl;
    const title = cleanText(
      $li.find("span").first().text() ||
      $a.attr("title") ||
      $li.find("img").first().attr("title") ||
      $li.find("img").first().attr("alt") ||
      vodName
    );
    if (!href) return;
    const episodePage = absUrl(href);
    episodes.push({
      name: title || vodName || "播放",
      playId: buildPlayId({
        page: episodePage,
        title: title || vodName || "播放",
        vodName,
        pic: vodPic,
      }),
    });
  });

  if (!episodes.length) {
    episodes.push({
      name: labels["分辨率"] || "正片",
      playId: buildPlayId({
        page: pageUrl,
        title: labels["分辨率"] || "正片",
        direct: mediaSources[0]?.url || "",
        vodName,
        pic: vodPic,
      }),
    });
  }

  const playSources = [{
    name: "4KMP",
    episodes: dedupeById(episodes),
  }];

  return {
    vod_id: pageUrl,
    vod_name: vodName,
    vod_pic: wrapImage(vodPic, context),
    vod_content: vodContent,
    vod_subtitle: vodSubtitle,
    vod_year: labels["年份"] || "",
    vod_remarks: [labels["分辨率"], labels["片长"]].filter(Boolean).join(" / "),
    type_id: detectTypeId(pageUrl),
    type_name: tags.join(" / "),
    vod_play_sources: playSources,
  };
}

function normalizeKeyword(value) {
  return String(value || "")
    .replace(/[\s\-_—–·•:：,，.。!?！？'"“”‘’()（）\[\]【】{}]/g, "")
    .toLowerCase();
}

function scoreSearchResult(vodName, keyword) {
  const name = normalizeKeyword(vodName);
  const key = normalizeKeyword(keyword);
  if (!name || !key) return 0;
  if (name === key) return 1000 + key.length;
  if (name.startsWith(key)) return 800 + key.length;
  if (name.includes(key)) return 600 + key.length;
  if (key.includes(name) && name.length >= 2) return 400 + name.length;
  return 0;
}

function refineSearchResults(list, keyword) {
  const scored = (list || []).map((item, index) => ({
    item,
    index,
    score: scoreSearchResult(item.vod_name, keyword),
  }));
  const matched = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
  return matched.length ? matched : list;
}

function parseRawPlayId(raw) {
  const value = String(raw || "").trim();
  if (!value) return {};
  if (value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch (_) {}
  }
  if (/^https?:\/\//i.test(value) || value.startsWith("/")) return { page: absUrl(value), title: "播放" };
  return { page: value, title: "播放" };
}

function looksLikeMedia(url) {
  return /\.(m3u8|mp4|m4v|mov|flv)(\?|#|$)/i.test(String(url || ""));
}

async function home(params, context) {
  try {
    const html = await fetchText(`${BASE_URL}/`);
    const list = parseVodList(html, undefined, context).slice(0, 36);
    await OmniBox.log("info", `[4KMP][home] list=${list.length}`);
    return {
      class: CLASS_LIST.map((item) => ({ ...item })),
      filters: FILTERS,
      list,
    };
  } catch (error) {
    await OmniBox.log("error", `[4KMP][home] ${error.message}`);
    return { class: CLASS_LIST.map((item) => ({ ...item })), filters: FILTERS, list: [] };
  }
}

async function category(params, context) {
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  try {
    const typeId = params?.type_id || params?.categoryId || params?.tid || "movie";
    const extend = normalizeExtend(params);
    const basePath = buildCategoryBasePath(typeId, extend);
    const firstHtml = await fetchText(basePath);
    const pageCount = parsePageCount(firstHtml);
    const sourcePage = Math.max(1, pageCount - page + 1);
    const html = page <= 1 ? firstHtml : await fetchText(buildPagedPath(basePath, sourcePage, pageCount), { referer: absUrl(basePath) });
    const list = parseVodList(html, undefined, context);
    await OmniBox.log("info", `[4KMP][category] type=${typeId} page=${page} sourcePage=${sourcePage} list=${list.length}`);
    return {
      page,
      pagecount: pageCount,
      total: pageCount * Math.max(list.length, 24),
      list,
    };
  } catch (error) {
    await OmniBox.log("error", `[4KMP][category] ${error.message}`);
    return { page, pagecount: page, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const vodId = String(params?.vod_id || params?.videoId || params?.id || "").trim();
    if (!vodId) return { list: [] };
    const pageUrl = absUrl(vodId);
    const html = await fetchText(pageUrl);
    const info = extractDetailInfo(html, pageUrl, context);
    await OmniBox.log("info", `[4KMP][detail] ${info.vod_name} episodes=${info.vod_play_sources?.[0]?.episodes?.length || 0}`);
    return { list: [info] };
  } catch (error) {
    await OmniBox.log("error", `[4KMP][detail] ${error.message}`);
    return { list: [] };
  }
}

// 页面里直接写着的 m3u8/mp4（含内联脚本里 \/ 转义的形式）
function findInlineMedia(html) {
  const text = String(html || "").replace(/\\\//g, "/");
  const found = text.match(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|m4v|flv)(?:\?[^\s"'<>\\]*)?/gi) || [];
  return found.find((u) => !/trailer|preview|sample|poster|\.jpg|\.png/i.test(u)) || "";
}

// 站内搜索 /s 被 Cloudflare 单独拦掉时的兜底：扫 /movie/、/tv/ 前几页做片名匹配。
// 注意：OmniBox 每次 execute 都是新进程，模块级 Map/变量不跨调用；
// 冷却和扫描结果必须落到 OmniBox 缓存里，否则翻页会从头再扫一遍
// （实测 page=1/2/3 各扫 6 页，每次 7 秒）。
const SEARCH_SCAN_PAGES = Number(process.env.KMP_SEARCH_SCAN_PAGES || 3);
const SEARCH_PAGE_SIZE = 30;
const SCAN_CACHE_TTL = 900; // 秒
const SCAN_CACHE_KEY = "kmp:scan:v1:";
const SEARCH_OFF_KEY = "kmp:scoff:v1";

function normText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\-_:：·,，.。'"!！?？()（）[\]/]/g, "");
}

// 片名 / 副标题 / URL slug 三处一起匹配：不少老片条目名是英文，
// 只有 slug（/tv/xxxxx-friends-ep01/）里带原名
function matchItem(item, key) {
  const name = normText(item?.vod_name);
  const sub = normText(item?.vod_subtitle);
  let slug = String(item?.vod_id || "").replace(/^https?:\/\/[^/]+/i, "");
  try {
    slug = decodeURIComponent(slug);
  } catch (_) {
    /* 保持原样 */
  }
  const slugText = normText(slug);
  return Boolean(
    (name && name.includes(key)) || (sub && sub.includes(key)) || (slugText && slugText.includes(key))
  );
}

async function searchCooldownActive() {
  if (Date.now() < searchBlockedUntil) return true;
  try {
    return Boolean(await OmniBox.getCache(SEARCH_OFF_KEY));
  } catch (_) {
    return false;
  }
}

async function markSearchCooldown() {
  searchBlockedUntil = Date.now() + BLOCK_COOLDOWN;
  try {
    await OmniBox.setCache(SEARCH_OFF_KEY, "1", Math.round(BLOCK_COOLDOWN / 1000));
  } catch (_) {
    /* 写缓存失败不影响返回 */
  }
}

async function readScanCache(key) {
  try {
    const raw = await OmniBox.getCache(SCAN_CACHE_KEY + key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function writeScanCache(key, list) {
  try {
    await OmniBox.setCache(SCAN_CACHE_KEY + key, JSON.stringify(list), SCAN_CACHE_TTL);
  } catch (_) {
    /* 写缓存失败不影响返回 */
  }
}

async function scanSearch(keyword, context) {
  const key = normText(keyword);
  const cached = await readScanCache(key);
  if (cached) return cached;

  const out = [];
  const seen = new Set();
  for (const base of ["/movie/", "/tv/"]) {
    for (let p = 1; p <= SEARCH_SCAN_PAGES; p += 1) {
      let html;
      try {
        html = await fetchText(buildPagedPath(base, p, 99), { referer: `${BASE_URL}/` });
      } catch (_) {
        break;
      }
      for (const item of parseVodList(html, undefined, context)) {
        const id = String(item?.vod_id || "");
        if (!id || seen.has(id)) continue;
        if (!matchItem(item, key)) continue;
        seen.add(id);
        out.push(item);
      }
      if (out.length >= SEARCH_PAGE_SIZE) break;
    }
    if (out.length >= SEARCH_PAGE_SIZE) break;
  }
  await writeScanCache(key, out);
  return out;
}

async function search(params, context) {
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  const keyword = String(params?.keyword || params?.key || params?.wd || "").trim();
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
  try {
    // 1) 站内搜索：能通就用它（结果最准）
    if (await searchCooldownActive()) {
      await OmniBox.log("info", "[4KMP][search] /s 冷却中，直接扫列表页");
    } else {
      // 站点搜索有两个参数：GitHub 上能跑的 TVBox 爬虫用的是 /s?k=，旧版脚本用的是 /s?y=。
      // 两个都试，能出一个结果就够；都 403 就进冷却并改扫列表页。
      for (const param of ["k", "y"]) {
        try {
          const url = `${BASE_URL}/s?${param}=${encodeURIComponent(keyword)}`;
          const html = await fetchText(url, { soft403: true });
          const list = refineSearchResults(parseVodList(html, undefined, context), keyword);
          await OmniBox.log("info", `[4KMP][search] /s?${param}= keyword=${keyword} list=${list.length}`);
          if (list.length) return { page, pagecount: 1, total: list.length, list };
        } catch (error) {
          if (/40[13]|429|503/.test(error.message)) await markSearchCooldown();
          await OmniBox.log("warn", `[4KMP][search] /s?${param}= 不可用（${error.message}）`);
          break; // 403 说明整条 /s 都被拦，换参数没用
        }
      }
    }

    // 2) 兜底：本地扫列表页匹配片名，结果落缓存并做分页
    const all = await scanSearch(keyword, context);

    // 3) 列表页也扫不到时，用真浏览器过 CF 挑战直接取搜索页
    if (!all.length && page === 1) {
      const rendered = await browserFetch(`${BASE_URL}/s?k=${encodeURIComponent(keyword)}`, {
        waitMs: 3500,
        warmup: `${BASE_URL}/`,
      });
      if (rendered && rendered.html && !/Attention Required|you have been blocked/i.test(rendered.html)) {
        const list = refineSearchResults(parseVodList(rendered.html, undefined, context), keyword);
        await OmniBox.log("info", `[4KMP][search] 浏览器兜底 keyword=${keyword} list=${list.length}`);
        if (list.length) return { page: 1, pagecount: 1, total: list.length, list };
      }
    }
    const pagecount = Math.max(1, Math.ceil(all.length / SEARCH_PAGE_SIZE));
    const list = page > pagecount ? [] : all.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE);
    await OmniBox.log(
      "info",
      `[4KMP][search] 本地扫描 keyword=${keyword} page=${page}/${pagecount} total=${all.length} list=${list.length}`
    );
    return { page, pagecount, total: all.length, list };
  } catch (error) {
    await OmniBox.log("error", `[4KMP][search] ${error.message}`);
    return { page, pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  try {
    const raw = String(params?.playId || params?.play_id || params?.id || "").trim();
    const meta = parseRawPlayId(raw);
    const pageUrl = meta.page ? absUrl(meta.page) : "";
    const direct = meta.direct ? absUrl(meta.direct) : "";
    const headers = buildPlayHeaders(pageUrl || `${BASE_URL}/`);

    if (direct && looksLikeMedia(direct)) {
      return {
        parse: 0,
        jx: 0,
        url: direct,
        urls: [{ name: meta.title || "直链", url: direct }],
        header: headers,
        headers};
    }

    if (!pageUrl) {
      return { parse: 0, jx: 0, url: "", urls: [], header: {}, headers: {} };
    }

    const html = await fetchText(pageUrl, { referer: `${BASE_URL}/` });
    const $ = cheerio.load(html || "", { decodeEntities: false });
    const mediaSources = parseMediaSources($, pageUrl);
    const firstUrl = mediaSources[0]?.url || "";
    if (!firstUrl && $("#MainContent_videowindow source").length) {
      await OmniBox.log("warn", "[4KMP][play] 找到 #MainContent_videowindow source 但没取到 src");
    }
    if (firstUrl) {
      const playHeaders = buildPlayHeaders(pageUrl);
      return {
        parse: 0,
        jx: 0,
        url: firstUrl,
        urls: mediaSources.map((item) => ({ name: item.name, url: item.url })),
        header: playHeaders,
        headers: playHeaders};
    }

    // 页面里直接写着 m3u8/mp4（含内联脚本里 \/ 转义）时，不用再等 8~15 秒嗅探
    const inline = findInlineMedia(html);
    if (inline) {
      const playHeaders = buildPlayHeaders(pageUrl);
      await OmniBox.log("info", `[4KMP][play] 页面内联直链 ${inline.slice(0, 120)}`);
      return {
        parse: 0,
        jx: 0,
        url: inline,
        urls: [{ name: meta.title || "直链", url: inline }],
        header: playHeaders,
        headers: playHeaders};
    }

    // 只有磁力/ed2k/网盘的下载页没有在线流，嗅探注定白等 15 秒
    const hasIframe = $("iframe[src]").length > 0;
    if (!hasIframe && /magnet:\?|ed2k:\/\/|pan\.(?:baidu|quark)\.|115\.com/i.test(html)) {
      await OmniBox.log("warn", "[4KMP][play] 该页只有下载链接（磁力/网盘），没有在线流");
      return {
        parse: 1,
        jx: 1,
        url: pageUrl,
        urls: [{ name: `${meta.title || "播放页"}（仅下载，无在线流）`, url: pageUrl }],
        header: headers,
        headers};
    }

    // 普通请求没拿到 <source>（常见于 CF 只对浏览器放行）时，用真浏览器再取一次页面，
    // 拿到 HTML 后按同样的选择器解析，比 sniffVideo 空等 15 秒更值
    const rendered = await browserFetch(pageUrl, { waitMs: 3500 });
    if (rendered && rendered.html) {
      const $b = cheerio.load(rendered.html, { decodeEntities: false });
      const browserSources = parseMediaSources($b, pageUrl);
      const browserUrl = browserSources[0]?.url || "";
      if (browserUrl) {
        const playHeaders = buildPlayHeaders(pageUrl);
        await OmniBox.log("info", `[4KMP][play] 浏览器取到直链 ${browserUrl.slice(0, 120)}`);
        return {
          parse: 0,
          jx: 0,
          url: browserUrl,
          urls: browserSources.map((item) => ({ name: item.name, url: item.url })),
          header: playHeaders,
          headers: playHeaders};
      }
    }

    if (typeof OmniBox.sniffVideo === "function") {
      try {
        const sniffed = await OmniBox.sniffVideo(pageUrl, headers);
        const sniffUrl = sniffed?.url || sniffed?.playUrl || sniffed?.src || "";
        if (sniffUrl) {
          return {
            parse: 0,
            jx: 0,
            url: sniffUrl,
            urls: [{ name: meta.title || "嗅探线路", url: sniffUrl }],
            header: sniffed.header || sniffed.headers || headers,
            headers: sniffed.header || sniffed.headers || headers};
        }
      } catch (error) {
        await OmniBox.log("warn", `[4KMP][play] sniffVideo failed: ${error.message}`);
      }
    }

    return {
      parse: 1,
      jx: 1,
      url: pageUrl,
      urls: [{ name: meta.title || "播放页", url: pageUrl }],
      header: headers,
      headers};
  } catch (error) {
    await OmniBox.log("error", `[4KMP][play] ${error.message}`);
    return { parse: 0, jx: 0, url: "", urls: [], header: {}, headers: {} };
  }
}
